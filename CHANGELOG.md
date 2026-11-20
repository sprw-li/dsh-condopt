# Changelog

## 0.3.0 — 2026-11-20（v3.0 第一波，评审 #3 后半 + #5）

- **诊断页**：`GET /condopt/api/diagnostics`（只读、不渲染、不写 run 目录）逐级列出**七级 root 候选**
  （含不合法项与原因）、python 探测（5s 超时，失败/超时都 200 且 `ok:false`）、CLI/condopt/plugin 版本、
  `env`、`allowExec`、`degraded`；客户端在 `settings.section`（id `condopt`，order 60）渲染「宿主诊断 /
  客户端注册结果 / 配置方式」三块，`configForms` 不可用时只给说明（本页只读，不写 profile）。
- **摘要页默认**：面板子页签改为 **摘要（默认）｜视图｜参数｜决策**；摘要页只调 `GET /api/study`
  （study 名/算法/目标/预算·已用·剩余/最优/观测数/待回填/`stateToken` 前 8 位/`step` 与 `next_command`/
  最近 3 条决策/warnings +「打开完整视图」），**挂载面板不再请求 `/api/view`**。
- **sandboxed iframe 取代 shadow DOM**：视图页懒加载（切到视图页或点按钮才请求，`?force=1` 只由
  「强制重新生成」触发）；`<iframe sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc=…>`，
  `srcDoc` 内置 CSP `default-src 'none'` + `<style>`/`<body>`，**不再使用 `attachShadow`**。
- 命令白名单、`condopt_view` 形状、写路径与 `expect`/零写入语义均不变。
- 验收：A1 双 exit 0；A2 `304/310 + 6 SKIP`（受限沙箱；可写环境 `342/342`）；A3 `127/127`。

## 0.2.0 — 2026-11-20

- **垂直切片**：单 study、单批次、用户确认的优化回合闭环 —— 参数页四块（当前 study / 下一批 / 算法覆写 / 新建 study）、
  `ask` 后可在面板内粘贴实测结果回填 `tell`、视图与决策自动刷新、显示执行回执，**全程不回终端**。
- **状态令牌**：`stateToken` + 写操作 `expect`，过期写入返回 409 `state-changed`（面板提示并刷新，不自动重试）。
- **`tell` 内容直传**：`resultsText`（JSON/JSONL/CSV）由宿主写临时文件调 CLI，调用后即删；回执的前后计数由宿主实读 run 目录。
- **工具卡交接**：`condopt_view` 卡片可带 root+run 直接打开面板并选中同一 study。
- **修复**：激活期属性式 `ctx.agents` 访问导致 `1 entry did not activate / cannot get property "agents" without inject`
  （改为 `ctx.get` 软访问 + 激活期零可选服务，惰性解析）。
- 验收：A1 双 exit 0；A2 315/315（可写环境；受限沙箱 277/283 + 6 SKIP）；A3 100/100；真机 ask→tell 垂直切片全绿。

## 0.1.0 — 2026-11-19

- 首个版本：宿主侧把 condopt CLI 包成 `/condopt/api/{health,studies,spec,view,study,exec}` + 只读工具 `condopt_view`；
  浏览器侧右侧栏「条件优化」tab、`/condopt` 命令、`tool.call.toolview` 卡；视图把 condopt 自己的
  `dashboard.html` 写进 shadow DOM；17 条命令白名单 + 参数校验，默认零写入 run 目录。
- 根目录七级解析（含「插件自身目录的上一级」，`link:` 安装开箱即用）。
