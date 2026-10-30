# dsh-coros-gui — implementation contract (single source of truth)

Mission: a DeepSeek Harness (DSH) plugin that brings COROS training data into the conversation.
Focus: **login** (COROS browser OAuth), then COROS MCP tools usable by the agent, plus a
spec-compliant plugin UI (a Settings page and a quick-access panel).

Target host: **installed DSH 0.2.1-rc.3** (the running app), not the 0.1.1 source checkout.

## 0. Ground rules

- Repo root: `/Users/jeholfenq/projects/dsh-coros-gui` (this file is `docs/CONTRACT.md`).
- Host half (`lib/index.js`, `lib/coros-engine.js`) and client half (`lib/client.js`) are written by
  different owners. **Do not edit files outside your write scope** (see §8).
- **Host half: ZERO `@deepseek-ai/*` imports.** Write plain cordis-plugin code and hand-written
  tool definition literals. Node builtins and relative imports only.
- **Client half: cannot import any Harness client package.** `require()` only the static module
  table: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
  `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit`. In practice: **only `require('react')`**. No JSX, no build
  step, no CSS loader — hand-write `React.createElement` and inject one `<style>` tag.
- UI styling: only `var(--dsw-*)` design tokens (see §6.5). No hard-coded colors, no iframes.
- Everything must work after `dsh plugin --profile <p> add .` and a restart; no extra setup, no
  config file edits by the user.

## 1. Reference implementations to read before coding

| What | Path |
| --- | --- |
| COROS OAuth golden implementation (SDK CLI, 953 lines) | `/tmp/coros-mcp-pkg/package/dist/cli.js` |
| Installed DSH 0.2.1 runtime (extracted from app.asar) | `/tmp/dsh-app/dsh/node_modules/@deepseek-ai/` |
| Official plugin-dev skill + templates | `/tmp/dsh-app/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` |
| Best host-side route pattern (plugin-owned RPC on `/api`) | `/Users/jeholfenq/.dsh/profiles/desktop/node_modules/dsh-codex-auth/lib/index.js` — see `registerAccountRoutes`, `createLoopbackRpcGuard`, `apply` bottom (~line 1100) |
| Best client-side bundle pattern | same plugin's `lib/client.cjs` |
| Host CSS variables actually shipped | `/tmp/dsh-app/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/*.css` |
| Installed CLI to run/test | `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" /tmp/dsh-app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` |

## 2. COROS protocol — login (authoritative)

### 2.1 Regions
| id | label zh / en | MCP URL |
| --- | --- | --- |
| `global` | 全球 / Global | `https://mcp.coros.com/mcp` |
| `cn` | 中国大陆 / Mainland China | `https://mcpcn.coros.com/mcp` |
| `eu` | 欧洲 / Europe | `https://mcpeu.coros.com/mcp` |
| `us` | 美国 / United States | `https://mcpus.coros.com/mcp` |

### 2.2 Discovery
`GET {origin-of-mcpUrl}/.well-known/openid-configuration` (follow redirects, 8 s timeout) →
JSON containing at least `issuer`, and usually `authorization_endpoint`, `token_endpoint`,
`registration_endpoint`. Fix the returned `issuer` for this login. Fallback when discovery fails:
issuer = origin of the region's MCP URL, endpoints = `{issuer}/oauth2/authorize`,
`{issuer}/oauth2/token`, `{issuer}/connect/register`.

Live fact (verified 2026-10-30): `https://mcp.coros.com/.well-known/openid-configuration` → 200,
`issuer: "https://mcpcn.coros.com"`.

### 2.3 Redirect URI and dynamic client registration
`redirectUri = "http://127.0.0.1:43123/callback"` (a URL we register but never serve; the
authorization `code` is read from the redirect `Location` header).

`POST {registration_endpoint}` (JSON):
```json
{ "client_name": "DeepSeek Harness COROS Plugin",
  "redirect_uris": ["http://127.0.0.1:43123/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "openid offline_access mcp.tools",
  "token_endpoint_auth_method": "none" }
```
→ `{ "client_id": "..." }`. Cache per issuer (`state.clients[issuer]`); re-register if missing.
Resend on 4xx once (registrations can be pruned).

