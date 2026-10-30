/**
 * dsh-coros-gui — host half plugin wiring.
 *
 * Creates the COROS engine, registers the fixed + dynamic tools, runs the
 * login poll ticker, and exposes the plugin RPC endpoints on the Connection
 * service's authenticated `/api` carrier.
 *
 * Contract: docs/CONTRACT.md §4.4. No `@deepseek-ai/*` imports: this file uses
 * Node builtins and relative imports only.
 */

import os from 'node:os';
import path from 'node:path';

import { CorosEngine, CorosError, REGIONS } from './coros-engine.js';

const CLIENT_VERSION = '0.1.0';
const RPC_NAMESPACE = 'coros-gui';
const RPC_ENDPOINTS = Object.freeze(['state', 'loginStart', 'loginCancel', 'logout', 'toolsRefresh', 'setRegion']);
const LOOPBACK_REQUIRED_MESSAGE = 'COROS 登录需要本机 DSH Host';
const LOGIN_POLL_INTERVAL_MS = 2_000;
const RPC_METHOD_PREFIX = `${RPC_NAMESPACE}/`;

/** Plugin entry point: never throws, even when COROS or the state file is broken. */
export function apply(ctx) {
	const engine = new CorosEngine({ statePath: resolveStatePath(ctx), version: CLIENT_VERSION });

	// Load persisted state, resume a pending poll and refresh a signed-in catalog.
	ctx.effect(() => {
		let disposed = false;
		void engine
			.init()
			.then(async () => {
				if (disposed) return;
				if (engine.getPendingLogin() !== null) void engine.pollLogin().catch(() => {});
				const state = await engine.getState();
				if (!disposed && state.phase === 'signed-in') {
					await engine.listTools().catch(() => {});
				}
			})
			.catch(() => {});
		return () => {
			disposed = true;
		};
	});

	// 2 s login poll ticker while a browser authorization is pending.
	ctx.effect(() => {
		let timer = null;
		const stop = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const tick = () => {
			void engine.pollLogin().catch(() => {});
		};
		const ensure = () => {
			if (engine.getPendingLogin() !== null) {
				if (timer === null) {
					timer = setInterval(tick, LOGIN_POLL_INTERVAL_MS);
					timer.unref?.();
				}
				return;
			}
			stop();
		};
		engine.on('change', ensure);
		ensure();
		return () => {
			engine.off('change', ensure);
			stop();
		};
	});

	// Tools: three fixed tools plus one per COROS MCP tool, re-registered on catalog changes.
	ctx.inject(['tools'], (toolsCtx) => {
		const disposers = [];
		const disposeAll = () => {
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch {
					// already disposed
				}
			}
		};
		const sync = () => {
			disposeAll();
			for (const definition of buildToolDefinitions(engine)) {
				try {
					disposers.push(toolsCtx.tools.register(definition));
				} catch (error) {
					toolsCtx.logger?.warn?.('coros-gui: 注册工具 %s 失败：%s', definition.name, errorMessage(error));
				}
			}
		};
		const onCatalog = () => sync();
		return toolsCtx.effect(() => {
			sync();
			engine.on('catalog', onCatalog);
			return () => {
				engine.off('catalog', onCatalog);
				disposeAll();
			};
		});
	});

	// RPC routes on Connection's authenticated /api carrier (loopback only).
	ctx.inject(['connection'], (connectionCtx) => {
		const webServer = connectionCtx.get('webServer');
		const enabled = webServer === undefined || webServer.host === '127.0.0.1';
		engine.setAvailable(enabled);
		if (!enabled) {
			connectionCtx.logger?.warn?.('coros-gui: WebServer 未绑定回环地址（%s），COROS 登录 RPC 已禁用', webServer?.host ?? '未知');
		}
		const handler = enabled
			? (endpoint, payload, signal) => handleRpc(engine, endpoint, payload, signal)
			: async () => loopbackFailure();
		return registerCorosRoutes(connectionCtx.connection, handler);
	});
}

// ------------------------------------------------------------------- routes

/**
 * Register the fixed POST routes `/api/coros-gui/<endpoint>` on the Connection
 * service, mirroring the codex-auth account-route pattern.
 * @param {object} connection - the host `connection` service.
 * @param {(endpoint: string, payload: unknown, signal: AbortSignal|undefined) => Promise<object>} handler
 */
function registerCorosRoutes(connection, handler) {
	const disposers = RPC_ENDPOINTS.map((endpoint) =>
		connection.fetch.register({
			path: `/api/${RPC_NAMESPACE}/${endpoint}`,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: (request) => handleRouteRequest(request, endpoint, handler)
		})
	);
	return () => Promise.all(disposers.map((dispose) => dispose()));
}

