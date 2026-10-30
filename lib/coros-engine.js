/**
 * dsh-coros-gui — COROS engine (pure Node).
 *
 * Implements the COROS browser ("CLI") OAuth login flow, token refresh, state
 * persistence, and the COROS MCP JSON-RPC calls. It deliberately has no DSH /
 * cordis imports: `./index.js` owns the plugin wiring (tools + RPC routes).
 *
 * Golden reference: /tmp/coros-mcp-pkg/package/dist/cli.js
 * Contract: docs/CONTRACT.md §2, §3, §4.1, §4.2, §4.3.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/** COROS regions, in the order the UI shows them. */
export const REGIONS = Object.freeze([
	{ id: 'global', label: { zh: '全球', en: 'Global' }, mcpUrl: 'https://mcp.coros.com/mcp' },
	{ id: 'cn', label: { zh: '中国大陆', en: 'Mainland China' }, mcpUrl: 'https://mcpcn.coros.com/mcp' },
	{ id: 'eu', label: { zh: '欧洲', en: 'Europe' }, mcpUrl: 'https://mcpeu.coros.com/mcp' },
	{ id: 'us', label: { zh: '美国', en: 'United States' }, mcpUrl: 'https://mcpus.coros.com/mcp' }
]);

/** OAuth scopes requested for the COROS MCP gateway. */
const SCOPES = 'openid offline_access mcp.tools';
/** Loopback redirect URI we register but never serve (code comes from Location). */
const REDIRECT_URI = 'http://127.0.0.1:43123/callback';
/** Dynamic client name registered with COROS. */
const CLIENT_NAME = 'DeepSeek Harness COROS Plugin';
/** MCP protocol version we initialize with. */
const PROTOCOL_VERSION = '2025-06-18';
/** Discovery timeout (§2.2). */
const DISCOVERY_TIMEOUT_MS = 8_000;
/** Per-MCP-call timeout (§3). */
const MCP_TIMEOUT_MS = 30_000;
/** Tool catalog cache lifetime (§4.2). */
const TOOL_CATALOG_TTL_MS = 300_000;
/** Refresh ahead of expiry (§2.6). */
const REFRESH_SKEW_MS = 60_000;
/** Store format version (§4.1). */
const STATE_VERSION = 1;
/** Fallback lifetime for a CLI login session when COROS omits a usable expiry. */
const FALLBACK_LOGIN_TTL_MS = 600_000;
/** Legacy fixed tool names that dynamic tools must not shadow (§4.4). */
const FIXED_TOOL_NAMES = Object.freeze(['coros_status', 'coros_login', 'coros_call_tool']);
/** Hard tool-name length limit (§3). */
const MAX_TOOL_NAME_LENGTH = 60;

/** Error codes carried by {@link CorosError}. */
const ERROR_CODES = Object.freeze(['auth-required', 'http', 'rpc', 'protocol', 'state']);

/** Typed engine error; `code` is one of `auth-required | http | rpc | protocol | state`. */
export class CorosError extends Error {
	/**
	 * @param {string} code - stable machine code.
	 * @param {string} message - human readable, token-free message.
	 * @param {object} [details] - optional structured details (never tokens).
	 */
	constructor(code, message, details = {}) {
		super(String(message));
		this.name = 'CorosError';
		this.code = ERROR_CODES.includes(code) ? code : 'http';
		this.details = isRecord(details) ? details : {};
	}
}

/**
 * COROS login / MCP engine.
 *
 * Emits `change` whenever the externally visible state changes and `catalog`
 * whenever the registered tool set changes (the plugin re-registers on both).
 */
export class CorosEngine extends EventEmitter {
	/** Absolute path of the persisted state file. */
	statePath;
	/** fetch-compatible implementation used for every HTTP call. */
	fetchImpl;
	/** Plugin version, reported in the MCP `initialize` clientInfo. */
	version;

	#state;
	#available = true;
	#discovery = null;
	#discoveryCache = new Map();
	#pending = null;
	#polling = false;
	#catalog = null;
	#toolDefs = [];
	#refreshPromise = null;
	#initializedToken = null;
	#mcpEndpoint = null;
	#requestId = 100;
	#loadPromise = null;
	#writeChain = Promise.resolve();
	#disposed = false;

	/**
	 * @param {object} [options]
	 * @param {string} [options.statePath] - override the state file location.
	 * @param {typeof fetch} [options.fetchImpl] - injectable fetch (tests).
	 * @param {string} [options.version] - plugin version.
	 */
	constructor(options = {}) {
		super();
		const statePath = typeof options.statePath === 'string' && options.statePath.length > 0 ? options.statePath : defaultStatePath();
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
		if (typeof fetchImpl !== 'function') throw new TypeError('CorosEngine requires a fetch implementation');
		this.statePath = statePath;
		this.fetchImpl = fetchImpl;
		this.version = typeof options.version === 'string' && options.version.length > 0 ? options.version : '0.1.0';
		this.#state = createDefaultState();
	}

	/** Load and repair persisted state. Resolves even when the file is missing or corrupt. */
	async init() {
		await this.#ensureLoaded();
		return this.getState();
	}

	/** Currently selected region id. */
	getRegion() {
		return this.#state.region;
	}