### 2.4 PKCE + authorize URL
- `codeVerifier`: base64url of 32 random bytes (`crypto.randomBytes`).
- `codeChallenge`: base64url(`crypto.createHash('sha256').update(codeVerifier).digest()`).
- `state`: base64url 16 random bytes.
- authorize URL (parameter order irrelevant):
  `{authorization_endpoint}?response_type=code&client_id=…&redirect_uri=…&scope=openid%20offline_access%20mcp.tools&code_challenge=…&code_challenge_method=S256&resource={mcpUrl}&state=…`

### 2.5 Browser ("CLI") login session — the flow we use
1. `POST {issuer}/api/v1/cli/login-sessions` JSON `{ "clientId": client_id }`
   → `{ sessionId, pollToken, loginUrl, expiresAt }` (all four required; else throw).
2. Show `loginUrl` to the user (they open it in any browser and approve).
3. Poll every ~2 s: `POST {issuer}/api/v1/cli/login-sessions/{sessionId}/claim`
   header `X-Poll-Token: {pollToken}` → JSON with `status`:
   `pending` (keep polling) · `authorized` (+ `loginTicket`) · `claimed` (already used → error) ·
   `failed` / `expired` (error, surface `errorCode` if present).
4. After `authorized`: `GET {authorizeUrl}&login_ticket={encodeURIComponent(loginTicket)}`
   with `redirect: 'manual'`; expect 3xx with `location: http://127.0.0.1:43123/callback?code=…&state=…`.
   Verify `state` matches, extract `code`, else throw.
5. `POST {token_endpoint}` form-urlencoded
   `grant_type=authorization_code&client_id=…&code=…&redirect_uri=…&code_verifier=…`
   → `{ access_token, refresh_token, expires_in, token_type, scope }`.

### 2.6 Refresh & token lifetime
- Refresh when `now >= expiresAt - 60_000`.
- `POST {token_endpoint}` form-urlencoded
  `grant_type=refresh_token&client_id=…&refresh_token=…` → **rotating** refresh token (persist the
  new pair atomically). Refresh failure ⇒ drop the token set and report `auth-required`.
- COROS docs: access token 30 days, refresh token 180 days.

## 3. COROS protocol — MCP calls

Stateless Streamable-HTTP JSON-RPC (no `Mcp-Session-Id`, no `notifications/initialized`).

- Endpoint: `{issuer}/mcp` (same origin as the discovered issuer). If issuer has no path, use
  `{issuer}/mcp`.
- Headers: `Authorization: {token_type} {access_token}` (default `Bearer`),
  `Accept: application/json, text/event-stream`, `Content-Type: application/json`.
- Body: JSON-RPC 2.0 single request `{jsonrpc:'2.0', id, method, params}`.
- Sequence: `initialize` once per token/process:
  `params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh-coros-gui", version: "0.1.0" } }`
  then `tools/list` (paginate with `params.cursor` until no `nextCursor`),
  then `tools/call` with `params: { name, arguments }`.
- Response parsing: if `content-type` contains `text/event-stream`, read the full text, walk lines,
  collect `data:` payloads, JSON.parse the **last** one; otherwise parse JSON body.
- `401` ⇒ force refresh + retry once. Also retry once when the JSON-RPC error code is an auth error
  (`-32001`, `-32600` with an auth-ish message, or HTTP 403).
- Per-call timeout 30 s, abortable via the caller's `AbortSignal`.
- MCP tool names may collide with ours / contain odd characters: our public tool name is
  `"coros_" + name` lowercased, `[^a-z0-9_-]` → `_`, collapse repeats, trim `_`, max 60 chars,
  suffix `_2`, `_3`… on collision.

## 4. Host half

Files: `lib/coros-engine.js` (pure Node, no cordis) and `lib/index.js` (plugin wiring).
`apply(ctx, config)` — no `export const Config` needed.

