# dsh-condopt 设计契约（v1，冻结）

> 本文件是 **host/client/verifier 三方共同遵守的接口契约**。任何一方要改契约，先改本文件并由 Lead 确认。
> 目标：把 `condopt` 包成 **独立** 的 DSH 插件——复用 `dsh-model-council` 已有的前端骨架（
> `window.__ModuleLoader__.load` 信封、`ctx.locale` 字典、右侧栏 tab、`/命令`、`tool.call.toolview` 卡），
> 不动 council 仓库、不动 condopt 既有文件（本目录 `dsh-plugin/` 之外一律只读）。

## 0. 身份

| 项 | 值 |
|---|---|
| npm 包名 | `dsh-condopt` |
| cordis 条目 id | `condopt` |
| client module id | `dsh-condopt` |
| 右侧栏 tab kind / id | kind=`condopt`，id=`dsh-condopt/panel` |
| HTTP 前缀 | `/condopt`（`webServer.register({kind:'prefix', path:'/condopt'})`） |
| locale namespace | `condopt` |
| agent 工具名 | `condopt_view`（只读，v1 唯一工具） |
| engines.dsh | `>=0.2.2-rc.1 <0.3.0`（与 council 一致） |

## 1. 文件与写入范围（互不重叠）

```
dsh-plugin/
  package.json            # Lead
  cordis.patch.yml        # Lead
  DESIGN.md               # Lead（本文件）
  LICENSE                 # Lead
  icon.svg                # Lead
  index.js                # host-dev
  client.js               # client-dev
  locale/zh.json          # client-dev
  locale/en.json          # client-dev
  dev/verify-host.mjs     # verify-dev
  dev/verify-client.mjs   # verify-dev
  dev/fixtures/*.json     # verify-dev
  README.md               # verify-dev
  docs/VERIFY.md          # verify-dev
```

不在上表的文件不得新建（`_work/` 下可放临时探针，用完删）。

## 2. 定位 condopt 根目录（`resolveRoot`）

**顺序**（host-dev 实现，export 出来给 harness 单测）：

1. 请求参数 `root` / 工具参数 `root`
2. 环境变量 `CONDOPT_ROOT`
3. 插件 config 的 `projectRoot`（无 Config schema 时从 `apply(ctx, config)` 的 config 上按 key 读，缺失不报错）
4. **插件自身所在目录的上一级**（`dsh-plugin/` 的父目录；本机以 `link:` 装进 profile 时它正好是 condopt 仓库根，开箱即用；从 npm 装时该路径不是 condopt 根，自动跳过）
5. 当前会话工作目录（请求带 `sessionId` 时按 `ctx.agents.get(id).session.header.cwd` / `workingDirectory` 解析；拿不到跳过）
6. `ctx.get('workspaceRegistry').list()` 里第一个满足合法性检查的工作区路径
7. `process.cwd()`

**合法性**：目录下同时存在 `scripts/run_condopt.py` 与 `src/condopt/cli.py`。
全部候选都不合法 → 错误 `code: 'root-not-found'`，HTTP 409。

**Python 调用**：`process.env.CONDOPT_PYTHON`（默认 win32 用 `py -3`、其它用 `python3`），
执行 `py -3 <root>/scripts/run_condopt.py <argv...>`，`cwd=<root>`，env 追加 `PYTHONUTF8=1`。
参数一律走 `spawn`(argv 数组)，**任何情况下不经过 shell**。

## 3. 读接口（全部 JSON；错误体 `{error, code}`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/condopt/api/health` | `{ok, root, python, version, runsDir, cli, allowExec}`；`allowExec` 是 §5 执行开关的当前值（客户端据此在打开面板时就禁用按钮，而不是等第一次点击收到 403）；`version` 取 `pyproject.toml` 的 `version = "..."`，读不到给 `''` |
| GET | `/condopt/api/studies` | `{root, runs:[Study]}`，`Study = {id, rel, abs, mtime, nObservations, algorithm, objective, budget, best}`；扫描 `<root>/runs/*`，只收含 `problem.json` 或 `dataset.jsonl` 的目录；按 mtime 倒序 |
| GET | `/condopt/api/spec` | 原样返回 `spec --json` 的解析结果（算法目录 + 参数 schema，供前端生成表单） |
| GET | `/condopt/api/view` | `{run, rel, abs, generatedAt, cached, bytes, css, html, warnings[]}`；见第 4 节 |
| GET | `/condopt/api/study` | `{run, report, decisions, pareto, pending, step, warnings[]}`；`report` 来自 `report --json`，`decisions` 来自 `decisions --json --limit 20`，`pareto` 来自 `pareto --json --out <tmp>/pareto_front.csv`（**必须给 `--out`，否则会写 run 目录**），`pending` 来自 `pending --json`；`step` **只在 `?step=1` 时调用**（它会写 `run/step.json`，默认不调=默认零写入）。任一子调用失败记到 `warnings` 并把该字段设为 `null`，整体仍 200 |
| POST | `/condopt/api/exec` | 见第 5 节 |

