# dsh-condopt 验收手册（A1–A7）

契约：[`../DESIGN.md`](../DESIGN.md) §8。本文件给每条检查**可复制的命令、期望输出、当前实测结果、已知限制**。
除 A7 外都不需要 GUI；A2/A3 是离线 harness（真加载被测文件，不做字符串匹配式假测试）。

> 本文的“最终实测”= **2026-11-20 v2.0 冻结快照**（`index.js` sha `0D29CAEB…`、`client.js` sha `42109921…`）：
> - **A1** `node --check index.js|client.js` → 双 exit 0
> - **A2** 真实仓库（DSH 沙箱）：`277/283 通过，0 失败，6 SKIP`；**可写根跑：`315/315，0 失败，0 SKIP`**
> - **A3** `100/100，0 失败`（完全离线，与检出位置无关）
> - **A7** ask→tell 垂直切片真机全绿（见 A7 节）；`tell` 临时文件实测残留 = 0
>
> A2 的数字随「有没有 condopt 检出 / `runs/` 可不可写」变化（三条自测表见 A2 节）：独立 clone 无检出 =
> `203/222 + 19 SKIP`，指向检出 = `303/309 + 6 SKIP`（沙箱）/ `342/342`（真仓库可写）。Lead 的 danger-full-access
> 首次 `307/307` 是后补 15 条断言（激活惰性 +6、辅助导出 +9）之前的数。
>
> **v3.0 第一波（DESIGN §8.7）已补断言并跑绿**（`index.js 78C23FC3…`、`client.js ECDAAC44…`）：
> A1 双 exit 0；A2 `304/310 + 6 SKIP`（可写 `342/342`）；A3 `127/127`。新增断言表见「A2/A3 的 v3.0 第一波」节。
>
> v1.4 冻结快照（更早一轮，供对照）：A2 234/234、A3 70/70、`--skip-real` 206/206、A5 17/19、A7 接口全 200。

## 0. 一分钟全量

```powershell
cd <dsh-plugin-dir>                    # 可以是一个独立 clone；检出位置由下面三级解析
node --check index.js                 # A1
node --check client.js                # A1
node dev/verify-host.mjs              # A2（含真机 python 子项；找不到检出时真机项 SKIP，仍 exit 0）
node dev/verify-client.mjs            # A3（完全离线）
```

期望：四条命令都 `exit 0`，末尾分别打印 `verify-host: PASS` / `verify-client: PASS`。
若 `verify-host` 报 `SKIP`（没有 condopt 检出 / `runs/` 不可写），那是环境限制而非失败——
想让真 CLI 断言也跑起来：`$env:DSH_CONDOPT_VERIFY_ROOT='<condopt 仓库>'; node dev/verify-host.mjs`。

## A1 语法

```powershell
cd <dsh-plugin-dir>
node --check index.js; node --check client.js
```

- 期望：两条都 exit 0（无输出）。
- 当前结果：**PASS**（均为 exit 0）。
- 说明：`package.json` 里也有等价脚本 `npm run syntax`。

## A2 宿主侧 harness（`node dev/verify-host.mjs`）

```powershell
cd <dsh-plugin-dir>
node dev/verify-host.mjs                  # 全量（含真实 python 渲染/路由）
node dev/verify-host.mjs --skip-real      # 纯离线：不启动任何子进程
$env:DSH_CONDOPT_SKIP_REAL='1'; node dev/verify-host.mjs; Remove-Item Env:DSH_CONDOPT_SKIP_REAL
```

- 期望：末尾 `verify-host: N/N 通过，0 失败`，exit 0；失败时逐条打印
  `[分组] 断言名 / 期望 / 实际` 并以 exit 1 收尾。
- **当前结果（v2.0）**：真实仓库（沙箱）**277/283 通过，0 失败，6 SKIP**；指向可写临时根 **315/315，0 失败，0 SKIP**
  —— 那 6 组真写入（expect 放行/不校验、tell 三形态、临时文件清理）在可写环境全部真跑。v1.4 快照为 234/234。