### 4.1 Storage (engine)
Path: `process.env.DSH_HOME ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')` +
`/coros-gui/state.json`; dir `0o700`, file `0o600`, atomic (write `state.json.tmp` + `rename`).
Shape:
```jsonc
{ "version": 1,
  "region": "global",                       // global|cn|eu|us
  "clients": { "<issuer>": { "clientId": "…", "redirectUri": "…", "createdAt": 0 } },
  "token": { "issuer": "…", "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer",
             "scope": "…", "expiresAt": 0, "obtainedAt": 0 } | null,
  "lastError": { "code": "…", "message": "…", "at": 0 } | null }
```
Never log token material; never return it from RPC/tools.

### 4.2 Engine API (exact)
```js
export const REGIONS = [{ id, label: { zh, en }, mcpUrl }, ...] // order: global, cn, eu, us
export class CorosError extends Error { code; details }        // code: 'auth-required'|'http'|'rpc'|'protocol'|'state'
export class CorosEngine extends EventEmitter {                // EventEmitter is fine (node:events)
  constructor(options: { statePath?: string, fetchImpl?: typeof fetch, version?: string })
  async init()                            // load+repair state (never throws on missing file)
  getRegion()                             // region id
  async setRegion(regionId)               // persist; clears pending login + token if issuer changes
  async getState()                        // see §4.3 (no token material)
  async startLogin(regionId?)             // discovery+client reg+PKCE+login-session → {loginUrl, expiresAt}
  async pollLogin()                       // advance the pending login; returns getState(); emits 'change'
  async cancelLogin()
  async logout()
  async getAccessToken({ signal })        // refresh if needed, throws CorosError('auth-required')
  async listTools({ force = false, signal } = {})   // cached 5 min → [{name, description, inputSchema}]
  async refreshTools({ signal })          // force reload, emits 'catalog', returns tools
  async callTool(name, args, { signal } = {})       // raw MCP result
  getToolDefs()                           // [{ toolName, mcpName, description, inputSchema }] for registered tools
  getPendingLogin()                       // { loginUrl, expiresAt } | null
}
```
Behavior notes:
- `pollLogin` is called by a host-side 2 s ticker while pending; it must be re-entrant-safe (guard
  with a boolean) and must never throw (store `lastError`, clear pending on terminal states).
- `startLogin` cancels any previous pending login first.
- `setRegion` to the same region is a no-op.
- `listTools` when signed out: return `[]` (do not throw); `callTool` when signed out throws
  `CorosError('auth-required', ...)` whose message tells the user to run `coros_login`.
- Discovery/HTTP failures → `CorosError('http', …)` with readable message (include status code).

### 4.3 `getState()` shape (client contract — keep exactly)
```ts
{
  phase: 'signed-out' | 'login-pending' | 'signed-in' | 'error',
  available: boolean,                 // true when the host route is enabled (loopback)
  region: 'global'|'cn'|'eu'|'us',
  regions: [{ id, label: {zh,en}, mcpUrl }],
  issuer: string | null,
  mcpUrl: string,
  connected: boolean,
  tokenExpiresAt: number | null,      // epoch ms
  tokenExpiresInMs: number | null,
  login: { url: string, expiresAt: number, startedAt: number } | null,
  tools: [{ toolName: string, mcpName: string, description: string }],
  toolsFetchedAt: number | null,
  error: { code: string, message: string, at: number } | null,
  storagePath: string,
}
```

### 4.4 Plugin wiring (`lib/index.js`)
```js
export function apply(ctx) {
  const engine = new CorosEngine({ version: '0.1.0' });
  // 1. fixed tools + dynamic tools (registered/disposed on 'change'/'catalog')
  // 2. host ticker for the pending login (2 s), inside ctx.effect
  // 3. RPC routes on Connection's authenticated /api carrier
}
```
Fixed tools (always registered, registered through `ctx.inject(['tools'], …)`):

| name | description (English, mention COROS) | parameters |
| --- | --- | --- |
| `coros_status` | "Show the COROS connection status: login state, region, and how many COROS tools are available. Call this before using other coros_ tools if unsure." | `{type:'object', properties:{}, additionalProperties:false}` |
| `coros_login` | "Start the COROS browser login. Returns a URL to open; ask the user to finish authorization there. COROS tools become available after login." | `{type:'object', properties:{region:{type:'string', enum:['global','cn','eu','us'], description:'COROS region; defaults to the saved region'}}, additionalProperties:false}` |
| `coros_call_tool` | "Call a raw COROS MCP tool by name with JSON arguments. Use it when no dedicated coros_* tool exists. Names come from coros_status." | `{type:'object', properties:{tool:{type:'string', description:'MCP tool name, e.g. get_activities'}, arguments:{type:'object', additionalProperties:true}}, required:['tool'], additionalProperties:false}` |