方法语义：未知路径 → 404；**GET/HEAD/POST 之外的动词**（`PUT/DELETE/PATCH` 等）→ 405；`POST` 到只读路径
（如 `POST /api/health`）→ 404（只有 `/api/exec` 接受 POST；实现如此，端到端已实测）。

`run` 参数一律是 **`<root>/runs` 下的相对路径或绝对路径**，统一走 `resolveRunDir(root, run)`：
`path.resolve` 后必须仍位于 `<root>/runs` 之内（`..` 逃逸 → 400 `run-out-of-root`）。

## 4. 视图管线（复用 condopt 自己的渲染器）

`renderView(root, runDir, {force})`：

1. 缓存键 = runDir 绝对路径；缓存目录 `<os.tmpdir()>/dsh-condopt-view/<sha1(runDir).slice(0,16)>/`。
2. 失效判定：`problem.json/config.json/dataset.jsonl/rounds.json/pending.json/decisions.jsonl/step.json/decision.json` 中最大 mtime > 缓存记录时间 → 重新渲染；`force=1` 强制。
3. 渲染命令：`render --run <rel-run> --out <cacheDir> --no-png --json`（**不写 run 目录**）。
4. 读 `<cacheDir>/dashboard.html`：
   - `css` = 所有 `<style ...>…</style>` 内容拼接（保留出现顺序）；
   - `html` = `<body ...>` 与 `</body>` 之间的内容（无 `<body>` 时取 `</head>` 之后全文）；
   - 两边都为空 → `code:'view-empty'` 500。
5. 渲染失败（非 0 退出）→ 502，`{error, code:'render-failed', stdout, stderr}`；**不要**回退成自造 HTML。

客户端把 `css` 与 `html` 一起写进 **shadow root**，避免污染 DSH 页面样式。

## 5. 写接口 `POST /condopt/api/exec`

请求体：`{root?, run, command, params?, reason?}`。

- `command` 必须在白名单表里（下表）；表由 `EXEC_COMMANDS` 导出，harness 直接单测。
- 值校验：计数类整数（`n`/`batch`/`budget`/`limit` 等）∈ `[1, 100000]`（`limit` ∈ `[1, 1000]`）；其余数值参数
  `Number.isFinite` 且 ≤ 100000；枚举查 `choices`；普通字符串
  `^[A-Za-z0-9_.:\-\\/\u4e00-\u9fa5 ]{0,200}$`；JSON 类参数（`config`/`params`）必须先 `JSON.parse`
  再紧凑重排；`weights` 形如 `yield=2,cost=1`（`^[\w\u4e00-\u9fa5]+=[0-9.]+(,[\w\u4e00-\u9fa5]+=[0-9.]+)*$`）；
  路径类参数必须落在 `<root>` 内；`run` 为空字符串 → 400 `{code:'bad-param'}`。任何校验失败 → 400 `{code:'bad-param'}`。
- 拼 argv 只允许查表 + 追加 `--json`（若该命令支持），**不接受调用方直接传 argv**。
- **零写入不变量**：凡是有 `--out` 且默认写进 run 目录的子命令（`pareto` / `export` / `template` /
  `digest` / `render`），argv 里必须显式给 `<tmpdir>` 下的 `--out`。`step` 没有 `--out`，因此只在
  显式请求时才允许调用（见 §3 `/api/study?step=1` 与工具 `include:['step']`）。
- 返回 `{ok, argv, exitCode, stdout, stderr, data}`；`data` 是 stdout 能解析出的 JSON（解析不了为 `null`）。