	/**
	 * Persist the selected region. Changing region clears any pending login and
	 * drops an incompatible token set (different issuer).
	 * @param {string} regionId - one of `global|cn|eu|us`.
	 */
	async setRegion(regionId) {
		await this.#ensureLoaded();
		const def = REGIONS.find((region) => region.id === regionId);
		if (def === undefined) throw new CorosError('state', `未知的 COROS 区域：${String(regionId)}`);
		if (this.#state.region === regionId) return this.getState();
		this.#state.region = regionId;
		this.#pending = null;
		this.#discovery = null;
		this.#initializedToken = null;
		this.#mcpEndpoint = null;
		this.#catalog = null;
		this.#recomputeToolDefs();
		// Drop the token set only when the authorization issuer actually changes.
		if (this.#state.token !== null) {
			const origin = new URL(def.mcpUrl).origin;
			const cached = this.#discoveryCache.get(origin);
			const nextIssuer = cached !== undefined ? cached.issuer : origin;
			if (this.#state.token.issuer !== nextIssuer) this.#state.token = null;
		}
		this.#state.lastError = null;
		await this.#persist();
		this.#emitChange();
		this.#emitCatalog();
		return this.getState();
	}

	/** Public snapshot for the client (§4.3). Never contains token material. */
	async getState() {
		await this.#ensureLoaded();
		const now = Date.now();
		const pending = this.#pending;
		const token = this.#state.token;
		let phase = 'signed-out';
		if (pending !== null) phase = 'login-pending';
		else if (token !== null) phase = 'signed-in';
		else if (this.#state.lastError !== null) phase = 'error';
		const regionDef = this.#regionDef();
		return {
			phase,
			available: this.#available,
			region: this.#state.region,
			regions: REGIONS.map((region) => ({ id: region.id, label: { zh: region.label.zh, en: region.label.en }, mcpUrl: region.mcpUrl })),
			issuer: this.#discovery?.issuer ?? token?.issuer ?? null,
			mcpUrl: regionDef.mcpUrl,
			connected: token !== null,
			tokenExpiresAt: token !== null ? token.expiresAt : null,
			tokenExpiresInMs: token !== null ? Math.max(0, token.expiresAt - now) : null,
			login: pending !== null ? { url: pending.loginUrl, expiresAt: pending.expiresAt, startedAt: pending.startedAt } : null,
			tools: this.#toolDefs.map((definition) => ({
				toolName: definition.toolName,
				mcpName: definition.mcpName,
				description: definition.description,
				inputSchema: definition.inputSchema
			})),
			toolsFetchedAt: this.#catalog !== null ? this.#catalog.fetchedAt : null,
			error: this.#state.lastError !== null ? { code: this.#state.lastError.code, message: this.#state.lastError.message, at: this.#state.lastError.at } : null,
			storagePath: this.statePath
		};
	}

	/** Whether the host RPC route is enabled (loopback). */
	setAvailable(available) {
		this.#available = available !== false;
	}

	/** Start the browser ("CLI") login session; resolves with the URL to open. */
	async startLogin(regionId) {
		await this.#ensureLoaded();
		if (regionId !== undefined && regionId !== null) {
			const def = REGIONS.find((region) => region.id === regionId);
			if (def === undefined) throw new CorosError('state', `未知的 COROS 区域：${String(regionId)}`);
			if (this.#state.region !== regionId) await this.setRegion(regionId);
		}
		this.#pending = null;
		try {
			const regionDef = this.#regionDef();
			const discovery = await this.#discover(regionDef);
			this.#discovery = discovery;
			const clientId = await this.#ensureClient(discovery);
			const codeVerifier = generatePkceVerifier();
			const codeChallenge = buildPkceChallenge(codeVerifier);
			const oauthState = base64Url(crypto.randomBytes(16));
			const authorizeUrl = new URL(discovery.authorizationEndpoint);
			authorizeUrl.searchParams.set('response_type', 'code');
			authorizeUrl.searchParams.set('client_id', clientId);
			authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
			authorizeUrl.searchParams.set('scope', SCOPES);
			authorizeUrl.searchParams.set('code_challenge', codeChallenge);
			authorizeUrl.searchParams.set('code_challenge_method', 'S256');
			authorizeUrl.searchParams.set('resource', regionDef.mcpUrl);
			authorizeUrl.searchParams.set('state', oauthState);
			const session = await this.#createLoginSession(discovery, clientId);
			this.#pending = {
				sessionId: session.sessionId,
				pollToken: session.pollToken,
				loginUrl: session.loginUrl,
				expiresAt: session.expiresAt,
				startedAt: Date.now(),
				issuer: discovery.issuer,
				tokenEndpoint: discovery.tokenEndpoint,
				clientId,
				authorizeUrl: authorizeUrl.toString(),
				codeVerifier,
				oauthState
			};
			this.#state.lastError = null;
			await this.#persist();
			this.#emitChange();
			return { loginUrl: session.loginUrl, expiresAt: session.expiresAt };
		} catch (error) {
			const failure = asCorosError(error, 'http', 'COROS 登录发起失败');
			this.#recordError(failure.code, failure.message);
			await this.#persist();
			this.#emitChange();
			throw failure;
		}
	}