- **当前结果（v3.0 第一波）**：真实仓库（沙箱）**304/310 + 6 SKIP**；可写临时根 **342/342 + 0 SKIP**。

**位置无关的 condopt 根解析（发布仓库自证 / fresh clone）**

harness 按 **`DSH_CONDOPT_VERIFY_ROOT` → `CONDOPT_ROOT` → 插件目录的上一级** 顺序找检出，
每一级都要求同时存在 `scripts/run_condopt.py` 与 `src/condopt/cli.py`，不合法就继续下一级。
全都不合法时：**离线断言（导出面 / 纯函数 / 解析 / 路由分派 / 409）照跑**，真 CLI 与写路径全部
`SKIP`（文案：`未找到 condopt 检出：设置 DSH_CONDOPT_VERIFY_ROOT 或 CONDOPT_ROOT 指向一个 condopt 仓库…`），
进程 **exit 0**，不会 ENOENT / 未捕获异常。三条自测（2026-11-20）：

| 场景 | 命令 | 结果 |
|---|---|---|
| (a) 真仓库 | `node dev/verify-host.mjs`（本仓库，沙箱） | `304/310，0 失败，6 SKIP`，exit 0 |
| (a') 真仓库可写 | `DSH_CONDOPT_VERIFY_ROOT=<可写临时根>` | `342/342，0 失败，0 SKIP`，exit 0 |
| (b) 独立 clone、无环境变量、旁边无检出 | `node dev/verify-host.mjs` | `203/222，0 失败，19 SKIP`，exit 0；无崩溃 |
| (c) 独立 clone + 指向检出 | `DSH_CONDOPT_VERIFY_ROOT=<condopt 仓库>`（或 `CONDOPT_ROOT`） | `303/309，0 失败，6 SKIP`（沙箱）；指向可写临时根则 0 SKIP |

```powershell
# (b) 独立 clone 的最朴素跑法：不设任何环境变量也能 exit 0（真 CLI 断言 SKIP）
node dev/verify-client.mjs        # 完全离线，127/127
node dev/verify-host.mjs
# (c) 指一个 condopt 检出（或可写临时根）即可全跑
$env:DSH_CONDOPT_VERIFY_ROOT = 'D:\path\to\condopt'; node dev/verify-host.mjs; Remove-Item Env:DSH_CONDOPT_VERIFY_ROOT
```

> **为什么“可写”的总数比“沙箱”大（310 → 342）**：`SKIP` 是**整组占位**（每组 1 条结果），一旦
> `runs/` 可写，这 6 组会展开成 38 条真断言（expect 放行/不校验 + tell 三形态 receipt 全字段 + 临时文件清理）。
> 因此口径是：**受限沙箱 `304/310 + 6 SKIP`；可写环境 `342/342 + 0 SKIP`**（v2.0 时对应 283 → 315，同一原因）。

```powershell
# 想在沙箱里也跑真写入组：造一个可写临时根再指过去
$t = Join-Path $env:TEMP 'dsh-condopt-verify-root'
New-Item -ItemType Directory -Path $t -Force | Out-Null
Copy-Item <repo>\scripts, <repo>\src -Destination $t -Recurse
Copy-Item <repo>\pyproject.toml -Destination $t
New-Item -ItemType Directory -Path "$t\runs" | Out-Null
Copy-Item <repo>\runs\demo_moo, <repo>\runs\flow2 -Destination "$t\runs" -Recurse
$env:DSH_CONDOPT_VERIFY_ROOT = $t; node dev/verify-host.mjs; Remove-Item Env:DSH_CONDOPT_VERIFY_ROOT
```
- 覆盖的断言组（每条都在真实导出上跑）：

| 组 | 断言要点 |
|---|---|
| 导出面 | `resolveRoot`/`resolveRunDir`/`EXEC_COMMANDS`/`buildExecArgv`/`splitDashboardHtml`/`parseJsonLoose`/`listStudies`/`renderView`/`createHandler`/`CondoptError`/`apply` 都在；`inject=['webServer','tools']` |
| `resolveRoot` | v1.4 七级顺序：arg→env→config→**插件父目录（`opts.selfDir` 可隔离）**→会话 cwd（`cwd`/`sessionCwd`）→workspace 列表（数组/取值函数/`{list()}`/`ctx.get('workspaceRegistry')` 四种形态）→`process.cwd()`，各自 `source` 正确；`isRoot` 覆盖；`resolveRoot('<path>')` 旧式调用；全不合法 → `{root:null, source:'none', code:'root-not-found'}`；chdir 到非法目录时仍能靠插件父目录命中仓库根 |
| `resolveRunDir` | 相对/绝对/`.` 接受；`..`、`../outside`、绝对越界、`a/../../b` 全部 `throw code='run-out-of-root'` |
| `EXEC_COMMANDS` | 恰好 17 键；`fork/import/retune/transfer*/prepare/template` 不在表内；v1.2 全部 `json:true` |
| `buildExecArgv` | 17 条命令的 argv 逐项精确（含 v1.2 的 `override --params`/`--json`、`knee-weights --json`）；`--run` 原样透传；`--out` 逐命令精确；`pareto/export/render` 的 `--out` 不在 run 目录（零写入） |
| 校验负例 | `override` 缺 reason / params 非对象 / 坏 JSON；`ask` n 非数字/0/-1/超 100000/Infinity、plate 注入字符；`confirm n=0`；`decisions limit=0/1001`；`init budget=0/batch=0`；`route batch=0`；`tell/predict` 路径逃逸；`digest format=pdf/json`；`knee-weights` 坏 weights；`init` 缺 budget/algorithm 非法；未知命令 → `command-not-allowed`；未知参数键 → `bad-param`；不接受直传 argv |
| `splitDashboardHtml` | 多 `<style>` 按序拼接、`<body>` 内切分、无 `<body>` 时取 `</head>` 之后、空串不抛 |
| `parseJsonLoose` | 纯 JSON/前后噪声/数组/坏输入→null/多候选/stdout 空 + stderr JSON |
| `listStudies` | 只收含 `problem.json` 或 `dataset.jsonl` 的目录；mtime 倒序；9 个字段齐全 |
| `apply` + 工具 | 注册 `prefix /condopt`；`condopt_view` 的 parameters/output/isConcurrencySafe/presentationMeta 形状；`execute` 真跑（只读子命令）返回 `{text,run,root,warnings}`、text 紧凑 Markdown（无整份 HTML/<style>）、零写入 run 目录 |
| `createHandler` | 404（未知路径/前缀本身/**POST 到只读路径**）、405（PUT/DELETE/PATCH）、JSON 错误体 `{error,code}`；health（含 `allowExec=true/false`、不带 root 也能 200）/studies/spec 真跑；`/api/view` 逃逸 400；exec 的 `command-not-allowed`/`bad-param`（含空 run 串）/`run-out-of-root`/非 JSON 体/`exec-disabled`；409 `root-not-found` |
| 真机 python | `decisions` 经 `/api/exec` 真跑（`{ok,argv,exitCode:0,data}`）；`/api/study` 四个子字段非 null、`step===null`、零写入 run 目录；`renderView` 真渲染 + 二次 `cached:true` + 零写入；不存在的 run → `render-failed/502` |

- **已知限制 / SKIP 语义**：若 harness 进程所在沙箱禁止 Node `spawn(stdio:'pipe')`（Windows DSH 文件沙箱下会
  `EPERM`），真实子进程断言会打印 `SKIP … 沙箱内 spawn EPERM` 并**不计失败**；此时 A2 的纯函数/路由分派仍全跑。
  要在完整环境里跑真机项，请在非沙箱终端（或让 Lead 在 GUI 宿主环境）执行同一命令。

## A3 浏览器侧 harness（`node dev/verify-client.mjs`）

```powershell
cd <dsh-plugin-dir>
node dev/verify-client.mjs
```

- 期望：末尾 `verify-client: N/N 通过，0 失败`，exit 0。
- **当前结果（v2.0）：PASS，100/100，0 失败**；**（v3.0 第一波）：PASS，127/127，0 失败**（v1.4 快照为 70/70）。
- 技法：`node:vm` + stub `window.__ModuleLoader__`/`document`/`fetch`/最小 React（`createElement`、
  hooks、`Fragment`、`forwardRef`…），hooks 按组件函数身份分槽，`plugin.apply(假 Cordis ctx)` 后真的渲染面板。
- 覆盖的断言组：

| 组 | 断言要点 |
|---|---|
| 信封 | `__ModuleLoader__.load({id:'dsh-condopt', factory})` 被调用；factory 只 `require('react')`；返回 `{apply}` |
| 注册面 | `slots.register('sidebar.right.pane.tab', key+'/panel', locale:'condopt')`、`('tool.call.toolview', key:'condopt_view')`；`sidebarRightTabs.register({id,kind:'condopt',title})`；`commandUi.register({name:'condopt', ui:{kind:'action', run}})`；命令 run 触发 `openRightbar` + `openTab('condopt')` |
| locale | `ctx.locale.register('condopt', {zh,en})`；zh/en 键集合完全一致；`locale/*.json` 合法且两文件键一致 |
| 样式 | 注入带 `data-plugin-css="dsh-condopt…"` 的 `<style>`；teardown 时移除 |
| 面板渲染（v3.0） | 首次/数据到达后/渲染均不抛；请求 `/api/studies`、`/api/study`；**挂载面板后 `/api/view` 调用次数 = 0**（摘要默认，DESIGN §8.7 H/J）；摘要页渲染 study 名/算法/预算/最优/待回填/`stateToken` 前 8 位且不含 dashboard 正文；切到「视图」页后 `/api/view` = **1**（懒加载） |
| 视图 iframe（v3.0） | 视图用 `<iframe>`：`sandbox === 'allow-same-origin'`（**精确值**，无 allow-scripts/forms/popups）、`referrerPolicy='no-referrer'`、`srcDoc` 含 CSP meta（`default-src 'none'`）+ `<style>`/css + `<body>`/html、**不含 `<script`**；全局 `document.body` 未被污染 |
| 设置页（v3.0） | `settings.section` slot 注册（`id:'condopt'`、`order:60`、locale）、组件渲染不抛；读取 `/api/diagnostics` 并渲染 root 路径/候选表；`configForms` 缺失时给配置说明而不是抛；本页只读（无 POST） |
| 参数页交互 | 切到「参数」子页签 → 出现动作按钮组；点击向 `POST /condopt/api/exec` 发请求；存在 `command:'ask'` 且 body 形状 `{run,command,params}`、不含直传 argv；无未捕获异常 / 无 unhandledRejection |
| 执行开关（v1.3） | health 回 `allowExec:false` 时，ask/confirm/override/auto/step 五个写按钮**全部 disabled**、显示 `panel.execDisabled` 提示、点击不发 POST |
| override 内层 params（v1.2） | 改 schema choice 控件（kernel→rbf）+ 填理由 → POST `override` 的 `params.params.kernel === 'rbf'`、`algorithm/reason` 齐全、无直传 argv |
| 决策页 | 触发 `GET /condopt/api/study` |
| 工具卡 | `condopt_view` 卡渲染不抛、不把整份 dashboard HTML 塞进来 |

- 已知限制：harness 用假 React 求值组件树（不是真 DOM/真调度），能覆盖注册、数据流、事件回调、
  iframe 的 `sandbox`/`srcDoc` 契约；**像素级布局/样式与 iframe 内真实排版**不在覆盖内（那需要 A7 真机目视）。

## A2/A3 的 v2.0 新增断言（DESIGN §8.6）

v2.0 的断言就在同两条命令里跑（`node dev/verify-host.mjs` / `node dev/verify-client.mjs`），下表单列以便对账。

**Host（A2）**

| 组 | 断言要点 |
|---|---|
| `stateToken` | 导出存在；16 位 hex；同目录稳定；随 size / mtime 变化；四文件全缺（目录存在）→ 稳定且与有数据目录不同；整个 run 目录不存在 → 空串 `''`（未知，DESIGN §8.6A 定稿） |
| **激活期惰性（真机 A7 P0 回归）** | 用 Proxy 仿 cordis（属性式访问未 inject 的服务即抛 `cannot get property "X" without inject`）：`apply` 不抛、注册路由/工具各 1、**激活期 `ctx.get` 调用 0 次**；`ctx.get('agents')` 返回对象 / `undefined` / **抛错** 三形态都不冒泡；**不带 `sessionId` 的请求不访问 agents**，带 `sessionId` 才软访问；`agents` getter 抛错时 `/api/health` 仍 200（第 5 级静默跳过） |
| `/api/study` v2.0 字段 | `stateToken === stateToken(runDir)`；`current` 含 9 个约定字段、`algorithm` 非空、数值字段为 number/null；缺数据 run → `current` 为 null 或 9 键全 null（不伪造数值） |
| `expect` 令牌 | `ask/confirm/override/auto/step/tell` 六条：`expect` 与当前令牌不等 → 409 `{code:'state-changed', stateToken}`；匹配 → 放行；未带 `expect` → 不校验（非 409）（后两条需可写 `runs/`） |
| `tell` 校验（写前拒绝） | `resultsText` 空串 / 5001 行 / 不可解析 / 超 2,000,000 字符 → 400 `bad-param`；**`results` 与 `resultsText` 同时给 → 400**（§8.6B 冻结的互斥） |
| `tell` 契约冻结项 | `expect` 在 body 顶层且**不进 argv**；`reason` 只做审计留痕、**不进 argv**；CSV 回填必须带条件列（harness 动态从 pending 的 `x` 生成列，JSON/JSONL 只需 `{id,y}`） |
| 辅助导出（host-dev 提供） | `parseResultsText`：JSON 数组 / JSONL / CSV / TSV → `{format,ext,rows}`，空串/空数组/不可解析 → `bad-param`；`readCurrent(runDir)` 含 9 键且 `algorithm` 非空 |
| `tell` 三种形态真跑 | JSON 数组 / JSONL / CSV（含 `id` + 条件列）各真跑一次：200 + `receipt`；`resultsRows` = 回填记录数；`format` 对应；`pendingBefore/After`、`datasetBefore/After` 与宿主独立读取一致；`acceptedRows === datasetAfter-datasetBefore` 且 `0 ≤ acceptedRows ≤ resultsRows`；`stateTokenBefore/After` 与实际一致；`<tmpdir>/dsh-condopt-tell` 无残留文件 |

**Client（A3）**

| 组 | 断言要点 |
|---|---|
| 参数页四块 | 「当前 study / 下一批参数 / 算法覆写 / 新建 study」四块都渲染；当前块显示 `stateToken` 前 8 位与 `current.algorithm`；新建块默认只「复制命令」 |
| override diff | 未改字段 → `override` 请求不带内层 `params`；改一个 schema 字段（kernel→rbf）→ `params.params` **只含 kernel**，不含未改动的默认字段 |
| `expect` 随写动作 | 五个写动作（ask/confirm/override/auto/step）都 POST，且每个 body 的 `expect === /api/study` 的 `stateToken`；study 的 `stateToken` 为空串（未知）时**不发 `expect`** |
| tell 预览 + 回填 | ask 成功后出现 textarea；粘贴 JSONL → 预览含行数、`jsonl` 形态、令牌前 8 位；「确认回填」→ `POST {command:'tell', params:{resultsText, expect}}`；回执字段出现在面板 |
| 409 `state-changed` | 写操作收到 409 → 该次点击只有 1 个 POST（**不重试**）、显示「状态已变化/已刷新」、之后出现 GET study/view 刷新 |
| 工具卡交接 | 有「在条件优化面板中打开」按钮；点击触发 `layout.openRightbar` + `openTab('condopt')`；再挂载面板时按该 run 取视图（demo，而非 studies 首条 demo_moo） |

- **环境限制（重要）**：两类断言会 `SKIP` 且**不计失败**：
  1. **找不到 condopt 检出**（独立 clone / 发布仓库 fresh clone）→ 真 CLI 与写路径 SKIP，文案见上；
     纯离线断言照跑，进程仍 exit 0。
  2. **`<root>/runs` 不可写**（DSH 文件沙箱）→ `expect 放行/不校验、tell 三形态、临时文件清理` SKIP。
  两种都能靠 `DSH_CONDOPT_VERIFY_ROOT` 指向一个合法（且可写的）condopt 根绕过；等价全绿为 `315/315`（真仓库布局）
  或 `314/314`（独立 clone 布局）。

## A2/A3 的 v3.0 第一波新增断言（DESIGN §8.7 G/H/I/J）

**Host（A2）：`GET /condopt/api/diagnostics`**

| 组 | 断言要点 |
|---|---|
| 未命中 root | 用注入 `selfDir`+空 `workspaces`+chdir 空目录让七级全不合法：**仍 200**（诊断不因 root 缺失而 409/500）、`candidates` 七级齐全且顺序 = request/env/config/self/session/workspace/cwd、`valid` 全 `false`、`root.source==='none'` |
| 命中 root | 形状：`ok:true`、`plugin{name='dsh-condopt', version===package.json version, node, dshEngine}`、`root{path,source}`、7 个候选 `{level,path,valid:boolean,detail}`（合法 detail=`ok`、不合法 ∈ `not-a-condopt-root|missing`）、`python{spec,ok,probe}`、`cli{path,ok}`、`condopt.version`、`env{CONDOPT_ROOT,CONDOPT_PYTHON}`、`allowExec`、`degraded[]`；`root.source`/`root.path` 与候选表一致 |
| 探测失败 | 假 spawn 返回 `{ok:false,code:1}` → **200** 且 `python.ok===false`（不 500） |
| 探测挂起 | 假 spawn 返回永不结算的 Promise → **不挂起**（<12s，契约 5s 超时）且 `python.ok===false` |
| 只读 | 该端点调用前后 run 目录快照一致（零写入）；记录型 spawn 断言 argv 里**没有 `render`**；`allowExec=false` 时 `allowExec` 如实为 `false` |

**Client（A3）**

| 组 | 断言要点 |
|---|---|
| 摘要默认 | 挂载面板 `/api/view` = **0**；请求 `/api/studies`+`/api/study`；摘要渲染 study 名/算法/预算/最优/待回填/`stateToken` 前 8 位；不含 dashboard 正文 |
| 视图懒加载 + iframe | 切到视图页 `/api/view` = **1**；`iframe.sandbox` 精确 `allow-same-origin`、`referrerPolicy='no-referrer'`、`srcDoc` 含 CSP meta(`default-src 'none'`)+`<style>`+`<body>`、不含 `<script`；无 shadow DOM 污染 |
| 设置页 | `settings.section`（`id:'condopt'`、`order:60`）注册、渲染不抛、读 `/api/diagnostics`、`configForms` 缺失给说明、只读无 POST |
| 源码级 | `client.js` 全文 **不含 `attachShadow`**（DESIGN §8.7 I） |

- **当前结果**：Host（A2）`304/310 通过，0 失败，6 SKIP`（可写临时根 `342/342`；6 组真写入因沙箱禁写 `runs/`）；Client（A3）`127/127 通过，0 失败`。证据 sha：`index.js 78C23FC3…`、`client.js ECDAAC44…`。

## A4 真实视图管线（纯读）

```powershell
cd <condopt-root>
$tmp = Join-Path $env:TEMP ('condopt-view-' + [guid]::NewGuid().ToString('N'))
py -3 scripts/run_condopt.py render --run runs/demo_moo --out $tmp --no-png --json
$html = Get-Content (Join-Path $tmp 'dashboard.html') -Raw
@{ chars = $html.Length; styles = ([regex]::Matches($html,'<style')).Count; hasBody = [bool]([regex]::Matches($html,'<body').Count) } | ConvertTo-Json
```

- 期望：JSON 行有 `"out"`；`dashboard.html` 存在且 `chars > 0`、`styles ≥ 1`、`hasBody = true`。
- 等价 harness 断言：A2 的 `renderView 真实渲染 demo_moo`（断言 `css/html` 非空、`html` 无 `<body>`、
  `bytes>0`、二次 `cached:true`、run 目录零写入）。
- 当前结果：**PASS**（`demo_moo` 实测 `dashboard.html` 约 26 KB）。
- 限制：`--out` 必须指向临时目录，绝不要写 run 目录（零写入不变量）。

## A5 仓库门禁不被污染

```powershell
cd <condopt-root>
py -3 scripts/release_check.py
py -3 -m pytest -q
```

- 期望（DESIGN §8）：`release_check` 19/19；pytest 全绿。**冻结实测为 17/19，2 项差额已逐条归因到并行 workbench，见下。**
- **最终实测（2026-11-20 00:2x，Lead 在非沙箱 / danger-full-access 下完整跑完）：`release_check: 17/19 passed`。**
  两项红**均与本插件无关**：
  1. `readme_test_count: README=585 collected=605` —— 20 条差额全部来自并行 workbench 工作流新增的
     `tests/test_workbench.py`（`pytest --collect-only -q | Select-String workbench` → `tests/test_workbench.py: 20`；
     `dsh-plugin/` 内 .py 文件数 = 0）。
  2. `evidence_claims: verify_evidence 24/25 claims hold in 592.4s` —— 复跑 condopt 研究证据声明，与 JS 插件无因果关系。
  其余 17 项全 OK（含 pytest、`docs_links 127 files/0 broken`、`release_notes`、`status_snapshot`、
  `decision_matrix`、`evidence_policy`、`skill_install`）。
- **结构性证据**：门禁脚本只扫 `docs/ research/ skill/ examples/ README.md RELEASE_NOTES.md`
  （`check_docs_links.py:SCAN_DIRS`、`check_doc_counts.py:DOCS`），**不扫 `dsh-plugin/`**；
  插件目录只有 3 个 .md（DESIGN/README/VERIFY）与 0 个 .py。
- 沙箱限制（仅供复现参考）：在 DSH 文件沙箱里跑同两条命令会得到 `10~11/19` 与 `pytest exit 1`，
  失败全是 `PermissionError`（pytest tmp / `<agent-library>` / `runs/e2e_drill`）——那是沙箱拒绝写，不是门禁缺陷。

## A6 独立性（`git status --short`）

```powershell
cd <condopt-root>
git status --short
```

- **最终实测**：`?? dsh-plugin/` 是本插件唯一新增。其余条目全部来自并行的 workbench 会话：
  ` M .gitignore`、` M README.md`、` M RELEASE_NOTES.md`（改动时间 00:18:33，本组三个队友的写入范围都不含它）、
  `?? docs/WORKBENCH.md`、`?? docs/_fs_probe.txt`、`?? tests/test_workbench.py`、`?? workbench/`。
- T3 的全部写入仅限：`dsh-plugin/dev/**`、`dsh-plugin/README.md`、`dsh-plugin/docs/VERIFY.md`；
  `index.js`/`client.js`/`locale/` 由 host-dev/client-dev 写入，verifier 未改。
- 限制：`runs/` 在 `.gitignore` 内，所以“run 目录零写入”无法靠 `git status` 证明，只能靠 A2 的目录快照断言
  （`GET /api/study`、`renderView`、`condopt_view.execute`、`/api/exec decisions` 四处都有 before/after 快照比较）。

## A7 真机（Lead 执行；客户端渲染由用户刷新后目视确认）

1. 装进 desktop profile（见 [`../README.md`](../README.md) 安装节），重启 DSH / 刷新
   `http://127.0.0.1:59280`。
2. 接口：

```powershell
Invoke-RestMethod http://127.0.0.1:59280/condopt/api/health  | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:59280/condopt/api/studies | ConvertTo-Json -Depth 4
Invoke-RestMethod 'http://127.0.0.1:59280/condopt/api/view?run=runs/demo_moo' | Select-Object run,cached,bytes,warnings
Invoke-RestMethod 'http://127.0.0.1:59280/condopt/api/study?run=runs/demo_moo' | Select-Object run,step,warnings
```

- **最终实测（Lead，真机 desktop profile）**：
  - `GET /api/health`（**不带 root**）= **200**，`root=<condopt-root>`、`version=0.1.0`、`allowExec=true`；
  - `/api/spec` = 200（18 个算法）；
  - `/api/view?run=runs/demo_moo` = 200（`bytes=26231`、`css=2045`、`html=22887`）；
  - `/api/study?run=runs/demo_moo` = 200（`step:null` 默认零写入、`warnings=0`）；
  - 宿主 `config.allowExec` disable→enable 重载后即时生效；激活期 P0（`ctx.agents` 属性式访问 → 条目激活失败）已修：修复前 `1 entry did not activate / cannot get property "agents" without inject`，修复后 `application: applied`。

**v2.0 垂直切片真机实测（Lead，全程 HTTP 面板路径、未回终端）**

| 步骤 | 实测 |
|---|---|
| `GET /api/study?run=runs/_plugin_e2e_lead` | token `824dd77f52fc5ae8`、algorithm=bayes、nObs=0、pending=0 |
| `POST /api/exec {ask,n:3,expect:token}` | `ok=true`；argv=`ask --run runs/_plugin_e2e_lead --n 3 --json`；pending 0→3；token 轮换 `824dd77f…`→`e217f5ac…` |
| 用**旧令牌**再 `ask` | **409 `state-changed`**，回包带新 `stateToken`，run 零状态变化 |
| `POST /api/exec {tell, resultsText:3 行 JSONL, expect:新令牌}` | `ok=true`；argv 指向 `%TEMP%\dsh-condopt-tell\<hash>\results-*.jsonl`；receipt：rows=3 / format=jsonl / pending 3→0 / dataset 0→3 / acceptedRows=3 / token `e217…`→`0e27c84364547e2f` |
| `GET /api/study` + `/api/view` | nObs=3、pending=0、warnings=0；view `bytes=14555`（css 2045 / html 11507） |
| 清理 | scratch study 已删；`runs/` 无 `__dsh*`/`_plugin*` 残留；`%TEMP%\dsh-condopt-tell` 残留文件数 0 |
- 3. GUI：侧栏出现「条件优化」tab → 视图页出图（shadow DOM）；参数页按钮可用；决策页有时间线；
  `/condopt` 命令能打开右栏。**浏览器侧 tab 出图需用户刷新页面后目视确认**（Lead 已在对话里给出步骤）；
  自动化 harness（A3）只能证明注册、数据流、事件回调与 shadow 写入，不能替代像素级目视。
- 注意：真机上 `POST /api/exec` 的写命令会真的改 `runs/<id>/`；验证 `step`/`override`/`init` 时请用一次性
  study，或先设 `allowExec=false` 验证禁用态（403 `exec-disabled` + 按钮灰）。

## 附：验收证据留档建议

```powershell
cd <dsh-plugin-dir>
node dev/verify-host.mjs   *> verify-host.log
node dev/verify-client.mjs *> verify-client.log
```

日志里每行 `ok/FAIL/SKIP/NOTE` 都带断言名，足以逐条对账；`FAIL` 行同时给出「期望/实际」。