白名单（**v1.1：已按 `src/condopt/cli.py` 实测口径修正**，下表即唯一真相）：

| command | 允许的 params | 生成 argv |
|---|---|---|
| `route` | `space`(root 内文件), `budget?`, `batch?`, `smoothness?`, `noise?`, `domain?` | `route [--space p] [--budget n] [--batch n] [--smoothness s] [--noise s] [--domain s] --json` |
| `init` | `space`(root 内文件), `objective`, `budget`, `batch`, `algorithm?`, `params?`(JSON) | `init --run <r> --space <p> --objective <o> --budget n --batch n [--algorithm a] [--params <json>] --json` |
| `ask` | `n?`, `plate?` | `ask --run <r> [--n n] [--plate P] --json` |
| `tell` | `resultsText`(内容，非路径，1–2,000,000 字符，≤5000 行) 或 `results`(root 内文件) | `tell --run <r> --results <tmp 或 root 内文件> --json`；带 `resultsText` 时宿主写 tmp 并在调用后删除（§8.6B） |
| `confirm` | `n?` | `confirm --run <r> [--n n] --json` |
| `override` | `algorithm`, `params?`(JSON 对象), `reason`（**必填**） | `override --run <r> --algorithm <a> [--params <紧凑 JSON>] --reason <r> --json` |
| `auto` | — | `auto --run <r> --json` |
| `step` | — | `step --run <r> --json` |
| `recommend` | — | `recommend --run <r> --json` |
| `predict` | `config`(JSON 对象) | `predict --run <r> --config <紧凑 JSON> --json` |
| `knee-weights` | `weights`(形如 `yield=2,cost=1`) | `knee-weights --run <r> --weights <w> --json` |
| `digest` | `format?`(`md`/`html`) | `digest --run <r> --out <tmp>/digest.<ext> --format f --json` |
| `export` | — | `export --run <r> --out <tmp>/dataset_export.csv --json` |
| `pareto` | — | `pareto --run <r> --out <tmp>/pareto_front.csv --json` |
| `doctor` | — | `doctor --run <r> --json` |
| `decisions` | `limit?`, `action?` | `decisions --run <r> [--limit n] [--action a] --json` |
| `render` | — | `render --run <r> --out <cacheDir> --no-png --json` |

> v1.3 修订记录（2026-11-19，client-dev 反馈，Lead 裁定）：`/api/health` 增加 `allowExec`（打开面板即可禁用按钮），
> 修正客户端 `confirm` 的本地 argv 预览补 `--json`（与服务端 argv 一致，纯展示）。
>
> v1.2 修订记录（2026-11-19，host-dev/client-dev 反馈，Lead 裁定）：
> ① `override` 增加可选 `params`（JSON 对象 → 紧凑字符串），让「参数可调」真的能落到算法超参上（`init --params` 只能建新 study）；
> ② `override`/`auto`/`knee-weights` 补 `--json`（CLI 支持，回包 `data` 才有结构）；
> ③ `/api/study` 内部 `pareto` 的 `--out` 允许 `<tmp>/dsh-condopt-view/<sha1(run)[0:16]>/pareto_front.csv`（按 run 隔离，仍在 tmpdir、仍零写入）——采纳 host-dev 实现。
>
> v1.1 修订记录（2026-11-19，host-dev 实测反馈，Lead 裁定采纳）：`ask` 是 `--n` 不是 `--batch`；
> `predict` 是 `--config <JSON>` 不是 `--point`；`digest --format` 只接受 `md|html`；
> `knee-weights` 是 `名称=权重` 逗号串；`pareto/export` 加 `--out` 以守住零写入。
> 初版表格里 `fork`/`import`/`retune`/`transfer*` 仍不在 v1 白名单内。


> 未在白名单的命令（含 `transfer*`、`fork`、`import`、`retune`）v1 一律 403 `{code:'command-not-allowed'}`，
> 需要时由 Lead 加表并同步本文件。

**执行开关**：`config.allowExec === false` 时 `/api/exec` 返回 403 `{code:'exec-disabled'}`（面板按钮全禁用并提示）。
默认 `true`（写操作必须来自用户显式点击或 `condopt` CLI，插件不自动跑）。

## 6. agent 工具 `condopt_view`