	/** Advance the pending login by one claim tick. Never throws; emits `change`. */
	async pollLogin() {
		await this.#ensureLoaded();
		if (this.#pending === null || this.#polling) return this.getState();
		this.#polling = true;
		try {
			await this.#pollOnce(this.#pending);
		} catch (error) {
			const failure = asCorosError(error, 'http', 'COROS 登录状态轮询失败');
			this.#recordError(failure.code, failure.message);
		} finally {
			this.#polling = false;
		}
		this.#emitChange();
		return this.getState();
	}

	/** Forget the pending login (if any). */
	async cancelLogin() {
		await this.#ensureLoaded();
		if (this.#pending !== null) {
			this.#pending = null;
			await this.#persist();
			this.#emitChange();
		}
		return this.getState();
	}

	/** Drop the token set and the tool catalog. */
	async logout() {
		await this.#ensureLoaded();
		this.#pending = null;
		this.#initializedToken = null;
		this.#mcpEndpoint = null;
		this.#state.token = null;
		this.#state.lastError = null;
		this.#catalog = null;
		this.#recomputeToolDefs();
		await this.#persist();
		this.#emitChange();
		this.#emitCatalog();
		return this.getState();
	}

	/** Access token, refreshed when it is within the expiry skew. */
	async getAccessToken({ signal } = {}) {
		await this.#ensureLoaded();
		const token = await this.#currentTokenSet(signal);
		return token.accessToken;
	}

	/** Cached COROS MCP tool catalog (5 min); `[]` while signed out. */
	async listTools({ force = false, signal } = {}) {
		await this.#ensureLoaded();
		if (this.#state.token === null) return [];
		if (!force && this.#catalog !== null && Date.now() - this.#catalog.fetchedAt < TOOL_CATALOG_TTL_MS) return this.#catalog.tools;
		const tools = await this.#fetchToolCatalog({ signal });
		this.#catalog = { tools, fetchedAt: Date.now() };
		this.#recomputeToolDefs();
		this.#emitCatalog();
		return tools;
	}

	/** Force-reload the tool catalog, emit `catalog`, and return the tools. */
	async refreshTools({ signal } = {}) {
		await this.#ensureLoaded();
		if (this.#state.token === null) {
			this.#catalog = null;
			this.#recomputeToolDefs();
			this.#emitCatalog();
			return [];
		}
		return this.listTools({ force: true, signal });
	}

	/** Call a COROS MCP tool by its raw (`mcpName`) name and return the raw result. */
	async callTool(name, args, { signal } = {}) {
		await this.#ensureLoaded();
		if (typeof name !== 'string' || name.length === 0) throw new CorosError('state', 'COROS 工具名称不能为空。');
		if (this.#state.token === null) throw authRequired();
		const result = await this.#invoke('tools/call', { name, arguments: isRecord(args) ? args : {} }, { signal });
		return result ?? null;
	}

	/** Definitions of the currently available dynamic tools (§4.4). */
	getToolDefs() {
		return this.#toolDefs.map((definition) => ({
			toolName: definition.toolName,
			mcpName: definition.mcpName,
			description: definition.description,
			inputSchema: definition.inputSchema
		}));
	}

	/** Pending login as `{ loginUrl, expiresAt }` (never the poll token), or `null`. */
	getPendingLogin() {
		if (this.#pending === null) return null;
		return { loginUrl: this.#pending.loginUrl, expiresAt: this.#pending.expiresAt };
	}

	// ---------------------------------------------------------------- state

	async #ensureLoaded() {
		if (this.#loadPromise === null) {
			this.#loadPromise = this.#load().catch((error) => {
				this.#state = createDefaultState();
				this.#recordError('state', `无法加载 COROS 状态：${errorMessage(error)}`);
			});
		}
		await this.#loadPromise;
	}

