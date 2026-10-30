# Changelog

## 0.1.0 — 2026-10-30

首个可用版本。

### 功能

- **COROS 浏览器登录**：OAuth 授权码 + PKCE + 动态客户端注册 + CLI 登录会话轮询（与 COROS 官方 `coros-mcp` 同一协议），
  登录后令牌自动保存并在到期前用轮换刷新令牌续期。
- **四个账号区域**：全球 / 中国大陆 / 欧洲 / 美国，自动做 OAuth 发现并对齐授权集群。
- **对话内工具**：常驻 `coros_status`、`coros_login`、`coros_call_tool`；登录后按 COROS MCP 目录自动注册
  `coros_<tool>`（实测 34 个，覆盖活动/健康/睡眠 HRV/训练负荷/训练计划/训练日程/路线导入等）。
- **原生插件 UI**（遵循 DSH 插件规范）：
  - 设置页「COROS」：连接状态、区域选择、浏览器登录/取消/退出、工具目录检索与参数 JSON Schema 查看；
  - 侧栏快捷入口 + 浮层面板；
  - 会话头部连接状态 chip。
- **本地安全**：令牌只保存在 `$DSH_HOME/coros-gui/state.json`（目录 0700、文件 0600、原子写入），
  不写入日志/工具输出/对话内容；登录 RPC 仅在本机回环 Host 上启用。

### 验证

- `npm run check` 通过；`node test/engine.test.mjs` **10/10 passed**（含假 IdP 完整登录闭环、目录注册、
  401 刷新重试、schema 清洗，以及真实 COROS 端点的 live smoke）。
- 隔离 profile 端到端：面板/设置页渲染、登录跳转真实授权页、区域切换、取消登录、对话内工具调用。
- 真实 desktop profile（DSH 0.2.1-rc.3）：安装后热加载生效；用真实 COROS 账号完成登录，
  面板显示已连接，34 个 `coros_*` 工具注册成功并可在对话中调用。