Dynamic tools: one per MCP tool, name from §3, description = MCP description (prefix
`"[COROS] "`), parameters = sanitized `inputSchema`:

- A tool definition literal for `ctx.tools.register` is `{name, description, parameters, output:{schema, render}, execute(args, exec)}`.
- `parameters` must be in DSH's supported JSON-Schema subset: only `type` (`object|array|string|number|integer|boolean|null`), `oneOf`, `properties`, `required`, `additionalProperties` (boolean), `items`, `enum` (scalars), `const` (scalar), `description`, `title`, `default`, `examples`. Strip anything else (`$schema`, `format`, `minLength`, `anyOf`, `allOf`, `pattern`, `examples` OK). If the sanitized schema is not an object schema or sanitization fails, fall back to `{type:'object', additionalProperties:true}`. Empty property maps are fine.
- `output: { schema: {}, render(args, value) { return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] } }` — `{}` is a legal "any JSON" schema.
- `execute(args, exec)` must pass `exec.signal` into the engine and return a plain JSON value.
- Registering must be effect-safe: keep the disposable returned by `ctx.tools.register(def)` and call it when the dynamic set changes; re-register inside `ctx.effect` so disposal follows the plugin.
- Dynamic tool names must not be `run_code`; `coros_status`/`coros_login`/`coros_call_tool`/`coros_*` collisions get the `_2` suffix scheme.

