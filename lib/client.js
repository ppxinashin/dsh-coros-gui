/* dsh-coros-gui — browser half.
 *
 * Ships the COROS settings section, a quick-access overlay panel, a sidebar
 * footer entry, and a small conversation-header chip. The file is loaded by the
 * DSH web client through `window.__ModuleLoader__.load({ id, factory })` and may
 * only require("react") — everything else (icons, markup, styles) is inline.
 *
 * Host contract: docs/CONTRACT.md §4.3 (state), §5 (client), §6 (design).
 */
window.__ModuleLoader__.load({
	id: "dsh-coros-gui",
	factory: function (require) {
		"use strict";

		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var NS = "dsh-coros-gui";
		var CSS_ID = "dsh-coros-gui/panel.css";
		var RPC_CHANNEL = "/api";
		var RPC_PREFIX = "coros-gui/";
		var POLL_INTERVAL_MS = 1500;
		var LOGIN_SETTLE_MS = 500;

		/*
		 * Browsers only allow window.open() from a user gesture, and the login URL
		 * only arrives after the RPC resolves. Open it best-effort from the click
		 * continuation, at most once per URL, so re-renders and 1.5 s polls never
		 * spawn extra tabs. The "Open COROS authorization" anchor in the pending
		 * card is the popup-blocker-proof fallback.
		 */
		var openedLoginUrls = Object.create(null);

		function openLoginUrlOnce(url) {
			var href = typeof url === "string" ? url.trim() : "";
			if (!href || openedLoginUrls[href]) return false;
			openedLoginUrls[href] = true;
			try {
				if (typeof window !== "undefined" && typeof window.open === "function") {
					window.open(href, "_blank", "noopener,noreferrer");
					return true;
				}
			} catch (error) {
				/* popup blocked — the pending card exposes an explicit anchor */
			}
			return false;
		}

		var DEFAULT_REGION = "global";

		var DEFAULT_REGIONS = [
			{ id: "global", label: { zh: "全球", en: "Global" } },
			{ id: "cn", label: { zh: "中国大陆", en: "Mainland China" } },
			{ id: "eu", label: { zh: "欧洲", en: "Europe" } },
			{ id: "us", label: { zh: "美国", en: "United States" } }
		];

		/* ------------------------------------------------------------------ *\
		 * Dictionaries (Chinese is the primary voice, English mirrors it).
		\* ------------------------------------------------------------------ */

		var zh = {
			"settings.nav": "COROS",
			"panel.title": "COROS 接入",
			"subtitle": "训练数据已接入对话",
			"sidebar.name": "COROS",
			"sidebar.label": "打开 COROS 接入面板",
			"status.idle": "未连接",
			"status.pending": "等待浏览器授权",
			"status.connected": "已连接",
			"status.error": "连接异常",
			"action.close": "关闭",
			"action.retry": "重试",
			"loading": "正在读取 COROS 状态",
			"unavailable.title": "当前环境不可用",
			"unavailable.remote": "COROS 接入需要本机运行的 DSH Host。请通过 127.0.0.1 打开 DSH 后重试。",
			"unavailable.host": "当前 DSH Host 暂不支持 COROS 接入，请升级 DSH 后重试。",
			"error.title": "连接异常",
			"signedOut.title": "连接 COROS 账号",
			"signedOut.body": "登录后，教练可以在对话里直接查询训练记录、体能负荷、比赛与训练计划。",
			"signedOut.region": "账号区域",
			"signedOut.cta": "使用浏览器登录",
			"signedOut.ctaBusy": "正在打开浏览器…",
			"signedOut.footnote": "登录在浏览器完成，授权后本页自动更新。",
			"signedOut.errorHint": "上次授权可能已失效，请重新登录。",
			"pending.title": "等待浏览器授权",
			"pending.body": "授权页已在浏览器打开。完成登录后本页自动更新；若未打开，请点击下方按钮。",
			"pending.open": "打开 COROS 授权页",
			"pending.urlLabel": "授权链接",
			"pending.copy": "复制链接",
			"pending.copied": "已复制",
			"pending.copyFailed": "复制失败，请手动选择链接",
			"pending.reopen": "再次打开",
			"pending.cancel": "取消登录",
			"pending.expiresIn": "链接 {minutes} 分 {seconds} 秒后失效",
			"pending.expired": "链接已失效，请取消后重新发起登录",
			"connected.title": "已连接",
			"connected.body": "训练数据工具已经就绪，可以直接在对话里使用。",
			"connected.account": "账号",
			"connected.accountValue": "COROS 账号 · {region}",
			"connected.token": "令牌到期",
			"connected.tokenDays": "剩余 {days} 天",
			"connected.tokenHours": "剩余 {hours} 小时",
			"connected.tokenMinutes": "剩余 {minutes} 分钟",
			"connected.tokenExpired": "已过期",
			"connected.tools": "可用工具",
			"connected.toolsCount": "{count} 个",
			"connected.refreshTools": "刷新工具列表",
			"connected.relogin": "重新授权",
			"connected.logout": "退出登录",
			"tools.title": "可用工具",
			"tools.body": "工具只在对话中可用，无需在设置里手动调用。",
			"tools.search": "搜索工具名称或用途",
			"tools.count": "{count} 个工具",
			"tools.empty": "还没有拉取到工具，点「刷新工具列表」试试。",
			"tools.emptySearch": "没有匹配的工具，换个关键词试试。",
			"tools.hint": "对话里直接说：用 {name} 查…",
			"tools.schema": "工具定义",
			"tools.expand": "展开工具定义",
			"tools.collapse": "收起工具定义",
			"footer.note": "工具只在对话中可用，数据来自 COROS MCP",
			"misc.none": "—",
			"misc.unknown": "未知"
		};

		var en = {
			"settings.nav": "COROS",
			"panel.title": "COROS",
			"subtitle": "Training data in your conversations",
			"sidebar.name": "COROS",
			"sidebar.label": "Open the COROS panel",
			"status.idle": "Not connected",
			"status.pending": "Waiting for approval",
			"status.connected": "Connected",
			"status.error": "Connection error",
			"action.close": "Close",
			"action.retry": "Retry",
			"loading": "Reading COROS status",
			"unavailable.title": "Unavailable here",
			"unavailable.remote": "COROS needs the local DSH Host. Open DSH at 127.0.0.1 and try again.",
			"unavailable.host": "This DSH Host does not support COROS yet. Update DSH and try again.",
			"error.title": "Connection error",
			"signedOut.title": "Connect your COROS account",
			"signedOut.body": "Once connected, your coach can query workouts, training load, races, and plans right in the conversation.",
			"signedOut.region": "Account region",
			"signedOut.cta": "Sign in with browser",
			"signedOut.ctaBusy": "Opening browser…",
			"signedOut.footnote": "Sign-in happens in your browser. This page updates automatically.",
			"signedOut.errorHint": "The previous authorization may have expired. Please sign in again.",
			"pending.title": "Waiting for approval",
			"pending.body": "The authorization page opened in your browser. This panel refreshes after you sign in; use the button below if it did not open.",
			"pending.open": "Open COROS authorization page",
			"pending.urlLabel": "Authorization link",
			"pending.copy": "Copy link",
			"pending.copied": "Copied",
			"pending.copyFailed": "Copy failed — select the link manually",
			"pending.reopen": "Open again",
			"pending.cancel": "Cancel sign-in",
			"pending.expiresIn": "Link expires in {minutes}m {seconds}s",
			"pending.expired": "This link has expired. Cancel and start sign-in again.",
			"connected.title": "Connected",
			"connected.body": "Training tools are ready. Use them directly in the conversation.",
			"connected.account": "Account",
			"connected.accountValue": "COROS account · {region}",
			"connected.token": "Token expires",
			"connected.tokenDays": "{days} days left",
			"connected.tokenHours": "{hours} hours left",
			"connected.tokenMinutes": "{minutes} minutes left",
			"connected.tokenExpired": "Expired",
			"connected.tools": "Tools",
			"connected.toolsCount": "{count}",
			"connected.refreshTools": "Refresh tools",
			"connected.relogin": "Re-authorize",
			"connected.logout": "Sign out",
			"tools.title": "Available tools",
			"tools.body": "Tools are used in conversations, not from this panel.",
			"tools.search": "Search tool name or purpose",
			"tools.count": "{count} tools",
			"tools.empty": "No tools yet. Try “Refresh tools”.",
			"tools.emptySearch": "No matching tools. Try another keyword.",
			"tools.hint": "In the conversation, just say: use {name} to…",
			"tools.schema": "Tool definition",
			"tools.expand": "Expand tool definition",
			"tools.collapse": "Collapse tool definition",
			"footer.note": "Tools work in conversations only · Data from COROS MCP",
			"misc.none": "—",
			"misc.unknown": "Unknown"
		};

		/* ------------------------------------------------------------------ *\
		 * Small utilities.
		\* ------------------------------------------------------------------ */

		function fallbackT(key) {
			return zh[key] !== undefined ? zh[key] : key;
		}

		function useT(props) {
			return props && typeof props.t === "function" ? props.t : fallbackT;
		}

		function fill(template, params) {
			if (typeof template !== "string") return "";
			return template.replace(/\{(\w+)\}/g, function (match, key) {
				return params && params[key] !== undefined ? String(params[key]) : match;
			});
		}

		function tr(t, key, params) {
			return fill(t(key), params);
		}

		function toEpoch(value) {
			if (typeof value === "number" && isFinite(value)) return value;
			if (typeof value === "string") {
				var parsed = Date.parse(value);
				return isNaN(parsed) ? null : parsed;
			}
			return null;
		}

		function formatTokenRemaining(remainingMs, t) {
			if (remainingMs === null || remainingMs === undefined || !isFinite(remainingMs)) return t("misc.none");
			if (remainingMs <= 0) return t("connected.tokenExpired");
			var days = Math.floor(remainingMs / 86400000);
			if (days >= 1) return tr(t, "connected.tokenDays", { days: days });
			var hours = Math.floor(remainingMs / 3600000);
			if (hours >= 1) return tr(t, "connected.tokenHours", { hours: hours });
			var minutes = Math.max(1, Math.ceil(remainingMs / 60000));
			return tr(t, "connected.tokenMinutes", { minutes: minutes });
		}

		function formatCountdown(remainingMs, t) {
			if (remainingMs === null || remainingMs === undefined || !isFinite(remainingMs) || remainingMs <= 0) {
				return t("pending.expired");
			}
			var totalSeconds = Math.floor(remainingMs / 1000);
			var minutes = Math.floor(totalSeconds / 60);
			var seconds = totalSeconds % 60;
			return tr(t, "pending.expiresIn", { minutes: minutes, seconds: seconds < 10 ? "0" + seconds : seconds });
		}

		function safeString(value) {
			return typeof value === "string" ? value : "";
		}

		function toLocalError(error) {
			var code = error && error.code ? String(error.code) : "rpc-failed";
			var message = error && error.message ? String(error.message) : "RPC failed";
			return { code: code, message: message, at: Date.now() };
		}

		function legacyCopy(text) {
			try {
				var area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				var copied = document.execCommand("copy");
				document.body.removeChild(area);
				return !!copied;
			} catch (error) {
				return false;
			}
		}

		function detectLanguage(ctx) {
			try {
				var locale = ctx && ctx.locale;
				if (!locale) return "zh";
				var snapshot = typeof locale.getLocale === "function" ? locale.getLocale() : null;
				var active = snapshot && (snapshot.active || snapshot.locale || snapshot.language);
				var id = typeof active === "string" ? active : active && (active.id || active.locale || active.language);
				if (typeof id === "string" && /^en\b/i.test(id)) return "en";
				if (typeof id === "string" && /^zh\b/i.test(id)) return "zh";
			} catch (error) {
				/* locale snapshot is best-effort */
			}
			return "zh";
		}

		function createTranslator(ctx) {
			var bound = null;
			try {
				if (ctx && ctx.locale && typeof ctx.locale.bind === "function") bound = ctx.locale.bind(NS);
			} catch (error) {
				bound = null;
			}
			var dict = detectLanguage(ctx) === "en" ? en : zh;
			return function translate(key) {
				if (typeof bound === "function") {
					try {
						var value = bound(key);
						if (typeof value === "string" && value !== key) return value;
					} catch (error) {
						/* fall back to the bundled dictionary */
					}
				}
				return dict[key] !== undefined ? dict[key] : key;
			};
		}

		/* ------------------------------------------------------------------ *\
		 * Icons. Stroke-based, 24×24, inherit currentColor.
		\* ------------------------------------------------------------------ */

		function icon(size, children, className) {
			return h(
				"svg",
				{
					width: size || 16,
					height: size || 16,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.8,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					focusable: "false",
					className: className
				},
				children
			);
		}

		function IconCopy(props) {
			return icon((props && props.size) || 16, [
				h("rect", { key: "r", x: 8, y: 8, width: 13, height: 13, rx: 2.2 }),
				h("path", {
					key: "p",
					d: "M16 8V5.8A2.8 2.8 0 0 0 13.2 3H5.8A2.8 2.8 0 0 0 3 5.8v7.4A2.8 2.8 0 0 0 5.8 16H8"
				})
			]);
		}

		function IconExternal(props) {
			return icon((props && props.size) || 16, [
				h("path", { key: "a", d: "M14 4h6v6" }),
				h("path", { key: "b", d: "M20 4l-9 9" }),
				h("path", { key: "c", d: "M19 14v4.2A2.8 2.8 0 0 1 16.2 21H4.8A2.8 2.8 0 0 1 2 18.2V6.8A2.8 2.8 0 0 1 4.8 4H9" })
			]);
		}

		function IconRefresh(props) {
			return icon((props && props.size) || 16, [
				h("path", { key: "a", d: "M20.5 12a8.5 8.5 0 1 1-2.5-6.02" }),
				h("path", { key: "b", d: "M20.5 3.5V9H15" })
			]);
		}

		function IconLogout(props) {
			return icon((props && props.size) || 16, [
				h("path", { key: "a", d: "M9.5 20.5H5.8A2.3 2.3 0 0 1 3.5 18.2V5.8a2.3 2.3 0 0 1 2.3-2.3h3.7" }),
				h("path", { key: "b", d: "M16 16.5l4.5-4.5L16 7.5" }),
				h("path", { key: "c", d: "M20.5 12H9" })
			]);
		}

		function IconClose(props) {
			return icon((props && props.size) || 16, [
				h("path", { key: "a", d: "M6 6l12 12" }),
				h("path", { key: "b", d: "M18 6L6 18" })
			]);
		}

		function IconSearch(props) {
			return icon((props && props.size) || 16, [
				h("circle", { key: "c", cx: 11, cy: 11, r: 6.5 }),
				h("path", { key: "p", d: "M20.5 20.5l-4.2-4.2" })
			]);
		}

		function IconChevron(props) {
			return icon((props && props.size) || 16, [h("path", { key: "p", d: "M9.5 6l6 6-6 6" })]);
		}

		function IconAlert(props) {
			return icon((props && props.size) || 16, [
				h("circle", { key: "c", cx: 12, cy: 12, r: 8.8 }),
				h("path", { key: "l", d: "M12 7.6v5.2" }),
				h("path", { key: "d", d: "M12 16.4h.01" })
			]);
		}

		function IconCheck(props) {
			return icon((props && props.size) || 16, [h("path", { key: "p", d: "M4.5 12.5l4.6 4.6L19.5 6.8" })]);
		}

		function IconPulse(props) {
			return icon((props && props.size) || 18, [
				h("path", { key: "p", d: "M2.5 12h4l2.4-5.6 4 13 2.6-7.4H21.5" })
			]);
		}

		function IconLink(props) {
			return icon((props && props.size) || 16, [
				h("path", { key: "a", d: "M10.6 13.4a4.6 4.6 0 0 0 6.5 0l2.8-2.8a4.6 4.6 0 0 0-6.5-6.5l-1.6 1.6" }),
				h("path", { key: "b", d: "M13.4 10.6a4.6 4.6 0 0 0-6.5 0l-2.8 2.8a4.6 4.6 0 0 0 6.5 6.5l1.6-1.6" })
			]);
		}

		/** The COROS mark: gradient rounded square, open "C" arc, pulse line. */
		function BrandMark(props) {
			var size = (props && props.size) || 40;
			var generated = typeof React.useId === "function" ? React.useId() : "coros";
			var gradientId = "corosGrad-" + String(generated).replace(/[^a-zA-Z0-9_-]/g, "");
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 64 64",
					fill: "none",
					role: "img",
					"aria-label": "COROS",
					focusable: "false"
				},
				[
					h("defs", { key: "defs" }, [
						h(
							"linearGradient",
							{ key: "g", id: gradientId, x1: 8, y1: 6, x2: 56, y2: 58, gradientUnits: "userSpaceOnUse" },
							[
								h("stop", { key: "a", stopColor: "#FF7A2F" }),
								h("stop", { key: "b", offset: 1, stopColor: "#E13A12" })
							]
						)
					]),
					h("rect", { key: "bg", x: 1, y: 1, width: 62, height: 62, rx: 16, fill: "url(#" + gradientId + ")" }),
					h("rect", {
						key: "ring",
						x: 1.75,
						y: 1.75,
						width: 60.5,
						height: 60.5,
						rx: 15.25,
						stroke: "#FFFFFF",
						strokeOpacity: 0.22,
						strokeWidth: 1.5
					}),
					h("path", {
						key: "arc",
						d: "M45.5 22.5A16 16 0 1 0 45.5 41.5",
						stroke: "#FFFFFF",
						strokeWidth: 4.25,
						strokeLinecap: "round"
					}),
					h("path", {
						key: "pulse",
						d: "M17 32h7.4l2.9-6.2 4.6 12.9 3.3-6.7h11.8",
						stroke: "#FFFFFF",
						strokeWidth: 3.1,
						strokeLinecap: "round",
						strokeLinejoin: "round"
					})
				]
			);
		}

		/* ------------------------------------------------------------------ *\
		 * View store: one face per plugin instance, shared by every surface.
		\* ------------------------------------------------------------------ */

		function createView(ctx) {
			var connection = null;
			try {
				connection = ctx && typeof ctx.get === "function" ? ctx.get("connection") : ctx && ctx.connection;
			} catch (error) {
				connection = null;
			}

			var rpc = connection && connection.rpc && typeof connection.rpc.call === "function" ? connection.rpc : null;
			var loopback = !connection || connection.isLoopback !== false;

			var hostState = null;
			var loading = true;
			var localError = null;
			var open = false;
			var busy = null;
			var regionOverride = null;
			var pollInFlight = null;
			var listeners = [];
			var disposed = false;

			function baseState() {
				if (hostState) return hostState;
				return {
					phase: "signed-out",
					available: true,
					region: DEFAULT_REGION,
					regions: DEFAULT_REGIONS,
					issuer: null,
					mcpUrl: null,
					connected: false,
					tokenExpiresAt: null,
					tokenExpiresInMs: null,
					login: null,
					tools: [],
					toolsFetchedAt: null,
					error: null,
					storagePath: null
				};
			}

			function isAvailable() {
				if (!loopback) return false;
				if (!rpc) return false;
				if (hostState && hostState.available === false) return false;
				return true;
			}

			function compose() {
				var base = baseState();
				var snapshot = {};
				for (var key in base) {
					if (Object.prototype.hasOwnProperty.call(base, key)) snapshot[key] = base[key];
				}
				snapshot.phase = base.phase || "signed-out";
				snapshot.loading = loading;
				snapshot.loaded = hostState !== null;
				snapshot.localError = localError;
				snapshot.open = open;
				snapshot.busy = busy;
				snapshot.available = isAvailable();
				snapshot.loopback = loopback;
				snapshot.hasRpc = rpc !== null;
				if (regionOverride) snapshot.region = regionOverride;
				return snapshot;
			}

			var snapshot = compose();

			function emit() {
				if (disposed) return;
				snapshot = compose();
				for (var index = 0; index < listeners.length; index += 1) {
					try {
						listeners[index]();
					} catch (error) {
						/* a broken subscriber must not break the store */
					}
				}
			}

			function commit(value) {
				if (value && value.state && typeof value.state === "object") {
					hostState = value.state;
				}
				loading = false;
				localError = null;
			}

			function callRpc(endpoint, payload) {
				if (!rpc) return Promise.reject(new Error("connection RPC unavailable"));
				return Promise.resolve()
					.then(function () {
						return rpc.call(RPC_CHANNEL, RPC_PREFIX + endpoint, payload || {});
					})
					.then(function (result) {
						if (result && result.ok === true) return result.value;
						var error = result && result.error;
						var failure = new Error((error && (error.message || error.code)) || "RPC failed");
						failure.code = error && error.code ? String(error.code) : "rpc-failed";
						throw failure;
					});
			}

			function load(options) {
				var quiet = options === true || (options && options.quiet === true);
				if (disposed) return Promise.resolve(null);
				if (!rpc) {
					loading = false;
					if (!quiet) localError = { code: "rpc-unavailable", message: "connection RPC unavailable", at: Date.now() };
					emit();
					return Promise.resolve(null);
				}
				if (!hostState) {
					loading = true;
					emit();
				}
				return callRpc("state", {}).then(
					function (value) {
						commit(value);
						emit();
						return value;
					},
					function (error) {
						loading = false;
						if (!quiet) localError = toLocalError(error);
						emit();
						return null;
					}
				);
			}

			function poll() {
				if (disposed) return Promise.resolve(null);
				if (pollInFlight) return pollInFlight;
				if (!rpc) return Promise.resolve(null);
				var request = callRpc("state", {}).then(
					function (value) {
						commit(value);
						emit();
						return value;
					},
					function () {
						return null;
					}
				);
				pollInFlight = request;
				request.then(
					function () {
						pollInFlight = null;
					},
					function () {
						pollInFlight = null;
					}
				);
				return request;
			}

			function runAction(kind, endpoint, payload) {
				if (disposed || !rpc || busy) return Promise.resolve(null);
				busy = kind;
				localError = null;
				emit();
				return callRpc(endpoint, payload || {}).then(
					function (value) {
						commit(value);
						busy = null;
						emit();
						return value;
					},
					function (error) {
						busy = null;
						localError = toLocalError(error);
						emit();
						return null;
					}
				);
			}

			function startLogin(region) {
				var payload = {};
				var target = region || (hostState && hostState.region) || regionOverride || DEFAULT_REGION;
				if (target) payload.region = target;
				var task = runAction("login", "loginStart", payload);
				task.then(function (value) {
					if (!value) return;
					openLoginUrlOnce(hostState && hostState.login ? hostState.login.url : null);
					setTimeout(function () {
						load({ quiet: true });
					}, LOGIN_SETTLE_MS);
				});
				return task;
			}

			var view = {
				getState: function getState() {
					return snapshot;
				},
				subscribe: function subscribe(listener) {
					if (typeof listener !== "function") return function () {};
					listeners.push(listener);
					return function unsubscribe() {
						var index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				},
				load: function exposeLoad(options) {
					return load(options);
				},
				poll: poll,
				retry: function retry() {
					localError = null;
					emit();
					return load();
				},
				startLogin: startLogin,
				cancelLogin: function cancelLogin() {
					return runAction("cancel", "loginCancel", {});
				},
				logout: function logout() {
					return runAction("logout", "logout", {});
				},
				refreshTools: function refreshTools() {
					return runAction("tools", "toolsRefresh", {});
				},
				setRegion: function setRegion(region) {
					if (disposed || !rpc || busy || !region) return Promise.resolve(null);
					var previous = regionOverride;
					regionOverride = region;
					busy = "region";
					emit();
					return callRpc("setRegion", { region: region }).then(
						function (value) {
							commit(value);
							regionOverride = null;
							busy = null;
							emit();
							return value;
						},
						function (error) {
							regionOverride = previous;
							busy = null;
							localError = toLocalError(error);
							emit();
							return null;
						}
					);
				},
				setOpen: function setOpen(next) {
					var value = next !== false;
					if (open === value) return;
					open = value;
					emit();
					if (value) load({ quiet: true });
				},
				resolveText: function resolveText(text) {
					if (typeof text === "string") return text;
					try {
						if (ctx && ctx.locale && typeof ctx.locale.resolveText === "function") {
							var resolved = ctx.locale.resolveText(text);
							if (typeof resolved === "string") return resolved;
						}
					} catch (error) {
						/* fall through to the bundled default */
					}
					if (text && typeof text.zh === "string") return text.zh;
					if (text && typeof text.en === "string") return text.en;
					return "";
				},
				destroy: function destroy() {
					disposed = true;
					listeners = [];
				}
			};

			Object.defineProperty(view, "open", {
				enumerable: true,
				get: function getOpen() {
					return open;
				}
			});

			Object.defineProperty(view, "available", {
				enumerable: true,
				get: function getAvailable() {
					return isAvailable();
				}
			});

			return view;
		}

		/* ------------------------------------------------------------------ *\
		 * React helpers.
		\* ------------------------------------------------------------------ */

		/** Subscribe a component to the shared view snapshot. */
		function useViewState(view) {
			if (typeof React.useSyncExternalStore === "function") {
				return React.useSyncExternalStore(view.subscribe, view.getState, view.getState);
			}
			var pair = React.useState(view.getState());
			var setSnapshot = pair[1];
			React.useEffect(
				function () {
					return view.subscribe(function () {
						setSnapshot(view.getState());
					});
				},
				[view]
			);
			return pair[0];
		}

		/** A once-a-second clock, used by countdowns and relative token expiry. */
		function useNow(active) {
			var pair = React.useState(Date.now());
			var setNow = pair[1];
			var ticking = active !== false;
			React.useEffect(
				function () {
					if (!ticking) return undefined;
					var timer = setInterval(function () {
						setNow(Date.now());
					}, 1000);
					return function () {
						clearInterval(timer);
					};
				},
				[ticking]
			);
			return pair[0];
		}

		/** Clipboard copy with a legacy fallback for insecure contexts. */
		function useCopy(text) {
			var pair = React.useState("idle");
			var status = pair[0];
			var setStatus = pair[1];
			var timer = React.useRef(null);
			React.useEffect(function () {
				return function () {
					if (timer.current) clearTimeout(timer.current);
				};
			}, []);
			function mark(next) {
				setStatus(next);
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(function () {
					setStatus("idle");
				}, 1800);
			}
			function copy() {
				var value = safeString(text);
				if (!value) {
					mark("fail");
					return;
				}
				try {
					if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
						navigator.clipboard.writeText(value).then(
							function () {
								mark("ok");
							},
							function () {
								mark(legacyCopy(value) ? "ok" : "fail");
							}
						);
						return;
					}
				} catch (error) {
					/* fall through to the legacy path */
				}
				mark(legacyCopy(value) ? "ok" : "fail");
			}
			return { status: status, copy: copy };
		}

		/* ------------------------------------------------------------------ *\
		 * Presentation helpers.
		\* ------------------------------------------------------------------ */

		function statusTone(state) {
			var phase = state && state.phase ? state.phase : "signed-out";
			if (phase === "login-pending") return "warn";
			if (phase === "signed-in") return state.connected === false ? "error" : "success";
			if (phase === "error") return "error";
			return "idle";
		}

		function statusLabel(t, state) {
			var tone = statusTone(state);
			if (tone === "warn") return t("status.pending");
			if (tone === "success") return t("status.connected");
			if (tone === "error") return t("status.error");
			return t("status.idle");
		}

		function regionsOf(state) {
			if (state && Array.isArray(state.regions) && state.regions.length > 0) return state.regions;
			return DEFAULT_REGIONS;
		}

		function findRegion(state, id) {
			var list = regionsOf(state);
			for (var index = 0; index < list.length; index += 1) {
				if (list[index] && list[index].id === id) return list[index];
			}
			return null;
		}

		function regionLabel(view, state, id) {
			var region = findRegion(state, id);
			if (!region) return id || view.resolveText({ zh: "未知", en: "Unknown" });
			return view.resolveText(region.label);
		}

		function toolNameOf(tool) {
			if (!tool) return "";
			return safeString(tool.toolName) || safeString(tool.name) || safeString(tool.id);
		}

		function toolSchemaText(tool) {
			var schema = tool && (tool.inputSchema || tool.input_schema || tool.schema || tool.parameters);
			var payload = schema || {
				toolName: toolNameOf(tool),
				mcpName: safeString(tool && tool.mcpName),
				description: safeString(tool && tool.description)
			};
			try {
				return JSON.stringify(payload, null, 2);
			} catch (error) {
				return "";
			}
		}

		/* ------------------------------------------------------------------ *\
		 * Small shared UI atoms.
		\* ------------------------------------------------------------------ */

		function SkeletonRows(props) {
			var count = props && props.rows ? props.rows : 3;
			var rows = [];
			for (var index = 0; index < count; index += 1) {
				rows.push(
					h("div", { key: index, className: "coros-skeletonRow" }, [
						h("span", { key: "title", className: "coros-skeletonBar coros-skeletonBar--title" }),
						h("span", { key: "body", className: "coros-skeletonBar coros-skeletonBar--body" })
					])
				);
			}
			return h("div", { className: "coros-skeleton", "aria-hidden": "true" }, rows);
		}

		function StatusPill(props) {
			var tone = statusTone(props.state);
			return h("span", { className: "coros-pill", "data-tone": tone }, [
				h("span", { key: "dot", className: "coros-dot", "data-tone": tone }),
				h("span", { key: "label", className: "coros-pillLabel" }, statusLabel(props.t, props.state))
			]);
		}

		function actionButton(key, className, label, options) {
			var opts = options || {};
			var children = [];
			if (opts.busy) {
				children.push(h("span", { key: "spinner", className: "coros-spinner coros-spinner--sm", "aria-hidden": "true" }));
			}
			children.push(h("span", { key: "label" }, label));
			return h(
				"button",
				{
					key: key,
					type: "button",
					className: className,
					disabled: !!opts.disabled || !!opts.busy,
					onClick: opts.onClick,
					"aria-busy": opts.busy ? "true" : undefined
				},
				children
			);
		}

		function PanelHead(props) {
			var state = props.state;
			var t = props.t;
			var brandSize = props.brandSize || 40;
			return h("header", { className: "coros-head" }, [
				h("span", { key: "brand", className: "coros-headBrand" }, h(BrandMark, { size: brandSize })),
				h("span", { key: "meta", className: "coros-headMeta" }, [
					h("span", { key: "top", className: "coros-headTop" }, [
						h("h2", { key: "title", className: "coros-title" }, "COROS"),
						h(StatusPill, { key: "pill", state: state, t: t })
					]),
					h("p", { key: "sub", className: "coros-sub" }, t("subtitle"))
				]),
				props.onClose
					? h(
							"button",
							{
								key: "close",
								type: "button",
								className: "coros-iconBtn coros-close",
								onClick: props.onClose,
								"aria-label": t("action.close"),
								title: t("action.close")
							},
							h(IconClose, { size: 16 })
						)
					: null
			]);
		}

		function ErrorBanner(props) {
			var state = props.state;
			var t = props.t;
			var message = "";
			if (state.localError && state.localError.message) message = state.localError.message;
			else if (state.error && state.error.message) message = state.error.message;
			if (!message) return null;
			return h("div", { className: "coros-banner", role: "alert" }, [
				h("span", { key: "icon", className: "coros-bannerIcon" }, h(IconAlert, { size: 16 })),
				h("div", { key: "body", className: "coros-bannerBody" }, [
					h("strong", { key: "title", className: "coros-bannerTitle" }, t("error.title")),
					h("p", { key: "message", className: "coros-bannerText" }, message)
				]),
				actionButton("retry", "coros-btn coros-btn--outline coros-btn--sm", t("action.retry"), {
					busy: state.busy === "state",
					disabled: !!state.busy,
					onClick: function () {
						props.onRetry();
					}
				})
			]);
		}

		function UnavailableCard(props) {
			var state = props.state;
			var t = props.t;
			var message = state.loopback === false ? t("unavailable.remote") : t("unavailable.host");
			return h("section", { className: "coros-card" }, [
				h("h3", { key: "title", className: "coros-cardTitle" }, t("unavailable.title")),
				h("p", { key: "body", className: "coros-cardText" }, message)
			]);
		}

		function LoadingCard(props) {
			return h("section", { className: "coros-card", "aria-busy": "true" }, [
				h("span", { key: "title", className: "coros-srOnly" }, props.t("loading")),
				h(SkeletonRows, { key: "rows", rows: 2 })
			]);
		}

		/* ------------------------------------------------------------------ *\
		 * Cards.
		\* ------------------------------------------------------------------ */

		function SignedOutCard(props) {
			var state = props.state;
			var view = props.view;
			var t = props.t;
			var busy = state.busy === "login";
			var phaseError = state.phase === "error";
			var regions = regionsOf(state);
			var currentRegion = state.region || DEFAULT_REGION;

			var options = regions.map(function (region) {
				return h("option", { key: region.id, value: region.id }, view.resolveText(region.label));
			});

			return h("section", { className: "coros-card" }, [
				h("div", { key: "intro", className: "coros-intro" }, [
					h("span", { key: "icon", className: "coros-introIcon" }, h(IconPulse, { size: 18 })),
					h("div", { key: "text", className: "coros-introText" }, [
						h("h3", { key: "title", className: "coros-cardTitle" }, t("signedOut.title")),
						h("p", { key: "body", className: "coros-cardText" }, t("signedOut.body"))
					])
				]),
				phaseError ? h("p", { key: "hint", className: "coros-inlineNote" }, t("signedOut.errorHint")) : null,
				h("div", { key: "form", className: "coros-form" }, [
					h("label", { key: "region", className: "coros-field" }, [
						h("span", { key: "label", className: "coros-label" }, t("signedOut.region")),
						h(
							"select",
							{
								key: "select",
								className: "coros-select",
								value: currentRegion,
								disabled: !!state.busy,
								"aria-label": t("signedOut.region"),
								onChange: function (event) {
									view.setRegion(event.target.value);
								}
							},
							options
						)
					]),
					h("div", { key: "cta", className: "coros-formCta" }, [
						actionButton(
							"login",
							"coros-btn coros-btn--primary coros-btn--lg",
							busy ? t("signedOut.ctaBusy") : t("signedOut.cta"),
							{
								busy: busy,
								disabled: !!state.busy || state.available === false,
								onClick: function () {
									view.startLogin();
								}
							}
						)
					])
				]),
				h("p", { key: "footnote", className: "coros-hint" }, t("signedOut.footnote"))
			]);
		}

		function PendingCard(props) {
			var state = props.state;
			var view = props.view;
			var t = props.t;
			var login = state.login && typeof state.login === "object" ? state.login : {};
			var url = safeString(login.url);
			var now = useNow(true);
			var clipboard = useCopy(url);
			var expiresAt = toEpoch(login.expiresAt);
			var remaining = expiresAt === null ? null : expiresAt - now;
			var expired = remaining !== null && remaining <= 0;
			var reopening = state.busy === "cancel";

			function reopen() {
				if (!url) return;
				try {
					if (typeof window !== "undefined" && typeof window.open === "function") {
						window.open(url, "_blank", "noopener,noreferrer");
					}
				} catch (error) {
					/* popup blocked — the copy action remains available */
				}
			}

			var copyLabel = clipboard.status === "ok" ? t("pending.copied") : t("pending.copy");
			var openHref = url || undefined;

			return h("section", { className: "coros-card" }, [
				h("div", { key: "head", className: "coros-pendingHead" }, [
					h("span", { key: "spinner", className: "coros-pendingIcon" }, h("span", { className: "coros-spinner" })),
					h("div", { key: "text", className: "coros-introText" }, [
						h("h3", { key: "title", className: "coros-cardTitle" }, t("pending.title")),
						h("p", { key: "body", className: "coros-cardText" }, t("pending.body"))
					])
				]),
				h(
					"a",
					{
						key: "open",
						href: openHref,
						target: "_blank",
						rel: "noopener noreferrer",
						className: "coros-btn coros-btn--primary coros-btn--lg coros-btn--link",
						"aria-disabled": openHref ? undefined : "true"
					},
					[
						h("span", { key: "icon", className: "coros-btnIcon" }, h(IconExternal, { size: 15 })),
						h("span", { key: "label" }, t("pending.open"))
					]
				),
				h("div", { key: "url", className: "coros-urlRow" }, [
					h("label", { key: "label", className: "coros-srOnly", htmlFor: "coros-login-url" }, t("pending.urlLabel")),
					h("input", {
						key: "input",
						id: "coros-login-url",
						className: "coros-urlInput",
						type: "text",
						value: url,
						readOnly: true,
						spellCheck: false,
						onFocus: function (event) {
							event.target.select();
						}
					}),
					h(
						"button",
						{
							key: "copy",
							type: "button",
							className: "coros-btn coros-btn--outline coros-btn--sm",
							onClick: clipboard.copy,
							"aria-label": t("pending.copy")
						},
						[
							h(
								"span",
								{ key: "icon", className: "coros-btnIcon" },
								clipboard.status === "ok" ? h(IconCheck, { size: 14 }) : h(IconCopy, { size: 14 })
							),
							h("span", { key: "label" }, copyLabel)
						]
					),
					actionButton("reopen", "coros-btn coros-btn--ghost coros-btn--sm", t("pending.reopen"), {
						onClick: reopen,
						disabled: !url
					})
				]),
				h("p", { key: "countdown", className: "coros-countdown", "data-tone": expired ? "error" : "idle" }, [
					h("span", { key: "icon", className: "coros-btnIcon" }, h(IconLink, { size: 14 })),
					h("span", { key: "text" }, formatCountdown(remaining, t))
				]),
				clipboard.status === "fail"
					? h("p", { key: "copy-error", className: "coros-inlineNote", role: "status" }, t("pending.copyFailed"))
					: null,
				h("div", { key: "actions", className: "coros-actions" }, [
					actionButton("cancel", "coros-btn coros-btn--ghost", t("pending.cancel"), {
						busy: reopening,
						disabled: !!state.busy,
						onClick: function () {
							view.cancelLogin();
						}
					})
				])
			]);
		}

		function ConnectedCard(props) {
			var state = props.state;
			var view = props.view;
			var t = props.t;
			var now = useNow(true);
			var expiresAt = toEpoch(state.tokenExpiresAt);
			var remaining = expiresAt !== null ? expiresAt - now : typeof state.tokenExpiresInMs === "number" ? state.tokenExpiresInMs : null;
			var tools = Array.isArray(state.tools) ? state.tools : [];
			var expired = remaining !== null && remaining <= 0;
			var region = regionLabel(view, state, state.region);

			function fact(key, label, value, tone) {
				return h("div", { key: key, className: "coros-fact" }, [
					h("dt", { key: "label" }, label),
					h("dd", { key: "value", "data-tone": tone || undefined }, value)
				]);
			}

			return h("section", { className: "coros-card" }, [
				h("div", { key: "head", className: "coros-cardHead" }, [
					h("div", { key: "text", className: "coros-introText" }, [
						h("h3", { key: "title", className: "coros-cardTitle" }, t("connected.title")),
						h("p", { key: "body", className: "coros-cardText" }, t("connected.body"))
					]),
					h("span", { key: "badge", className: "coros-badge" }, "COROS")
				]),
				h("dl", { key: "facts", className: "coros-facts" }, [
					fact("account", t("connected.account"), fill(t("connected.accountValue"), { region: region })),
					fact("token", t("connected.token"), formatTokenRemaining(remaining, t), expired ? "error" : undefined),
					fact("tools", t("connected.tools"), fill(t("connected.toolsCount"), { count: tools.length }))
				]),
				h("div", { key: "actions", className: "coros-actions" }, [
					actionButton("refresh", "coros-btn coros-btn--outline", t("connected.refreshTools"), {
						busy: state.busy === "tools",
						disabled: !!state.busy,
						onClick: function () {
							view.refreshTools();
						}
					}),
					actionButton("relogin", "coros-btn coros-btn--ghost", t("connected.relogin"), {
						busy: state.busy === "login",
						disabled: !!state.busy,
						onClick: function () {
							view.startLogin();
						}
					}),
					actionButton("logout", "coros-btn coros-btn--ghost coros-btn--danger", t("connected.logout"), {
						busy: state.busy === "logout",
						disabled: !!state.busy,
						onClick: function () {
							view.logout();
						}
					})
				])
			]);
		}

		function ToolsSection(props) {
			var state = props.state;
			var view = props.view;
			var t = props.t;
			var queryPair = React.useState("");
			var query = queryPair[0];
			var setQuery = queryPair[1];
			var expandedPair = React.useState(null);
			var expanded = expandedPair[0];
			var setExpanded = expandedPair[1];

			var tools = Array.isArray(state.tools) ? state.tools : [];
			var loadingTools = state.busy === "tools";
			var needle = query.trim().toLowerCase();
			var filtered = !needle
				? tools
				: tools.filter(function (tool) {
						var name = toolNameOf(tool).toLowerCase();
						var description = safeString(tool && tool.description).toLowerCase();
						var mcp = safeString(tool && tool.mcpName).toLowerCase();
						return name.indexOf(needle) >= 0 || description.indexOf(needle) >= 0 || mcp.indexOf(needle) >= 0;
					});

			function toggle(index) {
				setExpanded(expanded === index ? null : index);
			}

			var rows = [];
			for (var index = 0; index < filtered.length; index += 1) {
				var tool = filtered[index] || {};
				var name = toolNameOf(tool);
				var description = safeString(tool && tool.description);
				var isOpen = expanded === index;
				var detailId = "coros-tool-detail-" + index;
				rows.push(
					h("div", { key: name + "-" + index, className: "coros-toolItem" }, [
						h(
							"button",
							{
								key: "row",
								type: "button",
								className: "coros-toolRow",
								"aria-expanded": isOpen ? "true" : "false",
								"aria-controls": detailId,
								title: isOpen ? t("tools.collapse") : t("tools.expand"),
								onClick: (function (position) {
									return function () {
										toggle(position);
									};
								})(index)
							},
							[
								h("span", { key: "main", className: "coros-toolMain" }, [
									h("span", { key: "name", className: "coros-toolName" }, name),
									description ? h("span", { key: "desc", className: "coros-toolDesc" }, description) : null
								]),
								h("span", { key: "chevron", className: "coros-toolChevron" }, h(IconChevron, { size: 14 }))
							]
						),
						isOpen
							? h("div", { key: "detail", id: detailId, className: "coros-toolDetail" }, [
									h("span", { key: "label", className: "coros-toolDetailLabel" }, t("tools.schema")),
									h("pre", { key: "code", className: "coros-code" }, toolSchemaText(tool)),
									h("p", { key: "hint", className: "coros-toolHint" }, fill(t("tools.hint"), { name: name }))
								])
							: null
					])
				);
			}

			var body;
			if (loadingTools && tools.length === 0) {
				body = h(SkeletonRows, { key: "skeleton", rows: 3 });
			} else if (filtered.length === 0) {
				body = h("div", { key: "empty", className: "coros-empty" }, [
					h("p", { key: "text", className: "coros-emptyText" }, needle ? t("tools.emptySearch") : t("tools.empty")),
					needle
						? null
						: actionButton("refresh", "coros-btn coros-btn--outline coros-btn--sm", t("connected.refreshTools"), {
								busy: loadingTools,
								disabled: !!state.busy,
								onClick: function () {
									view.refreshTools();
								}
							})
				]);
			} else {
				body = h("div", { key: "list", className: "coros-toolList", id: "coros-tool-list" }, rows);
			}

			return h("section", { className: "coros-card coros-tools" }, [
				h("div", { key: "head", className: "coros-cardHead" }, [
					h("div", { key: "text", className: "coros-introText" }, [
						h("h3", { key: "title", className: "coros-cardTitle" }, t("tools.title")),
						h("p", { key: "body", className: "coros-cardText" }, t("tools.body"))
					]),
					loadingTools
						? h("span", { key: "busy", className: "coros-count coros-count--busy" }, h("span", { className: "coros-spinner coros-spinner--xs" }))
						: h("span", { key: "count", className: "coros-count" }, fill(t("tools.count"), { count: tools.length }))
				]),
				tools.length > 0
					? h("div", { key: "search", className: "coros-searchField" }, [
							h("span", { key: "icon", className: "coros-searchIcon" }, h(IconSearch, { size: 14 })),
							h("input", {
								key: "input",
								className: "coros-input coros-search",
								type: "search",
								value: query,
								placeholder: t("tools.search"),
								"aria-label": t("tools.search"),
								spellCheck: false,
								onChange: function (event) {
									setQuery(event.target.value);
								}
							})
						])
					: null,
				body
			]);
		}

		function PanelFooter(props) {
			var state = props.state;
			var t = props.t;
			var storage = safeString(state.storagePath);
			var parts = [h("span", { key: "note", className: "coros-footNote" }, t("footer.note"))];
			if (storage) {
				parts.push(h("span", { key: "sep", className: "coros-footSep", "aria-hidden": "true" }, " · "));
				parts.push(
					h("code", { key: "path", className: "coros-footPath", title: storage }, storage)
				);
			}
			return h("footer", { className: "coros-foot" }, parts);
		}

		/* ------------------------------------------------------------------ *\
		 * The panel body, shared by the Settings page and the overlay modal.
		\* ------------------------------------------------------------------ */

		function CorosPanel(props) {
			var view = props.view;
			var t = props.t;
			var variant = props.variant || "page";
			var state = useViewState(view);

			React.useEffect(
				function () {
					view.load({ quiet: true });
				},
				[view]
			);

			var polling = state.phase === "login-pending";
			React.useEffect(
				function () {
					if (!polling) return undefined;
					var stopped = false;
					var timer = null;
					function tick() {
						if (stopped) return;
						view.poll();
						timer = setTimeout(tick, POLL_INTERVAL_MS);
					}
					timer = setTimeout(tick, POLL_INTERVAL_MS);
					return function () {
						stopped = true;
						if (timer) clearTimeout(timer);
					};
				},
				[polling, view]
			);

			var content = [
				h(PanelHead, {
					key: "head",
					state: state,
					t: t,
					onClose: props.onClose,
					brandSize: variant === "modal" ? 36 : 40
				}),
				h(ErrorBanner, {
					key: "banner",
					state: state,
					t: t,
					onRetry: function () {
						view.retry();
					}
				})
			];

			if (!state.available) {
				content.push(h(UnavailableCard, { key: "unavailable", state: state, t: t }));
			} else if (state.loading && state.loaded !== true) {
				content.push(h(LoadingCard, { key: "loading", t: t }));
			} else if (state.phase === "login-pending") {
				content.push(h(PendingCard, { key: "pending", state: state, view: view, t: t }));
			} else if (state.phase === "signed-in") {
				content.push(h(ConnectedCard, { key: "connected", state: state, view: view, t: t }));
				content.push(h(ToolsSection, { key: "tools", state: state, view: view, t: t }));
			} else {
				content.push(h(SignedOutCard, { key: "signed-out", state: state, view: view, t: t }));
			}

			content.push(h(PanelFooter, { key: "foot", state: state, t: t }));

			return h("div", { className: "coros-panel" + (variant === "modal" ? " coros-panel--modal" : "") }, content);
		}

		/* ------------------------------------------------------------------ *\
		 * Surfaces.
		\* ------------------------------------------------------------------ */

		/** `settings.section` — the full page in Settings. */
		function CorosSettingsSection(props) {
			var t = useT(props);
			return h("div", { className: "coros-page" }, h(CorosPanel, { view: props.view, t: t, variant: "page" }));
		}

		/** `shell.overlay` — the quick panel over the whole app frame. */
		function CorosQuickPanel(props) {
			var view = props.view;
			var t = useT(props);
			var state = useViewState(view);
			var dialogRef = React.useRef(null);
			var previousFocus = React.useRef(null);

			React.useEffect(
				function () {
					if (!state.open) return undefined;
					previousFocus.current = typeof document !== "undefined" ? document.activeElement : null;
					var node = dialogRef.current;
					if (node && typeof node.focus === "function") node.focus();
					return function () {
						var previous = previousFocus.current;
						if (previous && typeof previous.focus === "function") previous.focus();
					};
				},
				[state.open]
			);

			function close() {
				view.setOpen(false);
			}

			function onKeyDown(event) {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					close();
				}
			}

			function onBackdrop(event) {
				if (event.target === event.currentTarget) close();
			}

			if (!state.open) return null;

			return h("div", { className: "coros-layer", onMouseDown: onBackdrop }, [
				h(
					"div",
					{
						key: "dialog",
						ref: dialogRef,
						className: "coros-modal",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": t("panel.title"),
						tabIndex: -1,
						onKeyDown: onKeyDown
					},
					h("div", { className: "coros-modalBody" }, h(CorosPanel, { view: view, t: t, variant: "modal", onClose: close }))
				)
			]);
		}

		/** `sidebar.footer.action` — brand mark entry above Settings. */
		function CorosSidebarButton(props) {
			var view = props.view;
			var t = useT(props);
			var state = useViewState(view);
			var wide = props.wide === true;
			var tone = statusTone(state);
			var label = statusLabel(t, state);

			return h(
				"button",
				{
					type: "button",
					className: "coros-sideBtn" + (wide ? " coros-sideBtn--wide" : ""),
					onClick: function () {
						view.setOpen(!view.getState().open);
					},
					title: t("sidebar.label"),
					"aria-label": t("sidebar.label") + "，" + label,
					"aria-haspopup": "dialog"
				},
				[
					h("span", { key: "icon", className: "coros-sideBtnIcon" }, h(BrandMark, { size: wide ? 18 : 20 })),
					wide
						? h("span", { key: "label", className: "coros-sideBtnLabel" }, [
								h("span", { key: "text", className: "coros-sideBtnText" }, t("sidebar.name")),
								h("span", { key: "dot", className: "coros-dot coros-sideBtnDot", "data-tone": tone, title: label })
							])
						: h("span", { key: "dot", className: "coros-sideBtnDotCorner" }, h("span", { className: "coros-dot", "data-tone": tone }))
				]
			);
		}

		/** `conversation.session.header.actions` — compact entry in chat. */
		function CorosHeaderChip(props) {
			var view = props.view;
			var t = useT(props);
			var state = useViewState(view);
			var tone = statusTone(state);
			var label = statusLabel(t, state);

			return h(
				"button",
				{
					type: "button",
					className: "coros-chip",
					onClick: function () {
						view.setOpen(!view.getState().open);
					},
					title: t("panel.title") + " · " + label,
					"aria-label": t("panel.title") + "，" + label,
					"aria-haspopup": "dialog"
				},
				[
					h("span", { key: "dot", className: "coros-dot", "data-tone": tone }),
					h("span", { key: "name", className: "coros-chipName" }, "COROS")
				]
			);
		}

		/* ------------------------------------------------------------------ *\
		 * Styles. Token-driven, scoped to the plugin's own `coros-` classes.
		 * One guarded <style> is injected per document; nothing else is global.
		\* ------------------------------------------------------------------ */

		var COROS_STYLES = `
.coros-page,
.coros-layer {
	box-sizing: border-box;
	color: var(--dsw-alias-label-primary);
	font-family: var(--dsw-font-family, var(--dsh-font-family-text-default, system-ui, sans-serif));
	font-size: 13px;
	line-height: 22px;
	-webkit-font-smoothing: antialiased;
}
.coros-page *,
.coros-page *::before,
.coros-page *::after,
.coros-layer *,
.coros-layer *::before,
.coros-layer *::after {
	box-sizing: border-box;
}

/* Page shell inside Settings. Width is a ceiling: the host settings column is narrower. */
.coros-page {
	width: 100%;
	max-width: 720px;
	margin: 0 auto;
	padding: 4px 0 20px;
}
.coros-panel {
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 0;
}

/* Header. */
.coros-head {
	display: flex;
	align-items: center;
	gap: 12px;
	min-width: 0;
}
.coros-headBrand {
	display: inline-flex;
	flex: 0 0 auto;
	filter: drop-shadow(0 1px 2px var(--dsw-alias-bg-mask-1));
}
.coros-headMeta {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
	flex: 1 1 auto;
}
.coros-headTop {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
}
.coros-title {
	margin: 0;
	font-size: 15px;
	line-height: 22px;
	font-weight: 600;
	letter-spacing: 0.01em;
	white-space: nowrap;
}
.coros-sub {
	margin: 0;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* Status pill + dot. */
.coros-pill {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 22px;
	padding: 0 9px;
	border-radius: 999px;
	background: var(--dsw-alias-bg-layer-3);
	box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2);
	color: var(--dsw-alias-label-secondary);
	font-size: 11.5px;
	line-height: 16px;
	white-space: nowrap;
	flex: 0 0 auto;
}
.coros-pillLabel {
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 14em;
}
.coros-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--dsw-alias-state-idle-primary);
	flex: 0 0 auto;
}
.coros-dot[data-tone="success"] { background: var(--dsw-alias-state-success-primary); }
.coros-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.coros-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }

/* Icon-only button (close). */
.coros-iconBtn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	padding: 0;
	border: 0;
	border-radius: var(--dsw-radius-sm);
	background: transparent;
	color: var(--dsw-alias-label-tertiary);
	cursor: pointer;
	flex: 0 0 auto;
	transition: background 0.16s var(--ds-ease-in-out), color 0.16s var(--ds-ease-in-out);
}
.coros-iconBtn:hover {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}
.coros-iconBtn:active { background: var(--dsw-alias-interactive-bg-active); }

/* Cards. */
.coros-card {
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 0;
	padding: 16px;
	border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4));
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2));
}
.coros-cardHead {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	min-width: 0;
}
.coros-cardTitle {
	margin: 0;
	font-size: 14px;
	line-height: 20px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}
.coros-cardText {
	margin: 0;
	font-size: 13px;
	line-height: 20px;
	color: var(--dsw-alias-label-tertiary);
}
.coros-intro {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	min-width: 0;
}
.coros-introIcon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border-radius: var(--dsw-radius-sm);
	background: var(--dsw-alias-markdown-inline-code);
	color: var(--dsw-alias-brand-primary);
	flex: 0 0 auto;
}
.coros-introText {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}
.coros-badge {
	display: inline-flex;
	align-items: center;
	height: 20px;
	padding: 0 8px;
	border-radius: 999px;
	background: var(--dsw-alias-markdown-inline-code);
	color: var(--dsw-alias-label-tertiary);
	font-family: var(--dsh-font-family-code-default, ui-monospace, SFMono-Regular, Menlo, monospace);
	font-size: 10px;
	letter-spacing: 0.08em;
	flex: 0 0 auto;
}

/* Forms. */
.coros-form {
	display: flex;
	align-items: flex-end;
	gap: 10px;
	flex-wrap: wrap;
}
.coros-field {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
	flex: 1 1 200px;
}
.coros-label {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-secondary);
}
.coros-select {
	height: 34px;
	max-width: 100%;
	padding: 0 10px;
	border: 0.5px solid var(--dsw-alias-border-l4);
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-bg-layer-3);
	color: var(--dsw-alias-label-primary);
	font: inherit;
	font-size: 13px;
	cursor: pointer;
}
.coros-select:disabled { opacity: 0.4; cursor: not-allowed; }
.coros-select:focus {
	outline: none;
	border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l3));
}
.coros-formCta {
	display: flex;
	align-items: center;
	flex: 0 0 auto;
}

/* Inputs. */
.coros-input {
	height: 34px;
	width: 100%;
	padding: 0 10px;
	border: 0.5px solid var(--dsw-alias-border-l4);
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-bg-layer-3);
	color: var(--dsw-alias-label-primary);
	font: inherit;
	font-size: 13px;
}
.coros-input::placeholder { color: var(--dsw-alias-label-caption); }
.coros-input:focus {
	outline: none;
	border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l3));
}

/* Buttons. */
.coros-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	height: 32px;
	padding: 0 12px;
	border: 0;
	border-radius: var(--dsw-radius-md);
	background: transparent;
	color: var(--dsw-alias-label-primary);
	font-family: inherit;
	font-size: 13px;
	line-height: 20px;
	font-weight: 500;
	white-space: nowrap;
	cursor: pointer;
	flex: 0 0 auto;
	transition: background 0.16s var(--ds-ease-in-out), color 0.16s var(--ds-ease-in-out), opacity 0.16s var(--ds-ease-in-out);
}
.coros-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.coros-btn--primary {
	height: 36px;
	padding: 0 18px;
	background: var(--dsw-alias-button-primary-fill);
	color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-label-primary-inverted));
	font-size: 13.5px;
}
.coros-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.coros-btn--lg { height: 38px; padding: 0 20px; font-size: 14px; }
/* An anchor styled as a button: same metrics, no underline, still keyboard-focusable. */
.coros-btn--link {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	align-self: flex-start;
	text-decoration: none;
}
.coros-btn--link[aria-disabled="true"] {
	opacity: 0.4;
	cursor: not-allowed;
	pointer-events: none;
}
.coros-btn--outline {
	color: var(--dsw-alias-label-primary);
	box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3);
}
.coros-btn--outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.coros-btn--ghost { color: var(--dsw-alias-label-secondary); }
.coros-btn--ghost:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}
.coros-btn--ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.coros-btn--danger { color: var(--dsw-alias-label-error); }
.coros-btn--danger:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover-danger);
	color: var(--dsw-alias-label-error);
}
.coros-btn--sm {
	height: 28px;
	padding: 0 10px;
	border-radius: var(--dsw-radius-sm);
	font-size: 12px;
	line-height: 18px;
}
.coros-btnIcon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 auto;
}
.coros-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}

/* Focus ring: browser default outline is preserved but tinted. */
.coros-btn:focus-visible,
.coros-iconBtn:focus-visible,
.coros-select:focus-visible,
.coros-input:focus-visible,
.coros-urlInput:focus-visible,
.coros-toolRow:focus-visible,
.coros-chip:focus-visible,
.coros-sideBtn:focus-visible,
.coros-modal:focus-visible {
	outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
	outline-offset: 1px;
}
.coros-modal:focus-visible { outline: none; }

/* Shared small text. */
.coros-hint {
	margin: 0;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-caption);
	overflow-wrap: anywhere;
}
.coros-inlineNote {
	margin: 0;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-error);
	overflow-wrap: anywhere;
}

/* Spinner. */
.coros-spinner {
	display: inline-block;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	border: 1.5px solid var(--dsw-alias-border-l3);
	border-top-color: var(--dsw-alias-brand-primary);
	animation: coros-spin 0.8s linear infinite;
	flex: 0 0 auto;
}
.coros-spinner--sm { width: 12px; height: 12px; }
.coros-spinner--xs { width: 10px; height: 10px; border-width: 1px; }

/* Pending login. */
.coros-pendingHead {
	display: flex;
	align-items: flex-start;
	gap: 12px;
}
.coros-pendingIcon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border-radius: 50%;
	background: var(--dsw-alias-bg-layer-3);
	color: var(--dsw-alias-brand-primary);
	flex: 0 0 auto;
}
.coros-urlRow {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
}
.coros-urlInput {
	flex: 1 1 220px;
	min-width: 0;
	height: 34px;
	padding: 0 10px;
	border: 0.5px solid var(--dsw-alias-border-l4);
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-bg-layer-3);
	color: var(--dsw-alias-label-secondary);
	font-family: var(--dsh-font-family-code-default, ui-monospace, SFMono-Regular, Menlo, monospace);
	font-size: 12px;
}
.coros-urlInput:focus {
	outline: none;
	border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l3));
}
.coros-countdown {
	display: flex;
	align-items: center;
	gap: 6px;
	margin: 0;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
}
.coros-countdown[data-tone="error"] { color: var(--dsw-alias-label-error); }

/* Connected facts. */
.coros-facts {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
}
.coros-fact {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 16px;
	margin: 0;
	padding: 9px 0;
	border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.coros-fact:first-child {
	padding-top: 0;
	border-top: 0;
}
.coros-fact dt {
	margin: 0;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
	flex: 0 0 auto;
}
.coros-fact dd {
	margin: 0;
	font-size: 13px;
	line-height: 20px;
	color: var(--dsw-alias-label-primary);
	text-align: right;
	min-width: 0;
	overflow-wrap: anywhere;
}
.coros-fact dd[data-tone="error"] { color: var(--dsw-alias-label-error); }

/* Tools. */
.coros-tools { gap: 12px; }
.coros-count {
	display: inline-flex;
	align-items: center;
	height: 20px;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
	white-space: nowrap;
	flex: 0 0 auto;
}
.coros-searchField {
	position: relative;
	display: flex;
	align-items: center;
}
.coros-searchIcon {
	position: absolute;
	left: 10px;
	display: inline-flex;
	color: var(--dsw-alias-label-caption);
	pointer-events: none;
}
.coros-search { padding-left: 32px; }
.coros-toolList {
	display: flex;
	flex-direction: column;
	gap: 2px;
	max-height: 340px;
	overflow-y: auto;
	margin: 0 -4px;
	min-height: 0;
}
.coros-toolItem {
	border-radius: var(--dsw-radius-sm);
	min-width: 0;
}
.coros-toolRow {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	padding: 7px 8px;
	border: 0;
	border-radius: var(--dsw-radius-sm);
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}
.coros-toolRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.coros-toolRow:active { background: var(--dsw-alias-interactive-bg-active); }
.coros-toolMain {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
	flex: 1 1 auto;
}
.coros-toolName {
	font-family: var(--dsh-font-family-code-default, ui-monospace, SFMono-Regular, Menlo, monospace);
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-primary);
	overflow-wrap: anywhere;
}
.coros-toolDesc {
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-tertiary);
	overflow-wrap: anywhere;
}
.coros-toolChevron {
	display: inline-flex;
	color: var(--dsw-alias-label-caption);
	flex: 0 0 auto;
	transition: transform 0.16s var(--ds-ease-in-out);
}
.coros-toolRow[aria-expanded="true"] .coros-toolChevron { transform: rotate(180deg); }
.coros-toolDetail {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 2px 8px 12px;
}
.coros-toolDetailLabel {
	font-size: 10.5px;
	line-height: 16px;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--dsw-alias-label-caption);
}
.coros-code {
	margin: 0;
	padding: 10px 12px;
	border-radius: var(--dsw-radius-sm);
	background: var(--dsw-alias-markdown-inline-code);
	color: var(--dsw-alias-label-secondary);
	font-family: var(--dsh-font-family-code-default, ui-monospace, SFMono-Regular, Menlo, monospace);
	font-size: 11.5px;
	line-height: 17px;
	max-height: 240px;
	overflow: auto;
	white-space: pre;
	tab-size: 2;
}
.coros-toolHint {
	margin: 0;
	font-size: 11.5px;
	line-height: 17px;
	color: var(--dsw-alias-label-caption);
	overflow-wrap: anywhere;
}
.coros-empty {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 10px;
	padding: 14px 12px;
	border: 0.5px dashed var(--dsw-alias-border-l3);
	border-radius: var(--dsw-radius-sm);
	background: var(--dsw-alias-bg-layer-3);
}
.coros-emptyText {
	margin: 0;
	font-size: 12.5px;
	line-height: 19px;
	color: var(--dsw-alias-label-tertiary);
}

/* Skeletons. */
.coros-skeleton {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 2px 0;
}
.coros-skeletonRow {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.coros-skeletonBar {
	display: block;
	height: 10px;
	border-radius: 999px;
	background: var(--dsw-alias-bg-layer-3);
	animation: coros-pulse 1.4s var(--ds-ease-in-out) infinite;
}
.coros-skeletonBar--title { width: 38%; }
.coros-skeletonBar--body { width: 72%; height: 8px; }

/* Footer. */
.coros-foot {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	padding: 0 2px;
	font-size: 11.5px;
	line-height: 18px;
	color: var(--dsw-alias-label-caption);
}
.coros-footNote { flex: 0 1 auto; }
.coros-footSep { flex: 0 0 auto; }
.coros-footPath {
	flex: 0 1 auto;
	max-width: 100%;
	padding: 0 4px;
	border-radius: var(--dsw-radius-xs);
	background: var(--dsw-alias-markdown-inline-code);
	font-family: var(--dsh-font-family-code-default, ui-monospace, SFMono-Regular, Menlo, monospace);
	font-size: 10.5px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* Error banner. */
.coros-banner {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 12px 14px;
	border: 0.5px solid var(--dsw-alias-border-l2);
	border-left: 2px solid var(--dsw-alias-state-error-primary);
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-bg-layer-2);
	min-width: 0;
}
.coros-bannerIcon {
	display: inline-flex;
	margin-top: 2px;
	color: var(--dsw-alias-label-error);
	flex: 0 0 auto;
}
.coros-bannerBody {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
	flex: 1 1 auto;
}
.coros-bannerTitle {
	font-size: 13px;
	line-height: 20px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}
.coros-bannerText {
	margin: 0;
	font-size: 12.5px;
	line-height: 19px;
	color: var(--dsw-alias-label-secondary);
	overflow-wrap: anywhere;
}
.coros-banner .coros-btn { margin-left: auto; }

/* Overlay surface: the host overlay layer ignores pointer events, so opt back in. */
.coros-layer {
	position: fixed;
	inset: 0;
	z-index: 1000;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	background: var(--dsw-alias-bg-mask-1);
	pointer-events: auto;
	animation: coros-fade 0.18s var(--ds-ease-in-out);
}
.coros-modal {
	display: flex;
	flex-direction: column;
	width: min(560px, 100%);
	max-height: min(760px, 85vh);
	border-radius: var(--dsw-radius-panel);
	background: var(--dsw-alias-bg-layer-2);
	box-shadow: var(--dsw-elevation-prominent);
	outline: none;
	overflow: hidden;
	animation: coros-rise 0.2s var(--ds-ease-in-out);
}
.coros-modalBody {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	padding: 20px 24px 16px;
}
.coros-panel--modal .coros-toolList { max-height: none; }

/* Sidebar footer entry. */
.coros-sideBtn {
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	padding: 0;
	border: 0;
	border-radius: var(--dsw-radius-sm);
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	cursor: pointer;
	transition: background 0.16s var(--ds-ease-in-out);
}
.coros-sideBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.coros-sideBtn:active { background: var(--dsw-alias-interactive-bg-active); }
.coros-sideBtn--wide {
	width: 100%;
	height: 42px;
	justify-content: flex-start;
	gap: 8px;
	padding: 0 10px 0 8px;
}
.coros-sideBtnIcon {
	display: inline-flex;
	flex: 0 0 auto;
}
.coros-sideBtnLabel {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	flex: 1 1 auto;
}
.coros-sideBtnText {
	font-size: 13px;
	line-height: 20px;
	color: var(--dsw-alias-label-secondary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.coros-sideBtn--wide:hover .coros-sideBtnText { color: var(--dsw-alias-label-primary); }
.coros-sideBtnDot { margin-left: auto; }
.coros-sideBtnDotCorner {
	position: absolute;
	top: 6px;
	right: 6px;
	display: inline-flex;
	width: 6px;
	height: 6px;
}

/* Conversation header chip. */
.coros-chip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 26px;
	padding: 0 9px;
	border: 0;
	border-radius: 999px;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	font: inherit;
	font-size: 12px;
	line-height: 18px;
	cursor: pointer;
	flex: 0 0 auto;
	transition: background 0.16s var(--ds-ease-in-out), color 0.16s var(--ds-ease-in-out);
}
.coros-chip:hover {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}
.coros-chip:active { background: var(--dsw-alias-interactive-bg-active); }
.coros-chipName { letter-spacing: 0.02em; }

/* Accessibility helper. */
.coros-srOnly {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

@keyframes coros-spin { to { transform: rotate(360deg); } }
@keyframes coros-pulse {
	0%, 100% { opacity: 0.55; }
	50% { opacity: 1; }
}
@keyframes coros-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes coros-rise {
	from { opacity: 0; transform: translateY(6px) scale(0.99); }
	to { opacity: 1; transform: none; }
}

/* Small screens: the Settings column can be as narrow as ~320px. */
@media (max-width: 520px) {
	.coros-layer { padding: 12px; }
	.coros-modal {
		width: 100%;
		max-height: none;
		height: 100%;
		border-radius: var(--dsw-radius-lg);
	}
	.coros-modalBody { padding: 16px; }
	.coros-head { gap: 10px; }
	.coros-title { font-size: 14px; }
	.coros-fact { gap: 10px; }
}
@media (max-width: 420px) {
	.coros-form { flex-direction: column; align-items: stretch; }
	.coros-formCta .coros-btn { width: 100%; }
	.coros-urlInput { flex-basis: 100%; }
	.coros-toolList { margin: 0; }
}

@media (prefers-reduced-motion: reduce) {
	.coros-layer,
	.coros-modal,
	.coros-skeletonBar { animation: none; }
	.coros-spinner { animation-duration: 1.6s; }
	.coros-toolChevron,
	.coros-btn,
	.coros-chip,
	.coros-iconBtn,
	.coros-sideBtn { transition: none; }
}
`;

		/**
		 * Inject the stylesheet once per document. Cosmetic only: failures are ignored.
		 */
		function injectStyles() {
			try {
				if (typeof document === "undefined") return;
				var selector = 'style[data-plugin-css="' + CSS_ID + '"]';
				if (document.querySelector(selector)) return;
				var style = document.createElement("style");
				style.setAttribute("data-plugin-css", CSS_ID);
				style.textContent = COROS_STYLES;
				var target = document.head || document.documentElement;
				if (target) target.appendChild(style);
			} catch (error) {
				/* the panel still works without its stylesheet */
			}
		}

		/* ------------------------------------------------------------------ *\
		 * Activation.
		\* ------------------------------------------------------------------ */

		function warn(message, error) {
			try {
				if (typeof console !== "undefined" && typeof console.warn === "function") {
					console.warn("[dsh-coros-gui] " + message, error || "");
				}
			} catch (ignored) {
				/* logging is best-effort */
			}
		}

		/**
		 * Run an activation step inside `ctx.effect` so the host can dispose it, and
		 * never let one unavailable slot take the whole plugin down.
		 */
		function effect(ctx, label, run) {
			function guarded() {
				try {
					return run();
				} catch (error) {
					warn("could not activate " + label, error);
					return function () {};
				}
			}
			try {
				if (typeof ctx.effect === "function") {
					var dispose = ctx.effect(guarded, "dsh-coros-gui: " + label);
					return typeof dispose === "function" ? dispose : function () {};
				}
				return guarded();
			} catch (error) {
				warn("could not activate " + label, error);
				return function () {};
			}
		}

		function apply(ctx) {
			injectStyles();

			var t = createTranslator(ctx);
			var view = createView(ctx);

			function injectFace() {
				return { view: view, t: t };
			}

			effect(ctx, "dictionaries", function () {
				if (!ctx.locale || typeof ctx.locale.register !== "function") return function () {};
				return ctx.locale.register(NS, { zh: zh, en: en });
			});

			var slots = ctx && ctx.slots ? ctx.slots : null;

			function register(slotName, component, registration) {
				return effect(ctx, slotName, function () {
					if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
						throw new Error("slot service unavailable");
					}
					return slots.inject(slotName, function () {
						return slots.register(registration, component);
					});
				});
			}

			register("settings.section", CorosSettingsSection, {
				name: "settings.section",
				id: "coros-gui",
				order: 55,
				label: function () {
					return t("settings.nav");
				},
				locale: NS,
				inject: injectFace
			});

			register("shell.overlay", CorosQuickPanel, {
				name: "shell.overlay",
				id: "coros-gui-panel",
				order: 40,
				locale: NS,
				inject: injectFace
			});

			register("sidebar.footer.action", CorosSidebarButton, {
				name: "sidebar.footer.action",
				id: "coros-gui-button",
				order: 40,
				locale: NS,
				inject: injectFace
			});

			register("conversation.session.header.actions", CorosHeaderChip, {
				name: "conversation.session.header.actions",
				id: "coros-gui-chip",
				order: 40,
				locale: NS,
				inject: injectFace
			});

			return {
				view: view,
				dispose: function dispose() {
					try {
						view.destroy();
					} catch (error) {
						/* already gone */
					}
				}
			};
		}

		exports.inject = ["slots", "locale", "connection"];
		exports.apply = apply;

		return module.exports;

	}
});
