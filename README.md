# dsh-condopt

把 [condopt](https://github.com/sprw-li/condopt-router) 的条件优化内容视图搬进 **DeepSeek Harness** 的独立插件：右侧栏面板 +
`/condopt` 命令 + 只读 agent 工具 `condopt_view`。前端骨架复用 `dsh-model-council`（
`window.__ModuleLoader__` 信封、`ctx.locale` 字典、右侧栏 tab、`/命令`、`tool.call.toolview` 卡），
**零运行时依赖**（宿主只 `node:` 内置模块，浏览器侧只 `require('react')`，无构建链）。

契约：[`DESIGN.md`](DESIGN.md)（v2.0，host/client/verifier 三方共同遵守）。验收：[`docs/VERIFY.md`](docs/VERIFY.md)。
理事会产品评审（本产品的改进依据）：[`docs/COUNCIL_REVIEW-2026-11-20.md`](docs/COUNCIL_REVIEW-2026-11-20.md)。

> 文中的占位符：`<dsh-plugin-dir>` = 本仓库/本目录，`<condopt-root>` = 一个 condopt 检出（含
> `scripts/run_condopt.py` 与 `src/condopt/cli.py`），`<agent-library>` = agent-library 技能库根。

## 功能

- **右侧栏「条件优化」tab**（kind `condopt`，id `dsh-condopt/panel`）：
  - **视图**：把 `/condopt/api/view` 返回的 `css+html` 写进 **shadow DOM**（dashboard 自带全局样式，不能污染 DSH 页面）；失败显示错误态 +「强制重新生成」（`?force=1`）。
  - **参数**：算法下拉（`/api/spec` schema 生成）+ 参数表单 + 动作按钮
    `生成待测批(ask)` / `确认复孔(confirm)` / `覆写算法(override，理由必填)` / `恢复自动(auto)` / `下一步(step)` / `复制命令`；
    所有写操作只走 `POST /condopt/api/exec`，并回显 argv 与 stdout/stderr。
  - **决策**：`/api/study` 的 `decisions` 时间线 + warnings。
  - 头部：当前 root / study 下拉 / 刷新 / 30s 自动刷新开关；无 runs 时给「先 `init` 一个 study」的可复制命令。
- **`/condopt` 命令**：`layout.openRightbar(true,false)` + `sidebarRight.openTab('condopt')`。
- **工具 `condopt_view`**（只读，v1 唯一 agent 工具）：返回紧凑 Markdown（study 信息 → 预算/最优 →
  下一步 `action`/`next_command` → 待回填批次数 → 最近 5 条决策 → 降级说明），**不会**把整份 dashboard HTML 塞进 `text`。
  默认不含 `step`（它会写 `run/step.json`），只有显式 `include:['step']` 才调。
  v2.0 起工具卡带「**在条件优化面板中打开**」按钮：带上 `root`+`run` 打开右侧栏并选中同一 study。

## v2.0 垂直切片用法（ask → 回填 → 视图/决策更新）

目标：**全程不回终端**——工具卡带 run 打开面板 → 看当前状态与参数来源 → 确认 diff 后 ask →
面板内粘贴实测结果回填 tell → 视图与决策自动刷新 → 看到执行回执。

1. **参数页四块，各自写清生效对象**（互不混用）：
   - *当前 study*：只读展示 `/api/study.current`（算法/目标/方向/预算/批量/观测数/待回填/剩余），
     并显示状态令牌 `stateToken` 前 8 位；读不到显示「未知」。
   - *下一批参数*：`n` / `plate` → 按钮「生成下一批」（`ask`）。
   - *算法覆写*：算法 + **只列出你真正改动过的字段**（与 spec 默认值不同的 diff）+ `reason`（必填）→ `override`。
   - *新建 study*：`space`/`objective`/`budget`/`batch` + 新 run 名；默认只「复制命令」，点「创建」才执行 `init`。
2. **回填区块**：`ask` 成功后出现。把实测结果（JSON 数组 / JSONL / CSV，CSV 表头需含 `id` 列）粘进
   textarea；预览显示 目标 run / 行数 / 解析形态 / 当前 pending 数 / 令牌前 8 位。点「确认回填」→
   `POST /api/exec {command:'tell', params:{resultsText, expect}}`，面板显示回执
   （`acceptedRows`、`pendingBefore→After`、`datasetBefore→After`、`format`），并自动刷新视图与决策页。
   宿主把 `resultsText` 写成**临时文件**调用 CLI，**调用结束即删**，不污染 run 目录的既有文件。
3. **过期状态保护**：所有写操作（`ask/confirm/override/auto/step/tell`）都带 `expect` = 打开面板时读到的
   `stateToken`。若期间 run 被别的会话改动，宿主返回 **409 `state-changed`**，面板提示「状态已变化，已刷新，
   请重新确认」并刷新 study/view，**不自动重试**原请求。
4. **零写入不变量**：默认浏览路径（health/studies/spec/view/study 无 `?step=1`）不写 run 目录；
   只有你显式点击的 `ask/tell/confirm/override/auto/step/init` 会写。agent 侧仍然只有只读 `condopt_view`，
   v2.0 **不新增写工具**。

## 目录结构

```
dsh-plugin/
  package.json        cordis 条目 id / dsh.bundle+client / exports
  cordis.patch.yml    insert: id=condopt, name=dsh-condopt
  index.js            host：/condopt/api/*、condopt_view、apply(ctx, config)
  client.js           浏览器：tab / 命令 / 工具卡 / locale / shadow DOM
  locale/zh.json      locale namespace `condopt`
  locale/en.json
  dev/verify-host.mjs 宿主侧离线 harness（真加载 index.js）
  dev/verify-client.mjs 浏览器侧离线 harness（node:vm + stub window/React/fetch）
  dev/fixtures/*.json 假 study/view/spec/exec/health/tell/conflict 数据（含 dashboard 片段与 tell 行）
  docs/VERIFY.md      A1–A7 逐条命令与期望
  README.md
```

## 安装

插件是**独立包**，通过 profile 的 `link:` 依赖 + bundle 列表挂载（desktop profile 在
`~/.dsh/profiles/desktop/package.json`）。等价的两条路：

```powershell
# 1) CLI（推荐；把本目录 link 进 desktop profile 并加入 bundles）
dsh plugin --profile desktop add <dsh-plugin-dir>
```

或手工编辑 profile 的 `package.json`（与 `dsh-model-council` 同款写法）：

```jsonc
{
  "dependencies": {
    "dsh-condopt": "link:<dsh-plugin-dir>"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-condopt"]
    }
  }
}
```

装完重启 DSH（或按 profile 热加载提示刷新 Web），侧栏出现「条件优化」tab；
`GET <dsh-web-url>/condopt/api/health` 应返回 JSON（`<dsh-web-url>` 形如 `http://127.0.0.1:<port>`，
端口见 DSH 启动输出；未配置 `CONDOPT_ROOT` 时 `root` 会自动解析到 condopt 检出）。

## 配置（全部可选，缺失不报错）

| 来源 | 键 | 说明 |
|---|---|---|
| 环境变量 | `CONDOPT_ROOT` | condopt 仓库根目录（含 `scripts/run_condopt.py` 与 `src/condopt/cli.py`） |
| 环境变量 | `CONDOPT_PYTHON` | python 解释器；默认 win32 `py -3`，其它 `python3` |
| 插件 config | `projectRoot` | 同上，低于 `CONDOPT_ROOT`、高于会话 cwd |
| 插件 config | `allowExec` | `false` 时 `POST /api/exec` 返回 403 `exec-disabled`，面板按钮禁用并提示；默认 `true` |
| 插件 config | `python` | 同 `CONDOPT_PYTHON` |

root 解析顺序（`resolveRoot`，v1.4 七级）：请求/工具参数 `root` → `CONDOPT_ROOT` → `config.projectRoot` →
**插件自身目录的上一级**（`link:` 装进 profile 时正好是 condopt 仓库根，开箱即用）→ 会话 cwd →
`workspaceRegistry` 的第一个合法工作区 → `process.cwd()`；全部不合法 → HTTP 409 `{code:'root-not-found'}`。

## HTTP 接口

前缀 `/condopt`（`webServer.register({kind:'prefix', path:'/condopt'})`）。
公共 `run` 参数是 `<root>/runs` 下的相对路径或绝对路径，统一走 `resolveRunDir` 围栏：
解析后必须仍在 `<root>/runs` 内，`..` 逃逸 → 400 `{code:'run-out-of-root'}`。

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/condopt/api/health` | `{ok, root, python, version, runsDir, cli, allowExec}`；`allowExec` 让面板打开即置灰写按钮 |
| GET | `/condopt/api/studies` | `{root, runs:[Study]}`；`Study={id,rel,abs,mtime,nObservations,algorithm,objective,budget,best}`，按 mtime 倒序 |
| GET | `/condopt/api/spec` | `spec --json` 的算法目录 + 参数 schema |
| GET | `/condopt/api/view` | `{run,rel,abs,generatedAt,cached,bytes,css,html,warnings[]}`；按 run 目录 mtime 失效 + `?force=1` 强制；`--out` 在系统临时目录（零写入 run 目录） |
| GET | `/condopt/api/study` | `{run,report,decisions,pareto,pending,step,stateToken,current,warnings[]}`；`stateToken` 是 run 状态的 sha1 前 16 位（v2.0），`current` 是当前生效参数（读不到给 null，不伪造）；子调用失败记 warnings 并把该字段置 null，整体仍 200；`pareto` 必须带 `--out <tmp>`；**`step` 只在 `?step=1` 时调用**（它会写 `run/step.json`） |
| POST | `/condopt/api/exec` | `{ok,argv,exitCode,stdout,stderr,data}`；`tell` 额外带 `receipt` |

方法语义：未知路径 → 404；`PUT/DELETE/PATCH` 等非 GET/HEAD/POST 动词 → 405 `method-not-allowed`；
`POST` 打到只读路径（如 `/api/health`）→ 404（只有 `/api/exec` 接受 POST）。

错误体统一 `{error, code}`：`not-found` 404、`method-not-allowed` 405、`root-not-found` 409、
`state-changed` 409（v2.0 `expect` 过期）、`run-out-of-root`/`bad-param` 400、
`command-not-allowed`/`exec-disabled` 403、`render-failed` 502、`timeout` 504、`view-empty` 500。

**`POST /api/exec` 请求体** `{root?, run, command, params?, reason?, expect?}`。`command` 只在白名单表里
（`EXEC_COMMANDS`，17 条：`route/init/ask/tell/confirm/override/auto/step/recommend/predict/
knee-weights/digest/export/pareto/doctor/decisions/render`）；argv 由查表生成，**不接受调用方传 argv**；
`fork/import/retune/transfer*` 等一律 403。`override` 支持可选 `params`（JSON 对象 → 紧凑串，落到算法超参）；
凡自带 `--out` 的子命令（`pareto/export/digest/render`）argv 必须显式给 `<tmpdir>` 下的 `--out`（零写入不变量）。
v2.0：`expect` 是可选的 run 状态令牌，写类命令 `ask/confirm/override/auto/step/tell` 带了它与当前
`stateToken` 不等 → 409 `state-changed`；不带则不校验（CLI 等价语义）。

`command:'tell'` 的 `params` 支持 `resultsText`（**内容**，1–2e6 字符、≤5000 行，JSON 数组 / JSONL /
CSV（表头含 `id`；CSV 必须带条件列，JSON/JSONL 可只给 `{id,y}`）任选其一，**与 `results` 文件路径互斥**）、`reason?`
（只做审计留痕、不传 CLI）；`expect?` 在 body 顶层。宿主写临时文件调用 CLI 后即删，回包 `receipt`
含 `{run,resultsRows,format,pendingBefore,pendingAfter,datasetBefore,datasetAfter,acceptedRows,
stateTokenBefore,stateTokenAfter}`（前后计数由宿主自行读 run 目录得出，不信任 stdout）。

## agent 工具

`condopt_view`：`{root?, run?, include?}`（`include` 枚举 `report|step|pending|decisions|pareto`，
省略=全部但不含 `step`）。只读，返回 `{text, run, root, view, warnings}`。

## 验收

```powershell
cd dsh-plugin
node --check index.js; node --check client.js     # A1
node dev/verify-host.mjs                          # A2：真加载 index.js（可写环境 315/315；受限沙箱 277/283 + 6 SKIP）
node dev/verify-client.mjs                        # A3：node:vm 加载 client.js，100 条断言
node dev/verify-host.mjs --skip-real              # 不跑 python 的纯离线模式
```

其余门禁（A4 真实渲染、A5 仓库门禁、A6 独立性、A7 真机 GUI）见 [`docs/VERIFY.md`](docs/VERIFY.md)。

> 沙箱里 `runs/` 不可写时，A2 的 6 组真写入断言会显示 `SKIP`；把它们跑成真断言的办法：
> 造一个可写临时根（复制 `scripts/`、`src/`、`pyproject.toml`、`runs/demo_moo`），
> 用 `DSH_CONDOPT_VERIFY_ROOT=<那个根>` 指过去再跑 `node dev/verify-host.mjs`（详见 VERIFY.md）。

## 独立性 / 发布

- 本仓库就是插件的独立发布地址：**https://github.com/sprw-li/dsh-condopt**；condopt 主仓库内容不因本插件变更。
- 插件不 import / 不调用 / 不复制主仓库里既有的 `workbench/`（浏览器工作台）与 `docs/WORKBENCH.md`：
  两者只是共用同一份真源 `runs/<id>/`，互为独立实现。
- 架构上与主仓库的关系是**只读消费者**：读 `runs/<id>/` 与 `scripts/run_condopt.py`；写操作全部由用户
  显式点击触发并透传 CLI，插件自己不产生衍生文件到 run 目录（缓存/导出都在系统临时目录）。

## 已知限制

- `step` / `override` / `init` 等写操作会改动 `runs/<id>/`，因此默认不自动调用；`allowExec=false` 可整体禁用。
- `render` 对 `demo_moo` 实测约 2s（`--no-png`）：视图走缓存 + 30s 自动刷新，不在请求内重算。
- 依赖 condopt CLI 的 `--json` 输出；CLI 出错时 JSON 可能落在 stderr，host 两侧都解析，解析不了给 `data:null`。
- DSH 版本漂移（slot/服务名变化）时客户端全部 feature detect：拿不到服务就跳过注册，不抛。