	async #load() {
		let raw;
		try {
			raw = await readFile(this.statePath, 'utf8');
		} catch (error) {
			if (error?.code !== 'ENOENT') {
				this.#state = createDefaultState();
				this.#recordError('state', `无法读取 COROS 状态文件：${errorMessage(error)}`);
				return;
			}
			this.#state = createDefaultState();
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			this.#state = createDefaultState();
			this.#recordError('state', 'COROS 状态文件不是合法 JSON，已使用默认状态。');
			return;
		}
		this.#state = repairState(parsed);
	}

	#persist() {
		const snapshot = {
			version: STATE_VERSION,
			region: this.#state.region,
			clients: this.#state.clients,
			token: this.#state.token,
			lastError: this.#state.lastError
		};
		this.#writeChain = this.#writeChain
			.then(() => writeStateFile(this.statePath, snapshot))
			.catch((error) => {
				this.#recordError('state', `无法保存 COROS 状态文件：${errorMessage(error)}`);
			});
		return this.#writeChain;
	}

	#regionDef() {
		return REGIONS.find((region) => region.id === this.#state.region) ?? REGIONS[0];
	}

	#recordError(code, message) {
		this.#state.lastError = { code, message: String(message), at: Date.now() };
	}

	#emitChange() {
		if (!this.#disposed) this.emit('change');
	}

	#emitCatalog() {
		if (!this.#disposed) this.emit('catalog');
	}

	// --------------------------------------------------------------- oauth

	async #discover(regionDef) {
		const origin = new URL(regionDef.mcpUrl).origin;
		const cached = this.#discoveryCache.get(origin);
		if (cached !== undefined) return cached;
		let record = null;
		try {
			const response = await this.#httpJson(`${origin}/.well-known/openid-configuration`, {
				method: 'GET',
				headers: { accept: 'application/json' },
				timeoutMs: DISCOVERY_TIMEOUT_MS
			});
			if (response.status === 200 && isRecord(response.json)) {
				const payload = response.json;
				const issuer = typeof payload.issuer === 'string' && payload.issuer.startsWith('https://') ? normalizeIssuer(payload.issuer) : origin;
				record = {
					issuer,
					authorizationEndpoint: httpUrlOr(payload.authorization_endpoint, `${issuer}/oauth2/authorize`),
					tokenEndpoint: httpUrlOr(payload.token_endpoint, `${issuer}/oauth2/token`),
					registrationEndpoint: httpUrlOr(payload.registration_endpoint, `${issuer}/connect/register`)
				};
			}
		} catch {
			record = null;
		}
		if (record === null) {
			record = {
				issuer: origin,
				authorizationEndpoint: `${origin}/oauth2/authorize`,
				tokenEndpoint: `${origin}/oauth2/token`,
				registrationEndpoint: `${origin}/connect/register`
			};
		}
		this.#discoveryCache.set(origin, record);
		return record;
	}

	async #ensureClient(discovery) {
		const cached = this.#state.clients[discovery.issuer];
		if (isRecord(cached) && typeof cached.clientId === 'string' && cached.clientId.length > 0) return cached.clientId;
		const body = JSON.stringify({
			client_name: CLIENT_NAME,
			redirect_uris: [REDIRECT_URI],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			scope: SCOPES,
			token_endpoint_auth_method: 'none'
		});
		let response = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			response = await this.#httpJson(discovery.registrationEndpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body,
				timeoutMs: 15_000
			});
			const ok = (response.status === 200 || response.status === 201) && isRecord(response.json) && typeof response.json.client_id === 'string' && response.json.client_id.length > 0;
			if (ok) break;
			// Registrations can be pruned: resend once on a 4xx answer (§2.3).
			if (!(attempt === 0 && response.status >= 400 && response.status < 500)) break;
		}
		const payload = response?.json;
		if (response === null || !((response.status === 200 || response.status === 201) && isRecord(payload) && typeof payload.client_id === 'string' && payload.client_id.length > 0)) {
			throw new CorosError('http', `COROS 客户端注册失败（HTTP ${response?.status ?? '无响应'}）${describeOAuthError(payload)}`);
		}
		this.#state.clients[discovery.issuer] = { clientId: payload.client_id, redirectUri: REDIRECT_URI, createdAt: Date.now() };
		await this.#persist();
		return payload.client_id;
	}

	async #createLoginSession(discovery, clientId) {
		const response = await this.#httpJson(`${discovery.issuer}/api/v1/cli/login-sessions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ clientId }),
			timeoutMs: 15_000
		});
		const payload = response.json;
		if (!(response.status === 200 || response.status === 201) || !isRecord(payload)) {
			throw new CorosError('http', `COROS 登录会话创建失败（HTTP ${response.status}）${describeOAuthError(payload)}`);
		}
		const missing = ['sessionId', 'pollToken', 'loginUrl', 'expiresAt'].filter((field) => typeof payload[field] !== 'string' && typeof payload[field] !== 'number');
		if (missing.length > 0) throw new CorosError('protocol', `COROS 登录会话响应缺少字段：${missing.join(', ')}`);
		const loginUrl = String(payload.loginUrl);
		if (!loginUrl.startsWith('https://') && !loginUrl.startsWith('http://')) throw new CorosError('protocol', 'COROS 登录会话返回了无效的登录链接。');
		return {
			sessionId: String(payload.sessionId),
			pollToken: String(payload.pollToken),
			loginUrl,
			expiresAt: parseEpoch(payload.expiresAt, Date.now() + FALLBACK_LOGIN_TTL_MS)
		};
	}

	async #pollOnce(pending) {
		if (Date.now() >= pending.expiresAt) {
			await this.#failPending('expired', 'COROS 登录链接已过期，请重新发起登录。');
			return;
		}
		let response;
		try {
			response = await this.#httpJson(`${pending.issuer}/api/v1/cli/login-sessions/${encodeURIComponent(pending.sessionId)}/claim`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json', 'x-poll-token': pending.pollToken },
				body: '{}',
				timeoutMs: 15_000
			});
		} catch (error) {
			// Transient network trouble: keep the pending login and retry next tick.
			this.#recordError('http', `无法轮询 COROS 登录状态：${errorMessage(error)}`);
			return;
		}
		if (response.status !== 200 && response.status !== 201) {
			if ([400, 401, 403, 404, 409, 410].includes(response.status)) {
				await this.#failPending('failed', `COROS 登录会话不可用（HTTP ${response.status}），请重新发起登录。`);
			} else {
				this.#recordError('http', `COROS 登录状态轮询失败（HTTP ${response.status}），稍后自动重试。`);
			}
			return;
		}
		const payload = response.json;
		if (!isRecord(payload)) {
			this.#recordError('protocol', 'COROS 登录状态响应不是合法 JSON，稍后自动重试。');
			return;
		}
		const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : '';
		switch (status) {
			case 'pending':
				return;
			case 'authorized': {
				const loginTicket = typeof payload.loginTicket === 'string' ? payload.loginTicket : '';
				if (loginTicket.length === 0) {
					await this.#failPending('protocol', 'COROS 登录响应缺少 loginTicket，请重新发起登录。');
					return;
				}
				await this.#finishLogin(pending, loginTicket);
				return;
			}
			case 'claimed':
				await this.#failPending('claimed', '该 COROS 登录会话已被使用，请重新发起登录。');
				return;
			case 'failed': {
				const errorCode = typeof payload.errorCode === 'string' && payload.errorCode.length > 0 ? `（${payload.errorCode}）` : '';
				await this.#failPending('failed', `COROS 登录失败${errorCode}，请重新发起登录。`);
				return;
			}
			case 'expired':
				await this.#failPending('expired', 'COROS 登录链接已过期，请重新发起登录。');
				return;
			default:
				this.#recordError('protocol', `COROS 返回了未知的登录状态：${status.length > 0 ? status : '（空）'}，继续等待授权。`);
		}
	}

	async #finishLogin(pending, loginTicket) {
		const authorizeUrl = new URL(pending.authorizeUrl);
		authorizeUrl.searchParams.append('login_ticket', loginTicket);
		let response;
		try {
			response = await this.#httpJson(authorizeUrl.toString(), {
				method: 'GET',
				headers: { accept: 'text/html' },
				redirect: 'manual',
				timeoutMs: 15_000
			});
		} catch (error) {
			await this.#failPending('http', `COROS 授权跳转失败：${errorMessage(error)}`);
			return;
		}
		const location = response.headers.get('location');
		if (!(response.status >= 300 && response.status < 400) || location === null || location.length === 0) {
			await this.#failPending('protocol', `COROS 授权未返回回调地址（HTTP ${response.status}），请重新发起登录。`);
			return;
		}
		let callbackUrl;
		try {
			callbackUrl = new URL(location, REDIRECT_URI);
		} catch {
			await this.#failPending('protocol', 'COROS 授权返回了无法解析的回调地址，请重新发起登录。');
			return;
		}
		const expected = new URL(REDIRECT_URI);
		if (callbackUrl.origin !== expected.origin || callbackUrl.pathname !== expected.pathname) {
			await this.#failPending('protocol', 'COROS 授权回调地址不匹配，请重新发起登录。');
			return;
		}
		const code = callbackUrl.searchParams.get('code') ?? '';
		const stateValue = callbackUrl.searchParams.get('state') ?? '';
		if (code.length === 0) {
			await this.#failPending('protocol', 'COROS 授权回调缺少 code，请重新发起登录。');
			return;
		}
		if (stateValue !== pending.oauthState) {
			await this.#failPending('protocol', 'COROS 授权回调 state 校验失败，请重新发起登录。');
			return;
		}
		const form = new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: pending.clientId,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: pending.codeVerifier
		});
		let tokenResponse;
		try {
			tokenResponse = await this.#httpJson(pending.tokenEndpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
				body: form.toString(),
				timeoutMs: 15_000
			});
		} catch (error) {
			await this.#failPending('http', `COROS 令牌交换失败：${errorMessage(error)}`);
			return;
		}
		if (tokenResponse.status !== 200 || !isRecord(tokenResponse.json)) {
			await this.#failPending('http', `COROS 令牌交换失败（HTTP ${tokenResponse.status}）${describeOAuthError(tokenResponse.json)}`);
			return;
		}
		const tokenSet = tokenSetFromResponse(tokenResponse.json, pending.issuer);
		if (tokenSet === null) {
			await this.#failPending('protocol', 'COROS 令牌响应缺少 access_token / refresh_token，请重新发起登录。');
			return;
		}
		this.#pending = null;
		this.#initializedToken = null;
		this.#mcpEndpoint = null;
		this.#state.token = tokenSet;
		this.#state.lastError = null;
		await this.#persist();
		this.#emitChange();
		void this.refreshTools().catch((error) => {
			const failure = asCorosError(error, 'http', 'COROS 工具列表刷新失败');
			this.#recordError(failure.code, failure.message);
			this.#emitChange();
		});
	}

	async #failPending(code, message) {
		this.#pending = null;
		this.#recordError(code, message);
		await this.#persist();
		this.#emitChange();
	}

	// -------------------------------------------------------------- tokens

	async #currentTokenSet(signal) {
		const token = this.#state.token;
		if (token === null) throw authRequired();
		if (Date.now() >= token.expiresAt - REFRESH_SKEW_MS) return this.#refreshOnce(signal);
		return token;
	}

	#refreshOnce(signal) {
		if (this.#refreshPromise !== null) return this.#refreshPromise;
		const tracked = this.#refreshToken(signal).finally(() => {
			if (this.#refreshPromise === tracked) this.#refreshPromise = null;
		});
		this.#refreshPromise = tracked;
		return tracked;
	}

	async #refreshToken(signal) {
		const token = this.#state.token;
		if (token === null) throw authRequired();
		const clientRecord = this.#state.clients[token.issuer];
		const clientId = isRecord(clientRecord) && typeof clientRecord.clientId === 'string' ? clientRecord.clientId : '';
		const discovery = await this.#discoveryForIssuer(token.issuer);
		if (clientId.length === 0) {
			await this.#dropToken('auth-required', 'COROS 登录信息不完整，请重新运行 coros_login 完成登录。');
			throw authRequired();
		}
		const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token.refreshToken });
		let response;
		try {
			response = await this.#httpJson(discovery.tokenEndpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
				body: form.toString(),
				timeoutMs: 15_000,
				signal
			});
		} catch (error) {
			await this.#dropToken('auth-required', 'COROS 登录已失效，请重新运行 coros_login 完成登录。');
			throw new CorosError('auth-required', 'COROS 登录已失效，请重新运行 coros_login 完成登录。', { cause: errorMessage(error) });
		}
		if (response.status !== 200 || !isRecord(response.json)) {
			await this.#dropToken('auth-required', 'COROS 登录已失效，请重新运行 coros_login 完成登录。');
			throw new CorosError('auth-required', 'COROS 登录已失效，请重新运行 coros_login 完成登录。');
		}
		const next = tokenSetFromResponse(response.json, token.issuer);
		if (next === null) {
			await this.#dropToken('auth-required', 'COROS 登录已失效，请重新运行 coros_login 完成登录。');
			throw new CorosError('auth-required', 'COROS 登录已失效，请重新运行 coros_login 完成登录。');
		}
		this.#state.token = next;
		this.#initializedToken = null;
		this.#state.lastError = null;
		await this.#persist();
		this.#emitChange();
		return next;
	}

	async #dropToken(code, message) {
		this.#state.token = null;
		this.#state.lastError = { code, message, at: Date.now() };
		this.#initializedToken = null;
		this.#mcpEndpoint = null;
		this.#catalog = null;
		this.#recomputeToolDefs();
		await this.#persist();
		this.#emitChange();
		this.#emitCatalog();
	}

	async #discoveryForIssuer(issuer) {
		for (const record of this.#discoveryCache.values()) {
			if (record.issuer === issuer) return record;
		}
		return {
			issuer,
			authorizationEndpoint: `${issuer}/oauth2/authorize`,
			tokenEndpoint: `${issuer}/oauth2/token`,
			registrationEndpoint: `${issuer}/connect/register`
		};
	}

	// ----------------------------------------------------------------- mcp

	#mcpCandidates() {
		if (this.#mcpEndpoint !== null) return [this.#mcpEndpoint];
		const regionDef = this.#regionDef();
		const issuer = this.#discovery?.issuer ?? this.#state.token?.issuer ?? new URL(regionDef.mcpUrl).origin;
		const fallback = `${normalizeIssuer(issuer)}/mcp`;
		return regionDef.mcpUrl === fallback ? [regionDef.mcpUrl] : [regionDef.mcpUrl, fallback];
	}

	async #fetchToolCatalog({ signal } = {}) {
		const tools = [];
		let cursor = '';
		for (let page = 0; page < 100; page += 1) {
			const params = cursor.length > 0 ? { cursor } : {};
			const result = await this.#invoke('tools/list', params, { signal });
			if (!isRecord(result) || !Array.isArray(result.tools)) throw new CorosError('protocol', 'COROS MCP 工具列表响应格式不正确。');
			for (const entry of result.tools) {
				if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) continue;
				const schema = isRecord(entry.inputSchema) ? entry.inputSchema : isRecord(entry.input_schema) ? entry.input_schema : { type: 'object', properties: {} };
				tools.push({
					name: entry.name,
					description: typeof entry.description === 'string' ? entry.description : '',
					inputSchema: schema
				});
			}
			const nextCursor = result.nextCursor;
			if (typeof nextCursor !== 'string' || nextCursor.length === 0) return tools;
			cursor = nextCursor;
		}
		throw new CorosError('protocol', 'COROS MCP 工具列表分页过多，已中止。');
	}

	#recomputeToolDefs() {
		const used = new Set(FIXED_TOOL_NAMES);
		const definitions = [];
		for (const tool of this.#catalog?.tools ?? []) {
			const toolName = allocateToolName(sanitizeMcpToolName(tool.name), used);
			used.add(toolName);
			definitions.push({
				toolName,
				mcpName: tool.name,
				description: typeof tool.description === 'string' && tool.description.trim().length > 0 ? tool.description : `COROS tool ${tool.name}`,
				inputSchema: sanitizeInputSchema(tool.inputSchema)
			});
		}
		this.#toolDefs = definitions;
	}

	async #invoke(method, params, { signal, timeoutMs = MCP_TIMEOUT_MS } = {}) {
		let tokenSet = await this.#currentTokenSet(signal);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			tokenSet = await this.#ensureInitialized(tokenSet, { signal });
			const response = await this.#postMcp(tokenSet, method, params, { signal, timeoutMs });
			if (attempt === 0 && isAuthFailureResponse(response)) {
				tokenSet = await this.#refreshOnce(signal);
				continue;
			}
			if (response.status !== 200 && response.status !== 201) {
				throw new CorosError('http', `COROS ${method} 请求失败（HTTP ${response.status}）`);
			}
			if (!isRecord(response.payload)) throw new CorosError('protocol', `COROS ${method} 响应不是合法 JSON。`);
			if (response.payload.error !== undefined) {
				const error = response.payload.error;
				const message = isRecord(error) && typeof error.message === 'string' && error.message.length > 0 ? error.message : '未知错误';
				if (isAuthFailureResponse(response)) {
					await this.#dropToken('auth-required', 'COROS 授权已失效，请重新运行 coros_login 完成登录。');
					throw new CorosError('auth-required', 'COROS 授权已失效，请重新运行 coros_login 完成登录。');
				}
				throw new CorosError('rpc', `COROS ${method} 调用失败：${message}`);
			}
			return response.payload.result;
		}
		throw new CorosError('rpc', `COROS ${method} 调用失败。`);
	}

	async #ensureInitialized(tokenSet, { signal } = {}) {
		if (this.#initializedToken === tokenSet.accessToken) return tokenSet;
		let current = tokenSet;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await this.#postMcp(
				current,
				'initialize',
				{ protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-coros-gui', version: this.version } },
				{ signal, timeoutMs: MCP_TIMEOUT_MS }
			);
			if (attempt === 0 && isAuthFailureResponse(response)) {
				current = await this.#refreshOnce(signal);
				continue;
			}
			if (response.status !== 200 && response.status !== 201) {
				throw new CorosError('http', `COROS MCP initialize 失败（HTTP ${response.status}）`);
			}
			if (!isRecord(response.payload)) throw new CorosError('protocol', 'COROS MCP initialize 响应不是合法 JSON。');
			if (response.payload.error !== undefined) throw new CorosError('rpc', 'COROS MCP initialize 被拒绝。');
			this.#initializedToken = current.accessToken;
			return current;
		}
		throw new CorosError('rpc', 'COROS MCP initialize 失败。');
	}

	async #postMcp(tokenSet, method, params, { signal, timeoutMs = MCP_TIMEOUT_MS } = {}) {
		const body = JSON.stringify({ jsonrpc: '2.0', id: this.#nextRequestId(), method, params: params ?? {} });
		const candidates = this.#mcpCandidates();
		let lastError = null;
		for (let index = 0; index < candidates.length; index += 1) {
			const endpoint = candidates[index];
			try {
				const response = await this.#httpJson(endpoint, {
					method: 'POST',
					headers: {
						authorization: `${tokenSet.tokenType} ${tokenSet.accessToken}`,
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json'
					},
					body,
					timeoutMs,
					signal
				});
				// A 404 means the region's MCP URL is not the endpoint the issuer
				// serves; fall back to `{issuer}/mcp` before giving up.
				if (response.status === 404 && index < candidates.length - 1) {
					lastError = new CorosError('http', `COROS MCP 端点不可用（HTTP 404）：${safeHost(endpoint) ?? endpoint}`);
					continue;
				}
				this.#mcpEndpoint = endpoint;
				return { status: response.status, payload: response.json, endpoint };
			} catch (error) {
				lastError = asCorosError(error, 'http', `COROS MCP 请求失败（${safeHost(endpoint) ?? endpoint}）`);
				if (index < candidates.length - 1) continue;
			}
		}
		throw lastError ?? new CorosError('http', 'COROS MCP 请求失败。');
	}

	#nextRequestId() {
		this.#requestId += 1;
		return this.#requestId;
	}

	// ---------------------------------------------------------------- http

	async #httpJson(url, options = {}) {
		const { method = 'GET', headers = {}, body, redirect = 'follow', timeoutMs = 30_000, signal } = options;
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (signal !== undefined && signal !== null) signals.push(signal);
		let combined;
		try {
			combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		} catch {
			combined = signals[0];
		}
		let response;
		try {
			response = await this.fetchImpl(url, { method, headers, body, redirect, signal: combined });
		} catch (error) {
			if (signal?.aborted === true) throw new CorosError('http', 'COROS 请求已取消。', { cause: errorMessage(error) });
			if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new CorosError('http', `COROS 请求超时（${timeoutMs} ms）。`);
			const host = safeHost(url);
			throw new CorosError('http', `无法连接 COROS 服务${host !== null ? `（${host}）` : ''}：${errorMessage(error)}`);
		}
		let text = '';
		try {
			text = await response.text();
		} catch {
			text = '';
		}
		const json = parseResponseBody(text, response.headers.get('content-type') ?? '');
		return { status: response.status, headers: response.headers, json, text };
	}
}

