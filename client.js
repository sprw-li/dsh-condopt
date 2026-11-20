/**
 * dsh-condopt · 浏览器半（单文件，无构建链，只 require('react')）
 *
 * 为什么这样写：
 * - 信封与 DSH Web 外壳一致（`window.__ModuleLoader__.load({id, factory})`），
 *   所以本文件既能被真实外壳加载，也能被 `node:vm` 离线 harness 加载；
 * - 全部 slot / 服务注册都做 feature detect：DSH 版本漂移时宁可少注册一个入口，
 *   也绝不把异常抛进外壳（DESIGN §9 R5）；
 * - dashboard 由 condopt 自己的渲染器产出，自带全局 CSS，因此视图必须注入
 *   **shadow DOM**（R1），否则会污染 DSH 页面样式；
 * - 任何写操作都只来自用户显式点击，且按钮失败/超时要给出可读错误态；
 * - 面板自己的 30s 定时器在组件卸载时清掉，模块 teardown 再兜底清一遍。
 */
window.__ModuleLoader__.load({
  id: 'dsh-condopt',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** locale namespace / HTTP 前缀 / 面板标识 —— 与 DESIGN §0 逐字对应。 */
    const NS = 'condopt'
    const API = '/condopt/api'
    const TAB_ID = 'dsh-condopt/panel'
    const TAB_KIND = 'condopt'
    /** 样式标签的 data-plugin-css 标记（DESIGN §7 指定的字符串）。 */
    const STYLE_ID = 'dsh-condopt/panel.css'
    /** 视图自动刷新周期：渲染走 host 缓存，不在这里重算（R2）。 */
    const AUTO_REFRESH_MS = 30000
    /** tell 回填的行数上限（DESIGN §8.6B：宿主 5000 行；这里只做预览期提示）。 */
    const MAX_TELL_ROWS = 5000

    /* ------------------------------------------------------------------ *
     * locale 字典（zh / en 的 key 集合必须完全一致，harness 会断言）      *
     * ------------------------------------------------------------------ */

    const zh = {
      'tab.title': '条件优化',
      'command.label': '条件优化',
      'command.description': '打开 condopt 面板：内容视图、参数调整、决策审计',
      'panel.title': '条件优化',
      'panel.loading': '读取中…',
      'panel.root': '根目录',
      'panel.study': 'Study',
      'panel.refresh': '刷新',
      'panel.retry': '重试',
      'panel.auto': '每 30 秒自动刷新',
      'panel.autoHint': '视图页每 30 秒重新读取一次 /api/view（命中 host 缓存；勾选「强制」才会重新渲染）。',
      'panel.noRunsTitle': '还没有可读的 study',
      'panel.noRunsHint': '这个根目录下没有含 problem.json / dataset.jsonl 的 study。先在 condopt 仓库里初始化一个：',
      'panel.studiesError': '读取 study 列表失败：{message}',
      'panel.execDisabled': '宿主关闭了写接口（config.allowExec=false），动作按钮不可用。',
      'panel.noStudy': '请先选择一个 study',
      'panel.copy': '复制',
      'panel.copyOk': '已复制',
      'panel.copyFail': '复制失败，请手动选中命令文本',
      'subtab.view': '视图',
      'subtab.params': '参数',
      'subtab.decisions': '决策',
      'view.idle': '还没有生成视图',
      'view.generate': '生成视图',
      'view.regenerate': '强制重新生成',
      'view.loading': '正在渲染（首次渲染可能要几秒）…',
      'view.failed': '视图渲染失败：{message}',
      'view.meta': '{bytes} 字节 · 生成于 {time}',
      'view.cached': '缓存命中',
      'view.rebuilt': '已重新渲染',
      'view.shadowHint': 'dashboard 自带全局 CSS，已隔离在 shadow DOM 内，不会影响 DSH 界面。',
      'view.warnings': '警告',
      'params.algorithm': '算法',
      'params.specFailed': '读取算法目录失败：{message}',
      'params.algorithmRequired': '请先选择算法',
      'params.family': '族：{family}',
      'params.when': '适用场景：{when}',
      'params.schemaTitle': '算法参数（{count} 个，按 /api/spec 生成）',
      'params.schemaHint': '改动过的字段会列在下方「本次改动」里，并随「覆写算法」作为 --params 一起提交；没改动就只提交算法与理由。',
      'params.space': '搜索空间 space（root 内相对路径）',
      'params.spacePlaceholder': '如 space.json',
      'params.objective': '目标 objective',
      'params.objectivePlaceholder': '如 yield:max',
      'params.budget': '预算 budget',
      'action.copyInit': '复制 init 命令',
      'action.copyInitHint': '按当前算法与参数生成一条可直接执行的 init 命令（只复制文本，不写盘）',
      'params.noParams': '该算法没有可调参数',
      'params.paramDefault': '默认 {value}',
      'params.paramRange': '范围 {low} ~ {high}',
      'params.paramChoices': '可选 {choices}',
      'params.numberIgnored': '{field} 不是合法数字，本次请求未提交该字段（由宿主取默认值）',
      'params.colParam': '参数',
      'params.colSchema': '参数值',
      'params.colNote': '说明',
      'params.batch': 'init 批大小 batch',
      'params.batchPlaceholder': '留空 = 用 study 默认',
      'params.askN': '待测批大小 n',
      'params.askNPlaceholder': 'ask --n，留空 = 用 study 默认',
      'params.plate': '孔板 plate',
      'params.platePlaceholder': '如 P1（留空 = 自动编排）',
      'params.confirmN': '复孔数 n',
      'params.reason': '覆写理由 reason（必填）',
      'params.reasonPlaceholder': '为什么不用自动路由推荐的算法？',
      'params.reasonRequired': '覆写算法必须填写理由',
      'action.ask': '生成下一批',
      'action.confirm': '确认复孔',
      'action.override': '覆写算法',
      'action.auto': '恢复自动',
      'action.step': '下一步',
      'action.copy': '复制命令',
      'action.copyIdle': '先点一个动作，才有可复制的命令',
      'action.running': '执行中…',
      'action.stepHint': 'step 会写入 run/step.json，是真实的下一步推进',
      'exec.title': '执行结果',
      'exec.argv': 'argv',
      'exec.exitCode': '退出码 {code}',
      'exec.ok': '成功',
      'exec.failed': '失败',
      'exec.failedCall': '调用失败：{message}',
      'exec.stdout': 'stdout',
      'exec.stderr': 'stderr',
      'exec.empty': '（无输出）',
      'exec.json': 'JSON',
      'decisions.failed': '读取决策失败：{message}',
      'decisions.empty': '还没有决策记录',
      'decisions.title': '决策时间线',
      'decisions.count': '最近 {count} 条',
      'decisions.algorithm': '算法',
      'decisions.report': '报告摘要',
      'decisions.budget': '预算 {used}/{budget}',
      'decisions.best': '最优 {score}',
      'decisions.pareto': 'Pareto 前沿：{count} 个点',
      'decisions.pending': '待回填：{count} 批',
      'toolview.title': '条件优化视图',
      'toolview.preparing': '正在读取 condopt study…',
      'toolview.study': 'Study',
      'toolview.root': '根目录',
      'toolview.result': '内容摘要',
      'toolview.noText': '（没有可显示的文本输出）',
      'toolview.error': '失败',
      /* --- v2.0：参数页四块 / tell 回填 / 工具卡交接 / 过期状态 --- */
      'params.block.current': '当前 study',
      'params.block.currentHint': '只读：写操作会用这里的令牌（前 8 位）作为 expect，防止把过期状态写进 run。',
      'params.current.algorithm': '算法',
      'params.current.params': '参数',
      'params.current.objective': '目标',
      'params.current.direction': '方向',
      'params.current.budget': '预算',
      'params.current.batch': '批大小',
      'params.current.nObservations': '观测数',
      'params.current.pendingCount': '待回填',
      'params.current.remaining': '剩余',
      'params.unknown': '未知',
      'params.token': '令牌',
      'params.reloadCurrent': '重新读取当前状态',
      'params.block.nextBatch': '下一批参数',
      'params.block.nextBatchHint': '作用对象：当前 study（{run}）。',
      'params.block.override': '算法覆写',
      'params.block.overrideHint': '作用对象：当前 study（{run}）。只提交你改动过的字段。',
      'params.block.init': '新建 study',
      'params.block.initHint': '新建 study 不会改动当前 study；默认只复制命令，点「创建」才会真的执行 init。',
      'params.diff.title': '本次改动（{count} 项）',
      'params.diff.none': '尚未改动任何算法参数：覆写只提交算法与理由。',
      'params.diff.row': '{name}：{from} → {to}',
      'params.diff.reset': '还原为默认值',
      'params.newRun': '新 run 名',
      'params.newRunPlaceholder': '如 runs/my_study',
      'params.initNeedRun': '请先填写新 run 名',
      'params.initNeedFields': '请填写 space / objective / budget / batch',
      'action.initCreate': '创建',
      'action.initConfirm': '确认创建（会写 run 目录）',
      'action.initCancel': '取消',
      'tell.title': '回填实验结果',
      'tell.hint': '粘贴 JSON 数组 / JSONL / 带 id 列的 CSV（或 TSV）；确认后由宿主写入临时文件再调用 tell。',
      'tell.placeholder': '粘贴结果内容…',
      'tell.reason': '审计理由（可选）',
      'tell.preview': '预览',
      'tell.targetRun': '目标 run',
      'tell.rows': '行数',
      'tell.format': '解析形态',
      'tell.pending': '当前待回填',
      'tell.token': '令牌',
      'tell.invalid': '解析失败：{message}',
      'tell.err.empty': '内容为空',
      'tell.err.emptyArray': 'JSON 数组里没有记录',
      'tell.err.csvNeedsId': 'CSV/TSV 表头必须有 id 列',
      'tell.err.unparsed': '无法解析为 JSON 数组 / JSONL / 带 id 列的 CSV',
      'tell.err.tooManyRows': '行数超过 5000 上限',
      'tell.format.json': 'JSON 数组',
      'tell.format.jsonl': 'JSONL',
      'tell.format.csv': 'CSV',
      'tell.format.tsv': 'TSV',
      'tell.rowsValue': '{count} 行',
      'tell.needText': '请先粘贴结果内容',
      'tell.confirm': '确认回填',
      'tell.close': '收起',
      'tell.opened': '已生成待测批；可以在这里回填实验结果。',
      'tell.receipt': '回执',
      'tell.receipt.rows': '提交行数：{rows}（{format}）',
      'tell.receipt.accepted': '写入观测：{accepted} 行',
      'tell.receipt.pending': '待回填：{before} → {after}',
      'tell.receipt.dataset': '数据集：{before} → {after}',
      'exec.stateChanged': '状态已变化，已刷新，请重新确认',
      'exec.staleHint': '原请求没有重试；「当前 study」已重新读取，令牌已更新。',
      'toolview.openPanel': '在条件优化面板中打开',
      'toolview.openHint': '在右侧栏打开条件优化面板并选中这个 study',
    }

    const en = {
      'tab.title': 'Condition optimization',
      'command.label': 'Condopt',
      'command.description': 'Open the condopt panel: dashboard, parameters, decision audit',
      'panel.title': 'Condition optimization',
      'panel.loading': 'Loading…',
      'panel.root': 'Root',
      'panel.study': 'Study',
      'panel.refresh': 'Refresh',
      'panel.retry': 'Retry',
      'panel.auto': 'Auto refresh every 30s',
      'panel.autoHint': 'The dashboard is re-read every 30 seconds (host cache; rendering only re-runs when forced).',
      'panel.noRunsTitle': 'No readable study yet',
      'panel.noRunsHint': 'This root has no study containing problem.json / dataset.jsonl. Initialize one in the condopt repository first:',
      'panel.studiesError': 'Failed to read the study list: {message}',
      'panel.execDisabled': 'The host disabled writes (config.allowExec=false); action buttons are unavailable.',
      'panel.noStudy': 'Select a study first',
      'panel.copy': 'Copy',
      'panel.copyOk': 'Copied',
      'panel.copyFail': 'Copy failed; select the command text manually',
      'subtab.view': 'Dashboard',
      'subtab.params': 'Parameters',
      'subtab.decisions': 'Decisions',
      'view.idle': 'No dashboard rendered yet',
      'view.generate': 'Render dashboard',
      'view.regenerate': 'Force re-render',
      'view.loading': 'Rendering (the first run may take a few seconds)…',
      'view.failed': 'Render failed: {message}',
      'view.meta': '{bytes} bytes · generated {time}',
      'view.cached': 'cache hit',
      'view.rebuilt': 're-rendered',
      'view.shadowHint': 'The dashboard ships global CSS; it is isolated inside a shadow DOM and cannot affect the DSH UI.',
      'view.warnings': 'Warnings',
      'params.algorithm': 'Algorithm',
      'params.specFailed': 'Failed to read the algorithm catalog: {message}',
      'params.algorithmRequired': 'Choose an algorithm first',
      'params.family': 'family: {family}',
      'params.when': 'When to use: {when}',
      'params.schemaTitle': 'Algorithm parameters ({count}, generated from /api/spec)',
      'params.schemaHint': 'Changed fields are listed under "Changes" and submitted as --params with "Override algorithm"; with no change only the algorithm and the reason are sent.',
      'params.space': 'Search space (root-relative path)',
      'params.spacePlaceholder': 'e.g. space.json',
      'params.objective': 'Objective',
      'params.objectivePlaceholder': 'e.g. yield:max',
      'params.budget': 'Budget',
      'action.copyInit': 'Copy init command',
      'action.copyInitHint': 'Builds a runnable init command from the current algorithm and parameters (text only; writes nothing)',
      'params.noParams': 'This algorithm has no tunable parameters',
      'params.paramDefault': 'default {value}',
      'params.paramRange': 'range {low} ~ {high}',
      'params.paramChoices': 'choices {choices}',
      'params.numberIgnored': '{field} is not a valid number; the field was omitted (the host default applies)',
      'params.colParam': 'Parameter',
      'params.colSchema': 'Value',
      'params.colNote': 'Notes',
      'params.batch': 'init batch size',
      'params.batchPlaceholder': 'empty = study default',
      'params.askN': 'Batch size n',
      'params.askNPlaceholder': 'ask --n; empty = study default',
      'params.plate': 'Plate',
      'params.platePlaceholder': 'e.g. P1 (empty = auto)',
      'params.confirmN': 'Replicates n',
      'params.reason': 'Override reason (required)',
      'params.reasonPlaceholder': 'Why override the recommended algorithm?',
      'params.reasonRequired': 'Overriding the algorithm requires a reason',
      'action.ask': 'Ask next batch',
      'action.confirm': 'Confirm replicates',
      'action.override': 'Override algorithm',
      'action.auto': 'Back to auto',
      'action.step': 'Next step',
      'action.copy': 'Copy command',
      'action.copyIdle': 'Click an action first — there is nothing to copy yet',
      'action.running': 'Running…',
      'action.stepHint': 'step writes run/step.json — a real advance of the study',
      'exec.title': 'Result',
      'exec.argv': 'argv',
      'exec.exitCode': 'exit code {code}',
      'exec.ok': 'ok',
      'exec.failed': 'failed',
      'exec.failedCall': 'Request failed: {message}',
      'exec.stdout': 'stdout',
      'exec.stderr': 'stderr',
      'exec.empty': '(no output)',
      'exec.json': 'JSON',
      'decisions.failed': 'Failed to read decisions: {message}',
      'decisions.empty': 'No decision recorded yet',
      'decisions.title': 'Decision timeline',
      'decisions.count': 'last {count}',
      'decisions.algorithm': 'Algorithm',
      'decisions.report': 'Report',
      'decisions.budget': 'budget {used}/{budget}',
      'decisions.best': 'best {score}',
      'decisions.pareto': 'Pareto front: {count} points',
      'decisions.pending': 'Pending: {count} batches',
      'toolview.title': 'Condopt view',
      'toolview.preparing': 'Reading the condopt study…',
      'toolview.study': 'Study',
      'toolview.root': 'Root',
      'toolview.result': 'Summary',
      'toolview.noText': '(no text output)',
      'toolview.error': 'failed',
      /* --- v2.0: parameter blocks / tell backfill / toolview handoff / stale state --- */
      'params.block.current': 'Current study',
      'params.block.currentHint': 'Read-only: writes send this token (first 8 chars) as expect so stale state is never written back.',
      'params.current.algorithm': 'Algorithm',
      'params.current.params': 'Parameters',
      'params.current.objective': 'Objective',
      'params.current.direction': 'Direction',
      'params.current.budget': 'Budget',
      'params.current.batch': 'Batch size',
      'params.current.nObservations': 'Observations',
      'params.current.pendingCount': 'Pending',
      'params.current.remaining': 'Remaining',
      'params.unknown': 'unknown',
      'params.token': 'Token',
      'params.reloadCurrent': 'Reload current state',
      'params.block.nextBatch': 'Next batch',
      'params.block.nextBatchHint': 'Applies to the current study ({run}).',
      'params.block.override': 'Algorithm override',
      'params.block.overrideHint': 'Applies to the current study ({run}). Only changed fields are submitted.',
      'params.block.init': 'New study',
      'params.block.initHint': 'Creating a new study does not touch the current one; by default only the command is copied — press Create to actually run init.',
      'params.diff.title': 'Changes ({count})',
      'params.diff.none': 'No algorithm parameter changed: the override submits only the algorithm and the reason.',
      'params.diff.row': '{name}: {from} → {to}',
      'params.diff.reset': 'Reset to defaults',
      'params.newRun': 'New run name',
      'params.newRunPlaceholder': 'e.g. runs/my_study',
      'params.initNeedRun': 'Enter the new run name first',
      'params.initNeedFields': 'Fill in space / objective / budget / batch',
      'action.initCreate': 'Create',
      'action.initConfirm': 'Confirm create (writes the run folder)',
      'action.initCancel': 'Cancel',
      'tell.title': 'Backfill results',
      'tell.hint': 'Paste a JSON array / JSONL / CSV with an id column (TSV works too); the host writes a temp file and calls tell.',
      'tell.placeholder': 'Paste the results…',
      'tell.reason': 'Audit reason (optional)',
      'tell.preview': 'Preview',
      'tell.targetRun': 'Target run',
      'tell.rows': 'Rows',
      'tell.format': 'Format',
      'tell.pending': 'Currently pending',
      'tell.token': 'Token',
      'tell.invalid': 'Parse failed: {message}',
      'tell.err.empty': 'the text is empty',
      'tell.err.emptyArray': 'the JSON array has no records',
      'tell.err.csvNeedsId': 'the CSV/TSV header must contain an id column',
      'tell.err.unparsed': 'not a JSON array / JSONL / CSV with an id column',
      'tell.err.tooManyRows': 'more than 5000 rows',
      'tell.format.json': 'JSON array',
      'tell.format.jsonl': 'JSONL',
      'tell.format.csv': 'CSV',
      'tell.format.tsv': 'TSV',
      'tell.rowsValue': '{count} rows',
      'tell.needText': 'Paste the results first',
      'tell.confirm': 'Confirm backfill',
      'tell.close': 'Collapse',
      'tell.opened': 'A batch was requested; you can backfill the results here.',
      'tell.receipt': 'Receipt',
      'tell.receipt.rows': 'Submitted rows: {rows} ({format})',
      'tell.receipt.accepted': 'Observations written: {accepted}',
      'tell.receipt.pending': 'Pending: {before} → {after}',
      'tell.receipt.dataset': 'Dataset: {before} → {after}',
      'exec.stateChanged': 'State changed — refreshed, please confirm again',
      'exec.staleHint': 'The original request was not retried; "Current study" was re-read and the token is up to date.',
      'toolview.openPanel': 'Open in the condopt panel',
      'toolview.openHint': 'Open the condopt panel in the right sidebar and select this study',
    }

    /** 模块级翻译函数；apply() 里用 ctx.locale.bind 覆盖成真实实现。 */
    let tr = (key) => key
    /** 客户端 Cordis ctx；apply() 里赋值，service() 通过它取服务。 */
    let hostCtx = null

    /* ------------------------------------------------------------------ *
     * 样式（与 council 同款：一次性 style 标签 + data-plugin-css 标记）   *
     * ------------------------------------------------------------------ */

    const CSS = `
.dco-tab{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.dco-head{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dco-head-row{display:flex;align-items:center;gap:7px;min-width:0}
.dco-title{font-size:13px;font-weight:600;flex:none}
.dco-root{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;direction:rtl;text-align:left}
.dco-field{display:flex;align-items:center;gap:6px;min-width:0}
.dco-field-label{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.dco-select{box-sizing:border-box;flex:1;min-width:0;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dco-select:focus{border-color:var(--dsw-alias-brand-primary)}
.dco-btn{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dco-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dco-btn:disabled{opacity:.5;cursor:default}
.dco-btn.dco-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.dco-toggle{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.dco-toggle input{width:12px;height:12px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dco-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dco-subtab{padding:5px 11px;border:1px solid transparent;border-bottom:0;border-radius:var(--dsw-radius-sm) var(--dsw-radius-sm) 0 0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dco-subtab.dco-on{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.dco-body{flex:1;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
.dco-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dco-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dco-dim{color:var(--dsw-alias-label-secondary);font-size:11px}
.dco-err{padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.dco-warn{padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.dco-ok{color:var(--dsw-alias-state-success-primary);font-size:11px}
.dco-card{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dco-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dco-pre{margin:0;padding:8px 9px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font:11px/1.55 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
.dco-shadow-host{display:block;flex:1;min-height:360px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:#fff;overflow:auto}
.dco-form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.dco-lbl{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dco-input{box-sizing:border-box;width:100%;height:26px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dco-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dco-input:disabled,.dco-select:disabled{opacity:.6}
.dco-textarea{box-sizing:border-box;width:100%;min-height:52px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;resize:vertical;outline:none}
.dco-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dco-table{width:100%;border-collapse:collapse;font-size:11px}
.dco-table th{text-align:left;padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-weight:600}
.dco-table td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;word-break:break-word}
.dco-timeline{display:flex;flex-direction:column;gap:6px}
.dco-entry{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 8px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
.dco-entry-t{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dco-entry-head{font-size:12px}
.dco-entry-body{grid-column:2;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.dco-tool{display:flex;flex-direction:column;gap:5px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dco-tool-head{display:flex;align-items:center;gap:6px}
.dco-tool-title{font-weight:600}
.dco-tool-chip{padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dco-tool-meta{display:flex;flex-wrap:wrap;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dco-tool-text{max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dco-spinner{width:10px;height:10px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dco-spin .8s linear infinite}
@keyframes dco-spin{to{transform:rotate(360deg)}}
`

    /* ------------------------------------------------------------------ *
     * 通用工具（全部 total：任何奇怪输入都不抛）                          *
     * ------------------------------------------------------------------ */

    /** 取客户端服务；拿不到就 undefined，调用方自行跳过。 */
    function service(name) {
      try {
        return hostCtx === null ? undefined : hostCtx.get(name)
      } catch {
        return undefined
      }
    }

    /** 任意异常的可读文本。 */
    function messageOf(error) {
      return String(error && error.message ? error.message : error)
    }

    function isObject(value) {
      return value !== null && typeof value === 'object' && Array.isArray(value) === false
    }

    /** 「记录在册的定时器」：teardown 时统一清掉，避免面板卸载后仍打 host。 */
    const timers = new Set()
    const intervals = new Set()

    function later(fn, ms) {
      const id = window.setTimeout(() => {
        timers.delete(id)
        try {
          fn()
        } catch {
          /* 定时回调里的异常同样不允许冒到外壳 */
        }
      }, ms)
      timers.add(id)
      return id
    }

    function startInterval(fn, ms) {
      const id = window.setInterval(() => {
        try {
          fn()
        } catch {
          /* 轮询回调吞掉异常 */
        }
      }, ms)
      intervals.add(id)
      return id
    }

    function stopInterval(id) {
      if (id === undefined || id === null) return
      intervals.delete(id)
      try {
        window.clearInterval(id)
      } catch {
        /* best effort */
      }
    }

    function clearAllTimers() {
      for (const id of intervals) {
        try {
          window.clearInterval(id)
        } catch {
          /* best effort */
        }
      }
      intervals.clear()
      for (const id of timers) {
        try {
          window.clearTimeout(id)
        } catch {
          /* best effort */
        }
      }
      timers.clear()
    }

    function sleep(ms) {
      return new Promise((resolve) => {
        window.setTimeout(resolve, ms)
      })
    }

    /* ------------------------------------------------------------------ *
     * HTTP（统一错误对象带 status / code / payload）                      *
     * ------------------------------------------------------------------ */

    async function fetchJson(path, options) {
      const response = await window.fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}))
      let data = {}
      try {
        data = await response.json()
      } catch {
        data = {}
      }
      if (response.ok !== true) {
        const message = isObject(data) && data.error ? String(data.error) : 'HTTP ' + String(response.status)
        const error = new Error(message)
        error.status = response.status
        error.code = isObject(data) && typeof data.code === 'string' ? data.code : ''
        error.payload = data
        throw error
      }
      return data
    }

    async function postJson(path, body) {
      return fetchJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    }

    /* ------------------------------------------------------------------ *
     * 剪贴板：navigator.clipboard → textarea+execCommand 兜底 → false     *
     * ------------------------------------------------------------------ */

    async function copyText(value) {
      const text = String(value === undefined || value === null ? '' : value)
      try {
        const nav = window.navigator
        if (isObject(nav) && isObject(nav.clipboard) && typeof nav.clipboard.writeText === 'function') {
          await nav.clipboard.writeText(text)
          return true
        }
      } catch {
        /* 落到下面的兜底方案 */
      }
      try {
        const doc = window.document
        if (doc === undefined || typeof doc.createElement !== 'function' || !isObject(doc.body)) return false
        const area = doc.createElement('textarea')
        area.value = text
        if (typeof area.setAttribute === 'function') area.setAttribute('readonly', 'readonly')
        if (typeof doc.body.appendChild !== 'function' || typeof area.select !== 'function') return false
        doc.body.appendChild(area)
        area.select()
        const ok = typeof doc.execCommand === 'function' ? doc.execCommand('copy') === true : false
        if (typeof doc.body.removeChild === 'function') doc.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------------ *
     * 展示用小工具                                                        *
     * ------------------------------------------------------------------ */

    function formatTime(value) {
      if (typeof value === 'string' && value !== '') {
        /* host 可能给 ISO 字符串：能解析就本地化，否则原样显示。 */
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed) === false) return value
        try {
          return new Date(parsed).toLocaleString()
        } catch {
          return value
        }
      }
      const n = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(n) === false || n <= 0) return '—'
      /* 大于 1e12 视为毫秒时间戳，否则按 Unix 秒（decisions.t / render 的 epoch）。 */
      const ms = n > 1e12 ? n : n * 1000
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(value)
      }
    }

    function formatScore(value) {
      const n = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(n) === false) return '—'
      return Math.abs(n) >= 1000 ? n.toFixed(1) : n.toFixed(4)
    }

    function displayValue(value) {
      if (value === null || value === undefined) return '—'
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      }
      return String(value)
    }

    /** 读取「可能是数字」的输入：空 = null（不传），非法 = {ok:false}。 */
    function readNumber(text) {
      const raw = String(text === undefined || text === null ? '' : text).trim()
      if (raw === '') return { ok: true, value: null }
      const value = Number(raw)
      return Number.isFinite(value) ? { ok: true, value } : { ok: false, value: null }
    }

    function readText(text) {
      const raw = String(text === undefined || text === null ? '' : text).trim()
      return raw === '' ? null : raw
    }

    /** select/input 的 change 事件里取字符串值。 */
    function eventValue(event) {
      if (isObject(event) && isObject(event.target)) {
        const value = event.target.value
        return typeof value === 'string' ? value : ''
      }
      return ''
    }

    /* ------------------------------------------------------------------ *
     * 视图：dashboard 的 css+html 写进 shadow root（R1）                  *
     * ------------------------------------------------------------------ */

    /** 清空并按序写入 style + canvas；任何 DOM 行为异常都只当作「没画上」。 */
    function paintShadow(shadow, css, html) {
      if (shadow === undefined || shadow === null) return
      try {
        if (typeof shadow.replaceChildren === 'function') shadow.replaceChildren()
        else if ('innerHTML' in shadow) shadow.innerHTML = ''
        const doc = window.document
        if (doc === undefined || typeof doc.createElement !== 'function') return
        if (typeof shadow.appendChild !== 'function') return
        const style = doc.createElement('style')
        style.textContent = typeof css === 'string' ? css : ''
        const canvas = doc.createElement('div')
        canvas.className = 'dco-canvas'
        try {
          canvas.innerHTML = typeof html === 'string' ? html : ''
        } catch {
          canvas.innerHTML = ''
        }
        shadow.appendChild(style)
        shadow.appendChild(canvas)
      } catch {
        /* 渲染失败由调用方展示错误态，这里绝不抛 */
      }
    }

    /**
     * shadow DOM 宿主。
     *
     * 用 ref 回调（而不是渲染期创建元素）拿真实 DOM 节点，再 attachShadow；
     * css 与 html 变化时重画。ref 被卸载时会收到 null，此时必须同时清掉
     * 元素与 shadow 引用，否则换 run（key 变化 → 重挂载）后画到旧的 detached 树上。
     * 离线 harness 若要覆盖这条路径，在 build/render 时把 props.ref 用带
     * attachShadow 的假元素调用一次即可。
     */
    function ShadowHtml(props) {
      const shadowRef = React.useRef(null)
      const hostRef = React.useRef(null)
      const css = typeof props.css === 'string' ? props.css : ''
      const html = typeof props.html === 'string' ? props.html : ''

      const attach = (element) => {
        if (element === undefined || element === null) {
          hostRef.current = null
          shadowRef.current = null
          return
        }
        if (hostRef.current === element) return
        hostRef.current = element
        let shadow = null
        try {
          shadow = typeof element.attachShadow === 'function' ? element.attachShadow({ mode: 'open' }) : null
        } catch {
          shadow = null
        }
        shadowRef.current = shadow
        /* 提交时就画一次：避免先出现一个空 shadow，再等 effect 补画。
           css/html 变化由下面的 effect 重画（paintShadow 是幂等的）。 */
        if (shadow !== null) paintShadow(shadow, css, html)
      }

      React.useEffect(() => {
        paintShadow(shadowRef.current, css, html)
      }, [css, html])

      return h('div', { className: 'dco-shadow-host', ref: attach })
    }

    /* ------------------------------------------------------------------ *
     * 对话内工具卡：tool.call.toolview / key `condopt_view`               *
     * ------------------------------------------------------------------ */

    /* Tool 层传的是惰读器（PartialArguments），不是普通对象；这里同时支持
       `args.text(key)` / `args.value(key)` 与离线 harness 直接传字面量。 */
    function toolArgValue(args, key) {
      if (isObject(args) === false) return undefined
      if (typeof args.value === 'function') return args.value(key)
      return args[key]
    }

    function toolArgText(args, key) {
      if (isObject(args) === false) return ''
      if (typeof args.text === 'function') {
        const text = args.text(key)
        return typeof text === 'string' ? text : ''
      }
      return typeof args[key] === 'string' ? args[key] : ''
    }

    /** 三个 phase 都从 block.args 取；settled 调用再兜底 block.call.argsRaw。 */
    function toolArgsOf(block) {
      if (isObject(block) === false) return undefined
      if (block.args !== undefined && block.args !== null) return block.args
      const call = block.call
      return isObject(call) ? call.argsRaw : undefined
    }

    function toolBlockText(block) {
      if (isObject(block) === false) return ''
      return typeof block.text === 'string' ? block.text : ''
    }

    /** `condopt_view` 的三段卡：preparing / start / result。 */
    function CondoptViewRow(props) {
      const t = typeof props.t === 'function' ? props.t : tr
      const phase = props.phase
      const block = props.block

      if (phase === 'preparing') {
        return h('div', { className: 'dco-tool' },
          h('div', { className: 'dco-tool-head' },
            h('span', { 'aria-hidden': true }, '⚗'),
            h('span', { className: 'dco-tool-title' }, t('toolview.preparing')),
          ),
        )
      }

      const args = toolArgsOf(block)
      const study = toolArgText(args, 'run')
      const root = toolArgText(args, 'root')

      const settled = isObject(block) && 'kind' in block
      if (phase === 'result' || settled) {
        const content = settled && Array.isArray(block.content) ? block.content : []
        const text = content.map(toolBlockText).filter((chunk) => chunk !== '').join('\n\n')
        const error = isObject(block) && isObject(block.error) ? block.error : null
        const failed = settled && (block.isError === true || error !== null)
        if (failed) {
          const detail = [error !== null && typeof error.name === 'string' ? error.name : '',
            error !== null && typeof error.code === 'string' ? error.code : ''].filter((part) => part !== '').join(' · ')
          const message = [detail, text].filter((part) => part !== '').join('\n')
          return h('div', { className: 'dco-tool' },
            h('div', { className: 'dco-tool-head' },
              h('span', { 'aria-hidden': true }, '⚗'),
              h('span', { className: 'dco-tool-title' }, t('toolview.title')),
              h('span', { className: 'dco-tool-chip' }, t('toolview.error')),
            ),
            h('div', { className: 'dco-err' }, message !== '' ? message : t('toolview.error')),
          )
        }
        return h('div', { className: 'dco-tool' },
          h('div', { className: 'dco-tool-head' },
            h('span', { 'aria-hidden': true }, '⚗'),
            h('span', { className: 'dco-tool-title' }, t('toolview.title')),
            h('span', { className: 'dco-tool-chip' }, t('exec.ok')),
          ),
          h('div', { className: 'dco-card-title' }, t('toolview.result')),
          h('div', { className: 'dco-tool-text' }, text !== '' ? text : t('toolview.noText')),
          h('div', { className: 'dco-row' },
            h('button', {
              type: 'button',
              className: 'dco-btn',
              title: t('toolview.openHint'),
              onClick: () => requestOpenPanel({ root, run: study }),
            }, t('toolview.openPanel')),
          ),
        )
      }

      /** 工具卡上的交接按钮：带 root+run 打开面板并选中同一 study。 */
      const openButton = () => h('button', {
        type: 'button',
        className: 'dco-btn',
        title: t('toolview.openHint'),
        onClick: () => requestOpenPanel({ root, run: study }),
      }, t('toolview.openPanel'))

      /* start：参数已齐（惰读器在这一刻能给出文本）。 */
      const include = toolArgValue(args, 'include')
      return h('div', { className: 'dco-tool' },
        h('div', { className: 'dco-tool-head' },
          h('span', { 'aria-hidden': true }, '⚗'),
          h('span', { className: 'dco-tool-title' }, t('toolview.title')),
        ),
        h('div', { className: 'dco-tool-meta' },
          h('span', null, `${t('toolview.study')}: ${study !== '' ? study : '—'}`),
          h('span', null, `${t('toolview.root')}: ${root !== '' ? root : '—'}`),
          Array.isArray(include) && include.length > 0 ? h('span', null, include.join(', ')) : null,
        ),
        h('div', { className: 'dco-row' }, openButton()),
      )
    }

    /**
     * 解析粘贴的结果内容（DESIGN §8.6B 的客户端镜像）。
     *
     * 与宿主同一套宽松规则：JSON 数组 → JSONL → 带 `id` 列的 CSV/TSV。
     * 只用于**预览**（行数 + 形态），真正的校验在宿主侧；两边不一致时以宿主为准。
     */
    function analyzeResults(raw) {
      const text = typeof raw === 'string' ? raw : ''
      if (text.trim() === '') return { ok: false, format: null, ext: '', rows: 0, code: 'empty' }
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) return { ok: false, format: 'json', ext: 'json', rows: 0, code: 'emptyArray' }
          if (parsed.length > MAX_TELL_ROWS) return { ok: false, format: 'json', ext: 'json', rows: parsed.length, code: 'tooManyRows' }
          return { ok: true, format: 'json', ext: 'json', rows: parsed.length, code: '' }
        }
      } catch {
        /* 不是整体 JSON，继续按 JSONL / CSV 试 */
      }
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
      if (lines.length === 0) return { ok: false, format: null, ext: '', rows: 0, code: 'empty' }
      let allJson = true
      for (const line of lines) {
        try {
          JSON.parse(line)
        } catch {
          allJson = false
          break
        }
      }
      if (allJson) {
        if (lines.length > MAX_TELL_ROWS) return { ok: false, format: 'jsonl', ext: 'jsonl', rows: lines.length, code: 'tooManyRows' }
        return { ok: true, format: 'jsonl', ext: 'jsonl', rows: lines.length, code: '' }
      }
      /* CSV/TSV：表头必须含 id 列（与宿主一致）。 */
      const header = lines[0]
      const delimiter = header.indexOf('\t') >= 0 ? '\t' : (header.indexOf(',') >= 0 ? ',' : '')
      if (delimiter === '') return { ok: false, format: null, ext: '', rows: 0, code: 'unparsed' }
      const cells = header.split(delimiter).map((cell) => cell.trim().toLowerCase())
      if (cells.includes('id') === false) return { ok: false, format: null, ext: '', rows: 0, code: 'csvNeedsId' }
      const rows = lines.length - 1
      if (rows <= 0) return { ok: false, format: null, ext: '', rows: 0, code: 'emptyArray' }
      if (rows > MAX_TELL_ROWS) return { ok: false, format: null, ext: 'csv', rows, code: 'tooManyRows' }
      return { ok: true, format: delimiter === '\t' ? 'tsv' : 'csv', ext: 'csv', rows, code: '' }
    }

    /** 斜杠菜单图标。 */
    function CondoptIcon(props) {
      const size = isObject(props) && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M9 3h6' }),
        h('path', { d: 'M10 3v6.2L5.4 17a3 3 0 0 0 2.6 4.5h8a3 3 0 0 0 2.6-4.5L14 9.2V3' }),
        h('path', { d: 'M7.2 14h9.6' }),
      )
    }

    /* ------------------------------------------------------------------ *
     * 打开右侧栏（与 council 同款：layout.openRightbar + openTab(kind)）  *
     * ------------------------------------------------------------------ */

    /**
     * 工具卡 → 面板的交接（DESIGN §8.6C-3）。
     *
     * 模块内 store：`condopt_view` 卡上点「在条件优化面板中打开」时先记下 `{root, run}`，
     * 通知已挂载的面板（若已挂载就当场切 study），再走 `openTab` 把右侧栏切过去。
     * 一个全局变量 + 一组监听器足够：这是一个「最后一次点击生效」的交接，不需要历史。
     */
    let pendingSelection = null
    const selectionListeners = new Set()

    function requestOpenPanel(selection) {
      const source = isObject(selection) ? selection : {}
      const root = typeof source.root === 'string' ? source.root.trim() : ''
      const run = typeof source.run === 'string' ? source.run.trim() : ''
      if (root === '' && run === '') return
      pendingSelection = { root, run }
      for (const listener of selectionListeners) {
        try {
          listener(pendingSelection)
        } catch {
          /* 面板自己的异常不许打断打开动作 */
        }
      }
      void openCondoptTab()
    }

    async function openCondoptTab() {
      const layout = service('layout')
      if (layout !== undefined && layout !== null && typeof layout.openRightbar === 'function') {
        try {
          layout.openRightbar(true, false)
        } catch {
          /* 展开只是尽力而为，下面的 openTab 仍要跑 */
        }
      }
      const deadline = Date.now() + 3000
      while (Date.now() <= deadline) {
        const sidebar = service('sidebarRight')
        if (sidebar !== undefined && sidebar !== null && typeof sidebar.openTab === 'function') {
          try {
            sidebar.openTab(TAB_KIND)
            break
          } catch {
            /* 侧栏可能还没挂载 */
          }
        }
        await sleep(60)
      }
    }

    /* ------------------------------------------------------------------ *
     * 面板                                                                *
     * ------------------------------------------------------------------ */

    /** 三个子页签。 */
    const PANES = ['view', 'params', 'decisions']

    /**
     * 右侧栏面板本体。
     *
     * 所有网络/渲染失败都变成可读的 error 态 + 重试按钮；
     * 数据读取全部走 /condopt/api/*（DESIGN §3），写操作全部走 /api/exec（§5）。
     */
    function CondoptTab(props) {
      const t = typeof props.t === 'function' ? props.t : tr

      const [health, setHealth] = React.useState(null)
      const [studies, setStudies] = React.useState(null)
      const [studiesError, setStudiesError] = React.useState('')
      const [loadingStudies, setLoadingStudies] = React.useState(true)
      const [run, setRun] = React.useState('')
      const [pane, setPane] = React.useState('view')
      const [auto, setAuto] = React.useState(true)
      const [view, setView] = React.useState({ status: 'idle', run: '', data: null, error: '', force: false })
      const [spec, setSpec] = React.useState({ status: 'idle', data: null, error: '' })
      const [study, setStudy] = React.useState({ status: 'idle', run: '', data: null, error: '' })
      const [exec, setExec] = React.useState({ status: 'idle', error: '', command: '', argv: [], result: null })
      const [execDisabled, setExecDisabled] = React.useState(false)
      const [form, setForm] = React.useState({
        algorithm: '', askN: '', batch: '', plate: '', n: '3', reason: '',
        space: '', objective: '', budget: '', newRun: '', tellText: '', tellReason: '',
      })
      /** spec schema 参数的本地草稿：override 只提交「与默认值不同」的项。 */
      const [paramValues, setParamValues] = React.useState({})
      const [copied, setCopied] = React.useState('')
      /** tell 回填区块：ask 成功后出现；回执单独存，便于刷新后仍可读。 */
      const [tellOpen, setTellOpen] = React.useState(false)
      const [tellReceipt, setTellReceipt] = React.useState(null)
      /** 工具卡交接带来的 root（为空表示跟随宿主解析结果）。 */
      const [handoffRoot, setHandoffRoot] = React.useState('')
      /** 新建 study 的两段确认：第一次点「创建」只亮出确认文案。 */
      const [initConfirm, setInitConfirm] = React.useState(false)
      /** 数字控件里写了非数字时的提示（不拦请求，只说明该字段被忽略）。 */
      const [inputNote, setInputNote] = React.useState('')

      /** 卸载后不再 setState（异步返回可能晚于卸载）。 */
      const aliveRef = React.useRef(true)
      React.useEffect(() => () => {
        aliveRef.current = false
      }, [])

      /* 每个加载器「最后一次请求的目标」与「在途请求」：与渲染时机解耦——
         过期响应丢弃，同一目标不重复请求。 */
      const viewTargetRef = React.useRef('')
      const studyTargetRef = React.useRef('')
      const inflightRef = React.useRef({ view: '', study: '' })
      /* 当前选中的 run：imperative 记录，挂载路径不必等下一轮渲染就能接上加载。 */
      const selectedRunRef = React.useRef('')

      /* ---------------- 数据读取 ---------------- */

      /**
       * 把「工具卡交接来的 root」拼进请求（DESIGN §2：请求参数 root 优先级最高）。
       * 没有交接 root 时原样返回，由宿主按 CONDOPT_ROOT / config / cwd 解析。
       */
      function withRoot(base, hasQuery) {
        if (typeof handoffRoot !== 'string' || handoffRoot === '') return base
        return `${base}${hasQuery === true ? '&' : '?'}root=${encodeURIComponent(handoffRoot)}`
      }

      async function loadHealth() {
        try {
          const data = await fetchJson(withRoot(`${API}/health`))
          if (aliveRef.current !== true) return
          setHealth(isObject(data) ? data : null)
          /* DESIGN v1.3：health 明确给 allowExec:false 时，打开面板即置灰动作按钮，
             不必等第一次点击吃 403。字段缺失（旧 host）→ 保持被动行为，等 403 再说。 */
          if (isObject(data) && data.allowExec === false) setExecDisabled(true)
        } catch {
          /* health 失败不阻塞面板：root 会从 /api/studies 拿 */
          if (aliveRef.current === true) setHealth(null)
        }
      }

      /**
       * 读取 study 列表；返回选中的 run（供挂载路径立刻接上视图加载，
       * 不依赖「状态变化 → 再渲染 → 再跑 effect」这条链路）。
       */
      async function loadStudies() {
        setLoadingStudies(true)
        setStudiesError('')
        try {
          const data = await fetchJson(withRoot(`${API}/studies`))
          if (aliveRef.current !== true) return ''
          const rows = isObject(data) && Array.isArray(data.runs) ? data.runs.filter((row) => isObject(row)) : []
          setStudies(isObject(data) ? data : { root: '', runs: rows })
          setLoadingStudies(false)
          /* 保留当前选择（如果它还在列表里），否则落到最近修改的一个。
             用 ref 记录而不是读 state：挂载路径的调用早于「状态→重渲染」这一轮。 */
          const current = selectedRunRef.current
          const kept = current !== '' && rows.some((row) => studyValue(row) === current)
          const chosen = kept ? current : (rows.length > 0 ? studyValue(rows[0]) : '')
          selectedRunRef.current = chosen
          setRun((previous) => (previous === chosen ? previous : chosen))
          return chosen
        } catch (error) {
          if (aliveRef.current !== true) return ''
          setStudiesError(messageOf(error))
          setLoadingStudies(false)
          return ''
        }
      }

      async function loadView(force, target) {
        const wanted = typeof target === 'string' && target !== '' ? target : run
        if (wanted === '') return
        if (force !== true && inflightRef.current.view === wanted) return
        inflightRef.current.view = wanted
        viewTargetRef.current = wanted
        setView((current) => ({
          status: 'loading',
          run: wanted,
          data: current.run === wanted ? current.data : null,
          error: '',
          force: force === true,
        }))
        const query = withRoot(`${API}/view?run=${encodeURIComponent(wanted)}${force === true ? '&force=1' : ''}`, true)
        try {
          const data = await fetchJson(query)
          if (aliveRef.current !== true || viewTargetRef.current !== wanted) return
          setView({ status: 'ready', run: wanted, data: isObject(data) ? data : null, error: '', force: false })
        } catch (error) {
          if (aliveRef.current !== true || viewTargetRef.current !== wanted) return
          setView({ status: 'error', run: wanted, data: null, error: messageOf(error), force: false })
        } finally {
          if (inflightRef.current.view === wanted) inflightRef.current.view = ''
        }
      }

      async function loadSpec() {
        if (spec.status === 'loading') return
        setSpec((current) => ({ status: 'loading', data: current.data, error: '' }))
        try {
          const data = await fetchJson(withRoot(`${API}/spec`))
          if (aliveRef.current !== true) return
          const list = Array.isArray(data) ? data.filter((row) => isObject(row)) : []
          setSpec({ status: 'ready', data: list, error: '' })
          setForm((current) => {
            if (current.algorithm !== '') return current
            return Object.assign({}, current, { algorithm: list.length > 0 ? String(list[0].name || '') : '' })
          })
        } catch (error) {
          if (aliveRef.current !== true) return
          setSpec({ status: 'error', data: null, error: messageOf(error) })
        }
      }

      async function loadStudy(force, target) {
        const wanted = typeof target === 'string' && target !== '' ? target : run
        if (wanted === '') return
        if (force !== true && inflightRef.current.study === wanted) return
        inflightRef.current.study = wanted
        studyTargetRef.current = wanted
        setStudy((current) => ({
          status: 'loading',
          run: wanted,
          data: current.run === wanted ? current.data : null,
          error: '',
        }))
        try {
          const data = await fetchJson(withRoot(`${API}/study?run=${encodeURIComponent(wanted)}`, true))
          if (aliveRef.current !== true || studyTargetRef.current !== wanted) return
          setStudy({ status: 'ready', run: wanted, data: isObject(data) ? data : null, error: '' })
        } catch (error) {
          if (aliveRef.current !== true || studyTargetRef.current !== wanted) return
          setStudy({ status: 'error', run: wanted, data: null, error: messageOf(error) })
        } finally {
          if (inflightRef.current.study === wanted) inflightRef.current.study = ''
        }
      }

      /** 某个子页签需要的数据；点击页签与 effect 都走这里，保证只发一次请求。 */
      function ensurePaneData(name, targetRun) {
        const wanted = typeof targetRun === 'string' && targetRun !== '' ? targetRun : run
        if (wanted === '') return
        if (name === 'view') {
          if (view.run !== wanted) void loadView(false, wanted)
        } else if (name === 'params') {
          if (spec.status !== 'ready' && spec.status !== 'loading') void loadSpec()
          /* v2.0：「当前 study」块与写操作的 expect 都来自 /api/study，参数页必须也读它。 */
          if (study.run !== wanted) void loadStudy(false, wanted)
        } else if (study.run !== wanted) {
          void loadStudy(false, wanted)
        }
      }

      /* ---------------- 生命周期 ---------------- */

      React.useEffect(() => {
        void loadHealth()
        /* v2.0：工具卡交接（root+run）在挂载时立即生效并订阅后续交接。 */
        const apply = (selection) => {
          if (isObject(selection) === false) return
          if (typeof selection.root === 'string' && selection.root !== '') setHandoffRoot(selection.root)
          if (typeof selection.run === 'string' && selection.run !== '') {
            selectedRunRef.current = selection.run
            setRun(selection.run)
          }
        }
        apply(pendingSelection)
        selectionListeners.add(apply)
        /* 挂载时就接上视图加载：不让首次出图依赖「再渲染一轮」的 effect 时机。 */
        void (async () => {
          const chosen = await loadStudies()
          if (aliveRef.current !== true) return
          const wanted = pendingSelection !== null && typeof pendingSelection.run === 'string' && pendingSelection.run !== ''
            ? pendingSelection.run
            : chosen
          if (typeof wanted === 'string' && wanted !== '') void loadView(false, wanted)
        })()
        return () => {
          selectionListeners.delete(apply)
        }
      }, [])

      /* run / pane 变化时按需取数；已有缓存就不重复请求。 */
      React.useEffect(() => {
        ensurePaneData(pane, run)
      }, [run, pane])

      /* 面板自己的 30s 定时器：只刷新当前页签的数据；卸载时清掉。 */
      React.useEffect(() => {
        if (auto !== true || run === '') return undefined
        const id = startInterval(() => {
          if (pane === 'view') void loadView(false, run)
          else if (pane === 'params') {
            /* 令牌会随 run 目录变化，参数页也要周期性刷新，否则 expect 会过期。 */
            void loadSpec()
            void loadStudy(false, run)
          } else void loadStudy(false, run)
        }, AUTO_REFRESH_MS)
        return () => stopInterval(id)
      }, [auto, run, pane])

      React.useEffect(() => {
        if (copied === '') return undefined
        const id = later(() => setCopied(''), 1800)
        return () => {
          timers.delete(id)
          try {
            window.clearTimeout(id)
          } catch {
            /* best effort */
          }
        }
      }, [copied])

      /* ---------------- 写操作（只由点击触发） ---------------- */

      /**
       * 当前 study 的状态令牌（DESIGN §8.6A）。
       *
       * 来自最近一次 `/api/study`；写操作一律把它作为 body 顶层 `expect` 回传，
       * 宿主比对不符即 409 `state-changed`——面板因此不会把过期状态写进 run 目录。
       */
      function stateTokenOf() {
        const data = isObject(study.data) ? study.data : null
        return data !== null && typeof data.stateToken === 'string' ? data.stateToken : ''
      }

      /** 针对「当前 study」的写操作。 */
      function runCommand(name, params, argvPreview, afterSuccess) {
        return runCommandOn(run, name, params, argvPreview, afterSuccess)
      }

      /**
       * 通用写操作。
       *
       * - `targetRun` 允许与当前选中的 study 不同（只有「新建 study」用得到）；
       * - `expect` 只对**当前 study** 带（新建 run 还没有 stateToken，带了必然 409）；
       * - 409 `state-changed` → 提示 + 刷新 + **不重试**（DESIGN §8.6C-4）。
       */
      async function runCommandOn(targetRun, name, params, argvPreview, afterSuccess) {
        const wanted = typeof targetRun === 'string' && targetRun !== '' ? targetRun : run
        if (wanted === '' || execDisabled === true) return
        const body = { run: wanted }
        body.command = name
        if (isObject(params) && Object.keys(params).length > 0) body.params = params
        const token = stateTokenOf()
        if (token !== '' && wanted === run) body.expect = token
        /* 交接来的 root 一并回传，保证面板与宿主对同一个根目录说话。 */
        if (typeof handoffRoot === 'string' && handoffRoot !== '') body.root = handoffRoot
        setExec({
          status: 'running',
          error: '',
          command: name,
          argv: Array.isArray(argvPreview) ? argvPreview : [],
          result: null,
        })
        try {
          const data = await postJson(withRoot(`${API}/exec`), body)
          if (aliveRef.current !== true) return
          const argv = isObject(data) && Array.isArray(data.argv) ? data.argv : argvPreview
          setExec({ status: 'done', error: '', command: name, argv: argv, result: isObject(data) ? data : null })
          if (isObject(data) && isObject(data.receipt)) setTellReceipt(data.receipt)
          /* 成功推进后立刻反映到视图/决策页；视图强制重渲染才能看到新批次。 */
          if (isObject(data) && data.exitCode === 0) {
            void loadView(true, wanted)
            void loadStudy(true, wanted)
            if (typeof afterSuccess === 'function') {
              try {
                afterSuccess(data)
              } catch {
                /* 成功回调不参与成败判定 */
              }
            }
          }
        } catch (error) {
          if (aliveRef.current !== true) return
          if (error && error.code === 'exec-disabled') setExecDisabled(true)
          /* DESIGN §8.6C-4：409 state-changed → 提示 + 刷新，绝不自动重试原请求。 */
          if (error && error.code === 'state-changed') {
            setExec({
              status: 'stale',
              error: t('exec.stateChanged'),
              command: name,
              argv: Array.isArray(argvPreview) ? argvPreview : [],
              result: null,
            })
            void loadStudy(true, run)
            void loadView(true, run)
            return
          }
          setExec({
            status: 'error',
            error: messageOf(error),
            command: name,
            argv: Array.isArray(argvPreview) ? argvPreview : [],
            result: null,
          })
        }
      }

      /* DESIGN §5 v1.1：ask 的参数是 `n`（不是 batch），argv 为 `ask --run <r> [--n n] [--plate P] --json`。 */
      function onAsk() {
        const n = readNumber(form.askN)
        /* 数字控件写得不像数字时**不拦请求**：字段是可选的，直接不带它交给宿主，
           同时在面板上说明被忽略了（值校验的权威在宿主，DESIGN §5）。 */
        setInputNote(n.ok === true ? '' : t('params.numberIgnored', { field: t('params.askN') }))
        const plate = readText(form.plate)
        const params = {}
        if (n.value !== null) params.n = n.value
        if (plate !== null) params.plate = plate
        const argv = ['ask', '--run', run]
        if (params.n !== undefined) argv.push('--n', String(params.n))
        if (params.plate !== undefined) argv.push('--plate', params.plate)
        argv.push('--json')
        /* ask 成功 → 亮出回填区块（DESIGN §8.6C-2：ask 成功后出现）。 */
        void runCommand('ask', params, argv, () => setTellOpen(true))
      }

      function onConfirm() {
        const n = readNumber(form.n)
        setInputNote(n.ok === true ? '' : t('params.numberIgnored', { field: t('params.confirmN') }))
        const params = {}
        if (n.value !== null) params.n = n.value
        const argv = ['confirm', '--run', run]
        if (params.n !== undefined) argv.push('--n', String(params.n))
        /* DESIGN v1.3：预览与服务端 argv 逐项一致（confirm 也带 --json）。 */
        argv.push('--json')
        void runCommand('confirm', params, argv)
      }

      /**
       * 覆写算法（DESIGN §8.6C-1 第三块）。
       *
       * v2.0：只提交**用户真正改动过**的字段（值与其 spec 默认值不同的项）。
       * 没改动任何字段 → 内层 `params` 省略，保持最小请求。
       */
      function onOverride() {
        const algorithm = readText(form.algorithm)
        if (algorithm === null) {
          setExec({ status: 'error', error: t('params.algorithmRequired'), command: 'override', argv: [], result: null })
          return
        }
        const reason = readText(form.reason)
        if (reason === null) {
          setExec({ status: 'error', error: t('params.reasonRequired'), command: 'override', argv: [], result: null })
          return
        }
        const hyper = hyperParamsFor(activeSpec)
        const commandParams = { algorithm, reason }
        const argv = ['override', '--run', run, '--algorithm', algorithm]
        if (hyper !== null) {
          commandParams.params = hyper
          try {
            /* host 的 json 类参数会被紧凑重排，本地预览与它保持一致。 */
            argv.push('--params', JSON.stringify(hyper))
          } catch {
            delete commandParams.params
          }
        }
        argv.push('--reason', reason, '--json')
        void runCommand('override', commandParams, argv)
      }

      /** 新建 study：默认只复制命令；点「创建」→ 亮出确认文案 → 再点一次才执行 init。 */
      function onInitCreate() {
        const newRun = readText(form.newRun)
        if (newRun === null) {
          setExec({ status: 'error', error: t('params.initNeedRun'), command: 'init', argv: [], result: null })
          return
        }
        const space = readText(form.space)
        const objective = readText(form.objective)
        const budget = readNumber(form.budget)
        const batch = readNumber(form.batch)
        if (space === null || objective === null || budget.ok !== true || budget.value === null
          || batch.ok !== true || batch.value === null) {
          setExec({ status: 'error', error: t('params.initNeedFields'), command: 'init', argv: [], result: null })
          return
        }
        if (initConfirm !== true) {
          /* 第一段：只亮出确认文案，不发请求。 */
          setInitConfirm(true)
          return
        }
        const params = { space, objective, budget: budget.value, batch: batch.value }
        if (form.algorithm !== '') params.algorithm = form.algorithm
        const hyper = paramJson(activeSpec)
        const argv = ['init', '--run', newRun, '--space', space, '--objective', objective,
          '--budget', String(budget.value), '--batch', String(batch.value)]
        if (params.algorithm !== undefined) argv.push('--algorithm', params.algorithm)
        if (Object.keys(hyper).length > 0) {
          params.params = hyper
          try {
            argv.push('--params', JSON.stringify(hyper))
          } catch {
            delete params.params
          }
        }
        argv.push('--json')
        setInitConfirm(false)
        /* init 的目标 run 与当前选中的 study 不同：用 newRun 覆盖 body.run。 */
        void runCommandOn(newRun, 'init', params, argv)
      }

      /**
       * 回填实验结果（DESIGN §8.6B/C-2）。
       *
       * `resultsText` 是**内容**而不是路径：宿主把它写进 tmpdir 再交给 CLI，
       * 调用结束即删。`expect` 由 runCommand 统一带上。
       */
      function onTell() {
        const resultsText = String(form.tellText === undefined ? '' : form.tellText)
        if (resultsText.trim() === '') {
          setExec({ status: 'error', error: t('tell.needText'), command: 'tell', argv: [], result: null })
          return
        }
        const params = { resultsText }
        const reason = readText(form.tellReason)
        if (reason !== null) params.reason = reason
        /* expect 是 **body 顶层**字段（DESIGN §8.6A）：由 runCommand 统一带上，
           不进 params——参数表里的 expect 只是旧稿的写法，宿主会把它删掉。 */
        const format = analyzeResults(resultsText)
        const argv = ['tell', '--run', run, '--results', '<tmp>' + (format.ok === true ? '.' + format.ext : ''), '--json']
        void runCommand('tell', params, argv)
      }

      function onAuto() {
        /* v1.2：auto 也带 --json（回包 data 才有结构）。 */
        void runCommand('auto', {}, ['auto', '--run', run, '--json'])
      }

      function onStep() {
        void runCommand('step', {}, ['step', '--run', run, '--json'])
      }

      /** `/api/health.python` 的可读形式：兼容字符串与 `['py','-3']` 数组两种形状。 */
      function pythonDisplay() {
        const value = health !== null ? health.python : undefined
        if (Array.isArray(value) && value.length > 0) return value.map((part) => String(part)).join(' ')
        if (typeof value === 'string' && value !== '') return value
        return 'py -3'
      }

      function onCopy() {
        const argv = Array.isArray(exec.argv) ? exec.argv : []
        if (argv.length === 0) return
        const root = rootPath()
        const prefix = root !== '' ? `cd ${root} && ` : ''
        void copyThen(prefix + `${pythonDisplay()} scripts/run_condopt.py ` + argv.join(' '))
      }

      async function copyThen(text) {
        const ok = await copyText(text)
        if (aliveRef.current !== true) return
        setCopied(ok ? 'ok' : 'fail')
      }

      /* ---------------- 派生展示值 ---------------- */

      const rows = studies !== null && Array.isArray(studies.runs) ? studies.runs : []
      const rootPathValue = health !== null && typeof health.root === 'string' && health.root !== ''
        ? health.root
        : studies !== null && typeof studies.root === 'string' ? studies.root : ''
      function rootPath() {
        return rootPathValue
      }

      function initSample() {
        const prefix = rootPathValue !== '' ? `cd ${rootPathValue} && ` : ''
        return `${prefix}${pythonDisplay()} scripts/run_condopt.py init --run runs/my_study `
          + '--space space.json --objective "yield:max" --budget 24 --batch 6 --json'
      }

      const busy = exec.status === 'running'
      const actionDisabled = run === '' || execDisabled === true || busy
      const activeSpec = spec.data !== null && Array.isArray(spec.data)
        ? spec.data.find((row) => String(row.name || '') === form.algorithm)
        : undefined

      const viewData = isObject(view.data) ? view.data : null
      const studyData = isObject(study.data) ? study.data : null

      /* ---------------- v2.0 派生值 ---------------- */

      /** 当前 study 的待回填批次数（优先 `/api/study.pending`，退回 `current.pendingCount`）。 */
      function pendingCountOfData(data) {
        if (isObject(data) === false) return null
        if (isObject(data.pending)) {
          if (typeof data.pending.n_pending === 'number') return data.pending.n_pending
          if (Array.isArray(data.pending.pending)) return data.pending.pending.length
        }
        if (isObject(data.current) && typeof data.current.pendingCount === 'number') return data.current.pendingCount
        return null
      }

      /** 缺失值统一显示「未知」。 */
      function unknownText(value) {
        return value === null || value === undefined || value === '' ? t('params.unknown') : displayValue(value)
      }

      /** 状态令牌只显示前 8 位（DESIGN §8.6C：面板显示令牌前 8 位）。 */
      function shortToken(token) {
        return typeof token === 'string' && token !== '' ? token.slice(0, 8) : t('params.unknown')
      }

      /** schema 默认值 → 输入框文本。 */
      function paramDefaultText(param) {
        return displayValue(param.default === undefined || param.default === null ? '' : param.default)
      }

      /** 按 schema 类型把控件文本转成 JSON 值。 */
      function typedParamValue(param, raw) {
        const type = typeof param.type === 'string' ? param.type : 'str'
        if (type === 'bool') return raw === 'true'
        if (type === 'int' || type === 'float') {
          const value = Number(raw)
          return Number.isFinite(value) ? value : param.default
        }
        return raw
      }

      /** 当前表单（默认值 + 用户改动）→ `--params` 需要的带类型 JSON 对象。 */
      function paramJson(activeAlgorithm) {
        const params = isObject(activeAlgorithm) && Array.isArray(activeAlgorithm.params)
          ? activeAlgorithm.params.filter((row) => isObject(row))
          : []
        const out = {}
        for (const param of params) {
          const name = typeof param.name === 'string' ? param.name : ''
          if (name === '') continue
          const raw = paramValues[name] !== undefined ? String(paramValues[name]) : paramDefaultText(param)
          /* 空值控件不参与：一个空的超参比缺省更糟（CLI 会拿到空串）。 */
          if (raw.trim() === '') continue
          out[name] = typedParamValue(param, raw.trim())
        }
        return out
      }

      /**
       * 用户**真正改动过**的字段（v2.0：override 只提交这些）。
       *
       * 「改动」= 控件文本与 spec 默认值不同，且非空；`rawFrom` 保留默认值原文，
       * 便于 diff 展示与类型转换。
       */
      function changedEntries(activeAlgorithm) {
        if (isObject(activeAlgorithm) === false) return []
        const params = Array.isArray(activeAlgorithm.params) ? activeAlgorithm.params.filter((row) => isObject(row)) : []
        const out = []
        for (const param of params) {
          const name = typeof param.name === 'string' ? param.name : ''
          if (name === '') continue
          const rawFrom = paramDefaultText(param).trim()
          const to = paramValues[name] !== undefined ? String(paramValues[name]).trim() : rawFrom
          if (to === '' || to === rawFrom) continue
          out.push({ name, rawFrom, from: rawFrom, to, param })
        }
        return out
      }

      /** 改动项 → 内层 `params`（JSON 对象）；无改动返回 null。 */
      function hyperParamsFor(activeAlgorithm) {
        const entries = changedEntries(activeAlgorithm)
        if (entries.length === 0) return null
        const out = {}
        for (const entry of entries) out[entry.name] = typedParamValue(entry.param, entry.to)
        return Object.keys(out).length > 0 ? out : null
      }

      /* ---------------- 子视图 ---------------- */

      function header() {
        return h('div', { className: 'dco-head' },
          h('div', { className: 'dco-head-row' },
            h('span', { className: 'dco-title' }, t('panel.title')),
            h('button', {
              type: 'button',
              className: 'dco-btn',
              onClick: () => {
                void loadHealth()
                void loadStudies()
                if (run !== '') {
                  void loadView(false, run)
                  void loadStudy(true, run)
                }
              },
            }, t('panel.refresh')),
          ),
          rootPathValue !== ''
            ? h('div', { className: 'dco-root', title: rootPathValue }, `${t('panel.root')}: ${rootPathValue}`)
            : null,
          h('div', { className: 'dco-field' },
            h('span', { className: 'dco-field-label' }, t('panel.study')),
            h('select', {
              className: 'dco-select',
              value: run,
              disabled: rows.length === 0,
              onChange: (event) => {
                const value = eventValue(event)
                selectedRunRef.current = value
                setRun(value)
              },
            }, rows.length === 0
              ? h('option', { value: '' }, t('panel.noStudy'))
              : rows.map((row) => {
                const value = studyValue(row)
                return h('option', { key: value, value }, studyLabel(row))
              })),
          ),
          h('div', { className: 'dco-head-row' },
            h('label', { className: 'dco-toggle', title: t('panel.autoHint') },
              h('input', {
                type: 'checkbox',
                checked: auto === true,
                onChange: () => setAuto((value) => value !== true),
              }),
              h('span', null, t('panel.auto')),
            ),
            copied === 'ok' ? h('span', { className: 'dco-ok' }, t('panel.copyOk')) : null,
            copied === 'fail' ? h('span', { className: 'dco-err' }, t('panel.copyFail')) : null,
          ),
          execDisabled === true ? h('div', { className: 'dco-note' }, t('panel.execDisabled')) : null,
        )
      }

      function subtabs() {
        return h('div', { className: 'dco-subtabs' },
          PANES.map((name) => h('button', {
            key: name,
            type: 'button',
            className: 'dco-subtab' + (pane === name ? ' dco-on' : ''),
            onClick: () => {
              setPane(name)
              /* 立刻取数，不等下一轮 effect：离线 harness 与真实外壳都更可预测。 */
              ensurePaneData(name, run)
            },
          }, t(`subtab.${name}`))),
        )
      }

      function emptyState() {
        return h('div', { className: 'dco-card' },
          h('div', { className: 'dco-card-title' }, t('panel.noRunsTitle')),
          h('div', { className: 'dco-note' }, t('panel.noRunsHint')),
          h('pre', { className: 'dco-pre' }, initSample()),
          h('div', { className: 'dco-row' },
            h('button', { type: 'button', className: 'dco-btn', onClick: () => void copyThen(initSample()) },
              t('panel.copy')),
          ),
        )
      }

      function warningList(warnings) {
        if (Array.isArray(warnings) === false || warnings.length === 0) return null
        return h('div', { className: 'dco-warn' },
          h('div', { className: 'dco-card-title' }, t('view.warnings')),
          h('div', null, warnings.map((item) => String(item)).join('\n')),
        )
      }

      function viewPane() {
        if (run === '') return h('div', { className: 'dco-note' }, t('panel.noStudy'))
        const meta = []
        if (viewData !== null) {
          meta.push(t('view.meta', {
            bytes: displayValue(viewData.bytes),
            time: formatTime(viewData.generatedAt),
          }))
          meta.push(viewData.cached === true ? t('view.cached') : t('view.rebuilt'))
        }
        return [
          h('div', { key: 'bar', className: 'dco-row' },
            h('button', {
              type: 'button',
              className: 'dco-btn dco-primary',
              disabled: view.status === 'loading',
              onClick: () => void loadView(viewData !== null, run),
            }, viewData === null ? t('view.generate') : t('view.regenerate')),
            h('span', { className: 'dco-dim' }, meta.join(' · ')),
          ),
          h('div', { key: 'note', className: 'dco-note' }, t('view.shadowHint')),
          view.status === 'error'
            ? h('div', { key: 'err', className: 'dco-err' }, t('view.failed', { message: view.error }))
            : null,
          view.status === 'error'
            ? h('div', { key: 'retry', className: 'dco-row' },
                h('button', { type: 'button', className: 'dco-btn', onClick: () => void loadView(true, run) },
                  t('panel.retry')),
              )
            : null,
          view.status === 'loading' && viewData === null
            ? h('div', { key: 'loading', className: 'dco-row' },
                h('span', { className: 'dco-spinner', 'aria-hidden': true }),
                h('span', { className: 'dco-dim' }, t('view.loading')),
              )
            : null,
          viewData === null
            ? (view.status === 'idle' ? h('div', { key: 'idle', className: 'dco-note' }, t('view.idle')) : null)
            : h(ShadowHtml, {
                key: `shadow:${view.run}`,
                css: typeof viewData.css === 'string' ? viewData.css : '',
                html: typeof viewData.html === 'string' ? viewData.html : '',
              }),
          h('div', { key: 'warn' }, warningList(viewData === null ? null : viewData.warnings)),
        ]
      }

      /**
       * schema 参数控件。
       *
       * v1 的 `/api/exec` 白名单不接受这些参数，所以它们不会被 POST 出去；
       * 输入值只用于拼「复制 init 命令」（真实 condopt CLI 的 init/override 收 --params）。
       */
      function specParamControl(param) {
        const type = typeof param.type === 'string' ? param.type : 'str'
        const name = typeof param.name === 'string' ? param.name : ''
        const title = typeof param.description === 'string' ? param.description : ''
        const current = paramValues[name] !== undefined ? paramValues[name] : paramDefaultText(param)
        const setParam = (value) => {
          setParamValues((previous) => Object.assign({}, previous, { [name]: value }))
        }
        if (type === 'choice' && Array.isArray(param.choices)) {
          return h('select', {
            className: 'dco-select',
            value: current,
            title,
            onChange: (event) => setParam(eventValue(event)),
          }, param.choices.map((choice, index) => h('option', { key: `${index}`, value: String(choice) }, String(choice))))
        }
        if (type === 'bool') {
          return h('input', {
            type: 'checkbox',
            checked: current === 'true',
            title,
            onChange: (event) => {
              /* 复选框读的是 event.target.checked，不能「有 onChange 就翻转」：
                 后者会把任何合成的 change 事件（离线 harness 的通用填充器、
                 或某些浏览器扩展）都当成用户操作。缺 checked 的事件直接忽略。 */
              const checked = isObject(event) && isObject(event.target) && typeof event.target.checked === 'boolean'
                ? event.target.checked
                : null
              if (checked === null) return
              setParam(checked ? 'true' : 'false')
            },
          })
        }
        return h('input', {
          className: 'dco-input',
          type: type === 'int' || type === 'float' ? 'number' : 'text',
          value: current,
          title,
          onChange: (event) => setParam(eventValue(event)),
        })
      }

      /** 把字面量安全地塞进 shell 单引号串（Windows PowerShell 同样接受）。 */
      function shellSingle(value) {
        return `'${String(value).replace(/'/g, "'\\''")}'`
      }

      function initCommandText(activeAlgorithm) {
        const prefix = rootPathValue !== '' ? `cd ${rootPathValue} && ` : ''
        /* 「新建 study」的目标是**新** run：优先用表单里的新 run 名，再看当前 study。 */
        const target = readText(form.newRun) !== null ? form.newRun.trim() : (run !== '' ? run : 'runs/my_study')
        const parts = [prefix + pythonDisplay(), 'scripts/run_condopt.py', 'init', '--run', target]
        parts.push('--space', readText(form.space) !== null ? form.space.trim() : 'space.json')
        if (readText(form.objective) !== null) parts.push('--objective', shellSingle(form.objective.trim()))
        const budget = readNumber(form.budget)
        if (budget.ok === true && budget.value !== null) parts.push('--budget', String(budget.value))
        const batch = readNumber(form.batch)
        if (batch.ok === true && batch.value !== null) parts.push('--batch', String(batch.value))
        if (activeAlgorithm !== undefined && form.algorithm !== '') parts.push('--algorithm', form.algorithm)
        const params = paramJson(activeAlgorithm)
        if (Object.keys(params).length > 0) {
          try {
            parts.push('--params', shellSingle(JSON.stringify(params)))
          } catch {
            /* 序列化失败就不带 --params */
          }
        }
        parts.push('--json')
        return parts.join(' ')
      }

      /** 表单里的一格：label + input，值统一写进 `form[key]`。 */
      function formField(label, placeholder, key, type, extraStyle) {
        const props = {
          className: 'dco-input',
          type: type === 'number' ? 'number' : 'text',
          value: form[key],
          onChange: (event) => {
            const value = eventValue(event)
            setForm((current) => Object.assign({}, current, { [key]: value }))
          },
        }
        if (typeof placeholder === 'string' && placeholder !== '') props.placeholder = placeholder
        if (isObject(extraStyle)) props.style = extraStyle
        return h('label', { key, className: 'dco-lbl' },
          h('span', null, label),
          h('input', props),
        )
      }

      /** 去掉按钮/选择框里的行内样式噪音：统一走 className。 */
      function tellFormatLabel(format) {
        if (format === 'json' || format === 'jsonl' || format === 'csv' || format === 'tsv') {
          return t(`tell.format.${format}`)
        }
        return t('params.unknown')
      }

      /**
       * 第一块：当前 study（只读）。
       *
       * 数据来自 `/api/study` 的 `current` 与 `stateToken`（DESIGN §8.6A）；
       * 取不到就显示「未知」——绝不用面板自己的猜测填充。
       */
      function currentBlock() {
        const current = studyData !== null && isObject(studyData.current) ? studyData.current : null
        const rowsView = current === null ? [] : [
          [t('params.current.algorithm'), current.algorithm],
          [t('params.current.params'), current.params],
          [t('params.current.objective'), current.objective],
          [t('params.current.direction'), current.direction],
          [t('params.current.budget'), current.budget],
          [t('params.current.batch'), current.batch],
          [t('params.current.nObservations'), current.nObservations],
          [t('params.current.pendingCount'), current.pendingCount],
          [t('params.current.remaining'), current.remaining],
        ]
        return h('div', { className: 'dco-card' },
          h('div', { className: 'dco-card-title' }, t('params.block.current')),
          h('div', { className: 'dco-note' }, t('params.block.currentHint')),
          h('div', { className: 'dco-row' },
            h('span', { className: 'dco-dim' }, `${t('panel.study')}: ${run}`),
            h('span', { className: 'dco-dim' }, `${t('params.token')}: ${shortToken(studyData === null ? '' : studyData.stateToken)}`),
            h('button', {
              type: 'button',
              className: 'dco-btn',
              disabled: study.status === 'loading',
              onClick: () => void loadStudy(true, run),
            }, t('params.reloadCurrent')),
          ),
          study.status === 'error'
            ? h('div', { className: 'dco-err' }, t('decisions.failed', { message: study.error }))
            : null,
          rowsView.length === 0
            ? h('div', { className: 'dco-note' }, t('params.unknown'))
            : h('table', { className: 'dco-table' },
                h('tbody', null, rowsView.map((pair, index) => h('tr', { key: `${index}:${pair[0]}` },
                  h('td', { className: 'dco-dim' }, pair[0]),
                  h('td', null, unknownText(pair[1])),
                )))),
          h('div', null, warningList(studyData === null ? null : studyData.warnings)),
        )
      }

      /** 第二块：下一批参数（作用对象 = 当前 study）。 */
      function nextBatchBlock() {
        return h('div', { className: 'dco-card' },
          h('div', { className: 'dco-card-title' }, t('params.block.nextBatch')),
          h('div', { className: 'dco-note' }, t('params.block.nextBatchHint', { run })),
          h('div', { className: 'dco-form-grid' },
            formField(t('params.askN'), t('params.askNPlaceholder'), 'askN', 'number'),
            formField(t('params.plate'), t('params.platePlaceholder'), 'plate', 'text'),
            formField(t('params.confirmN'), '', 'n', 'number'),
          ),
          h('div', { className: 'dco-row' },
            h('button', {
              type: 'button', className: 'dco-btn dco-primary', disabled: actionDisabled, onClick: onAsk,
            }, busy ? t('action.running') : t('action.ask')),
            h('button', { type: 'button', className: 'dco-btn', disabled: actionDisabled, onClick: onConfirm },
              t('action.confirm')),
            h('button', { type: 'button', className: 'dco-btn', disabled: actionDisabled, onClick: onAuto },
              t('action.auto')),
            h('button', {
              type: 'button', className: 'dco-btn', disabled: actionDisabled,
              title: t('action.stepHint'), onClick: onStep,
            }, t('action.step')),
            h('button', {
              type: 'button', className: 'dco-btn',
              disabled: execDisabled === true || exec.argv.length === 0,
              title: exec.argv.length === 0 ? t('action.copyIdle') : t('action.copy'),
              onClick: onCopy,
            }, t('action.copy')),
          ),
        )
      }

      /** 回填回执（DESIGN §8.6B：acceptedRows / pending 前后 / dataset 前后 / format）。 */
      function tellReceiptBlock() {
        if (isObject(tellReceipt) === false) return null
        const receipt = tellReceipt
        return h('div', { className: 'dco-card' },
          h('div', { className: 'dco-card-title' }, t('tell.receipt')),
          h('div', { className: 'dco-dim' }, t('tell.receipt.rows', {
            rows: displayValue(receipt.resultsRows),
            format: tellFormatLabel(receipt.format),
          })),
          h('div', { className: 'dco-dim' }, t('tell.receipt.accepted', { accepted: displayValue(receipt.acceptedRows) })),
          h('div', { className: 'dco-dim' }, t('tell.receipt.pending', {
            before: displayValue(receipt.pendingBefore), after: displayValue(receipt.pendingAfter),
          })),
          h('div', { className: 'dco-dim' }, t('tell.receipt.dataset', {
            before: displayValue(receipt.datasetBefore), after: displayValue(receipt.datasetAfter),
          })),
        )
      }

      /**
       * 回填区块（ask 成功后出现，DESIGN §8.6C-2）。
       *
       * 预览的五个要素：目标 run / 行数 / 解析形态 / 当前 pending 数 / 令牌前 8 位。
       * 解析只用客户端镜像做「预览」，最终校验在宿主；两边不一致时以宿主回执为准。
       */
      function tellBlock() {
        if (tellOpen !== true) return null
        const analysis = analyzeResults(form.tellText)
        const text = String(form.tellText === undefined ? '' : form.tellText)
        const parseError = text.trim() === ''
          ? t('tell.needText')
          : (analysis.ok === true ? '' : t('tell.invalid', { message: t(`tell.err.${analysis.code === '' ? 'unparsed' : analysis.code}`) }))
        return h('div', { className: 'dco-card' },
          h('div', { className: 'dco-card-title' }, t('tell.title')),
          h('div', { className: 'dco-note' }, t('tell.hint')),
          h('div', { className: 'dco-note' }, t('tell.opened')),
          h('label', { className: 'dco-lbl' },
            h('span', null, t('tell.placeholder')),
            h('textarea', {
              className: 'dco-textarea',
              placeholder: t('tell.placeholder'),
              value: form.tellText,
              onChange: (event) => {
                const value = eventValue(event)
                setForm((current) => Object.assign({}, current, { tellText: value }))
              },
            }),
          ),
          h('div', { className: 'dco-card-title' }, t('tell.preview')),
          h('div', { className: 'dco-row' },
            h('span', { className: 'dco-dim' }, `${t('tell.targetRun')}: ${run}`),
            h('span', { className: 'dco-dim' }, `${t('tell.rows')}: ${t('tell.rowsValue', { count: analysis.rows })}`),
            h('span', { className: 'dco-dim' }, `${t('tell.format')}: ${analysis.format === null ? t('params.unknown') : tellFormatLabel(analysis.format)}`),
            h('span', { className: 'dco-dim' }, `${t('tell.pending')}: ${unknownText(pendingCountOfData(studyData))}`),
            h('span', { className: 'dco-dim' }, `${t('tell.token')}: ${shortToken(studyData === null ? '' : studyData.stateToken)}`),
          ),
          parseError !== '' && text.trim() !== '' ? h('div', { className: 'dco-err' }, parseError) : null,
          h('label', { className: 'dco-lbl' },
            h('span', null, t('tell.reason')),
            h('input', {
              className: 'dco-input',
              type: 'text',
              value: form.tellReason,
              onChange: (event) => {
                const value = eventValue(event)
                setForm((current) => Object.assign({}, current, { tellReason: value }))
              },
            }),
          ),
          h('div', { className: 'dco-row' },
            h('button', {
              type: 'button', className: 'dco-btn dco-primary',
              disabled: actionDisabled || text.trim() === '',
              onClick: onTell,
            }, busy ? t('action.running') : t('tell.confirm')),
            h('button', { type: 'button', className: 'dco-btn', onClick: () => setTellOpen(false) },
              t('tell.close')),
          ),
          tellReceiptBlock(),
        )
      }

      /**
       * 第三块：算法覆写（作用对象 = 当前 study）。
       *
       * v2.0 的关键差异：schema 控件就在这一块里，但**只有与默认值不同的字段**
       * 会被 diff 列出来并随 override 提交（见 `changedEntries`）。
       */
      function overrideBlock() {
        const entries = changedEntries(activeSpec)
        const paramList = isObject(activeSpec) && Array.isArray(activeSpec.params)
          ? activeSpec.params.filter((row) => isObject(row))
          : []
        const nodes = [
          h('div', { key: 'title', className: 'dco-card-title' }, t('params.block.override')),
          h('div', { key: 'hint', className: 'dco-note' }, t('params.block.overrideHint', { run })),
          h('div', { key: 'algo', className: 'dco-field' },
            h('span', { className: 'dco-field-label' }, t('params.algorithm')),
            h('select', {
              className: 'dco-select',
              value: form.algorithm,
              disabled: spec.data === null || spec.data.length === 0,
              onChange: (event) => {
                const value = eventValue(event)
                /* 换算法 = 换参数集合：清掉旧草稿，避免把上一个算法的键带进 --params。 */
                setParamValues({})
                setForm((current) => Object.assign({}, current, { algorithm: value }))
              },
            }, spec.data === null || spec.data.length === 0
              ? h('option', { value: '' }, t('panel.loading'))
              : spec.data.map((row) => {
                const name = String(row.name || '')
                return h('option', { key: name, value: name }, name)
              })),
          ),
        ]

        if (activeSpec !== undefined) {
          nodes.push(h('div', { key: 'summary', className: 'dco-note' },
            [
              typeof activeSpec.family === 'string' && activeSpec.family !== ''
                ? t('params.family', { family: activeSpec.family }) : '',
              typeof activeSpec.when === 'string' && activeSpec.when !== ''
                ? t('params.when', { when: activeSpec.when }) : '',
            ].filter((part) => part !== '').join(' · '),
          ))
          nodes.push(h('div', { key: 'schema-title', className: 'dco-card-title' },
            t('params.schemaTitle', { count: paramList.length })))
          nodes.push(h('div', { key: 'schema-hint', className: 'dco-note' }, t('params.schemaHint')))
          if (paramList.length === 0) {
            nodes.push(h('div', { key: 'schema-empty', className: 'dco-note' }, t('params.noParams')))
          } else {
            const body = paramList.map((param, index) => {
              const type = typeof param.type === 'string' ? param.type : 'str'
              const notes = []
              notes.push(t('params.paramDefault', { value: displayValue(param.default) }))
              if (param.low !== undefined && param.high !== undefined) {
                notes.push(t('params.paramRange', { low: displayValue(param.low), high: displayValue(param.high) }))
              }
              if (Array.isArray(param.choices)) {
                notes.push(t('params.paramChoices', { choices: param.choices.map((c) => String(c)).join(' / ') }))
              }
              return h('tr', { key: `${index}:${String(param.name || '')}` },
                h('td', null,
                  h('div', null, String(param.name || '')),
                  h('div', { className: 'dco-dim' }, type),
                ),
                h('td', null, specParamControl(param)),
                h('td', null,
                  h('div', { className: 'dco-dim' }, notes.join(' · ')),
                  typeof param.description === 'string'
                    ? h('div', { className: 'dco-note' }, param.description)
                    : null,
                ),
              )
            })
            nodes.push(h('table', { key: 'schema', className: 'dco-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('params.colParam')),
                h('th', null, t('params.colSchema')),
                h('th', null, t('params.colNote')))),
              h('tbody', null, body),
            ))
          }
          /* 只列真正改动过的字段——这是 override 会提交的全部内容。 */
          nodes.push(h('div', { key: 'diff-title', className: 'dco-card-title' },
            t('params.diff.title', { count: entries.length })))
          nodes.push(entries.length === 0
            ? h('div', { key: 'diff-none', className: 'dco-note' }, t('params.diff.none'))
            : h('div', { key: 'diff', className: 'dco-timeline' }, entries.map((entry) => h('div', {
                key: entry.name,
                className: 'dco-entry',
              },
                h('div', { className: 'dco-entry-head' },
                  t('params.diff.row', { name: entry.name, from: entry.from, to: entry.to })),
              ))))
          nodes.push(h('div', { key: 'diff-reset', className: 'dco-row' },
            h('button', {
              type: 'button', className: 'dco-btn', disabled: entries.length === 0,
              onClick: () => setParamValues({}),
            }, t('params.diff.reset')),
          ))
        }

        nodes.push(h('label', { key: 'reason', className: 'dco-lbl' },
          h('span', null, t('params.reason')),
          h('textarea', {
            className: 'dco-textarea',
            placeholder: t('params.reasonPlaceholder'),
            value: form.reason,
            onChange: (event) => {
              const value = eventValue(event)
              setForm((current) => Object.assign({}, current, { reason: value }))
            },
          }),
        ))

        nodes.push(h('div', { key: 'actions', className: 'dco-row' },
          h('button', {
            type: 'button', className: 'dco-btn dco-primary', disabled: actionDisabled, onClick: onOverride,
          }, t('action.override')),
        ))
        return h('div', { className: 'dco-card' }, nodes)
      }

      /**
       * 第四块：新建 study。
       *
       * 默认只「复制命令」；点「创建」先亮出确认文案，再点一次才真的执行 init
       * （init 的目标 run 与当前 study 不同，因此走 `runCommandOn(newRun, …)`）。
       */
      function initBlock() {
        return h('div', { className: 'dco-card' },
          h('div', { className: 'dco-card-title' }, t('params.block.init')),
          h('div', { className: 'dco-note' }, t('params.block.initHint')),
          h('div', { className: 'dco-form-grid' },
            formField(t('params.newRun'), t('params.newRunPlaceholder'), 'newRun', 'text'),
            formField(t('params.space'), t('params.spacePlaceholder'), 'space', 'text'),
            formField(t('params.objective'), t('params.objectivePlaceholder'), 'objective', 'text'),
            formField(t('params.budget'), '', 'budget', 'number'),
            formField(t('params.batch'), t('params.batchPlaceholder'), 'batch', 'number'),
          ),
          h('div', { className: 'dco-row' },
            h('button', {
              type: 'button', className: 'dco-btn',
              title: t('action.copyInitHint'),
              onClick: () => void copyThen(initCommandText(activeSpec)),
            }, t('action.copyInit')),
            h('button', {
              type: 'button',
              className: 'dco-btn' + (initConfirm === true ? ' dco-primary' : ''),
              disabled: actionDisabled,
              onClick: onInitCreate,
            }, initConfirm === true ? t('action.initConfirm') : t('action.initCreate')),
            initConfirm === true
              ? h('button', {
                  type: 'button', className: 'dco-btn', onClick: () => setInitConfirm(false),
                }, t('action.initCancel'))
              : null,
            copied === 'ok' ? h('span', { className: 'dco-ok' }, t('panel.copyOk')) : null,
          ),
        )
      }

      /**
       * 参数页 = 四块（当前 study / 下一批 / 覆写 / 新建）+ 条件出现的回填区块。
       *
       * 四块互不混用：每块只写它自己声明的对象（DESIGN §8.6C-1）。
       */
      function paramsPane() {
        if (run === '') return h('div', { className: 'dco-note' }, t('panel.noStudy'))
        const nodes = []

        if (spec.status === 'error') {
          nodes.push(h('div', { key: 'specerr', className: 'dco-err' }, t('params.specFailed', { message: spec.error })))
          nodes.push(h('div', { key: 'specretry', className: 'dco-row' },
            h('button', { type: 'button', className: 'dco-btn', onClick: () => void loadSpec() }, t('panel.retry')),
          ))
        }

        nodes.push(h('div', { key: 'block-current' }, currentBlock()))
        nodes.push(h('div', { key: 'block-next' }, nextBatchBlock()))
        nodes.push(h('div', { key: 'block-tell' }, tellBlock()))
        nodes.push(h('div', { key: 'block-override' }, overrideBlock()))
        nodes.push(h('div', { key: 'block-init' }, initBlock()))
        if (inputNote !== '') nodes.push(h('div', { key: 'note', className: 'dco-warn' }, inputNote))
        nodes.push(h('div', { key: 'exec' }, execPane()))
        return nodes
      }

      function execPane() {
        if (exec.status === 'idle') return null
        const result = isObject(exec.result) ? exec.result : null
        const failed = exec.status === 'error' || (result !== null && result.exitCode !== 0)
        const nodes = [
          h('div', { key: 'head', className: 'dco-card-title' },
            `${t('exec.title')}${exec.command !== '' ? ' · ' + exec.command : ''}${result !== null ? ' · ' + (failed ? t('exec.failed') : t('exec.ok')) : ''}`),
        ]
        if (exec.status === 'error') {
          nodes.push(h('div', { key: 'err', className: 'dco-err' }, t('exec.failedCall', { message: exec.error })))
        }
        /* 409 state-changed：提示 + 已刷新，绝不自动重试（DESIGN §8.6C-4）。 */
        if (exec.status === 'stale') {
          nodes.push(h('div', { key: 'stale', className: 'dco-warn' }, t('exec.stateChanged')))
          nodes.push(h('div', { key: 'stale-hint', className: 'dco-note' }, t('exec.staleHint')))
        }
        if (Array.isArray(exec.argv) && exec.argv.length > 0) {
          nodes.push(h('div', { key: 'argv' },
            h('div', { className: 'dco-dim' }, t('exec.argv')),
            h('pre', { className: 'dco-pre' }, exec.argv.join(' ')),
          ))
        }
        if (result !== null) {
          nodes.push(h('div', { key: 'code', className: 'dco-dim' }, t('exec.exitCode', { code: displayValue(result.exitCode) })))
          nodes.push(h('div', { key: 'out' },
            h('div', { className: 'dco-dim' }, t('exec.stdout')),
            h('pre', { className: 'dco-pre' }, typeof result.stdout === 'string' && result.stdout !== '' ? result.stdout : t('exec.empty')),
          ))
          nodes.push(h('div', { key: 'serr' },
            h('div', { className: 'dco-dim' }, t('exec.stderr')),
            h('pre', { className: 'dco-pre' }, typeof result.stderr === 'string' && result.stderr !== '' ? result.stderr : t('exec.empty')),
          ))
          if (result.data !== null && result.data !== undefined) {
            nodes.push(h('div', { key: 'json' },
              h('div', { className: 'dco-dim' }, t('exec.json')),
              h('pre', { className: 'dco-pre' }, displayValue(result.data)),
            ))
          }
        }
        return h('div', { className: 'dco-card' }, nodes)
      }

      function decisionsPane() {
        if (run === '') return h('div', { className: 'dco-note' }, t('panel.noStudy'))
        const nodes = []
        if (study.status === 'error') {
          nodes.push(h('div', { key: 'err', className: 'dco-err' }, t('decisions.failed', { message: study.error })))
          nodes.push(h('div', { key: 'retry', className: 'dco-row' },
            h('button', { type: 'button', className: 'dco-btn', onClick: () => void loadStudy(true, run) }, t('panel.retry')),
          ))
        }
        if (study.status === 'loading' && studyData === null) {
          nodes.push(h('div', { key: 'loading', className: 'dco-row' },
            h('span', { className: 'dco-spinner', 'aria-hidden': true }),
            h('span', { className: 'dco-dim' }, t('panel.loading')),
          ))
        }

        if (studyData !== null) {
          const report = isObject(studyData.report) ? studyData.report : null
          if (report !== null) {
            nodes.push(h('div', { key: 'report', className: 'dco-card' },
              h('div', { className: 'dco-card-title' }, t('decisions.report')),
              h('div', { className: 'dco-row' },
                h('span', null, `${t('decisions.algorithm')}: ${displayValue(report.algorithm)}`),
                h('span', null, t('decisions.budget', {
                  used: displayValue(report.used), budget: displayValue(report.budget),
                })),
              ),
              h('div', { className: 'dco-row' },
                h('span', null, t('decisions.best', { score: formatScore(report.best_score) })),
                report.pending !== undefined
                  ? h('span', null, t('decisions.pending', { count: displayValue(report.pending) }))
                  : null,
                isObject(studyData.pareto) && studyData.pareto.n_front !== undefined
                  ? h('span', null, t('decisions.pareto', { count: displayValue(studyData.pareto.n_front) }))
                  : null,
              ),
            ))
          }

          const decisionList = isObject(studyData.decisions) && Array.isArray(studyData.decisions.decisions)
            ? studyData.decisions.decisions.filter((row) => isObject(row))
            : []
          nodes.push(h('div', { key: 'title', className: 'dco-card-title' },
            `${t('decisions.title')} · ${t('decisions.count', { count: decisionList.length })}`))
          if (decisionList.length === 0) {
            nodes.push(h('div', { key: 'empty', className: 'dco-note' }, t('decisions.empty')))
          } else {
            nodes.push(h('div', { key: 'timeline', className: 'dco-timeline' },
              decisionList.map((row, index) => h('div', {
                key: typeof row.seq === 'number' || typeof row.seq === 'string' ? String(row.seq) : `${index}`,
                className: 'dco-entry',
              },
                h('div', { className: 'dco-entry-t' }, formatTime(row.t)),
                h('div', { className: 'dco-entry-head' },
                  `${displayValue(row.action)} · ${displayValue(row.algorithm)}`),
                h('div', { className: 'dco-entry-body' },
                  typeof row.reason === 'string' && row.reason !== '' ? row.reason : '—'),
              )),
            ))
          }
          nodes.push(h('div', { key: 'warn' }, warningList(studyData.warnings)))
        }
        return nodes
      }

      // body
      let body = null
      if (loadingStudies === true) {
        body = h('div', { className: 'dco-row' },
          h('span', { className: 'dco-spinner', 'aria-hidden': true }),
          h('span', { className: 'dco-dim' }, t('panel.loading')),
        )
      } else if (studiesError !== '') {
        body = [
          h('div', { key: 'err', className: 'dco-err' }, t('panel.studiesError', { message: studiesError })),
          h('div', { key: 'retry', className: 'dco-row' },
            h('button', { type: 'button', className: 'dco-btn', onClick: () => void loadStudies() }, t('panel.retry')),
          ),
        ]
      } else if (rows.length === 0) {
        body = emptyState()
      } else if (pane === 'view') {
        body = viewPane()
      } else if (pane === 'params') {
        body = paramsPane()
      } else {
        body = decisionsPane()
      }

      return h('div', { className: 'dco-tab' },
        header(),
        subtabs(),
        h('div', { className: 'dco-body' }, body),
      )
    }

    /** study 行 → 用于 `/api/*` 的 run 值（优先相对路径）。 */
    function studyValue(row) {
      if (isObject(row) === false) return ''
      if (typeof row.rel === 'string' && row.rel !== '') return row.rel
      if (typeof row.id === 'string' && row.id !== '') return row.id
      return ''
    }

    /** study 行 → 下拉标签：`<id> · <algorithm> · <n> obs`。 */
    function studyLabel(row) {
      const id = studyValue(row)
      const parts = [id]
      if (isObject(row) && typeof row.algorithm === 'string' && row.algorithm !== '') parts.push(row.algorithm)
      if (isObject(row) && row.nObservations !== undefined && row.nObservations !== null) {
        parts.push(`${String(row.nObservations)} obs`)
      }
      return parts.filter((part) => part !== '').join(' · ')
    }

    /* ------------------------------------------------------------------ *
     * 插件入口                                                            *
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        hostCtx = ctx

        /* 热重载时可能残留上一份实例：先 teardown 掉，避免重复注册与定时器泄漏。 */
        const previous = window.__dshCondoptTeardown
        if (typeof previous === 'function') {
          try {
            previous()
          } catch {
            /* 上一份实例的清理是尽力而为 */
          }
        }

        const disposers = []
        let retired = false
        const track = (dispose) => {
          if (typeof dispose !== 'function') return dispose
          if (retired) {
            try {
              dispose()
            } catch {
              /* best effort */
            }
            return () => {}
          }
          disposers.push(dispose)
          return dispose
        }

        const teardown = () => {
          if (retired) return
          retired = true
          clearAllTimers()
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              /* 继续拆剩下的 */
            }
          }
          disposers.length = 0
          if (window.__dshCondoptTeardown === teardown) delete window.__dshCondoptTeardown
        }
        window.__dshCondoptTeardown = teardown

        /** ctx.effect 的防御式包装：没有这个能力就退化成 noop disposer。 */
        const effect = (fn, label) => {
          if (ctx === undefined || ctx === null || typeof ctx.effect !== 'function') return () => {}
          try {
            const dispose = ctx.effect(fn, label)
            return typeof dispose === 'function' ? dispose : () => {}
          } catch {
            return () => {}
          }
        }

        track(effect(() => teardown, 'condopt: instance'))

        /* locale：注册字典 + 绑定翻译；缺一个都不影响后面的注册。 */
        try {
          if (ctx !== undefined && ctx !== null && isObject(ctx.locale)) {
            if (typeof ctx.locale.register === 'function') {
              track(effect(() => ctx.locale.register(NS, { zh, en }), 'condopt: dictionaries'))
            }
            if (typeof ctx.locale.bind === 'function') {
              const bound = ctx.locale.bind(NS)
              if (typeof bound === 'function') tr = bound
            }
          }
        } catch {
          /* locale 不可用时保留 key 原文 */
        }

        /* 样式一次性注入，teardown 时移除。 */
        track(effect(() => {
          const doc = window.document
          if (doc === undefined || doc === null || typeof doc.createElement !== 'function') return undefined
          let tag = null
          try {
            tag = typeof doc.querySelector === 'function' ? doc.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) : null
          } catch {
            tag = null
          }
          const created = tag === null || tag === undefined
          if (created) {
            try {
              tag = doc.createElement('style')
              /* 用 setAttribute 而不是 dataset.x=：dataset 在真实 DOM 上是只读
                 访问器，严格模式下赋值会抛 TypeError，把整个 apply 打穿。 */
              if (typeof tag.setAttribute === 'function') {
                tag.setAttribute('data-plugin', '@local/dsh-condopt')
                tag.setAttribute('data-plugin-css', STYLE_ID)
              } else if (isObject(tag.dataset)) {
                tag.dataset.plugin = '@local/dsh-condopt'
                tag.dataset.pluginCss = STYLE_ID
              }
              tag.textContent = CSS
              if (isObject(doc.head) && typeof doc.head.appendChild === 'function') doc.head.appendChild(tag)
            } catch {
              /* 样式注入失败只意味着没有自定义外观，功能仍可用 */
              return undefined
            }
          }
          return () => {
            if (created && tag !== null && typeof tag.remove === 'function') tag.remove()
          }
        }, 'condopt: styles'))

        const slots = ctx === undefined || ctx === null ? undefined : ctx.slots

        /* 右侧栏 tab 本体：slot 注册（拿不到 slots 就整块跳过）。 */
        if (isObject(slots) && typeof slots.inject === 'function') {
          track(slots.inject('sidebar.right.pane.tab', () => {
            try {
              return slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, CondoptTab)
            } catch {
              return undefined
            }
          }))

          /* 对话内工具卡：key 必须与 agent 工具名逐字相同。 */
          track(slots.inject('tool.call.toolview', () => {
            try {
              return slots.register({ name: 'tool.call.toolview', key: 'condopt_view', locale: NS }, CondoptViewRow)
            } catch {
              return undefined
            }
          }))
        }

        /* 侧栏 tab 类型：服务缺失则跳过（不注册就只是没有这个入口）。 */
        if (ctx !== undefined && ctx !== null && typeof ctx.inject === 'function') {
          track(ctx.inject(['sidebarRightTabs'], (scope) => {
            try {
              const tabs = scope.get('sidebarRightTabs')
              if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return
              scope.effect(() => tabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                title: () => tr('tab.title'),
              }), 'condopt: sidebar tab type')
            } catch {
              /* 服务形状不对就跳过 */
            }
          }))

          /* `/condopt` 命令：available 恒真，run 打开右侧栏；不开任何写操作。 */
          track(ctx.inject(['commandUi'], (scope) => {
            try {
              const commandUi = scope.commandUi
              if (commandUi === undefined || commandUi === null || typeof commandUi.register !== 'function') return
              scope.effect(() => commandUi.register({
                name: 'condopt',
                label: () => tr('command.label'),
                description: () => tr('command.description'),
                icon: CondoptIcon,
                available: () => true,
                ui: {
                  kind: 'action',
                  run: () => {
                    void openCondoptTab()
                  },
                },
              }), 'condopt: /condopt command')
            } catch {
              /* 命令层不可用就跳过 */
            }
          }))
        }
      },
    }
  },
})
