/**
 * dsh-coros-gui — engine + plugin wiring tests.
 *
 * Run with `node test/engine.test.mjs` (or `npm test`).
 *
 * Coverage:
 *  1. REGIONS contract shape.
 *  2. state lifecycle: signed-out defaults, atomic persistence, 0700/0600 modes.
 *  3. corrupt state file is repaired without breaking the engine.
 *  4. signed-out engine behaviour (no tools / auth-required).
 *  5. full fake COROS flow: discovery, dynamic client registration, CLI login
 *     session, PKCE authorize redirect, token exchange + rotation, SSE tool
 *     catalog, tool-call retry after a 401.
 *  6. unreachable COROS: startLogin fails with a readable error, no crash.
 *  7. apply(ctx) wiring: fixed + dynamic tool definitions, six RPC routes,
 *     envelope handling, loopback guard.
 *  8. LIVE smoke test (network): discovery issuer, dynamic client_id, CLI login
 *     URL, getState() shape with no token material.
 *
 * The live test is skipped only when COROS is unreachable, but that is reported
 * as a failure (the contract requires a working live login URL).
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CorosEngine, CorosError, REGIONS, sanitizeInputSchema } from '../lib/coros-engine.js';
import { apply } from '../lib/index.js';

const results = [];
const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

async function test(name, fn) {
	try {
		await fn();
		results.push({ name, ok: true });
		console.log(`ok - ${name}`);
	} catch (error) {
		results.push({ name, ok: false, error });
		console.error(`not ok - ${name}`);
		console.error(String(error?.stack ?? error).split('\n').slice(0, 12).join('\n'));
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(payload, status = 200, headers = {}) {
	return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function errCode(error) {
	return error instanceof CorosError ? error.code : null;
}

// --------------------------------------------------------------- fake flow

function createFakeCorosFlow() {
	const calls = [];
	let nextTokenSerial = 1;
	let toolsCallFailuresLeft = 1;

	const fakeFetch = async (url, options = {}) => {
		const target = new URL(String(url));
		const method = options.method ?? 'GET';
		calls.push({ url: target, method, headers: options.headers ?? {}, body: options.body ?? null, redirect: options.redirect });

		if (target.pathname === '/.well-known/openid-configuration') {
			return jsonResponse({
				issuer: 'https://mcpcn.coros.com',
				authorization_endpoint: 'https://mcpcn.coros.com/oauth2/authorize',
				token_endpoint: 'https://mcpcn.coros.com/oauth2/token',
				registration_endpoint: 'https://mcpcn.coros.com/connect/register'
			});
		}

		if (target.hostname === 'mcpcn.coros.com') {
			if (target.pathname === '/connect/register') return jsonResponse({ client_id: 'client-123' }, 201);
			if (target.pathname === '/api/v1/cli/login-sessions') {
				return jsonResponse(
					{
						sessionId: 'session-1',
						pollToken: 'poll-secret',
						loginUrl: 'https://mcpcn.coros.com/login/authorize?session=session-1',
						expiresAt: new Date(Date.now() + 600_000).toISOString()
					},
					201
				);
			}
			if (target.pathname === '/api/v1/cli/login-sessions/session-1/claim') return jsonResponse({ status: 'authorized', loginTicket: 'ticket-1' });
			if (target.pathname === '/oauth2/authorize') {
				const state = target.searchParams.get('state') ?? '';
				return new Response(null, {
					status: 302,
					headers: { location: `http://127.0.0.1:43123/callback?code=code-123&state=${encodeURIComponent(state)}` }
				});
			}
			if (target.pathname === '/oauth2/token') {
				const params = new URLSearchParams(String(options.body ?? ''));
				const serial = nextTokenSerial;
				nextTokenSerial += 1;
				const shortLived = params.get('grant_type') === 'authorization_code';
				return jsonResponse({
					access_token: `at-fake-${serial}`,
					refresh_token: `rt-fake-${serial}`,
					expires_in: shortLived ? 0.5 : 3600,
					token_type: 'Bearer',
					scope: 'openid offline_access mcp.tools'
				});
			}
		}

		if (target.hostname === 'mcp.coros.com' && target.pathname === '/mcp') {
			const request = JSON.parse(String(options.body ?? '{}'));
			if (request.method === 'initialize') {
				return jsonResponse({
					jsonrpc: '2.0',
					id: request.id,
					result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'coros', version: '1' } }
				});
			}
			if (request.method === 'tools/list') {
				const payload = {
					jsonrpc: '2.0',
					id: request.id,
					result: {
						tools: [
							{
								name: 'get_activities',
								description: 'List activities',
								inputSchema: {
									type: 'object',
									properties: { limit: { type: 'number', description: 'Max rows' } },
									required: ['limit'],
									additionalProperties: false
								}
							},
							{ name: 'weird tool!', inputSchema: { type: 'object', properties: { bad: { $ref: 'nope' } } } }
						]
					}
				};
				return new Response(`data: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
			}
			if (request.method === 'tools/call') {
				if (toolsCallFailuresLeft > 0) {
					toolsCallFailuresLeft -= 1;
					return jsonResponse({}, 401);
				}
				return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }] } });
			}
		}

		return new Response('not found', { status: 404 });
	};

	return { fakeFetch, calls };
}

// --------------------------------------------------------------- fake host

function createApplyHarness(home, { webServerHost = '127.0.0.1' } = {}) {
	const registeredTools = [];
	const routes = [];
	const disposers = [];
	const childTools = {
		tools: {
			register(definition) {
				registeredTools.push(definition);
				return () => {};
			}
		},
		effect(callback) {
			const disposer = callback();
			if (typeof disposer === 'function') disposers.push(disposer);
			return () => disposer?.();
		},
		logger: silentLogger
	};
	const childConnection = {
		connection: {
			fetch: {
				register(route) {
					routes.push(route);
					return () => {};
				}
			}
		},
		get(name) {
			if (name === 'webServer') return { host: webServerHost };
			return undefined;
		},
		logger: silentLogger
	};
	const ctx = {
		effect(callback) {
			const disposer = callback();
			if (typeof disposer === 'function') disposers.push(disposer);
			return () => disposer?.();
		},
		inject(names, callback) {
			if (names.includes('tools')) return callback(childTools);
			if (names.includes('connection')) return callback(childConnection);
			throw new Error(`unexpected inject: ${names.join(',')}`);
		},
		get(name) {
			if (name === 'profileContext') return { home };
			return undefined;
		},
		logger: silentLogger
	};
	apply(ctx);
	return { registeredTools, routes, disposers };
}

// -------------------------------------------------------------------- tests

async function main() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-coros-gui-test-'));

	await test('REGIONS matches contract (§2.1)', async () => {
		assert.deepEqual(
			REGIONS.map((region) => region.id),
			['global', 'cn', 'eu', 'us']
		);
		assert.equal(REGIONS[0].mcpUrl, 'https://mcp.coros.com/mcp');
		assert.equal(REGIONS[1].mcpUrl, 'https://mcpcn.coros.com/mcp');
		for (const region of REGIONS) {
			assert.equal(typeof region.label.zh, 'string');
			assert.equal(typeof region.label.en, 'string');
			assert.match(region.mcpUrl, /^https:\/\/[a-z.]+\/mcp$/);
		}
	});

	await test('state lifecycle: signed-out defaults + atomic 0700/0600 persistence', async () => {
		const statePath = path.join(root, 'lifecycle', 'coros-gui', 'state.json');
		const engine = new CorosEngine({ statePath });
		const initial = await engine.init();
		assert.equal(initial.phase, 'signed-out');
		assert.equal(initial.available, true);
		assert.equal(initial.region, 'global');
		assert.equal(initial.connected, false);
		assert.equal(initial.issuer, null);
		assert.equal(initial.tokenExpiresAt, null);
		assert.equal(initial.tokenExpiresInMs, null);
		assert.equal(initial.login, null);
		assert.equal(initial.error, null);
		assert.equal(initial.toolsFetchedAt, null);
		assert.equal(initial.storagePath, statePath);
		assert.deepEqual(initial.tools, []);
		assert.deepEqual(
			initial.regions.map((region) => region.id),
			['global', 'cn', 'eu', 'us']
		);
		assert.deepEqual(initial.regions[0].label, { zh: '全球', en: 'Global' });

		const moved = await engine.setRegion('cn');
		assert.equal(moved.region, 'cn');
		const raw = JSON.parse(await readFile(statePath, 'utf8'));
		assert.equal(raw.version, 1);
		assert.equal(raw.region, 'cn');
		assert.equal(raw.token, null);
		assert.deepEqual(raw.clients, {});
		assert.equal((await stat(statePath)).mode & 0o777, 0o600);
		assert.equal((await stat(path.dirname(statePath))).mode & 0o777, 0o700);

		await assert.rejects(() => engine.setRegion('mars'), (error) => errCode(error) === 'state');
		const same = await engine.setRegion('cn');
		assert.equal(same.region, 'cn');
	});

	await test('corrupt state file is repaired; engine stays usable', async () => {
		const dir = path.join(root, 'corrupt', 'coros-gui');
		const statePath = path.join(dir, 'state.json');
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(statePath, '{ not json', 'utf8');
		const engine = new CorosEngine({ statePath });
		const state = await engine.init();
		assert.equal(state.phase, 'error');
		assert.equal(state.error.code, 'state');
		assert.match(state.error.message, /JSON/);
		assert.deepEqual(await engine.listTools(), []);
		assert.equal(engine.getRegion(), 'global');
	});

	await test('signed-out engine: no tools, callTool requires login', async () => {
		const engine = new CorosEngine({ statePath: path.join(root, 'signed-out', 'coros-gui', 'state.json') });
		await engine.init();
		assert.deepEqual(await engine.listTools(), []);
		assert.deepEqual(engine.getToolDefs(), []);
		assert.equal(engine.getPendingLogin(), null);
		await assert.rejects(
			() => engine.callTool('get_activities', {}),
			(error) => errCode(error) === 'auth-required' && /coros_login/.test(error.message)
		);
	});

	await test('fake COROS flow: registration, CLI session, PKCE, tokens, SSE catalog, retry', async () => {
		const { fakeFetch, calls } = createFakeCorosFlow();
		const statePath = path.join(root, 'fake-flow', 'coros-gui', 'state.json');
		const engine = new CorosEngine({ statePath, fetchImpl: fakeFetch });
		await engine.init();

		const login = await engine.startLogin('global');
		assert.match(login.loginUrl, /^https:\/\/mcpcn\.coros\.com\/login\/authorize/);
		assert.equal(typeof login.expiresAt, 'number');
		const pending = await engine.getState();
		assert.equal(pending.phase, 'login-pending');
		assert.equal(pending.login.url, login.loginUrl);
		assert.equal(engine.getPendingLogin().loginUrl, login.loginUrl);

		const signedIn = await engine.pollLogin();
		assert.equal(signedIn.phase, 'signed-in');
		assert.equal(signedIn.connected, true);
		assert.ok(signedIn.tokenExpiresAt > Date.now());
		assert.ok(signedIn.tokenExpiresInMs > 0);
		assert.equal(signedIn.login, null);
		assert.equal(signedIn.error, null);

		await sleep(30);
		const tools = await engine.listTools();
		assert.equal(tools.length, 2);
		const definitions = engine.getToolDefs();
		assert.deepEqual(
			definitions.map((definition) => definition.toolName),
			['coros_get_activities', 'coros_weird_tool']
		);
		assert.equal(definitions[0].mcpName, 'get_activities');
		assert.equal(definitions[0].inputSchema.properties.limit.type, 'number');
		assert.equal(JSON.stringify(definitions[1].inputSchema).includes('$ref'), false);
		assert.ok(!JSON.stringify(await engine.getState()).includes('at-fake'));
		assert.ok(!JSON.stringify(await engine.getState()).includes('rt-fake'));
		assert.ok(!JSON.stringify(await engine.getState()).includes('poll-secret'));

		// State file holds the rotated token pair, but getState() never exposes it.
		const persisted = JSON.parse(await readFile(statePath, 'utf8'));
		assert.match(persisted.token.accessToken, /^at-fake-\d+$/);
		assert.match(persisted.token.refreshToken, /^rt-fake-\d+$/);
		assert.equal(persisted.clients['https://mcpcn.coros.com'].clientId, 'client-123');
		assert.equal(persisted.clients['https://mcpcn.coros.com'].redirectUri, 'http://127.0.0.1:43123/callback');

		// 401 on tools/call -> one forced refresh -> retried successfully.
		const result = await engine.callTool('get_activities', { limit: 5 });
		assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });

		// --- recorded request checks -------------------------------------------------
		const registration = calls.find((call) => call.url.pathname === '/connect/register');
		assert.ok(registration, 'registration request sent');
		const registrationBody = JSON.parse(registration.body);
		assert.equal(registrationBody.client_name, 'DeepSeek Harness COROS Plugin');
		assert.deepEqual(registrationBody.redirect_uris, ['http://127.0.0.1:43123/callback']);
		assert.deepEqual(registrationBody.grant_types, ['authorization_code', 'refresh_token']);
		assert.deepEqual(registrationBody.response_types, ['code']);
		assert.equal(registrationBody.scope, 'openid offline_access mcp.tools');
		assert.equal(registrationBody.token_endpoint_auth_method, 'none');

		const session = calls.find((call) => call.url.pathname === '/api/v1/cli/login-sessions');
		assert.equal(JSON.parse(session.body).clientId, 'client-123');

		const claim = calls.find((call) => call.url.pathname.endsWith('/claim'));
		assert.equal(claim.headers['x-poll-token'], 'poll-secret');

		const authorize = calls.find((call) => call.url.pathname === '/oauth2/authorize');
		assert.equal(authorize.redirect, 'manual');
		assert.equal(authorize.url.searchParams.get('response_type'), 'code');
		assert.equal(authorize.url.searchParams.get('client_id'), 'client-123');
		assert.equal(authorize.url.searchParams.get('redirect_uri'), 'http://127.0.0.1:43123/callback');
		assert.equal(authorize.url.searchParams.get('code_challenge_method'), 'S256');
		assert.equal(authorize.url.searchParams.get('code_challenge').length, 43);
		assert.equal(authorize.url.searchParams.get('resource'), 'https://mcp.coros.com/mcp');
		assert.equal(authorize.url.searchParams.get('login_ticket'), 'ticket-1');
		assert.ok(authorize.url.searchParams.get('state').length > 0);

		const tokenCalls = calls.filter((call) => call.url.pathname === '/oauth2/token');
		const codeExchange = tokenCalls.find((call) => new URLSearchParams(call.body).get('grant_type') === 'authorization_code');
		assert.ok(codeExchange, 'authorization_code exchange sent');
		const exchange = new URLSearchParams(codeExchange.body);
		assert.equal(exchange.get('code'), 'code-123');
		assert.equal(exchange.get('redirect_uri'), 'http://127.0.0.1:43123/callback');
		assert.ok(exchange.get('code_verifier').length >= 43);
		const rotations = tokenCalls.filter((call) => new URLSearchParams(call.body).get('grant_type') === 'refresh_token');
		assert.ok(rotations.length >= 2, `expected rotated tokens, got ${rotations.length} refreshes`);
		assert.match(new URLSearchParams(rotations[0].body).get('refresh_token'), /^rt-fake-\d+$/);

		const initialize = calls.find((call) => call.url.hostname === 'mcp.coros.com' && JSON.parse(call.body ?? '{}').method === 'initialize');
		assert.match(initialize.headers.authorization, /^Bearer at-fake-[2-9]\d*$/); // rotated before MCP use (short-lived first token)
		assert.equal(initialize.headers.accept, 'application/json, text/event-stream');
		const initBody = JSON.parse(initialize.body);
		assert.equal(initBody.params.protocolVersion, '2025-06-18');
		assert.deepEqual(initBody.params.clientInfo, { name: 'dsh-coros-gui', version: '0.1.0' });

		const loggedOut = await engine.logout();
		assert.equal(loggedOut.phase, 'signed-out');
		assert.equal(loggedOut.connected, false);
		assert.deepEqual(engine.getToolDefs(), []);
	});

	await test('unreachable COROS: readable failure in state.lastError, no crash', async () => {
		const brokenFetch = async () => {
			throw new TypeError('fetch failed');
		};
		const engine = new CorosEngine({ statePath: path.join(root, 'offline', 'coros-gui', 'state.json'), fetchImpl: brokenFetch });
		await engine.init();
		const error = await engine.startLogin().then(
			() => null,
			(failure) => failure
		);
		assert.ok(error instanceof CorosError);
		assert.equal(error.code, 'http');
		assert.match(error.message, /无法连接 COROS/);
		const state = await engine.getState();
		assert.equal(state.phase, 'error');
		assert.equal(state.error.code, 'http');
		assert.match(state.error.message, /无法连接 COROS/);
		assert.equal(engine.getPendingLogin(), null);
		const polled = await engine.pollLogin();
		assert.equal(polled.phase, 'error');
	});

	await test('apply(ctx) registers tools + six RPC routes and answers envelopes', async () => {
		const home = path.join(root, 'apply');
		const { registeredTools, routes } = createApplyHarness(home, { webServerHost: '127.0.0.1' });
		assert.deepEqual(
			registeredTools.map((definition) => definition.name),
			['coros_status', 'coros_login', 'coros_call_tool']
		);
		for (const definition of registeredTools) {
			assert.equal(typeof definition.description, 'string');
			assert.equal(definition.parameters.type, 'object');
			assert.equal(typeof definition.output.render, 'function');
			assert.equal(typeof definition.execute, 'function');
		}
		assert.equal(registeredTools[0].description.includes('COROS'), true);
		assert.deepEqual(
			routes.map((route) => [route.path, route.methods.join(','), route.requestBody]),
			[
				['/api/coros-gui/state', 'POST', 'buffered'],
				['/api/coros-gui/loginStart', 'POST', 'buffered'],
				['/api/coros-gui/loginCancel', 'POST', 'buffered'],
				['/api/coros-gui/logout', 'POST', 'buffered'],
				['/api/coros-gui/toolsRefresh', 'POST', 'buffered'],
				['/api/coros-gui/setRegion', 'POST', 'buffered']
			]
		);
		const stateRoute = routes[0];
		const request = () =>
			new Request('http://127.0.0.1:0/api/coros-gui/state', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'coros-gui/state', payload: {} })
			});
		const response = await stateRoute.fetch(request());
		assert.equal(response.status, 200);
		const envelope = await response.json();
		assert.equal(envelope.type, 'server-response');
		assert.equal(envelope.rpcId, 'rpc-1');
		assert.equal(envelope.result.ok, true);
		assert.equal(envelope.result.value.state.phase, 'signed-out');
		assert.equal(envelope.result.value.state.storagePath, path.join(home, 'coros-gui', 'state.json'));

		const wrongType = await stateRoute.fetch(new Request('http://127.0.0.1:0/api/coros-gui/state', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }));
		assert.equal(wrongType.status, 415);
		const invalidJson = await stateRoute.fetch(new Request('http://127.0.0.1:0/api/coros-gui/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }));
		assert.equal(invalidJson.status, 400);
		const wrongMethod = await stateRoute.fetch(
			new Request('http://127.0.0.1:0/api/coros-gui/state', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-2', method: 'coros-gui/logout', payload: {} })
			})
		);
		assert.equal((await wrongMethod.json()).result.error.code, 'bad-request');
		const badRegion = await routes[5].fetch(
			new Request('http://127.0.0.1:0/api/coros-gui/setRegion', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-3', method: 'coros-gui/setRegion', payload: { region: 'mars' } })
			})
		);
		assert.equal((await badRegion.json()).result.error.code, 'bad-request');
		const goodRegion = await routes[5].fetch(
			new Request('http://127.0.0.1:0/api/coros-gui/setRegion', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-4', method: 'coros-gui/setRegion', payload: { region: 'eu' } })
			})
		);
		const goodRegionBody = await goodRegion.json();
		assert.equal(goodRegionBody.result.ok, true);
		assert.equal(goodRegionBody.result.value.state.region, 'eu');
	});

	await test('apply(ctx) blocks RPC when the host is not loopback-bound', async () => {
		const home = path.join(root, 'apply-blocked');
		const { routes } = createApplyHarness(home, { webServerHost: '0.0.0.0' });
		const response = await routes[0].fetch(
			new Request('http://127.0.0.1:0/api/coros-gui/state', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'coros-gui/state', payload: {} })
			})
		);
		const envelope = await response.json();
		assert.equal(envelope.result.ok, false);
		assert.equal(envelope.result.error.code, 'loopback-required');
		assert.equal(envelope.result.error.message, 'COROS 登录需要本机 DSH Host');
	});

	await test('sanitizeInputSchema drops unsupported JSON-Schema keywords', async () => {
		const cleaned = sanitizeInputSchema({
			type: 'object',
			properties: {
				a: { type: 'string', enum: ['x', 1], const: 'x', $ref: 'no', format: 'bad', pattern: 'bad' },
				b: { type: 'nope' },
				c: { type: 'array', items: { type: 'string' }, enum: ['nope'] },
				d: { type: 'object', properties: { inner: { type: 'number' } }, required: ['inner', 'missing'], additionalProperties: false },
				e: { oneOf: [{ type: 'string' }, { type: 'number' }], type: 'string' },
				f: { oneOf: [{ type: 'string' }] }
			},
			required: ['a', 'ghost', 3],
			additionalProperties: true,
			$schema: 'http://json-schema.org/draft-07/schema#'
		});
		assert.equal(cleaned.type, 'object');
		assert.equal(cleaned.additionalProperties, true);
		assert.equal(cleaned.$schema, undefined);
		assert.deepEqual(cleaned.required, ['a']);
		assert.deepEqual(cleaned.properties.a.enum, ['x']);
		assert.equal(cleaned.properties.a.const, 'x');
		assert.equal(cleaned.properties.a.$ref, undefined);
		assert.equal(cleaned.properties.a.format, undefined);
		assert.equal(cleaned.properties.a.pattern, undefined);
		assert.deepEqual(cleaned.properties.b, {});
		assert.deepEqual(cleaned.properties.c, { type: 'array', items: { type: 'string' } });
		assert.deepEqual(cleaned.properties.d.required, ['inner']);
		assert.equal(cleaned.properties.d.additionalProperties, false);
		assert.deepEqual(cleaned.properties.e.oneOf, [{ type: 'string' }, { type: 'number' }]);
		assert.equal(cleaned.properties.e.type, undefined);
		assert.equal(cleaned.properties.f.oneOf, undefined);
		assert.deepEqual(sanitizeInputSchema({ type: 'string' }), { type: 'object', additionalProperties: true });
		assert.deepEqual(sanitizeInputSchema(null), { type: 'object', additionalProperties: true });
		assert.deepEqual(sanitizeInputSchema({ type: 'object', properties: [], required: ['x'], enum: [1] }), { type: 'object', properties: {} });
	});

	await test('LIVE smoke: discovery + dynamic client registration + CLI login session', async () => {
		const statePath = path.join(root, 'live', 'coros-gui', 'state.json');
		const engine = new CorosEngine({ statePath });
		const initial = await engine.init();
		assert.equal(initial.phase, 'signed-out');

		const login = await engine.startLogin('global');
		const state = await engine.getState();
		const persisted = JSON.parse(await readFile(statePath, 'utf8'));
		const issuer = state.issuer;
		assert.equal(typeof issuer, 'string');
		assert.match(issuer, /^https:\/\/[a-z.]*coros\.com$/);
		const clientRecord = persisted.clients[issuer];
		assert.ok(clientRecord, `client registration cached for ${issuer}`);
		assert.equal(typeof clientRecord.clientId, 'string');
		assert.ok(clientRecord.clientId.length > 0);
		assert.equal(clientRecord.redirectUri, 'http://127.0.0.1:43123/callback');

		const loginUrl = new URL(login.loginUrl);
		assert.equal(loginUrl.protocol, 'https:');
		assert.match(loginUrl.host, /coros\.com$/);
		assert.equal(state.phase, 'login-pending');
		assert.equal(state.login.url, login.loginUrl);
		assert.equal(typeof state.login.expiresAt, 'number');
		assert.equal(typeof state.login.startedAt, 'number');
		assert.equal(typeof state.available, 'boolean');
		assert.ok(!/accessToken|refreshToken|pollToken|codeVerifier/.test(JSON.stringify(state)));

		console.log('[smoke] discovery issuer:', issuer);
		console.log('[smoke] client_id present:', clientRecord.clientId.length, 'chars —', clientRecord.clientId);
		console.log('[smoke] loginUrl host:', loginUrl.host, '| path:', loginUrl.pathname);
		console.log('[smoke] state:', JSON.stringify(state, null, 2));

		const polled = await engine.pollLogin();
		assert.equal(polled.phase, 'login-pending');
		console.log('[smoke] after one live claim poll:', polled.phase, '| lastError:', polled.error?.code ?? 'none');

		const cancelled = await engine.cancelLogin();
		assert.equal(cancelled.phase, 'signed-out');
		assert.equal(cancelled.login, null);
		const loggedOut = await engine.logout();
		assert.equal(loggedOut.phase, 'signed-out');
	});

	await rm(root, { recursive: true, force: true });

	const failed = results.filter((result) => !result.ok);
	console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
	if (failed.length > 0) {
		console.error(`failed: ${failed.map((result) => result.name).join(', ')}`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error('test harness crashed:', error);
	process.exitCode = 1;
});