// ------------------------------------------------------------------ helpers

function defaultStatePath() {
	const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh');
	return path.join(home, 'coros-gui', 'state.json');
}

function createDefaultState() {
	return { version: STATE_VERSION, region: 'global', clients: {}, token: null, lastError: null };
}

function repairState(value) {
	const state = createDefaultState();
	if (!isRecord(value)) return state;
	if (REGIONS.some((region) => region.id === value.region)) state.region = value.region;
	if (isRecord(value.clients)) {
		for (const [issuer, record] of Object.entries(value.clients)) {
			if (!isRecord(record)) continue;
			if (typeof record.clientId !== 'string' || record.clientId.length === 0) continue;
			state.clients[issuer] = {
				clientId: record.clientId,
				redirectUri: typeof record.redirectUri === 'string' && record.redirectUri.length > 0 ? record.redirectUri : REDIRECT_URI,
				createdAt: finiteNumber(record.createdAt) ?? 0
			};
		}
	}
	const token = value.token;
	if (
		isRecord(token) &&
		typeof token.issuer === 'string' &&
		token.issuer.length > 0 &&
		typeof token.accessToken === 'string' &&
		token.accessToken.length > 0 &&
		typeof token.refreshToken === 'string' &&
		token.refreshToken.length > 0
	) {
		state.token = {
			issuer: token.issuer,
			accessToken: token.accessToken,
			refreshToken: token.refreshToken,
			tokenType: typeof token.tokenType === 'string' && token.tokenType.length > 0 ? token.tokenType : 'Bearer',
			scope: typeof token.scope === 'string' && token.scope.length > 0 ? token.scope : SCOPES,
			expiresAt: finiteNumber(token.expiresAt) ?? 0,
			obtainedAt: finiteNumber(token.obtainedAt) ?? 0
		};
	}
	if (isRecord(value.lastError) && typeof value.lastError.code === 'string' && typeof value.lastError.message === 'string') {
		state.lastError = { code: value.lastError.code, message: value.lastError.message, at: finiteNumber(value.lastError.at) ?? 0 };
	}
	return state;
}