```js
ctx.tools.register({
  name: 'condopt_view',
  description: '读取某个 condopt study 的优化内容视图（进度报告、下一步行动、待回填批次、审计决策、Pareto），
                用于 agent 在调项目材料时拿到最新优化状态。只读，不写 run 目录。',
  parameters: { type:'object', properties: {
    root: {type:'string', description:'condopt 仓库根目录；省略=按 resolveRoot 解析'},
    run:  {type:'string', description:'runs 下的 study，如 demo / demo_moo；省略=取最近修改的一个'},
    include: {type:'array', items:{type:'string', enum:['report','step','pending','decisions','pareto']},
              description:'省略=全部（step 会写 run/step.json，故默认不含；显式要才给）'},
  }, required: [], additionalProperties: false },
  output: { schema: { type:'object', properties: {
      text: {type:'string'}, run:{type:'string'}, root:{type:'string'},
      view: {type:'object'}, warnings:{type:'array', items:{type:'string'}},
    }, required:['text','run','root'] },
    render: (args, value) => [{ type:'text', text: value.text }],
    presentationMeta: (args, value) => ({ run: value.run, root: value.root }),
  },
  isConcurrencySafe: () => true,
  async execute(args, exec) { /* … */ },
})
```

`text` 是给模型看的紧凑 Markdown：study 基本信息 → 预算/最优 → 下一步行动(step 的 `action` 与 `next_command`) →
待回填批次数 → 最近 5 条决策 → 失败/降级说明。**不允许**把整份 dashboard HTML 塞进 `text`。

## 7. 客户端（复用 council 骨架）

- 信封：`window.__ModuleLoader__.load({ id: 'dsh-condopt', factory(require) { … } })`；
  只 `require('react')`（council 同款），不引入构建链。
- `inject: ['slots', 'locale']`；同时 `ctx.inject(['sidebarRightTabs'])`、`ctx.inject(['commandUi'])`。
- 注册（与 council 同款 API，键名不同）：
  - `ctx.slots.register({name:'sidebar.right.pane.tab', key:'dsh-condopt/panel', locale:'condopt'}, CondoptTab)`
  - `sidebarRightTabs.register({id:'dsh-condopt/panel', kind:'condopt', title:()=>tr('tab.title')})`
  - `commandUi.register({name:'condopt', label, description, icon, available:()=>true, ui:{kind:'action', run}})`
    → `layout.openRightbar(true,false)` + `sidebarRight.openTab('condopt')`
  - `ctx.slots.register({name:'tool.call.toolview', key:'condopt_view', locale:'condopt'}, CondoptViewRow)`
  - `ctx.effect(() => ctx.locale.register('condopt', {zh, en}))`，`tr = ctx.locale.bind('condopt')`
  - 样式：一次性 `<style data-plugin-css="dsh-condopt/panel.css">` 注入，teardown 时移除
- 面板结构（`CondoptTab`）：
  1. 头部：标题 / 当前 root / study 下拉（来自 `/api/studies`）/ 刷新 / 自动刷新开关（30s）
  2. 三个子页签：**视图**、**参数**、**决策**
     - 视图：shadow DOM 注入 `/api/view` 的 `css+html`；失败显示错误态 + 「重新生成」（`?force=1`）
     - 参数：算法下拉（`/api/spec`）+ 参数表单（按 `params` schema 生成）+ batch/plate 等控件 +
       动作按钮：生成待测批(ask) / 确认复孔(confirm) / 覆写算法(override+reason) / 恢复自动(auto) / 下一步(step) /
       「复制命令」。所有按钮 → `POST /api/exec`，回显 argv 与 stdout/stderr，成功后刷新视图。
     - 决策：`/api/study` 的 `decisions` 时间线（t/action/algorithm/reason）+ warnings
  3. 空态：没有 runs 时给「先在 condopt 里 `init` 一个 study」的提示与可复制命令。
- 全部可见文字走 locale（zh/en 两份字典 key 必须完全一致，harness 会断言）。
- `tool.call.toolview` 卡：渲染 `condopt_view` 的三段（preparing/start/result），
  参数用 `block.args.text(key)`/`.value(key)` 惰读器（**不是普通对象**），`result` 用 `block.call`。

## 8. 验收（必须全部可执行）