RPC carrier — copy the **exact** pattern from codex-auth (§1 path) with no `@deepseek-ai` import:
```js
ctx.inject(['connection'], (connectionCtx) => {
  const webServer = connectionCtx.get('webServer');
  const enabled = webServer === undefined || webServer.host === '127.0.0.1';
  const guard = enabled ? handler : async () => ({ ok:false, error:{ code:'loopback-required', message:'COROS 登录需要本机 DSH Host', details:{} } });
  const disposers = ENDPOINTS.map((endpoint) => connectionCtx.connection.fetch.register({
    path: `/api/coros-gui/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // require content-type application/json; parse body; validate envelope {type:'client-request', rpcId, method, payload}
      // method must equal `coros-gui/${endpoint}` else fail 'bad-request'
      // call guard(endpoint, payload, request.signal) → {ok:true,value}|{ok:false,error}
      // return Response.json({ type:'server-response', rpcId, result })
    },
  }));
  return () => Promise.all(disposers.map((d) => d()));
});
```
Endpoints (flat names, no slashes): `state`, `loginStart`, `loginCancel`, `logout`, `toolsRefresh`,
`setRegion`. Method names on the wire are `coros-gui/<endpoint>`.
Payload contracts:

| endpoint | payload | value |
| --- | --- | --- |
| `state` | `{}` | `{ state: getState() }` |
| `loginStart` | `{ region?: string }` | `{ state }` (throws → error result with `code`) |
| `loginCancel` | `{}` | `{ state }` |
| `logout` | `{}` | `{ state }` |
| `toolsRefresh` | `{}` | `{ state }` after `refreshTools()` + re-register |
| `setRegion` | `{ region: string }` | `{ state }` |

Error results: `{ ok:false, error:{ code, message, details:{} } }` with `code` `'bad-request'`,
`'auth-required'`, `'loopback-required'`, `'internal'`. Never leak tokens.

## 5. Client half (`lib/client.js`)

Single file, no build step. Shape:
```js
window.__ModuleLoader__.load({
  id: 'dsh-coros-gui',
  factory: function (require) {
    var module = { exports: {} }; var exports = module.exports;
    var React = require('react');
    var h = React.createElement;
    /* one guarded <style data-plugin-css="dsh-coros-gui/panel.css"> injection */
    /* components, store, api client */
    exports.inject = ['slots', 'locale', 'connection'];
    exports.apply = function (ctx) { /* registrations */ };
    return module.exports;
  },
});
```
`id` must be the package name (`dsh-coros-gui`). Only `react` may be required.

### 5.1 Services and registrations
- `ctx.locale.register(NS, { zh: {...}, en: {...} })` inside `ctx.effect(…)`, `NS = 'dsh-coros-gui'`.
- Pass `locale: NS` on every slot registration so the component receives `t`. Provide a safe fallback
  `var t = props.t || function (k) { return k; }`.
- Registrations (each inside `ctx.slots.inject(slotName, () => ctx.slots.register(opts, Comp))`,
  wrapped in try/catch so a missing slot never breaks the app):
  1. `settings.section` — `{ name:'settings.section', id:'coros-gui', order: 55, label: () => t('settings.nav'), locale: NS, inject: () => ({ view }) }`, component = full page (`props.close` available).
  2. `shell.overlay` — `{ name:'shell.overlay', id:'coros-gui-panel', order: 40, locale: NS, inject: () => ({ view }) }`, component renders the quick-access modal **only while `view.open`**; `null` otherwise.
  3. `sidebar.footer.action` — `{ name:'sidebar.footer.action', id:'coros-gui-button', order: 40, locale: NS, inject: () => ({ view }) }`, component = small icon button (`props.wide` boolean) that toggles `view.open`.
  4. Optional, only if trivially safe: `conversation.session.header.actions` chip that toggles `view.open`.
- `view` face (client store/controller, created once in `apply`):
  `{ available, getState(), subscribe(fn), open, setOpen(v), load(), startLogin(region), cancelLogin(), logout(), refreshTools(), setRegion(region) }`
  — `getState()` returns the snapshot from §4.3 plus `{ loading, localError, open }`; `subscribe` for
  `React.useSyncExternalStore`. Guard all calls: if `ctx.connection?.isLoopback === false`, mark
  `available = false` and render a "requires local DSH host" notice instead of the buttons.
- Client→host calls: `ctx.connection.rpc.call('/api', 'coros-gui/' + endpoint, payload, signal)`
  → `{ ok:true, value } | { ok:false, error }`; on `ok:false` show `error.message`.

### 5.2 UI requirements (this is the graded part)
One panel component reused by both surfaces. Layout, top to bottom:
1. **Header**: 40 px icon (inline SVG copy of our brand mark, see §6.6), title `COROS`,
   subtitle "训练数据已接入对话 / Training data in your conversations", and a status pill on the
   right: `未连接` (neutral) · `等待浏览器授权` (warning) · `已连接` (success) · `连接异常` (error).
2. **Signed-out card**: one-sentence value proposition, region selector (4 options, native
   `<select>` styled with tokens; default global), primary button `使用浏览器登录`,
   a muted line explaining "登录在浏览器完成，授权后本页自动更新".
3. **Pending card** (phase `login-pending`): spinner + "已在浏览器打开 COROS 授权页" +
   read-only URL field with `复制链接` and `重新打开` buttons + `取消登录` ghost button +
   expiry countdown text (e.g. "链接 9 分 12 秒后失效").
4. **Connected card**: rows `账号` (显示 "COROS 账号 · <region label>"), `令牌到期` (剩余天数),
   `可用工具` (n 个). Action row: `刷新工具列表`, `重新授权`, `退出登录` (danger-ghost).
5. **Tools section** (connected): search input filtering by name/description; list rows show public
   tool name (`coros_...`, monospace) + one-line description; click expands to show the JSON schema
   (pretty-printed) and the hint "对话里直接说：用 coros_xxx 查…". Empty state: "还没有拉取到工具，
   点「刷新工具列表」". Loading state: skeleton rows.
6. **Error banner** above the cards when `error`/`localError`, with a `重试` button.
7. **Footer**: small muted text `工具只在对话中可用，数据来自 COROS MCP · <storagePath>`.
- All states must be reachable from `view.getState()`; poll `state` every 1500 ms while the panel is
  mounted and phase is `login-pending` (also poll once on mount, and once 500 ms after `startLogin`).
- Buttons show a disabled/busy state while an RPC is in flight; failures surface in the error banner.
- Must be keyboard accessible (real `<button>`, `<input>`, `<select>`, Escape closes the modal,
  backdrop click closes, `aria-label`s on icon-only buttons) and must not overflow 320 px width.
- Modal: fixed inset overlay, `var(--dsw-alias-bg-mask-1)` backdrop, centered card
  `max-width: 560px`, `--dsw-radius-panel`, `--dsw-elevation-prominent`, scroll inside for tool list;
  closes on Escape/backdrop/×.

### 5.3 Text / i18n
Provide `zh` and `en` dictionaries (`zh` default). All visible strings from `t(...)`. Keep copy short
and product-like; Chinese primary labels, English secondary in `en`.

### 5.4 Client CSS
One CSS string injected once with the guard:
```js
var CSS_ID = 'dsh-coros-gui/panel.css';
if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) { …append style with dataset.pluginCss = CSS_ID… }
```
Class names prefixed `coros-`. Only the tokens from §6.5 (plus `--dsw-radius-*`, `--dsw-font-*`).
Must look right in both light and dark mode (tokens handle it) and inside Settings (max content width
~ 720 px) and in the modal.

## 6. Shared constants

### 6.1 Names
- npm package / bundle name: `dsh-coros-gui`; cordis row id: `coros-gui`; RPC namespace: `coros-gui`.
- Locale namespace: `dsh-coros-gui`.
- Public tool prefix: `coros_`.

### 6.2 Brand
Brand mark = inline SVG: rounded-square gradient (`#FF7A2F → #E13A12`) with a white open "C" arc and a
white pulse line through it (same as `icon/icon.svg`). Inline it in the client (never fetch the file).