async function handleRouteRequest(request, endpoint, handler) {
	const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 });
	let envelope;
	try {
		envelope = await request.json();
	} catch {
		return new Response('invalid JSON', { status: 400 });
	}
	if (!isClientRequestEnvelope(envelope)) return new Response('invalid COROS request', { status: 400 });
	let result;
	try {
		result =
			envelope.method === `${RPC_METHOD_PREFIX}${endpoint}`
				? await handler(endpoint, envelope.payload, request.signal)
				: badRequest(`COROS 请求方法 ${String(envelope.method)} 与端点 ${endpoint} 不匹配`);
	} catch (error) {
		result = rpcFailure(error, 'internal');
	}
	return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
}

async function handleRpc(engine, endpoint, payload, signal) {
	switch (endpoint) {
		case 'state': {
			if (!isEmptyPayload(payload)) return badRequest('state 端点不接受参数');
			return { ok: true, value: { state: await engine.getState() } };
		}
		case 'loginStart': {
			if (!isRecord(payload)) return badRequest('loginStart 需要对象参数');
			if (Object.keys(payload).some((key) => key !== 'region')) return badRequest('loginStart 只接受 { region? }');
			if (payload.region !== undefined && !isRegionId(payload.region)) return badRequest('loginStart.region 必须是 global|cn|eu|us');
			try {
				await engine.startLogin(payload.region);
			} catch (error) {
				return rpcFailure(error, 'internal');
			}
			return { ok: true, value: { state: await engine.getState() } };
		}
		case 'loginCancel': {
			if (!isEmptyPayload(payload)) return badRequest('loginCancel 不接受参数');
			await engine.cancelLogin();
			return { ok: true, value: { state: await engine.getState() } };
		}
		case 'logout': {
			if (!isEmptyPayload(payload)) return badRequest('logout 不接受参数');
			await engine.logout();
			return { ok: true, value: { state: await engine.getState() } };
		}
		case 'toolsRefresh': {
			if (!isEmptyPayload(payload)) return badRequest('toolsRefresh 不接受参数');
			try {
				await engine.refreshTools({ signal });
			} catch (error) {
				return rpcFailure(error, 'internal');
			}
			return { ok: true, value: { state: await engine.getState() } };
		}
		case 'setRegion': {
			if (!isRecord(payload) || typeof payload.region !== 'string' || !isRegionId(payload.region)) return badRequest('setRegion 需要 { region: "global"|"cn"|"eu"|"us" }');
			if (Object.keys(payload).some((key) => key !== 'region')) return badRequest('setRegion 只接受 { region }');
			try {
				await engine.setRegion(payload.region);
			} catch (error) {
				return rpcFailure(error, 'bad-request');
			}
			return { ok: true, value: { state: await engine.getState() } };
		}
		default:
			return badRequest(`未知的 COROS 端点：${String(endpoint)}`);
	}
}

function badRequest(message) {
	return { ok: false, error: { code: 'bad-request', message, details: {} } };
}

function loopbackFailure() {
	return { ok: false, error: { code: 'loopback-required', message: LOOPBACK_REQUIRED_MESSAGE, details: {} } };
}

function rpcFailure(error, fallbackCode) {
	if (error instanceof CorosError) {
		const code = error.code === 'auth-required' ? 'auth-required' : error.code === 'state' ? 'bad-request' : 'internal';
		return { ok: false, error: { code, message: error.message, details: {} } };
	}
	return { ok: false, error: { code: fallbackCode, message: `COROS 操作失败：${errorMessage(error)}`, details: {} } };
}

// -------------------------------------------------------------------- tools

function buildToolDefinitions(engine) {
	const definitions = [statusTool(engine), loginTool(engine), callToolTool(engine)];
	for (const tool of engine.getToolDefs()) definitions.push(dynamicTool(engine, tool));
	return definitions;
}

function textOutput() {
	return {
		schema: {},
		render(_args, value) {
			return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }];
		}
	};
}

function statusTool(engine) {
	return {
		name: 'coros_status',
		description:
			'Show the COROS connection status: login state, region, and how many COROS tools are available. Call this before using other coros_ tools if unsure.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		output: textOutput(),
		async execute(_args, _exec) {
			return summarizeState(engine);
		}
	};
}