| # | 检查 | 通过标准 |
|---|---|---|
| A1 | `node --check index.js && node --check client.js` | exit 0 |
| A2 | `node dev/verify-host.mjs` | exit 0；覆盖 `resolveRoot`、`EXEC_COMMANDS` 参数校验、`renderView` 的 HTML 切分、`/api/*` 路由分派（用假 `ctx` + 假 spawn） |
| A3 | `node dev/verify-client.mjs` | exit 0；`vm` 加载 client.js + stub `window`/React，断言 tab/命令/工具卡注册、locale 键一致、面板渲染不抛、`/api/exec` 提交路径 |
| A4 | `py -3 dev/verify-view.py`（可选，纯读） | 对 `runs/demo_moo` 跑 `render --out <tmp> --no-png` 后断言 `css`/`html` 非空 |
| A5 | 仓库门禁不被污染 | 加完 `dsh-plugin/` 后 `py -3 scripts/release_check.py` 仍 19/19、`py -3 -m pytest -q` 全绿 |
| A6 | 独立 | `git status --short` 只出现 `dsh-plugin/`（既有文件零改动） |
| A7 | 真机 | 装进 desktop profile 后 `GET http://127.0.0.1:59280/condopt/api/health` 与 `/api/studies` 返回 JSON，GUI 刷新后侧栏出现「条件优化」tab 且能出图（Lead 执行） |

## 8.5 边界：与 `workbench/` 的关系（不许踩）

本仓库里已有（未提交的）`workbench/`（浏览器工作台 + EduKit 前端复用）与 `docs/WORKBENCH.md`。
用户的要求是「**独立于已有的内容**」，因此：

- 本插件 **不 import、不调用、不复制** `workbench/` 的任何文件；`workbench/` 与 `docs/WORKBENCH.md` 一律零改动。
- 两者共用同一份真源（`runs/<id>/`），但各自独立：workbench 是浏览器服务，本插件是 DSH 内置插件。
- 本插件的 `dsh-plugin/` 将来单独开一个 GitHub 仓库发布；condopt 主仓库的内容不因此变更。

## 8.6 v2.0 垂直切片契约（2026-11-20，理事会评审 #1/#2/#6）

目标（唯一验收口径）：**agent 工具卡打开指定 run → 面板显示当前状态与参数来源 → 用户确认 diff 后 ask →
面板内回填 tell → 视图与决策记录更新 → 显示执行回执；全程不回终端。**
其它评审项（sandboxed iframe、摘要卡默认、诊断页、agent 写工具、跨 run 对比）**不在 v2.0 范围**，列 §10 待办。

### A. 状态令牌（防过期面板写入）

- 宿主导出 `stateToken(runDir) -> string`：对 `pending.json` / `dataset.jsonl` / `rounds.json` / `config.json`
  的 `${mtimeMs}:${size}` 串做 sha1 前 16 位；**文件缺失记 `-`，整个 run 目录不存在则返回 `''`（未知）**，
  `/api/study` 对不存在的 run 因此回 `stateToken:''`（客户端把它当「未知」，不参与 `expect` 比较）。
- `GET /api/study` 增加两个字段：`stateToken`，以及 `current`：
  `{algorithm, params, objective, direction, budget, batch, nObservations, pendingCount, remaining}`（取不到给 `null`）。
- `POST /api/exec` 的 body 增加可选 `expect`（字符串）。**凡是会写 run 的命令**（`ask/confirm/override/auto/step/tell`），
  若给了 `expect` 且与当前 `stateToken` 不等 → 409 `{error, code:'state-changed', stateToken}`。
  未给 `expect` 时不校验（保持 CLI 等价语义）；面板对写动作一律带 `expect`。

### B. `tell` 回填（面板 → 宿主 → CLI）

`POST /condopt/api/exec`，`command:'tell'`，params：

| 字段 | 规则 |
|---|---|
| `resultsText` | 字符串，1–2,000,000 字符；**不是路径**；宿主只把它当内容 |
| `expect?` | 状态令牌，见 A |
| `reason?` | 可选审计理由（≤200） |

宿主流程：
1. 校验 `resultsText` 非空、行数 ≤ 5000，且能被下面任一形态解析（宽松但必须至少 1 条记录）：
   JSON 数组 / JSONL（逐行 JSON）/ CSV 或 TSV（表头含 `id` 列）；