async function writeStateFile(filePath, value) {
	const directory = path.dirname(filePath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await chmod(directory, 0o700);
	} catch {
		// best effort: an existing directory may already have a stricter mode
	}
	const temporary = `${filePath}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	try {
		await chmod(temporary, 0o600);
	} catch {
		// best effort
	}
	await rename(temporary, filePath);
	try {
		await chmod(filePath, 0o600);
	} catch {
		// best effort
	}
}

function tokenSetFromResponse(payload, issuer) {
	if (!isRecord(payload)) return null;
	if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) return null;
	if (typeof payload.refresh_token !== 'string' || payload.refresh_token.length === 0) return null;
	const now = Date.now();
	const expiresIn = Number(payload.expires_in);
	const lifetimeSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
	return {
		issuer,
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token,
		tokenType: typeof payload.token_type === 'string' && payload.token_type.length > 0 ? payload.token_type : 'Bearer',
		scope: typeof payload.scope === 'string' && payload.scope.length > 0 ? payload.scope : SCOPES,
		expiresAt: now + lifetimeSeconds * 1000,
		obtainedAt: now
	};
}

function authRequired() {
	return new CorosError('auth-required', 'COROS 未登录，请先运行 coros_login 完成浏览器登录。');
}

function asCorosError(error, fallbackCode, prefix) {
	if (error instanceof CorosError) return error;
	return new CorosError(fallbackCode, `${prefix}：${errorMessage(error)}`);
}

function errorMessage(error) {
	if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message;
	if (typeof error === 'string' && error.length > 0) return error;
	return '未知错误';
}

function describeOAuthError(payload) {
	if (!isRecord(payload)) return '';
	const code = typeof payload.error === 'string' ? payload.error : '';
	const description = typeof payload.error_description === 'string' ? payload.error_description : '';
	if (code.length === 0 && description.length === 0) return '';
	const joined = [code, description].filter((part) => part.length > 0).join('：');
	return `（${joined.slice(0, 200)}）`;
}

function parseEpoch(value, fallback) {
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0) return fallback;
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeIssuer(issuer) {
	return String(issuer).replace(/\/+$/, '');
}

function httpUrlOr(value, fallback) {
	return typeof value === 'string' && /^https?:\/\//.test(value) ? value : fallback;
}

function safeHost(url) {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

function base64Url(buffer) {
	return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function generatePkceVerifier() {
	return base64Url(crypto.randomBytes(32));
}

function buildPkceChallenge(verifier) {
	return base64Url(crypto.createHash('sha256').update(verifier, 'utf8').digest());
}

function parseResponseBody(text, contentType) {
	if (typeof text !== 'string' || text.length === 0) return null;
	if (contentType.toLowerCase().includes('text/event-stream')) {
		const payloads = [];
		let current = [];
		for (const line of text.split(/\r?\n/)) {
			if (line === '') {
				if (current.length > 0) {
					payloads.push(current.join('\n'));
					current = [];
				}
				continue;
			}
			if (line.startsWith('data:')) current.push(line.slice(5).trimStart());
		}
		if (current.length > 0) payloads.push(current.join('\n'));
		if (payloads.length === 0) return null;
		try {
			return JSON.parse(payloads[payloads.length - 1]);
		} catch {
			return null;
		}
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value) {
	return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isJsonValue(value) {
	try {
		return JSON.stringify(value) !== undefined;
	} catch {
		return false;
	}
}

function isAuthFailureResponse(response) {
	if (response.status === 401 || response.status === 403) return true;
	const error = isRecord(response.payload) ? response.payload.error : undefined;
	if (!isRecord(error)) return false;
	if (error.code === -32001) return true;
	if (error.code === -32600 && typeof error.message === 'string' && /auth|token|unauthor|expired|forbidden|credential|login/i.test(error.message)) return true;
	return false;
}

function sanitizeMcpToolName(rawName) {
	const lowered = String(rawName ?? '').toLowerCase();
	const replaced = lowered.replace(/[^a-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
	return replaced.length > 0 ? replaced : 'tool';
}

function allocateToolName(sanitized, used) {
	const base = `coros_${sanitized}`;
	if (base.length <= MAX_TOOL_NAME_LENGTH && !used.has(base)) return base;
	for (let counter = 2; counter < 1000; counter += 1) {
		const suffix = `_${counter}`;
		const prefix = base.length + suffix.length > MAX_TOOL_NAME_LENGTH ? base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) : base;
		const candidate = `${prefix}${suffix}`;
		if (!used.has(candidate)) return candidate;
	}
	return `${base.slice(0, MAX_TOOL_NAME_LENGTH - 4)}_999`;
}

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Reduce an MCP `inputSchema` to the JSON-Schema subset DSH accepts (§4.4).
 * Falls back to a permissive object schema whenever the result is unusable.
 */
export function sanitizeInputSchema(rawSchema) {
	try {
		const cleaned = cleanSchemaNode(rawSchema, 0, new Set());
		if (cleaned === null || cleaned.type !== 'object') return { type: 'object', additionalProperties: true };
		if (cleaned.properties === undefined) cleaned.properties = {};
		if (!isRecord(cleaned.properties)) return { type: 'object', additionalProperties: true };
		return cleaned;
	} catch {
		return { type: 'object', additionalProperties: true };
	}
}

function cleanSchemaNode(node, depth, seen) {
	if (depth > 8 || !isRecord(node) || seen.has(node)) return null;
	seen.add(node);
	const out = {};
	const type = typeof node.type === 'string' && SCHEMA_TYPES.has(node.type) ? node.type : undefined;
	if (typeof node.description === 'string') out.description = node.description.slice(0, 2000);
	if (typeof node.title === 'string') out.title = node.title.slice(0, 200);
	if (Object.hasOwn(node, 'default') && isJsonValue(node.default)) out.default = node.default;
	if (Array.isArray(node.examples) && isJsonValue(node.examples)) out.examples = node.examples;

	// `oneOf` must stand alone (no sibling type/properties/...), needs >= 2 schemas,
	// and every branch must carry a real constraint to stay unambiguous.
	if (Array.isArray(node.oneOf)) {
		const branches = [];
		for (const branch of node.oneOf) {
			const child = cleanSchemaNode(branch, depth + 1, seen);
			if (child !== null && hasSchemaConstraint(child)) branches.push(child);
		}
		if (branches.length >= 2) {
			out.oneOf = branches;
			return out;
		}
	}
	if (type === undefined) return out;

	out.type = type;
	if (type === 'object') {
		const properties = {};
		if (isRecord(node.properties)) {
			for (const [key, value] of Object.entries(node.properties)) {
				const child = cleanSchemaNode(value, depth + 1, seen);
				if (child !== null) properties[key] = child;
			}
		}
		out.properties = properties;
		if (Array.isArray(node.required)) {
			const required = node.required.filter((entry) => typeof entry === 'string' && Object.hasOwn(properties, entry));
			if (required.length > 0) out.required = required;
		}
		if (typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties;
		return out;
	}
	if (type === 'array') {
		const items = cleanSchemaNode(node.items, depth + 1, seen);
		if (items !== null) out.items = items;
		return out;
	}
	// Scalar types: `enum` / `const` are only legal on scalars and every value
	// must match the declared primitive type (DSH validates this strictly).
	const enumValues = Object.hasOwn(node, 'enum') ? filteredEnumValues(type, node.enum) : null;
	if (enumValues !== null) out.enum = enumValues;
	if (Object.hasOwn(node, 'const')) {
		const constValue = filteredConstValue(type, node.const, enumValues);
		if (constValue !== undefined) out.const = constValue;
	}
	return out;
}

/** Whether a cleaned schema node carries an actual constraint (not annotation-only). */
function hasSchemaConstraint(node) {
	return (
		node.type !== undefined ||
		node.oneOf !== undefined ||
		node.enum !== undefined ||
		node.const !== undefined ||
		(Array.isArray(node.required) && node.required.length > 0) ||
		(isRecord(node.properties) && Object.keys(node.properties).length > 0)
	);
}

/** Scalar values from `enum` that match the declared type, or null when unusable. */
function filteredEnumValues(type, rawEnum) {
	if (!Array.isArray(rawEnum)) return null;
	const values = rawEnum.filter((entry) => scalarMatchesType(type, entry));
	return values.length > 0 ? values : null;
}

/** `const` value when it matches the declared type (and the retained enum), else undefined. */
function filteredConstValue(type, rawConst, enumValues) {
	if (!scalarMatchesType(type, rawConst)) return undefined;
	if (enumValues !== null && !enumValues.includes(rawConst)) return undefined;
	return rawConst;
}

/** Whether a JSON value belongs to the declared scalar schema type. */
function scalarMatchesType(type, value) {
	switch (type) {
		case 'string':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'null':
			return value === null;
		default:
			return false;
	}
}

/** Validate that a value is a plain record; re-exported for the plugin wiring. */
export function isJsonRecord(value) {
	return isRecord(value);
}