function loginTool(engine) {
	return {
		name: 'coros_login',
		description:
			'Start the COROS browser login. Returns a URL to open; ask the user to finish authorization there. COROS tools become available after login.',
		parameters: {
			type: 'object',
			properties: {
				region: { type: 'string', enum: REGIONS.map((region) => region.id), description: 'COROS region; defaults to the saved region' }
			},
			additionalProperties: false
		},
		output: textOutput(),
		async execute(args, _exec) {
			try {
				const result = await engine.startLogin(isRecord(args) && typeof args.region === 'string' ? args.region : undefined);
				const state = await engine.getState();
				return {
					ok: true,
					loginUrl: result.loginUrl,
					expiresAt: result.expiresAt,
					instructions: '在浏览器中打开 loginUrl 完成 COROS 授权；授权成功后 COROS 工具会自动出现，无需重启。',
					state: { phase: state.phase, region: state.region, login: state.login }
				};
			} catch (error) {
				return {
					ok: false,
					error: { code: error instanceof CorosError ? error.code : 'http', message: errorMessage(error) },
					hint: '请检查网络后重试 coros_login；若 COROS 服务不可达，登录链接暂时无法生成。'
				};
			}
		}
	};
}

function callToolTool(engine) {
	return {
		name: 'coros_call_tool',
		description:
			'Call a raw COROS MCP tool by name with JSON arguments. Use it when no dedicated coros_* tool exists. Names come from coros_status.',
		parameters: {
			type: 'object',
			properties: {
				tool: { type: 'string', description: 'MCP tool name, e.g. get_activities' },
				arguments: { type: 'object', additionalProperties: true }
			},
			required: ['tool'],
			additionalProperties: false
		},
		output: textOutput(),
		async execute(args, exec) {
			const tool = isRecord(args) && typeof args.tool === 'string' ? args.tool : '';
			const toolArgs = isRecord(args) && isRecord(args.arguments) ? args.arguments : {};
			return engine.callTool(tool, toolArgs, { signal: exec?.signal });
		}
	};
}

function dynamicTool(engine, tool) {
	return {
		name: tool.toolName,
		description: `[COROS] ${tool.description}`,
		parameters: tool.inputSchema,
		output: textOutput(),
		async execute(args, exec) {
			return engine.callTool(tool.mcpName, isRecord(args) ? args : {}, { signal: exec?.signal });
		}
	};
}

async function summarizeState(engine) {
	const state = await engine.getState();
	const hint =
		state.phase === 'signed-in'
			? 'COROS 已连接，可以直接调用 coros_ 工具。'
			: state.phase === 'login-pending'
				? 'COROS 登录等待浏览器授权：把 loginUrl 交给用户打开并完成授权。'
				: 'COROS 尚未登录：调用 coros_login 获取浏览器登录链接。';
	return {
		phase: state.phase,
		signedIn: state.phase === 'signed-in',
		region: state.region,
		regions: state.regions.map((region) => region.id),
		issuer: state.issuer,
		toolCount: state.tools.length,
		tools: state.tools.map((tool) => tool.toolName),
		tokenExpiresAt: state.tokenExpiresAt,
		tokenExpiresInMs: state.tokenExpiresInMs,
		loginUrl: state.login?.url ?? null,
		error: state.error,
		hint
	};
}

// ------------------------------------------------------------------ helpers

function resolveStatePath(ctx) {
	return path.join(resolveDshHome(ctx), 'coros-gui', 'state.json');
}

function resolveDshHome(ctx) {
	try {
		const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
		if (isRecord(profileContext) && typeof profileContext.home === 'string' && profileContext.home.length > 0) return profileContext.home;
	} catch {
		// service may not be mounted in a bare unit-test context
	}
	try {
		const dshHomePath = typeof ctx?.get === 'function' ? ctx.get('dshHomePath') : undefined;
		if (typeof dshHomePath === 'function') {
			const home = dshHomePath();
			if (typeof home === 'string' && home.length > 0) return home;
		}
	} catch {
		// ignore
	}
	if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0) return process.env.DSH_HOME;
	return path.join(os.homedir(), '.dsh');
}

function isClientRequestEnvelope(value) {
	return (
		isRecord(value) &&
		value.type === 'client-request' &&
		typeof value.rpcId === 'string' &&
		typeof value.method === 'string' &&
		Object.hasOwn(value, 'payload')
	);
}

function isEmptyPayload(payload) {
	return isRecord(payload) && Object.keys(payload).length === 0;
}

function isRegionId(value) {
	return typeof value === 'string' && REGIONS.some((region) => region.id === value);
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
	if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message;
	if (typeof error === 'string' && error.length > 0) return error;
	return '未知错误';
}