2. 写 `<tmpdir>/dsh-condopt-tell/<sha1(runDir)[0:16]>/results-<ts>.<json|jsonl|csv>`，
   调 `tell --run <r> --results <tmpFile> --json`，**调用结束即删临时文件**；
3. 回包在原有 `{ok,argv,exitCode,stdout,stderr,data}` 基础上加 `receipt`：

```json
{"run":"runs/demo","resultsRows":4,"format":"jsonl",
 "pendingBefore":4,"pendingAfter":0,"datasetBefore":24,"datasetAfter":28,
 "acceptedRows":4,"stateTokenBefore":"…","stateTokenAfter":"…"}
```

`pendingBefore/After`、`datasetBefore/After`、`acceptedRows` 由宿主在调用前后自行读取 run 目录得出
（不信任 stdout）；`acceptedRows = clamp(datasetAfter-datasetBefore, 0, resultsRows)`。

补充冻结（v2.0 实测后）：
- `results`（root 内路径）与 `resultsText` **互斥**，同时给 → 400 `bad-param`。
- 内容形态与 CLI 语义一致：**JSON 数组 / JSONL 可以只给 `{id, y}`**（缺的条件列由 CLI 从 pending 建议回填）；
  **CSV/TSV 必须带条件列**（只给 `id,y` 会被 CLI 判为 configuration missing variables）。README 要写清这条。
- `reason?` 只做校验（≤200）与回执留痕，**不传给 CLI**（`tell` 没有对应 flag）；要落进 `decisions.jsonl`
  需要 condopt 侧新增 flag，属仓库外改动，v2.0 不做。

### C. 客户端 v2.0 面板

1. **参数页四块**（互不混用，各自显示生效对象）：
   - *当前 study*：只读展示 `current` 各值（缺则显示「未知」），并显示 `stateToken` 前 8 位；
   - *下一批参数*：`n`、`plate` → `ask`（按钮文案「生成下一批」）；
   - *算法覆写*：`algorithm` + **只标出用户真正改动过的字段**（值与其 spec 默认值不同的项）+ 目标 run + `reason`（必填）→ `override`；
   - *新建 study*：`space/objective/budget/batch`（新 run 名）→ `init`；默认只「复制命令」，点「创建」才执行。
2. **回填区块**：`ask` 成功后出现；textarea 粘贴 JSON/JSONL/CSV；预览显示「目标 run / 行数 / 解析形态 /
   当前 pending 数 / 令牌前 8 位」；「确认回填」→ `tell`（带 `expect`）→ 显示回执（acceptedRows、pending 前后、dataset 前后）
   → 自动刷新视图与决策。
3. **工具卡交接**：`condopt_view` 卡加按钮「在条件优化面板中打开」，用 root+run 打开右侧栏 tab 并选中同一 study
   （模块内 store + `layout.openRightbar` + `sidebarRight.openTab('condopt')`）。
4. **过期状态**：任何写操作收到 409 `state-changed` → 显示「状态已变化，已刷新，请重新确认」，刷新 `study/view`，
   **不重试**原请求。

### D. 边界与不做

- 零写入不变量不变：默认浏览路径不写 run 目录；只有用户显式点击的 `ask/tell/confirm/override/auto/step/init` 会写。
- agent 侧仍只有只读 `condopt_view`，**v2.0 不新增写工具**。
- 不重写 dashboard、不改 shadow DOM 方案、不做跨 run 对比、不做后台循环推进（§10 待办）。

## 9. 已知风险（实现时按此处理）

- **R1 样式污染**：dashboard.html 自带全局 CSS → 必须 shadow DOM。
- **R2 render 耗时**：`demo_moo` 实测约 2s（`--no-png`）→ 必须缓存 + 30s 自动刷新，不做请求内重算。
- **R3 CLI `--json` 失败路径**：错时可能 stdout 为空、JSON 在 stderr → 解析两边，`data=null` 不抛。
- **R4 `step` 会写 run 目录**：默认不调用；只有显式 `include:['step']` 或面板「下一步」按钮才调。
- **R5 DSH 版本漂移**：slot 名/服务名可能随版本变 → 全部 `feature detect`（拿不到服务就跳过注册，不抛）。
- **R6 路径含中文/空格**：所有 `spawn` 用数组参数；JSON 显式 `utf8`；文件名不拼中文。