### 6.3 Storage / state path
`\${DSH_HOME:-~/.dsh}/coros-gui/state.json` (host side).

### 6.4 Token hygiene
Never log or return access/refresh tokens, never put them in tool output, never in error messages.

### 6.5 Design tokens available
`--dsw-alias-bg-base|bg-layer-1..4|bg-mask-1|border-l1..l4|label-primary|label-secondary|label-tertiary|
label-caption|label-dimmed|label-error|label-primary-inverted|brand-primary|link|interactive-bg-hover|
interactive-bg-active|interactive-bg-hover-danger|state-success-primary|state-warn-primary|state-error-primary|
state-idle-primary|button-primary-fill|button-primary-hover|button-ghost-active-fill|button-tool-bar-fill|
markdown-inline-code`, `--dsw-radius-xs|sm|md|lg|panel`, `--dsw-elevation-soft|panel|prominent`,
`--dsw-focus-ring-color|--dsw-focus-ring-width`, `--dsw-font-family`, `--dsw-font-xs-13`,
`--dsw-shadow-lv3`, `--dsw-static-neutral-00|neutral-400`, `--dsw-static-green-500|red-600|amber-500`.

### 6.6 Deliverable checks (both halves)
- `node --check` passes on every JS file.
- No `@deepseek-ai/*` import in host files; no `require` other than `react` in `lib/client.js`.
- No `console.log` of tokens; no hard-coded hex colors in client CSS (exception: brand SVG gradient).

## 7. Verification
1. Lead runs `npm run check` (syntax).
2. Engine smoke test script (Lead) against real COROS endpoints: discovery, client registration,
   login-session creation (must return a `loginUrl`), `state` shape. No token needed.
3. Isolated DSH instance (`DSH_HOME=/tmp/dsh-coros-e2e/home`, profile `coros-min`, port 50777) with
   the plugin installed: Settings → COROS page renders, buttons call the RPC routes (check host logs),
   login URL appears, poll works, then the user completes the browser login and tools register.
4. Tools visible in conversation (agent can call `coros_status`).

## 8. Write scopes
- Host owner: `lib/coros-engine.js`, `lib/index.js`, `test/engine.test.mjs`.
- Client owner: `lib/client.js`.
- Lead: `package.json`, `cordis.patch.yml`, `locale/*.json`, `icon/*`, `README.md`, `LICENSE`,
  `.gitignore`, `docs/*`, test harness scripts.
