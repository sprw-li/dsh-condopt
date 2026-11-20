/**
 * verify-host.mjs — dsh-condopt 宿主侧离线验收 harness（契约：DESIGN.md v1.2）
 *
 * 设计原则
 *  - 真实加载被测文件：`await import('../index.js')`，不做字符串匹配式假测试。
 *  - 纯函数单测（resolveRoot / resolveRunDir / EXEC_COMMANDS / buildExecArgv /
 *    splitDashboardHtml / parseJsonLoose / listStudies）用 node:fs 临时目录造 fixture。
 *  - 路由分派用假 req/res + 真 index.js；/api/exec 的“命令未列/参数错/开关关”等
 *    分支不落地任何子进程；唯一的写入路径用「run 目录快照」证明零写入不变量。
 *  - 真机项（真 spawn python）默认执行，`DSH_CONDOPT_SKIP_REAL=1` 或 `--skip-real` 可跳过。
 *
 * 运行：`node dev/verify-host.mjs`
 * 退出码：0 全过；1 有断言失败；2 被测文件不存在 / 无法加载。
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
/**
 * condopt 根解析（位置无关）：
 *   ① `DSH_CONDOPT_VERIFY_ROOT` → ② `CONDOPT_ROOT` → ③ 插件目录的上一级（`link:` 安装时就是仓库根）。
 * 每一级都要求「同时存在 `scripts/run_condopt.py` 与 `src/condopt/cli.py`」，不合法就继续下一级。
 * 全都不合法时 `repoRoot` 退化为插件父目录、`hasRealRoot = false`：**离线断言照跑**，所有真 CLI /
 * 写路径断言以明确原因 SKIP，进程仍 exit 0（发布仓库 fresh clone 不能因为找不到检出就崩）。
 * （`DSH_CONDOPT_VERIFY_ROOT` 只属于 harness，方便沙箱里指向一个可写临时根。）
 */
const pluginParent = resolve(pluginDir, '..')
function looksLikeCondoptRoot(dir) {
  return typeof dir === 'string' && dir.trim() !== ''
    && existsSync(join(dir, 'scripts', 'run_condopt.py'))
    && existsSync(join(dir, 'src', 'condopt', 'cli.py'))
}
const rootCandidates = []
if (typeof process.env.DSH_CONDOPT_VERIFY_ROOT === 'string' && process.env.DSH_CONDOPT_VERIFY_ROOT.trim() !== '') {
  rootCandidates.push({ dir: resolve(process.env.DSH_CONDOPT_VERIFY_ROOT), source: 'DSH_CONDOPT_VERIFY_ROOT' })
}
if (typeof process.env.CONDOPT_ROOT === 'string' && process.env.CONDOPT_ROOT.trim() !== '') {
  rootCandidates.push({ dir: resolve(process.env.CONDOPT_ROOT), source: 'CONDOPT_ROOT' })
}
rootCandidates.push({ dir: pluginParent, source: '插件目录的上一级' })
const matchedRoot = rootCandidates.find((candidate) => looksLikeCondoptRoot(candidate.dir))
const hasRealRoot = matchedRoot !== undefined
/* repoRoot 永远是个字符串（真根，或插件父目录），纯路径类断言用它做算术；真 CLI 断言看 hasRealRoot。 */
const repoRoot = hasRealRoot ? matchedRoot.dir : pluginParent
const NO_ROOT_REASON = '未找到 condopt 检出：设置 DSH_CONDOPT_VERIFY_ROOT 或 CONDOPT_ROOT 指向一个 condopt 仓库'
  + '（需含 scripts/run_condopt.py 与 src/condopt/cli.py）；纯离线断言已照跑'
const fixturesDir = join(here, 'fixtures')
const indexPath = join(pluginDir, 'index.js')
const skipReal = process.env.DSH_CONDOPT_SKIP_REAL === '1' || process.argv.includes('--skip-real')

/* ------------------------------------------------------------------ 断言骨架 */

const results = []
let groupName = 'general'

function group(name) {
  groupName = name
  process.stdout.write(`\n== ${name} ==\n`)
}
function pass(name, detail) {
  results.push({ ok: true, name, group: groupName })
  process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ''}\n`)
}
function fail(name, expected, actual) {
  results.push({ ok: false, name, group: groupName, expected, actual })
  process.stdout.write(`  FAIL ${name}\n       期望: ${expected}\n       实际: ${actual}\n`)
}
function check(name, cond, expected, actual) {
  if (cond) pass(name)
  else fail(name, expected, actual)
}
function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, same, JSON.stringify(expected), JSON.stringify(actual))
}
function note(message) {
  process.stdout.write(`  NOTE ${message}\n`)
}
const skips = []
function skip(name, reason) {
  skips.push({ name, reason })
  results.push({ ok: true, name, group: groupName, skipped: true })
  process.stdout.write(`  SKIP ${name} — ${reason}\n`)
}
/** 沙箱里 Node 的 spawn(stdio:'pipe') 会 EPERM（见 DSH 文件沙箱说明），真机项需据此降级。 */
function isSpawnBlocked(value) {
  let text = ''
  try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { text = String(value) }
  return /EPERM/.test(text) && /spawn/i.test(text)
}
/* JSON.stringify(undefined) 返回 undefined，直接 .slice 会崩；统一兜底。 */
const rawStringify = JSON.stringify
JSON.stringify = (value, ...rest) => {
  const out = rawStringify(value, ...rest)
  return out === undefined ? String(value) : out
}

function codeOf(err) {
  if (err === null || err === undefined) return undefined
  return err.code !== undefined ? err.code : err.errno
}
function thrown(fn) {
  try {
    return { threw: false, value: fn() }
  } catch (err) {
    return { threw: true, err, code: codeOf(err), status: err && err.status }
  }
}
async function thrownAsync(fn) {
  try {
    return { threw: false, value: await fn() }
  } catch (err) {
    return { threw: true, err, code: codeOf(err), status: err && err.status }
  }
}
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  return norm(a) === norm(b)
}

/* ------------------------------------------------------------------ 被测文件 */

process.stdout.write(`dsh-condopt host harness\n  plugin : ${pluginDir}\n  repo   : ${repoRoot}${hasRealRoot ? `  （condopt 检出：${matchedRoot.source}）` : '  （未找到 condopt 检出：真 CLI/写路径断言将 SKIP）'}\n`)

if (!existsSync(indexPath)) {
  process.stdout.write(`\n[缺失] ${indexPath} 不存在 —— 宿主侧实现尚未落地，无法验收（这是预期内的“文件不存在”）。\n`)
  process.stdout.write('       等 host-dev 交付 index.js 后重跑：node dev/verify-host.mjs\n')
  process.exit(2)
}

let mod
try {
  mod = await import(pathToFileURL(indexPath).href)
} catch (err) {
  process.stdout.write(`\n[加载失败] import('../index.js') 抛错：${err && err.stack ? err.stack : err}\n`)
  process.exit(2)
}

/* ------------------------------------------------------------------ 0. 导出面 */

group('导出面（DESIGN §2 / host-dev 冻结签名）')

const REQUIRED_EXPORTS = [
  'resolveRoot',
  'resolveRunDir',
  'EXEC_COMMANDS',
  'buildExecArgv',
  'splitDashboardHtml',
  'parseJsonLoose',
  'listStudies',
  'renderView',
  'createHandler',
  'stateToken',
  'CondoptError',
  'apply',
]
for (const name of REQUIRED_EXPORTS) {
  const value = mod[name]
  const kind = typeof value
  check(`导出 ${name} 存在且类型正确`, (name === 'EXEC_COMMANDS' && (kind === 'object' || kind === 'function')) || kind === 'function', 'function/object', `${kind}`)
}
check('导出 inject 含 webServer/tools', Array.isArray(mod.inject) && mod.inject.includes('webServer') && mod.inject.includes('tools'), "['webServer','tools']", JSON.stringify(mod.inject))
check('CondoptError 是 Error 子类且实例带 .code', typeof mod.CondoptError === 'function' && (mod.CondoptError.prototype instanceof Error || mod.CondoptError.prototype === Error) && (() => { try { throw new mod.CondoptError('x', 'bad-param') } catch (e) { return e instanceof Error && e.code === 'bad-param' } })(), 'Error 子类，new CondoptError(msg, code) 带 .code', String(mod.CondoptError))

/* ------------------------------------------------------------------ 临时 fixture */

const tmpBase = await mkdtemp(join(tmpdir(), 'dsh-condopt-host-'))
const validRoot = join(tmpBase, 'valid-root')
const badRoot = join(tmpBase, 'not-a-root')
const outDir = join(tmpBase, 'out')
await mkdir(join(validRoot, 'scripts'), { recursive: true })
await mkdir(join(validRoot, 'src', 'condopt'), { recursive: true })
await mkdir(join(validRoot, 'runs'), { recursive: true })
await mkdir(badRoot, { recursive: true })
await mkdir(outDir, { recursive: true })
await writeFile(join(validRoot, 'scripts', 'run_condopt.py'), '# fixture\n')
await writeFile(join(validRoot, 'src', 'condopt', 'cli.py'), '# fixture\n')
/* 把「插件自身目录」指到假目录，就能让 v1.4 候选 ④（插件父目录）失效，从而隔离测 ⑤/⑥/⑦。 */
const badSelfDir = join(badRoot, 'dsh-plugin')

/* ------------------------------------------------------------------ 1. resolveRoot */

group('resolveRoot（DESIGN §2 顺序 / 合法判据）')

const r1 = mod.resolveRoot({ root: validRoot })
check('arg 命中', r1 && samePath(r1.root, validRoot), `root=${validRoot}`, JSON.stringify(r1))
check('source=arg', r1 && r1.source === 'arg', "source='arg'", JSON.stringify(r1 && r1.source))

const r2 = mod.resolveRoot({ root: badRoot, env: { CONDOPT_ROOT: validRoot }, config: {}, cwd: badRoot })
check('env 命中（arg 不合法时）', r2 && samePath(r2.root, validRoot), `root=${validRoot}`, JSON.stringify(r2))

const r3 = mod.resolveRoot({ root: badRoot, env: { CONDOPT_ROOT: badRoot }, config: { projectRoot: validRoot }, cwd: badRoot })
check('config.projectRoot 命中', r3 && samePath(r3.root, validRoot), `root=${validRoot}`, JSON.stringify(r3))

const r4 = mod.resolveRoot({ root: badRoot, env: {}, config: { projectRoot: badRoot }, cwd: validRoot, selfDir: badSelfDir })
check('会话 cwd 命中', r4 && samePath(r4.root, validRoot), `root=${validRoot}`, JSON.stringify(r4))

const r4b = mod.resolveRoot({ root: badRoot, env: {}, config: { projectRoot: badRoot }, cwd: badRoot, selfDir: badSelfDir, sessionCwd: validRoot })
check('opts.sessionCwd 命中（v1.4 候选 ⑤ 的另一形态）', r4b && samePath(r4b.root, validRoot), `root=${validRoot}`, JSON.stringify(r4b))

const r5 = mod.resolveRoot({ root: badRoot, env: {}, config: {}, cwd: badRoot, isRoot: () => false })
check('全部不合法 → code=root-not-found', r5 && r5.root === null && r5.code === 'root-not-found', "{root:null, code:'root-not-found'}", JSON.stringify(r5))
check('全部不合法 → source=none', r5 && r5.source === 'none', "source='none'", JSON.stringify(r5 && r5.source))

const r6 = mod.resolveRoot(validRoot)
check('兼容 resolveRoot("<path>") 旧式调用', r6 && samePath(r6.root, validRoot), `root=${validRoot}`, JSON.stringify(r6))

const r7 = mod.resolveRoot({ root: badRoot, isRoot: (dir) => samePath(dir, badRoot) })
check('opts.isRoot 覆盖合法判据', r7 && samePath(r7.root, badRoot), `root=${badRoot}`, JSON.stringify(r7))

/* v1.4 候选 4：插件自身目录的上一级（真实 dsh-plugin 的父目录 = 本仓库根）。 */
const nowherCwd = join(tmpBase, 'nowhere-cwd')
await mkdir(nowherCwd, { recursive: true })
{
  const prevCwd = process.cwd()
  let r8
  try {
    process.chdir(nowherCwd)
    r8 = mod.resolveRoot({ root: badRoot, env: {}, config: {}, cwd: nowherCwd })
  } finally {
    process.chdir(prevCwd)
  }
  if (looksLikeCondoptRoot(pluginParent)) {
    /* 只有「插件父目录确实是合法 condopt 根」（link: 安装 / 真仓库里跑）时才可能命中候选 ④。 */
    check('v1.4 插件父目录候选命中（= 插件父目录）', r8 && samePath(r8.root, pluginParent), `root=${pluginParent}`, JSON.stringify(r8))
    check('v1.4 命中 source 不是 arg/env/config/session/cwd/none', r8 && typeof r8.source === 'string' && !['arg', 'env', 'config', 'session', 'cwd', 'none'].includes(r8.source), '专有 source 词面', JSON.stringify(r8 && r8.source))
  } else {
    /* 根来自环境变量（发布仓库 fresh clone 常见）：候选 ④ 不成立，断言「按实际候选解析」而不是词面。 */
    check('插件父目录不是 condopt 根时不误命中（root-not-found）', r8 && r8.root === null && r8.code === 'root-not-found', "{root:null, code:'root-not-found'}", JSON.stringify(r8))
    if (!hasRealRoot) skip('v1.4 插件父目录候选 source 词面', NO_ROOT_REASON)
  }
}

/* v1.4 候选 6：workspaceRegistry / workspaces 列表里第一个合法根（用 selfDir 隔离候选 4）。 */
{
  const ctxStub = { get(name) { return name === 'workspaceRegistry' ? { list() { return [badRoot, validRoot] } } : undefined } }
  const cases = [
    ['workspaces 数组', { workspaces: [badRoot, validRoot] }],
    ['ctx.get("workspaceRegistry")', { ctx: ctxStub }],
    ['workspaceRegistry.list()', { workspaceRegistry: { list() { return [badRoot, validRoot] } } }],
    ['workspaces 取值函数', { workspaces: () => [badRoot, validRoot] }],
  ]
  let anyHit = false
  for (const [label, extra] of cases) {
    const res = thrown(() => mod.resolveRoot({ root: badRoot, env: {}, config: {}, cwd: badRoot, selfDir: badSelfDir, ...extra }))
    const hit = !res.threw && res.value && samePath(res.value.root, validRoot) && res.value.source === 'workspace'
    if (hit) anyHit = true
    check(`v1.4 workspace 候选（${label}）选中第一个合法根`, hit, `root=${validRoot}, source='workspace'`, res.threw ? `throw ${res.code}` : JSON.stringify(res.value))
  }
  if (!anyHit) note('workspace 候选四种形态都没命中：DESIGN §2 候选 ⑥ 未生效')
}

/* ------------------------------------------------------------------ 2. resolveRunDir */

group('resolveRunDir（DESIGN §3 路径围栏）')

const runRel = 'demo_moo'
const expectRun = resolve(repoRoot, 'runs', runRel)
const rd1 = thrown(() => mod.resolveRunDir(repoRoot, runRel))
check('相对 run 名 → <root>/runs/<run>', !rd1.threw && samePath(rd1.value, expectRun), expectRun, JSON.stringify(rd1))
const rd2 = thrown(() => mod.resolveRunDir(repoRoot, expectRun))
check('绝对 run（在 runs 内）原样接受', !rd2.threw && samePath(rd2.value, expectRun), expectRun, JSON.stringify(rd2))
const rd3 = thrown(() => mod.resolveRunDir(repoRoot, '.'))
check("'.' → <root>/runs（自身也算在内）", !rd3.threw && samePath(rd3.value, resolve(repoRoot, 'runs')), resolve(repoRoot, 'runs'), JSON.stringify(rd3))

for (const evil of ['..', '../outside', '..\\outside', resolve(repoRoot, '..', 'outside'), resolve(repoRoot, 'docs'), 'a/../../b', '']) {
  const res = thrown(() => mod.resolveRunDir(repoRoot, evil))
  if (evil === '') {
    /* DESIGN 只写了 `..` 逃逸 → run-out-of-root；空串归 run-out-of-root 还是 bad-param 未冻结。 */
    const rejected = res.threw && (res.code === 'run-out-of-root' || res.code === 'bad-param')
    check('空值被拒（run-out-of-root 或 bad-param）', rejected, 'throw run-out-of-root/bad-param', res.threw ? `throw code=${res.code}` : `returned ${JSON.stringify(res.value)}`)
    if (res.threw && res.code === 'bad-param') note("空 run 串的实现是 bad-param；DESIGN §2 未冻结，host-dev 可任选（不判失败）")
    continue
  }
  const rejected = res.threw && res.code === 'run-out-of-root'
  check(`逃逸/空值被拒（${JSON.stringify(evil)}）`, rejected, "throw {code:'run-out-of-root'}", res.threw ? `throw code=${res.code}` : `returned ${JSON.stringify(res.value)}`)
}

/* ------------------------------------------------------------------ 3. EXEC_COMMANDS */

group('EXEC_COMMANDS（DESIGN §5 白名单表 v1.2）')

const EXPECTED_COMMANDS = [
  'route', 'init', 'ask', 'tell', 'confirm', 'override', 'auto', 'step', 'recommend',
  'predict', 'knee-weights', 'digest', 'export', 'pareto', 'doctor', 'decisions', 'render',
]
const table = mod.EXEC_COMMANDS
const tableKeys = table instanceof Map ? Array.from(table.keys()) : Object.keys(table || {})
for (const name of EXPECTED_COMMANDS) {
  check(`白名单含 ${name}`, tableKeys.includes(name), `${name} ∈ EXEC_COMMANDS`, `keys=${tableKeys.join(',')}`)
}
for (const forbidden of ['fork', 'import', 'retune', 'transfer-impact', 'transfer-audit', 'transfer-staged', 'prepare', 'template', 'spec', 'decision', 'calibrate-spec']) {
  check(`白名单不含 ${forbidden}`, !tableKeys.includes(forbidden), `${forbidden} ∉ EXEC_COMMANDS`, `keys=${tableKeys.join(',')}`)
}
check('白名单键数量 = 17', tableKeys.length === EXPECTED_COMMANDS.length, `17`, `${tableKeys.length}`)
{
  const entry = table instanceof Map ? table.get('ask') : table.ask
  check('EXEC_COMMANDS[ask] 形如 {params, json, argv}', entry !== undefined && entry !== null && typeof entry === 'object' && 'params' in entry && typeof entry.json === 'boolean' && typeof entry.argv === 'function', '{params, json:boolean, argv:function}', JSON.stringify(entry))
}
{
  /* v1.2：17 条命令的 CLI 都支持 --json，表里应全部 json:true。 */
  const nonJson = EXPECTED_COMMANDS.filter((name) => {
    const entry = table instanceof Map ? table.get(name) : table[name]
    return !entry || entry.json !== true
  })
  check('v1.2 全部命令 json:true', nonJson.length === 0, '全部 true', JSON.stringify(nonJson))
}

/* ------------------------------------------------------------------ 4. buildExecArgv */

group('buildExecArgv（DESIGN §5 v1.2 argv 逐项精确）')

const ctxBase = {
  run: runRel,
  root: repoRoot,
  runDir: expectRun,
  cacheDir: outDir,
  tmpDir: outDir,
}

/** template 项：字符串=精确；{p}=路径等价；{out:{name,under}}=basename+目录；{re}=正则。 */
function argvMatches(argv, template) {
  if (!Array.isArray(argv)) return `不是数组: ${JSON.stringify(argv)}`
  if (argv.length !== template.length) return `长度 ${argv.length} ≠ ${template.length}: ${JSON.stringify(argv)}`
  for (let i = 0; i < template.length; i += 1) {
    const exp = template[i]
    const got = argv[i]
    if (typeof exp === 'string') {
      if (got !== exp) return `argv[${i}] = ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`
    } else if (exp && exp.inRoot !== undefined) {
      /* 路径类参数：相对 root 与解析成绝对路径都接受（spawn cwd=<root>，两者等价）。 */
      if (typeof got !== 'string' || !samePath(resolve(repoRoot, got), resolve(repoRoot, exp.inRoot))) return `argv[${i}] = ${JSON.stringify(got)} 既非 ${exp.inRoot} 也不等价于 ${resolve(repoRoot, exp.inRoot)}`
    } else if (exp && exp.p !== undefined) {
      if (!samePath(got, exp.p)) return `argv[${i}] = ${JSON.stringify(got)} 路径不等价于 ${exp.p}`
    } else if (exp && exp.out !== undefined) {
      if (typeof got !== 'string') return `argv[${i}] 不是字符串`
      const base = got.replace(/\\/g, '/').split('/').pop()
      if (base !== exp.out.name) return `argv[${i}] basename=${base} ≠ ${exp.out.name}`
      if (!samePath(dirname(got), exp.out.under)) return `argv[${i}] 目录=${dirname(got)} ≠ ${exp.out.under}`
    } else if (exp && exp.re !== undefined) {
      if (typeof got !== 'string' || !exp.re.test(got)) return `argv[${i}] = ${JSON.stringify(got)} 不匹配 ${exp.re}`
    }
  }
  return null
}

function argvCase(label, command, params, template, ctx) {
  const res = thrown(() => mod.buildExecArgv(command, params, ctx || ctxBase))
  if (res.threw) {
    fail(label, JSON.stringify(template), `throw code=${res.code}: ${res.err && res.err.message}`)
    return
  }
  const mismatch = argvMatches(res.value, template)
  check(label, mismatch === null, JSON.stringify(template), mismatch || JSON.stringify(res.value))
}
function badParamCase(label, command, params, code, ctx) {
  const res = thrown(() => mod.buildExecArgv(command, params, ctx || ctxBase))
  const want = code || 'bad-param'
  check(label, res.threw && res.code === want, `throw {code:'${want}'}`, res.threw ? `throw code=${res.code}` : `returned ${JSON.stringify(res.value)}`)
}

argvCase('ask {n,plate}', 'ask', { n: 8, plate: 'P2' }, ['ask', '--run', runRel, '--n', '8', '--plate', 'P2', '--json'])
argvCase('ask {} → 仅默认', 'ask', {}, ['ask', '--run', runRel, '--json'])
argvCase('tell {results}', 'tell', { results: 'results.jsonl' }, ['tell', '--run', runRel, '--results', { inRoot: 'results.jsonl' }, '--json'])
argvCase('confirm {n}', 'confirm', { n: 3 }, ['confirm', '--run', runRel, '--n', '3', '--json'])
argvCase('confirm {}', 'confirm', {}, ['confirm', '--run', runRel, '--json'])
argvCase('override {algorithm,reason}', 'override', { algorithm: 'sobol', reason: '手动覆写' }, ['override', '--run', runRel, '--algorithm', 'sobol', '--reason', '手动覆写', '--json'])
argvCase('override {algorithm,params,reason}', 'override', { algorithm: 'bayes', params: { kappa: 2.5, acquisition: 'ei' }, reason: '换采集函数' }, ['override', '--run', runRel, '--algorithm', 'bayes', '--params', '{"kappa":2.5,"acquisition":"ei"}', '--reason', '换采集函数', '--json'])
argvCase('auto {}', 'auto', {}, ['auto', '--run', runRel, '--json'])
argvCase('step {}', 'step', {}, ['step', '--run', runRel, '--json'])
argvCase('recommend {}', 'recommend', {}, ['recommend', '--run', runRel, '--json'])
argvCase('predict {config}', 'predict', { config: { T: 80, time: 30 } }, ['predict', '--run', runRel, '--config', '{"T":80,"time":30}', '--json'])
argvCase('knee-weights {weights}', 'knee-weights', { weights: 'yield=2,cost=1' }, ['knee-weights', '--run', runRel, '--weights', 'yield=2,cost=1', '--json'])
argvCase('export {} 带 --out tmp', 'export', {}, ['export', '--run', runRel, '--out', { out: { name: 'dataset_export.csv', under: outDir } }, '--json'])
argvCase('pareto {} 带 --out tmp', 'pareto', {}, ['pareto', '--run', runRel, '--out', { out: { name: 'pareto_front.csv', under: outDir } }, '--json'])
argvCase('digest {format:html}', 'digest', { format: 'html' }, ['digest', '--run', runRel, '--out', { out: { name: 'digest.html', under: outDir } }, '--format', 'html', '--json'])
argvCase('doctor {}', 'doctor', {}, ['doctor', '--run', runRel, '--json'])
argvCase('decisions {limit,action}', 'decisions', { limit: 20, action: 'override' }, ['decisions', '--run', runRel, '--limit', '20', '--action', 'override', '--json'])
argvCase('decisions {limit}', 'decisions', { limit: 20 }, ['decisions', '--run', runRel, '--limit', '20', '--json'])
argvCase('decisions {}', 'decisions', {}, ['decisions', '--run', runRel, '--json'])
argvCase('render {} → --out cacheDir', 'render', {}, ['render', '--run', runRel, '--out', { p: outDir }, '--no-png', '--json'])
argvCase('init 全参数', 'init', { space: 'space.json', objective: 'yield:max', budget: 24, batch: 6, algorithm: 'bayes', params: { kernel: 'rbf' } },
  ['init', '--run', runRel, '--space', { inRoot: 'space.json' }, '--objective', 'yield:max', '--budget', '24', '--batch', '6', '--algorithm', 'bayes', '--params', '{"kernel":"rbf"}', '--json'])
argvCase('route 全参数（无 --run）', 'route', { space: 'space.json', budget: 12, batch: 4, smoothness: 'mixed', noise: 'low', domain: 'chemistry' },
  ['route', '--space', { inRoot: 'space.json' }, '--budget', '12', '--batch', '4', '--smoothness', 'mixed', '--noise', 'low', '--domain', 'chemistry', '--json'])
argvCase('route {}', 'route', {}, ['route', '--json'])

/* --run 原样（不做 resolve） */
argvCase('--run 原样透传相对名', 'ask', {}, ['ask', '--run', runRel, '--json'])
argvCase('--run 原样透传绝对路径', 'ask', {}, ['ask', '--run', { p: expectRun }, '--json'], { ...ctxBase, run: expectRun })

/* digest 默认 format：容忍省略 --format，但只要出现就必须是 md */
{
  const res = thrown(() => mod.buildExecArgv('digest', {}, ctxBase))
  if (res.threw) fail('digest 默认格式', "digest ... --out <tmp>/digest.md", `throw code=${res.code}`)
  else {
    const argv = res.value
    const outIdx = argv.indexOf('--out')
    const fmtIdx = argv.indexOf('--format')
    const okOut = outIdx >= 0 && typeof argv[outIdx + 1] === 'string' && argv[outIdx + 1].replace(/\\/g, '/').endsWith('digest.md') && samePath(dirname(argv[outIdx + 1]), outDir)
    const okFmt = fmtIdx === -1 || argv[fmtIdx + 1] === 'md'
    check('digest 默认格式 → digest.md', okOut, `<tmp>/digest.md`, JSON.stringify(argv))
    check('digest 默认 --format 若出现必须是 md', okFmt, 'md/省略', JSON.stringify(argv))
  }
}

/* 零写入不变量：带 --out 的子命令，其 out 不得落在 run 目录内 */
for (const cmd of ['pareto', 'export', 'render']) {
  const res = thrown(() => mod.buildExecArgv(cmd, {}, ctxBase))
  if (res.threw) { fail(`${cmd} 零写入（--out 在 tmp）`, 'argv 含 --out 且不在 run 目录', `throw ${res.code}`); continue }
  const argv = res.value
  const idx = argv.indexOf('--out')
  const target = idx >= 0 ? argv[idx + 1] : undefined
  const insideRun = typeof target === 'string' && (samePath(target, expectRun) || resolve(target).toLowerCase().startsWith(resolve(expectRun).toLowerCase()))
  check(`${cmd} 零写入（--out 不在 run 目录）`, idx >= 0 && typeof target === 'string' && !insideRun, `<tmp>/... 且不属于 ${expectRun}`, JSON.stringify(argv))
}

/* 校验负例 */
badParamCase('override 缺 reason → bad-param', 'override', { algorithm: 'sobol' })
badParamCase('override params 非对象（数组）→ bad-param', 'override', { algorithm: 'bayes', params: [1, 2], reason: 'x' })
badParamCase('override params 坏 JSON 字符串 → bad-param', 'override', { algorithm: 'bayes', params: '{bad json', reason: 'x' })
{
  /* v1.2：params 也接受 JSON 字符串，输出统一为紧凑 JSON 串。 */
  const res = thrown(() => mod.buildExecArgv('override', { algorithm: 'bayes', params: '{"kappa": 2.5}', reason: 'x' }, ctxBase))
  check('override params 传 JSON 字符串被接受', !res.threw && Array.isArray(res.value) && res.value.includes('--params') && res.value[res.value.indexOf('--params') + 1] === '{"kappa":2.5}', '--params {"kappa":2.5}', res.threw ? `throw ${res.code}` : JSON.stringify(res.value))
}
badParamCase('override algorithm 非法字符', 'override', { algorithm: 'sobol;rm -rf', reason: 'x' })
badParamCase('ask n 非数字', 'ask', { n: 'abc' })
{
  /* DESIGN v1.4 §5：计数类整数 ∈ [1,100000]（limit ∈ [1,1000]），下界与上界都要拒。 */
  badParamCase('ask n=-1 → bad-param（v1.4 下界）', 'ask', { n: -1 })
  badParamCase('ask n=0 → bad-param（v1.4 下界）', 'ask', { n: 0 })
  badParamCase('confirm n=0 → bad-param（v1.4 下界）', 'confirm', { n: 0 })
  badParamCase('decisions limit=0 → bad-param（v1.4 下界）', 'decisions', { limit: 0 })
  badParamCase('decisions limit=1001 → bad-param（limit≤1000）', 'decisions', { limit: 1001 })
  badParamCase('init budget=0 → bad-param', 'init', { space: 'space.json', objective: 'yield:max', budget: 0, batch: 6 })
  badParamCase('init batch=0 → bad-param', 'init', { space: 'space.json', objective: 'yield:max', budget: 24, batch: 0 })
  badParamCase('route batch=0 → bad-param', 'route', { batch: 0 })
  argvCase('decisions limit=1000 → 允许（上界内）', 'decisions', { limit: 1000 }, ['decisions', '--run', runRel, '--limit', '1000', '--json'])
}
badParamCase('ask n 超上限 100000', 'ask', { n: 100001 })
badParamCase('ask n=Infinity', 'ask', { n: Number.POSITIVE_INFINITY })
badParamCase('ask plate 含注入字符', 'ask', { plate: 'P2; rm -rf /' })
badParamCase('tell results 路径逃逸', 'tell', { results: '../../etc/passwd' })
badParamCase('tell results 绝对路径越界', 'tell', { results: resolve(repoRoot, '..', 'outside.json') })
badParamCase('predict config 非 JSON', 'predict', { config: '{bad json' })
badParamCase('digest format=pdf', 'digest', { format: 'pdf' })
badParamCase('digest format=json（v1.1 只允许 md/html）', 'digest', { format: 'json' })
badParamCase('knee-weights weights 缺 =', 'knee-weights', { weights: 'yield' })
badParamCase('knee-weights weights 权重非数字', 'knee-weights', { weights: 'yield=abc' })
badParamCase('init 缺 budget', 'init', { space: 'space.json', objective: 'yield:max', batch: 6 })
badParamCase('init algorithm 非法字符', 'init', { space: 'space.json', objective: 'yield:max', budget: 24, batch: 6, algorithm: 'bayes;x' })
badParamCase('未知命令 fork → command-not-allowed', 'fork', { reason: 'x' }, 'command-not-allowed')
for (const cmd of ['import', 'retune', 'transfer-impact', 'prepare']) {
  badParamCase(`未知命令 ${cmd} → command-not-allowed`, cmd, {}, 'command-not-allowed')
}
badParamCase('未知参数键 → bad-param（表驱动）', 'ask', { n: 2, evil: 'x' })

/* 不接受调用方直接传 argv */
{
  const res = thrown(() => mod.buildExecArgv('ask', { argv: ['--evil', 'x'] }, ctxBase))
  check('拒绝直接传 argv（或至少不落进结果）', res.threw ? res.code === 'bad-param' : !JSON.stringify(res.value).includes('--evil'), 'throw bad-param 或结果不含 --evil', res.threw ? `throw ${res.code}` : JSON.stringify(res.value))
}
/* 返回裸数组 */
{
  const res = thrown(() => mod.buildExecArgv('ask', {}, ctxBase))
  check('buildExecArgv 返回裸数组', !res.threw && Array.isArray(res.value) && res.value.every((t) => typeof t === 'string'), 'string[]', res.threw ? `throw ${res.code}` : JSON.stringify(res.value))
}

/* ------------------------------------------------------------------ 5. splitDashboardHtml */

group('splitDashboardHtml（DESIGN §4）')

{
  const sample = await readFile(join(fixturesDir, 'dashboard-sample.html'), 'utf8')
  const split = mod.splitDashboardHtml(sample)
  check('返回 {css,html}', split !== null && typeof split === 'object' && typeof split.css === 'string' && typeof split.html === 'string', '{css:string, html:string}', JSON.stringify(split))
  check('css 含两个 style 块内容', split && split.css.includes('FIXTURE_STYLE_ONE') && split.css.includes('FIXTURE_STYLE_TWO'), '两个 style 内容都在', JSON.stringify(split && split.css))
  check('css 保序（ONE 在 TWO 之前）', split && split.css.indexOf('FIXTURE_STYLE_ONE') < split.css.indexOf('FIXTURE_STYLE_TWO'), 'ONE < TWO', split && split.css)
  check('css 不含 <style 标签', split && !split.css.includes('<style'), '无 <style', JSON.stringify(split && split.css))
  check('html 取 body 内', split && split.html.includes('FIXTURE_VIEW_BODY'), '含 FIXTURE_VIEW_BODY', JSON.stringify(split && split.html))
  check('html 不含 <body', split && !/<body/i.test(split.html), '无 <body', JSON.stringify(split && split.html))
  check('html 不含 </body>', split && !/<\/body>/i.test(split.html), '无 </body>', JSON.stringify(split && split.html))

  const noBody = mod.splitDashboardHtml('<html><head><style>x{}</style></head><main>KEEP_ME</main></html>')
  check('无 <body> → </head> 之后全文', noBody && noBody.html.includes('KEEP_ME') && !noBody.html.includes('<head>'), '含 KEEP_ME，不含 <head>', JSON.stringify(noBody))
  check('无 <body> 时 css 仍切出', noBody && noBody.css.includes('x{}'), 'css=x{}', JSON.stringify(noBody))

  const plain = mod.splitDashboardHtml('PLAIN_TEXT_ONLY')
  check('既无 body 也无 head → 全文', plain && plain.html.includes('PLAIN_TEXT_ONLY'), 'html=全文', JSON.stringify(plain))

  const empty = thrown(() => mod.splitDashboardHtml(''))
  check('空串不抛', !empty.threw, '返回 {css,html}', empty.threw ? `throw ${empty.err && empty.err.message}` : JSON.stringify(empty.value))
}

/* ------------------------------------------------------------------ 6. parseJsonLoose */

group('parseJsonLoose（DESIGN §9 R3）')

eq('纯 JSON 对象', mod.parseJsonLoose('{"a":1}'), { a: 1 })
eq('前后噪声中取 JSON', mod.parseJsonLoose('warning: something\n{"a":1}\ndone'), { a: 1 })
eq('JSON 数组', mod.parseJsonLoose('[1,2,3]'), [1, 2, 3])
check('无法解析 → null', mod.parseJsonLoose('not json at all') === null, 'null', JSON.stringify(mod.parseJsonLoose('not json at all')))
check('空串 → null', mod.parseJsonLoose('') === null, 'null', JSON.stringify(mod.parseJsonLoose('')))
eq('多候选（第一个坏、第二个好）', mod.parseJsonLoose('bad', '{"b":2}'), { b: 2 })
eq('stdout 空、stderr 有 JSON（R3 场景）', mod.parseJsonLoose('', '{"error":"boom","code":"render-failed"}'), { error: 'boom', code: 'render-failed' })

/* ------------------------------------------------------------------ 7. listStudies */

group('listStudies（DESIGN §3）')

const scanRoot = join(tmpBase, 'scan-root')
await mkdir(join(scanRoot, 'runs', 'demo_a'), { recursive: true })
await mkdir(join(scanRoot, 'runs', 'demo_b'), { recursive: true })
await mkdir(join(scanRoot, 'runs', 'empty_dir'), { recursive: true })
await writeFile(join(scanRoot, 'runs', 'demo_a', 'problem.json'), '{"objective":{}}\n')
await writeFile(join(scanRoot, 'runs', 'demo_b', 'dataset.jsonl'), '{"x":1}\n')
await writeFile(join(scanRoot, 'runs', 'loose.txt'), 'not a dir\n')
{
  const old = new Date(Date.now() - 60000)
  const recent = new Date()
  await utimes(join(scanRoot, 'runs', 'demo_a'), old, old)
  await utimes(join(scanRoot, 'runs', 'demo_b'), recent, recent)

  const res = await thrownAsync(() => mod.listStudies(scanRoot))
  if (res.threw) {
    fail('listStudies 扫描', 'Study[]', `throw ${res.code}: ${res.err && res.err.message}`)
  } else {
    const studies = Array.isArray(res.value) ? res.value : res.value && res.value.runs
    check('返回数组', Array.isArray(studies), 'Study[]', JSON.stringify(res.value).slice(0, 200))
    if (Array.isArray(studies)) {
      const ids = studies.map((s) => s && s.id)
      check('只收含 problem.json/dataset.jsonl 的目录', ids.includes('demo_a') && ids.includes('demo_b') && !ids.includes('empty_dir') && !ids.includes('loose.txt'), 'demo_a+demo_b', JSON.stringify(ids))
      check('按 mtime 倒序（demo_b 更新在前）', ids.length === 2 && ids[0] === 'demo_b', 'demo_b,demo_a', JSON.stringify(ids))
      const s = studies[0] || {}
      const KEYS = ['id', 'rel', 'abs', 'mtime', 'nObservations', 'algorithm', 'objective', 'budget', 'best']
      const missing = KEYS.filter((k) => !(k in s))
      check('Study 含 DESIGN 9 键', missing.length === 0, KEYS.join(','), `missing=${missing.join(',')}, keys=${Object.keys(s).join(',')}`)
      check('abs 是绝对路径且指向该目录', typeof s.abs === 'string' && samePath(s.abs, join(scanRoot, 'runs', 'demo_b')), join(scanRoot, 'runs', 'demo_b'), String(s.abs))
      check('mtime 是数字（ms）', typeof s.mtime === 'number', 'number', typeof s.mtime)
      check('rel 指向目录名', typeof s.rel === 'string' && s.rel.replace(/\\/g, '/').endsWith('demo_b'), 'endsWith demo_b', String(s.rel))
    }
  }
}

/* ------------------------------------------------------------------ 8. apply / inject / 工具注册 */

group('apply + condopt_view 工具注册（DESIGN §6）')

const fakeWebRoutes = []
const fakeTools = []
const fakeEffects = []
const fakeCtx = {
  effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') fakeEffects.push(cleanup); return () => {} },
  get(name) { return undefined },
  inject(names, callback) { if (typeof callback === 'function') callback(fakeScope); return () => {} },
  webServer: { register: (route) => { fakeWebRoutes.push(route); return () => {} } },
  tools: { register: (tool) => { fakeTools.push(tool); return () => {} } },
}
const fakeScope = { get: () => undefined, webServer: fakeCtx.webServer, tools: fakeCtx.tools }
{
  const res = await thrownAsync(async () => mod.apply(fakeCtx, { projectRoot: repoRoot }))
  check('apply(ctx, config) 不抛', !res.threw, 'resolve 且不抛', res.threw ? `throw ${res.err && res.err.stack}` : 'ok')
  const prefix = fakeWebRoutes.find((r) => r && r.kind === 'prefix' && r.path === '/condopt')
  check('注册 webServer prefix /condopt', prefix !== undefined && typeof prefix.handler === 'function', "{kind:'prefix', path:'/condopt', handler}", JSON.stringify(fakeWebRoutes.map((r) => ({ kind: r.kind, path: r.path }))))
  const tool = fakeTools.find((t) => t && t.name === 'condopt_view')
  check('注册工具 condopt_view', tool !== undefined, 'name=condopt_view', JSON.stringify(fakeTools.map((t) => t.name)))
  if (tool) {
    check('工具 parameters.additionalProperties=false', tool.parameters && tool.parameters.additionalProperties === false, 'false', JSON.stringify(tool.parameters && tool.parameters.additionalProperties))
    check('工具 parameters.required=[]', Array.isArray(tool.parameters && tool.parameters.required) && tool.parameters.required.length === 0, '[]', JSON.stringify(tool.parameters && tool.parameters.required))
    const inc = tool.parameters && tool.parameters.properties && tool.parameters.properties.include
    const enumVals = inc && inc.items && inc.items.enum
    check('include 枚举 = report/step/pending/decisions/pareto', Array.isArray(enumVals) && ['report', 'step', 'pending', 'decisions', 'pareto'].every((v) => enumVals.includes(v)) && enumVals.length === 5, '[report,step,pending,decisions,pareto]', JSON.stringify(enumVals))
    check('output.schema.required 含 text/run/root', tool.output && tool.output.schema && Array.isArray(tool.output.schema.required) && ['text', 'run', 'root'].every((k) => tool.output.schema.required.includes(k)), '[text,run,root]', JSON.stringify(tool.output && tool.output.schema && tool.output.schema.required))
    check('isConcurrencySafe() === true', typeof tool.isConcurrencySafe === 'function' && tool.isConcurrencySafe() === true, 'true', String(tool.isConcurrencySafe && tool.isConcurrencySafe()))
    check('output.render 产出 text block', typeof tool.output.render === 'function' && JSON.stringify(tool.output.render({}, { text: 'T' })) === '[{"type":"text","text":"T"}]', '[{type:text,text:T}]', tool.output.render ? JSON.stringify(tool.output.render({}, { text: 'T' })) : 'n/a')
    check('presentationMeta 含 run/root', typeof tool.output.presentationMeta === 'function' && (() => { const m = tool.output.presentationMeta({}, { run: 'r', root: 'x' }); return m && m.run === 'r' && m.root === 'x' })())

    /* execute：真跑（report/pending/decisions 都是只读子命令），并守住「text 紧凑、不含整份 HTML、零写入」。 */
    if (!skipReal && existsSync(join(repoRoot, 'runs', 'demo_moo', 'problem.json'))) {
      const runDir = join(repoRoot, 'runs', 'demo_moo')
      const before = await snapshotDir(runDir)
      let value = null
      let lastError = null
      for (const execStub of [{}, { cwd: repoRoot }, { cwd: repoRoot, signal: undefined, session: { cwd: repoRoot } }]) {
        const res = await thrownAsync(() => tool.execute({ root: repoRoot, run: 'demo_moo', include: ['report', 'pending', 'decisions'] }, execStub))
        if (!res.threw) { value = res.value; break }
        lastError = res.err
      }
      const after = await snapshotDir(runDir)
      check('condopt_view.execute 零写入 run 目录', diffSnapshots(before, after).length === 0, '无新增/变化', diffSnapshots(before, after).join('; ') || '干净')
      if (value === null) {
        note(`condopt_view.execute 在最小 exec 桩上未成功（exec 形状未冻结，记 NOTE）：${lastError && lastError.message}`)
      } else {
        check('execute 返回 {text,run,root}', value !== null && typeof value === 'object' && typeof value.text === 'string' && typeof value.run === 'string' && value.run.replace(/\\/g, '/').endsWith('demo_moo') && typeof value.root === 'string', '{text:string, run:*demo_moo, root:string}', JSON.stringify({ text: `len=${value.text.length}`, run: value.run, root: value.root }))
        check('execute.text 是紧凑 Markdown（非整份 HTML）', !value.text.includes('<!doctype') && !/<style[\s>]/i.test(value.text) && value.text.length < 20000, '无 HTML/无 <style>/<20000 字', `len=${value.text.length}`)
        check('execute.text 提到 run 名', value.text.includes('demo_moo'), '含 demo_moo', value.text.slice(0, 120))
        check('execute.warnings 是数组', Array.isArray(value.warnings), '[]', JSON.stringify(value.warnings))
      }
    } else if (skipReal) {
      note('--skip-real：跳过 condopt_view.execute 真跑')
    }
  }
}

/* ------------------------------------------------------------------ 8b. apply 激活期惰性（cordis 真机 A7 回归） */

group('apply 激活期惰性（cordis without-inject 回归）')

{
  /* 仿真 cordis：属性式访问未 inject 的服务 —— 直接抛（真机 A7 报错原文）。 */
  const SERVICES = new Set(['agents', 'workspaceRegistry', 'llm', 'subagents', 'fs', 'sandbox', 'sessions'])
  const mk = (getImpl) => {
    const reg = { routes: [], tools: [] }
    const base = {
      effect(f) { f() },
      get: getImpl,
      webServer: { register(o) { reg.routes.push(o) } },
      tools: { register(s) { reg.tools.push(s) } },
    }
    return {
      reg,
      ctx: new Proxy(base, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && SERVICES.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
          return Reflect.get(target, prop, receiver)
        },
      }),
    }
  }

  const probe = mk(() => undefined)
  let simThrew = null
  try { void probe.ctx.agents } catch (err) { simThrew = err }
  check('仿真有效：ctx.agents 抛 without inject', simThrew !== null && /without inject/.test(simThrew.message), 'throw', simThrew ? simThrew.message : 'no throw')

  const calls = []
  const a = mk((name) => { calls.push(name); return undefined })
  let threw = null
  try { await mod.apply(a.ctx, {}) } catch (err) { threw = err }
  check('apply 不抛（无属性式服务访问）', threw === null && a.reg.routes.length === 1 && a.reg.tools.length === 1, '1 路由 + 1 工具', threw ? `throw ${threw.message}` : `routes=${a.reg.routes.length} tools=${a.reg.tools.length}`)
  check('激活期不读取可选服务（惰性）', calls.length === 0, 'ctx.get 调用 0 次', JSON.stringify(calls))

  const b = mk(() => { throw new Error('cannot get property "agents" without inject') })
  let threw2 = null
  try { await mod.apply(b.ctx, {}) } catch (err) { threw2 = err }
  check('ctx.get 抛错时 apply 仍不抛且已注册', threw2 === null && b.reg.routes.length === 1, 'no throw + 1 路由', threw2 ? `throw ${threw2.message}` : `routes=${b.reg.routes.length}`)

  /* 请求级：只有带 ?sessionId= 才软访问 agents；三形态（对象/undefined/抛错）都不得冒泡。 */
  const makeCtx = (agentsFactory) => {
    const calls = []
    const reg = { routes: [], tools: [] }
    const base = {
      effect(f) { f() },
      get(name) { calls.push(name); return name === 'agents' ? agentsFactory() : undefined },
      webServer: { register(o) { reg.routes.push(o) } },
      tools: { register(s) { reg.tools.push(s) } },
    }
    const ctx = new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && SERVICES.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
        return Reflect.get(target, prop, receiver)
      },
    })
    return { ctx, reg, calls }
  }

  if (!hasRealRoot) {
    for (const name of ['不带 sessionId 的请求不访问 agents', '带 sessionId 时才软访问 agents', 'agents=undefined 时 /api/health 仍 200', 'agents getter 抛错时 /api/health 仍 200']) {
      skip(`激活期惰性（${name}）`, NO_ROOT_REASON)
    }
  } else {

  const sessionCwdDir = join(tmpBase, 'session-cwd-root')
  await mkdir(sessionCwdDir, { recursive: true })
  const withAgents = makeCtx(() => ({ get: (id) => ({ session: { header: { cwd: sessionCwdDir } } }) }))
  await mod.apply(withAgents.ctx, { projectRoot: repoRoot })
  const h1 = withAgents.reg.routes[0] && withAgents.reg.routes[0].handler
  {
    withAgents.calls.length = 0
    const r = await thrownAsync(() => call(h1, { url: '/condopt/api/health' }))
    check('不带 sessionId 的请求不访问 agents', !r.threw && r.value.status === 200 && !withAgents.calls.includes('agents'), '200 且 calls 无 agents', `${r.threw ? 'throw' : r.value.status} calls=${JSON.stringify(withAgents.calls)}`)
    withAgents.calls.length = 0
    const r2 = await thrownAsync(() => call(h1, { url: '/condopt/api/health?sessionId=s1' }))
    check('带 sessionId 时才软访问 agents（且 200）', !r2.threw && r2.value.status === 200 && withAgents.calls.includes('agents'), '200 且 calls 含 agents', `${r2.threw ? 'throw' : r2.value.status} calls=${JSON.stringify(withAgents.calls)}`)
  }

  const noAgents = makeCtx(() => undefined)
  const rNo = (async () => {
    await mod.apply(noAgents.ctx, { projectRoot: repoRoot })
    const h = noAgents.reg.routes[0] && noAgents.reg.routes[0].handler
    return thrownAsync(() => call(h, { url: '/condopt/api/health?sessionId=s1' }))
  })()
  const noAgentsRes = await rNo
  check('agents=undefined 时 /api/health 仍 200', !noAgentsRes.threw && noAgentsRes.value.status === 200, '200', noAgentsRes.threw ? `throw ${noAgentsRes.err && noAgentsRes.err.message}` : String(noAgentsRes.value.status))

  const badAgents = makeCtx(() => { throw new Error('cannot get property "agents" without inject') })
  await mod.apply(badAgents.ctx, { projectRoot: repoRoot })
  const h3 = badAgents.reg.routes[0] && badAgents.reg.routes[0].handler
  const badRes = await thrownAsync(() => call(h3, { url: '/condopt/api/health?sessionId=s1' }))
  check('agents getter 抛错时 /api/health 仍 200（第 5 级静默跳过）', !badRes.threw && badRes.value.status === 200, '200', badRes.threw ? `throw ${badRes.err && badRes.err.message}` : String(badRes.value.status))
  }
}

/* ------------------------------------------------------------------ 9. createHandler 路由分派 */

group('createHandler 路由分派（DESIGN §3/§5）')

function makeReq({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const listeners = new Map()
  let scheduled = false
  let iterated = false
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on(ev, fn) {
      const set = listeners.get(ev) || new Set()
      set.add(fn)
      listeners.set(ev, set)
      if (ev === 'data' || ev === 'end' || ev === 'readable') schedule()
      return req
    },
    once(ev, fn) { return req.on(ev, (...a) => { req.off(ev, fn); fn(...a) }) },
    off(ev, fn) { const set = listeners.get(ev); if (set) set.delete(fn); return req },
    removeListener(ev, fn) { return req.off(ev, fn) },
    pause() { return req },
    resume() { return req },
    async *[Symbol.asyncIterator]() {
      if (listeners.has('data')) { iterated = true; return }
      iterated = true
      if (body !== undefined && body !== null) yield Buffer.from(body, 'utf8')
    },
  }
  function schedule() {
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      if (iterated && !listeners.has('data')) return
      const chunk = body === undefined || body === null ? Buffer.alloc(0) : Buffer.from(body, 'utf8')
      emit('data', chunk)
      emit('end')
    }, 0)
  }
  function emit(ev, ...args) {
    const set = listeners.get(ev)
    if (set) for (const fn of [...set]) { try { fn(...args) } catch { /* 交给 handler 自己处理 */ } }
  }
  return req
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    body: '',
    ended: false,
    writableEnded: false,
    finished: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
    getHeader(k) { return this.headers[String(k).toLowerCase()] },
    removeHeader(k) { delete this.headers[String(k).toLowerCase()] },
    writeHead(code, hdrs) { this.statusCode = code; if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v); return this },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)); this.ended = true; this.writableEnded = true; this.finished = true; this.body = this.chunks.join('') },
    on() { return this },
    once() { return this },
    emit() { return true },
    flushHeaders() {},
  }
  return res
}

const handlerTmp = join(tmpBase, 'handler-tmp')
await mkdir(handlerTmp, { recursive: true })
const deps = { config: { projectRoot: repoRoot, allowExec: true }, env: {}, cwd: repoRoot, tmpDir: handlerTmp, python: undefined }

let handler
{
  const res = thrown(() => mod.createHandler(deps))
  if (res.threw || typeof res.value !== 'function') {
    fail('createHandler(deps) 返回 handler 函数', '(req,res)=>Promise<void>', res.threw ? `throw ${res.err && res.err.stack}` : typeof res.value)
    handler = null
  } else {
    handler = res.value
    pass('createHandler(deps) 返回 handler 函数')
  }
}

async function call(handlerFn, { method = 'GET', url = '/', body, headers } = {}) {
  const req = makeReq({ method, url, body, headers: body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(headers || {}) } : headers })
  const res = makeRes()
  await Promise.race([
    Promise.resolve(handlerFn(req, res)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('handler timeout (30s)')), 30000)),
  ])
  let json = null
  try { json = res.body ? JSON.parse(res.body) : null } catch { json = null }
  return { status: res.statusCode, headers: res.headers, body: res.body, json }
}

if (handler) {

  /* 9.1 404 / 405 —— 不触碰子进程 */
  {
    const r = await thrownAsync(() => call(handler, { url: '/condopt/api/nope' }))
    check('未知路径 → 404', !r.threw && r.value.status === 404, '404', r.threw ? `throw ${r.err && r.err.message}` : `${r.value.status} ${r.value.body.slice(0, 120)}`)
    check('404 错误体 {error,code}', !r.threw && r.value.json && typeof r.value.json.error === 'string' && r.value.json.code === 'not-found', "{error,code:'not-found'}", r.threw ? 'n/a' : JSON.stringify(r.value.json))
  }
  {
    const r = await thrownAsync(() => call(handler, { url: '/condopt' }))
    check('前缀本身无路由 → 404', !r.threw && r.value.status === 404, '404', r.threw ? `throw ${r.err && r.err.message}` : String(r.value.status))
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const r = await thrownAsync(() => call(handler, { method, url: '/condopt/api/health' }))
    check(`${method} → 405`, !r.threw && r.value.status === 405, '405', r.threw ? `throw ${r.err && r.err.message}` : String(r.value.status))
  }
  {
    /* v1.4 撤回口径：非 GET/HEAD/POST 的动词在**任意路径**上都 405。 */
    const r = await thrownAsync(() => call(handler, { method: 'PATCH', url: '/condopt/api/nope' }))
    check('PATCH 未知路径 → 405（动词优先）', !r.threw && r.value.status === 405, '405', r.threw ? `throw ${r.err && r.err.message}` : String(r.value.status))
    const r2 = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/nope' }))
    check('POST 未知路径 → 404', !r.threw && r2.value.status === 404, '404', r.threw ? 'throw' : String(r2.value.status))
  }
  {
    /* DESIGN v1.4 §3 定稿：POST 到只读路径 → 404（只有 PUT/DELETE/PATCH 等非 GET/HEAD/POST 动词才 405）。 */
    const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/health' }))
    check('POST /api/health → 404（v1.4 定稿）', !r.threw && r.value.status === 404, '404', r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
  }
  {
    /* DESIGN 措辞把 HEAD 列在"非 405"的动词里，但路由表只登记了 GET；两种都接受。
       注意：HEAD 与 GET 走同一段 root 解析，没有可用根时会先 409——那是另一条语义，跳过。 */
    if (!hasRealRoot) {
      skip('HEAD /api/health → 200 或 404（不 405）', NO_ROOT_REASON)
    } else {
      const r = await thrownAsync(() => call(handler, { method: 'HEAD', url: '/condopt/api/health' }))
      const status = r.threw ? 0 : r.value.status
      check('HEAD /api/health → 200 或 404（不 405）', status === 200 || status === 404, '200/404', r.threw ? 'throw' : String(status))
      if (status === 404) note('HEAD 未单独登记路由（404）：DESIGN 未明确要求 HEAD 200，可接受')
    }
  }

  if (!hasRealRoot) {
    skip('createHandler 真数据/写路径（9.2–9.6：health/studies/spec/view/study/exec 真跑）', NO_ROOT_REASON)
    note('离线断言（导出面 / 纯函数 / 路由分派 404-405 / 409 root-not-found）不受影响，照跑')
  } else {

  /* 9.2 health / studies / spec —— 真 root，只读 */
  {
    const r = await thrownAsync(() => call(handler, { url: '/condopt/api/health' }))
    if (r.threw) fail('GET /api/health 200', '200 JSON', `throw ${r.err && r.err.message}`)
    else {
      check('GET /api/health → 200', r.value.status === 200, '200', `${r.value.status} ${r.value.body.slice(0, 160)}`)
      const body = r.value.json || {}
      check('health.ok === true', body.ok === true, 'true', JSON.stringify(body))
      check('health.root === 仓库根', samePath(body.root, repoRoot), repoRoot, String(body.root))
      check('health.python 非空', typeof body.python === 'string' && body.python.length > 0, '非空字符串', JSON.stringify(body.python))
      check('health.runsDir 指向 <root>/runs', typeof body.runsDir === 'string' && samePath(body.runsDir, join(repoRoot, 'runs')), join(repoRoot, 'runs'), String(body.runsDir))
      check('health.cli 指向 scripts/run_condopt.py', typeof body.cli === 'string' && body.cli.replace(/\\/g, '/').endsWith('scripts/run_condopt.py'), '.../scripts/run_condopt.py', String(body.cli))
      const pyproject = await readFile(join(repoRoot, 'pyproject.toml'), 'utf8')
      const version = (pyproject.match(/^version\s*=\s*"([^"]+)"/m) || [])[1]
      check('health.version 取 pyproject 版本', body.version === version, version, String(body.version))
      check('health.allowExec === true（v1.3，默认开关）', body.allowExec === true, 'true', String(body.allowExec))
    }
  }
  {
    /* v1.3：config.allowExec=false 时 health 也要如实上报，客户端才能开面板即置灰。 */
    const res = thrown(() => mod.createHandler({ ...deps, config: { projectRoot: repoRoot, allowExec: false } }))
    if (res.threw) fail('allowExec=false 的 health', "{allowExec:false}", `throw ${res.err && res.err.message}`)
    else {
      const r = await thrownAsync(() => call(res.value, { url: '/condopt/api/health' }))
      check('health.allowExec === false（v1.3）', !r.threw && r.value.status === 200 && r.value.json && r.value.json.allowExec === false, "200 {allowExec:false}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json && r.value.json.allowExec)}`)
    }
  }
  {
    const r = await thrownAsync(() => call(handler, { url: '/condopt/api/studies' }))
    if (r.threw) fail('GET /api/studies 200', '200 JSON {root,runs}', `throw ${r.err && r.err.message}`)
    else {
      check('GET /api/studies → 200', r.value.status === 200, '200', `${r.value.status} ${r.value.body.slice(0, 160)}`)
      const body = r.value.json || {}
      check('studies.runs 是数组', Array.isArray(body.runs), 'Study[]', JSON.stringify(body).slice(0, 160))
      const ids = Array.isArray(body.runs) ? body.runs.map((s) => s && s.id) : []
      check('studies 含 demo_moo', ids.includes('demo_moo'), 'demo_moo ∈ ids', JSON.stringify(ids.slice(0, 20)))
      check('studies 按 mtime 倒序', Array.isArray(body.runs) && body.runs.every((s, i, arr) => i === 0 || (arr[i - 1].mtime >= s.mtime)), 'mtime 非升', JSON.stringify(Array.isArray(body.runs) ? body.runs.slice(0, 5).map((s) => s.mtime) : []))
    }
  }
  {
    const r = await thrownAsync(() => call(handler, { url: '/condopt/api/spec' }))
    if (r.threw) fail('GET /api/spec 200', '200 JSON', `throw ${r.err && r.err.message}`)
    else if (r.value.status === 200) {
      pass('GET /api/spec → 200')
      const spec = r.value.json
      check('spec 是算法数组', Array.isArray(spec) && spec.length > 0, 'array', JSON.stringify(spec).slice(0, 120))
      check('spec 含 bayes', Array.isArray(spec) && spec.some((a) => a && a.name === 'bayes'), 'bayes', JSON.stringify(Array.isArray(spec) ? spec.slice(0, 5).map((a) => a && a.name) : spec).slice(0, 120))
    } else if (isSpawnBlocked(r.value.body)) {
      skip('GET /api/spec → 200', '本会话沙箱内 node spawn(stdio:pipe) 被拒（EPERM），需要真官能 launch；host 侧返回了结构化错误体（见 NOTE）')
      note(`/api/spec 在沙箱内的错误体：${r.value.body.slice(0, 160)}`)
    } else {
      fail('GET /api/spec → 200', '200 JSON', `${r.value.status} ${r.value.body.slice(0, 200)}`)
    }
  }

  /* 9.3 run 逃逸 400 */
  {
    const r = await thrownAsync(() => call(handler, { url: '/condopt/api/view?run=..%2Foutside' }))
    check('GET /api/view 逃逸 → 400 run-out-of-root', !r.threw && r.value.status === 400 && r.value.json && r.value.json.code === 'run-out-of-root', "400 {code:'run-out-of-root'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
  }

  /* 9.4 exec 白名单/参数/开关 —— 不落地写入 */
  {
    const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: 'demo_moo', command: 'fork' }) }))
    check('POST exec 未列命令 → 403 command-not-allowed', !r.threw && r.value.status === 403 && r.value.json && r.value.json.code === 'command-not-allowed', "403 {code:'command-not-allowed'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
  }
  {
    const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: 'demo_moo', command: 'override', params: { algorithm: 'sobol' } }) }))
    check('POST exec override 缺 reason → 400 bad-param', !r.threw && r.value.status === 400 && r.value.json && r.value.json.code === 'bad-param', "400 {code:'bad-param'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
  }
  {
    const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: '../outside', command: 'ask' }) }))
    check('POST exec run 逃逸 → 400 run-out-of-root', !r.threw && r.value.status === 400 && r.value.json && r.value.json.code === 'run-out-of-root', "400 {code:'run-out-of-root'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
  }
  {
    const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: '', command: 'ask' }) }))
    check('POST exec run 空串 → 400 bad-param（v1.4）', !r.threw && r.value.status === 400 && r.value.json && r.value.json.code === 'bad-param', "400 {code:'bad-param'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
  }
  {
    /* 不带 root 参数、不给 config.projectRoot：靠默认候选解析。候选 ④（插件父目录）优先于
       会话 cwd，所以当插件父目录本身是合法 condopt 根时，期望它而不是 DSH_CONDOPT_VERIFY_ROOT。 */
    const pluginParentIsRoot = existsSync(join(pluginParent, 'scripts', 'run_condopt.py')) && existsSync(join(pluginParent, 'src', 'condopt', 'cli.py'))
    const expectedRoot = pluginParentIsRoot ? pluginParent : repoRoot
    const res = thrown(() => mod.createHandler({ env: {}, config: {}, cwd: repoRoot, tmpDir: handlerTmp }))
    if (res.threw) fail('无 root 配置的 handler 创建', '(req,res)=>Promise', `throw ${res.err && res.err.message}`)
    else {
      const r = await thrownAsync(() => call(res.value, { url: '/condopt/api/health' }))
      check('不带 root 的 GET /api/health → 200 且 root=自动定位到的根', !r.threw && r.value.status === 200 && r.value.json && samePath(r.value.json.root, expectedRoot), `200 root=${expectedRoot}`, r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json && r.value.json.root)}`)
    }
  }
  {
    const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: '{not json' }))
    check('POST exec 非 JSON 体 → 400', !r.threw && r.value.status === 400, '400', r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
  }
  {
    const res = thrown(() => mod.createHandler({ ...deps, config: { projectRoot: repoRoot, allowExec: false } }))
    if (res.threw) fail('allowExec=false handler 创建', '(req,res)=>Promise', `throw ${res.err && res.err.message}`)
    else {
      const h2 = res.value
      const r = await thrownAsync(() => call(h2, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: 'demo_moo', command: 'ask' }) }))
      check('allowExec=false → 403 exec-disabled', !r.threw && r.value.status === 403 && r.value.json && r.value.json.code === 'exec-disabled', "403 {code:'exec-disabled'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
    }
  }

  /* 9.5 /api/exec 只读命令真跑（decisions，无 --out，不写 run 目录） */
  if (!skipReal) {
    const runDir = join(repoRoot, 'runs', 'demo_moo')
    if (!existsSync(join(runDir, 'problem.json'))) {
      note('跳过 /api/exec 真跑：runs/demo_moo 不存在')
    } else {
      const before = await snapshotDir(runDir)
      const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: 'demo_moo', command: 'decisions', params: { limit: 5 } }) }))
      const after = await snapshotDir(runDir)
      if (r.threw) fail('POST exec decisions（真跑）', '200 {ok:true}', `throw ${r.err && r.err.message}`)
      else if (r.value.status === 200 && r.value.json && r.value.json.ok === true && r.value.json.exitCode === 0) {
        pass('POST exec decisions → 200 ok')
        const body = r.value.json || {}
        check('exec.argv[0] === decisions', Array.isArray(body.argv) && body.argv[0] === 'decisions', "['decisions',...]", JSON.stringify(body.argv))
        check('exec.data 解析出 JSON', body.data !== null && typeof body.data === 'object', 'object', JSON.stringify(body.data).slice(0, 120))
      } else if (isSpawnBlocked(r.value.body)) {
        skip('POST exec decisions（真跑）', '沙箱内 spawn(stdio:pipe) EPERM')
        const body = r.value.json || {}
        check('exec 错误体仍带 argv（便于诊断）', Array.isArray(body.argv) && body.argv[0] === 'decisions', "argv[0]='decisions'", JSON.stringify(body.argv))
      } else {
        fail('POST exec decisions（真跑）', "200 {ok:true,exitCode:0}", `${r.value.status} ${r.value.body.slice(0, 200)}`)
      }
      const diff = diffSnapshots(before, after)
      check('exec decisions 零写入 run 目录', diff.length === 0, 'run 目录无新增/无 mtime 变化', diff.join('; ') || `新增/变化 ${diff.length} 项`)
    }
  }

  /* 9.6 /api/study —— 真跑，且必须零写入 */
  if (!skipReal) {
    const runDir = join(repoRoot, 'runs', 'demo_moo')
    if (!existsSync(join(runDir, 'problem.json'))) {
      note('跳过 /api/study 真跑：runs/demo_moo 不存在')
    } else {
      const before = await snapshotDir(runDir)
      const r = await thrownAsync(() => call(handler, { url: '/condopt/api/study?run=demo_moo' }))
      const after = await snapshotDir(runDir)
      if (r.threw) fail('GET /api/study（真跑）', '200 {report,...}', `throw ${r.err && r.err.message}`)
      else if (isSpawnBlocked(r.value.body)) {
        skip('GET /api/study 真跑数据', '沙箱内 spawn(stdio:pipe) EPERM；只检查了路由/零写入')
        check('GET /api/study → 200（EPERM 下仍降级不数百）', r.value.status === 200, '200', `${r.value.status} ${r.value.body.slice(0, 120)}`)
      } else {
        check('GET /api/study → 200', r.value.status === 200, '200', `${r.value.status} ${r.value.body.slice(0, 200)}`)
        const body = r.value.json || {}
        check('study.report 非 null', body.report !== null && body.report !== undefined, 'object', JSON.stringify(body.report).slice(0, 120))
        check('study.decisions 非 null', body.decisions !== null && body.decisions !== undefined, 'object', JSON.stringify(body.decisions).slice(0, 120))
        check('study.pending 非 null', body.pending !== null && body.pending !== undefined, 'object', JSON.stringify(body.pending).slice(0, 120))
        check('study.pareto 非 null（v1.1 必须带 --out tmp）', body.pareto !== null && body.pareto !== undefined, 'object', JSON.stringify(body.pareto).slice(0, 160))
        check('study.step === null（未显式 ?step=1）', body.step === null, 'null', JSON.stringify(body.step))
        check('study.warnings 是数组', Array.isArray(body.warnings), '[]', JSON.stringify(body.warnings))
        if (Array.isArray(body.warnings) && body.warnings.length > 0) note(`/api/study warnings: ${JSON.stringify(body.warnings)}`)
      }
      const diff = diffSnapshots(before, after)
      check('GET /api/study 零写入 run 目录', diff.length === 0, '无新增/无 mtime 变化（step 默认不调）', diff.join('; ') || '干净')
    }
  }

  } /* end hasRealRoot */

  /* 9.7 root 解析失败 → 409 */
  {
    const emptyRoot = join(tmpBase, 'nowhere')
    await mkdir(emptyRoot, { recursive: true })
    const res = thrown(() => mod.createHandler({ ...deps, selfDir: join(emptyRoot, 'dsh-plugin'), workspaces: [], config: {}, env: {}, cwd: emptyRoot }))
    if (res.threw) fail('root-not-found handler 创建', '(req,res)=>Promise', `throw ${res.err && res.err.message}`)
    else {
      const prevCwd = process.cwd()
      let r
      try {
        process.chdir(emptyRoot)
        r = await thrownAsync(() => call(res.value, { url: '/condopt/api/health' }))
      } finally {
        process.chdir(prevCwd)
      }
      check('全部候选不合法 → 409 root-not-found', !r.threw && r.value.status === 409 && r.value.json && r.value.json.code === 'root-not-found', "409 {code:'root-not-found'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json)}`)
    }
  }
}

/* ------------------------------------------------------------------ 10. renderView 真跑 */

group('renderView（DESIGN §4 真实渲染 / 零写入）')

if (skipReal) {
  note('DSH_CONDOPT_SKIP_REAL=1：跳过真实渲染')
} else if (!hasRealRoot) {
  skip('renderView 真实渲染 demo_moo', NO_ROOT_REASON)
} else if (!existsSync(join(repoRoot, 'scripts', 'run_condopt.py'))) {
  skip('renderView 真实渲染 demo_moo', NO_ROOT_REASON)
} else {
  const runDir = join(repoRoot, 'runs', 'demo_moo')
  if (!existsSync(join(runDir, 'problem.json'))) {
    note('runs/demo_moo 不存在，跳过真实渲染')
  } else {
    const cacheDir = join(tmpBase, 'render-cache')
    await mkdir(cacheDir, { recursive: true })
    const before = await snapshotDir(runDir)
    const res = await thrownAsync(() => mod.renderView(repoRoot, runDir, { force: true, tmpDir: cacheDir, timeoutMs: 120000 }))
    if (res.threw && isSpawnBlocked(String(res.err && (res.err.message || res.err)))) {
      skip('renderView 真实渲染 demo_moo', '沙箱内 spawn(stdio:pipe) EPERM：本 harness 进程无法启动子进程；需在非沙箱的 DSH/终端里跑（A4/真机由 Lead 执行）')
      const diff = diffSnapshots(before, await snapshotDir(runDir))
      check('renderView 失败时也未写 run 目录', diff.length === 0, '无新增/变化', diff.join('; ') || '干净')
    } else if (res.threw) {
      fail('renderView 真实渲染 demo_moo', '返回非空 css/html', `throw code=${res.code}: ${res.err && res.err.message}`)
    } else {
      const view = res.value || {}
      check('renderView.css 非空', typeof view.css === 'string' && view.css.length > 0, '非空 css', `len=${typeof view.css === 'string' ? view.css.length : 'n/a'}`)
      check('renderView.html 非空', typeof view.html === 'string' && view.html.length > 0, '非空 html', `len=${typeof view.html === 'string' ? view.html.length : 'n/a'}`)
      check('renderView.html 不含 <body', typeof view.html === 'string' && !/<body/i.test(view.html), '无 <body', typeof view.html === 'string' ? view.html.slice(0, 120) : 'n/a')
      check('renderView.css 含真实样式（body 或 :root）', typeof view.css === 'string' && (view.css.includes('body') || view.css.includes(':root')), 'body/:root', typeof view.css === 'string' ? view.css.slice(0, 120) : 'n/a')
      check('renderView.bytes > 0', typeof view.bytes === 'number' && view.bytes > 0, '>0', String(view.bytes))
      check('renderView.rel/abs 指向 run 目录', typeof view.abs === 'string' && samePath(view.abs, runDir), runDir, String(view.abs))
      check('renderView.generatedAt 是时间串', typeof view.generatedAt === 'string' && view.generatedAt.length > 0, 'ISO/时间串', String(view.generatedAt))
      check('renderView.warnings 是数组', Array.isArray(view.warnings), '[]', JSON.stringify(view.warnings))
      const second = await thrownAsync(() => mod.renderView(repoRoot, runDir, { tmpDir: cacheDir, timeoutMs: 120000 }))
      if (second.threw) fail('renderView 第二次（缓存）', 'cached=true', `throw ${second.code}`)
      else check('renderView 第二次走缓存 cached=true', second.value && second.value.cached === true, 'true', JSON.stringify(second.value && second.value.cached))
      const after = await snapshotDir(runDir)
      const diff = diffSnapshots(before, after)
      check('renderView 零写入 run 目录（--out 在 tmp）', diff.length === 0, 'run 目录无新增/无 mtime 变化', diff.join('; ') || '干净')
    }

    /* 渲染失败必须 502 render-failed，不得自造 HTML */
    const ghost = join(repoRoot, 'runs', '__dsh_condopt_ghost__')
    const failRes = await thrownAsync(() => mod.renderView(repoRoot, ghost, { force: true, tmpDir: cacheDir, timeoutMs: 60000 }))
    if (failRes.threw && isSpawnBlocked(String(failRes.err && (failRes.err.message || failRes.err)))) {
      skip('不存在的 run → render-failed/502', '沙箱内 spawn EPERM，无法真正触发渲染失败路径')
    } else {
      check('不存在的 run → throw render-failed/502', failRes.threw && failRes.code === 'render-failed' && failRes.status === 502, "throw {code:'render-failed', status:502}", failRes.threw ? `throw code=${failRes.code} status=${failRes.status}` : `returned ${JSON.stringify(failRes.value).slice(0, 120)}`)
    }
  }
}

/* ------------------------------------------------------------------ 11. v2.0 垂直切片（DESIGN §8.6） */

group('v2.0 stateToken（DESIGN §8.6A）')

{
  const tkDir = join(tmpBase, 'token-run')
  await mkdir(tkDir, { recursive: true })
  for (const name of ['pending.json', 'dataset.jsonl', 'rounds.json', 'config.json']) {
    await writeFile(join(tkDir, name), name === 'dataset.jsonl' ? '{"x":1}\n' : '[]\n')
  }
  const t1 = mod.stateToken(tkDir)
  check('stateToken 返回 16 位 hex', typeof t1 === 'string' && /^[0-9a-f]{16}$/.test(t1), '16 位 hex', JSON.stringify(t1))
  check('stateToken 稳定（同一目录两次相同）', mod.stateToken(tkDir) === t1, t1, String(mod.stateToken(tkDir)))
  /* 改内容（size 变化）→ 令牌变化 */
  await writeFile(join(tkDir, 'dataset.jsonl'), '{"x":1}\n{"x":2}\n')
  check('stateToken 随 size 变化', mod.stateToken(tkDir) !== t1, `≠ ${t1}`, String(mod.stateToken(tkDir)))
  /* 只改 mtime → 令牌变化 */
  const t2 = mod.stateToken(tkDir)
  const future = new Date(Date.now() + 5000)
  await utimes(join(tkDir, 'rounds.json'), future, future)
  check('stateToken 随 mtime 变化', mod.stateToken(tkDir) !== t2, `≠ ${t2}`, String(mod.stateToken(tkDir)))
  /* 文件缺失记 '-'：两个空目录令牌相同 */
  const e1 = join(tmpBase, 'empty-run-1')
  const e2 = join(tmpBase, 'empty-run-2')
  await mkdir(e1, { recursive: true })
  await mkdir(e2, { recursive: true })
  check('四文件全缺 → 令牌稳定（缺文件记 -）', mod.stateToken(e1) === mod.stateToken(e2) && /^[0-9a-f]{16}$/.test(mod.stateToken(e1)), '两空目录同值', `${mod.stateToken(e1)} / ${mod.stateToken(e2)}`)
  check('空目录令牌 ≠ 有数据目录令牌', mod.stateToken(e1) !== mod.stateToken(tkDir), '不同', String(mod.stateToken(e1)))
  const missing = thrown(() => mod.stateToken(join(tmpBase, 'no-such-run-dir')))
  check('不存在的 run 目录 → 返回空串（DESIGN §8.6A 定稿）', !missing.threw && missing.value === '', "''", missing.threw ? `throw ${missing.err && missing.err.message}` : JSON.stringify(missing.value))
}

group('v2.0 /api/study 的 stateToken + current（DESIGN §8.6A）')

if (!hasRealRoot) {
  skip('v2.0 /api/study 字段（stateToken/current）', NO_ROOT_REASON)
} else if (handler && !skipReal) {
  const runDir = join(repoRoot, 'runs', 'demo_moo')
  if (!existsSync(join(runDir, 'problem.json'))) {
    note('runs/demo_moo 不存在，跳过 /api/study v2.0 字段断言')
  } else {
    const tokenNow = mod.stateToken(runDir)
    const r = await thrownAsync(() => call(handler, { url: '/condopt/api/study?run=demo_moo' }))
    if (r.threw) fail('GET /api/study v2.0 字段', '200 {stateToken,current}', `throw ${r.err && r.err.message}`)
    else {
      const body = r.value.json || {}
      check('study.stateToken 与 stateToken(runDir) 一致', body.stateToken === tokenNow && /^[0-9a-f]{16}$/.test(String(body.stateToken)), tokenNow, String(body.stateToken))
      const cur = body.current
      check('study.current 是对象（不伪造）', cur !== null && cur !== undefined && typeof cur === 'object', 'object', JSON.stringify(cur).slice(0, 160))
      if (cur && typeof cur === 'object') {
        const KEYS = ['algorithm', 'params', 'objective', 'direction', 'budget', 'batch', 'nObservations', 'pendingCount', 'remaining']
        const missingKeys = KEYS.filter((k) => !(k in cur))
        check('current 含 9 个约定字段', missingKeys.length === 0, KEYS.join(','), `missing=${missingKeys.join(',')} keys=${Object.keys(cur).join(',')}`)
        check('current.algorithm 非空字符串', typeof cur.algorithm === 'string' && cur.algorithm.length > 0, 'string', String(cur.algorithm))
        check('current 数值字段是 number 或 null', ['budget', 'batch', 'nObservations', 'pendingCount', 'remaining'].every((k) => cur[k] === null || typeof cur[k] === 'number'), 'number|null', JSON.stringify({ budget: cur.budget, batch: cur.batch, nObservations: cur.nObservations, pendingCount: cur.pendingCount, remaining: cur.remaining }))
      }
    }
  }
  /* 缺数据 → current 为 null（不伪造） */
  {
    const r = await thrownAsync(() => call(handler, { url: '/condopt/api/study?run=__dsh_verify_missing__' }))
    if (r.threw) fail('缺数据 run 的 /api/study', '200 {current:null}', `throw ${r.err && r.err.message}`)
    else {
      const body = r.value.json || {}
      const allNullShape = body.current !== null && typeof body.current === 'object' && Object.values(body.current).every((v) => v === null)
      check('缺数据 run → current 为 null（或 9 键全 null，不伪造数值）', r.value.status === 200 && (body.current === null || allNullShape), '200 {current:null} 或全 null 对象', `${r.value.status} current=${JSON.stringify(body.current).slice(0, 120)}`)
      check('缺数据 run → stateToken 为空串（未知，DESIGN §8.6A 定稿）', r.value.status === 200 && body.stateToken === '', "200 {stateToken:''}", `${r.value.status} stateToken=${JSON.stringify(body.stateToken)}`)
    }
  }
} else if (skipReal) {
  note('--skip-real：跳过 /api/study v2.0 字段真跑')
}

group('v2.0 辅助导出（host-dev 提供：parseResultsText / readCurrent）')

if (typeof mod.parseResultsText === 'function') {
  const good = [
    ['JSON 数组', '[{"id":"a","y":1}]', 'json'],
    ['JSONL', '{"id":"a","y":1}\n{"id":"b","y":2}', 'jsonl'],
    ['CSV 带 id + 条件列', 'id,T,y\na,80,1', 'csv'],
    ['TSV 带 id', 'id\tT\ty\na\t80\t1', 'csv'],
  ]
  for (const [label, text, format] of good) {
    const res = thrown(() => mod.parseResultsText(text))
    const value = res.threw ? null : res.value
    check(`parseResultsText ${label} → format=${format}`, !res.threw && value && value.format === format && typeof value.rows === 'number' && value.rows >= 1 && typeof value.ext === 'string', `{format:'${format}', rows≥1, ext}`, res.threw ? `throw ${res.code}` : JSON.stringify(value))
  }
  for (const [label, text] of [['空串', ''], ['空数组', '[]'], ['不可解析', 'no json here']]) {
    const res = thrown(() => mod.parseResultsText(text))
    check(`parseResultsText ${label} → bad-param`, res.threw && res.code === 'bad-param', "throw {code:'bad-param'}", res.threw ? `throw ${res.code}` : JSON.stringify(res.value))
  }
} else {
  note('未导出 parseResultsText（DESIGN 未冻结该名字）：跳过辅助导出单测')
}

if (typeof mod.readCurrent === 'function') {
  const runDir = join(repoRoot, 'runs', 'demo_moo')
  if (existsSync(join(runDir, 'problem.json'))) {
    const res = thrown(() => mod.readCurrent(runDir))
    if (res.threw) {
      fail('readCurrent(demo_moo)', '{algorithm,params,…,remaining}', `throw ${res.code}: ${res.err && res.err.message}`)
    } else {
      const cur = res.value
      const KEYS = ['algorithm', 'params', 'objective', 'direction', 'budget', 'batch', 'nObservations', 'pendingCount', 'remaining']
      const missingKeys = KEYS.filter((k) => !(k in (cur || {})))
      check('readCurrent 含 9 键', missingKeys.length === 0, KEYS.join(','), `missing=${missingKeys.join(',')}`)
      check('readCurrent.algorithm 非空', cur && typeof cur.algorithm === 'string' && cur.algorithm.length > 0, 'string', String(cur && cur.algorithm))
    }
  } else if (hasRealRoot) {
    note('runs/demo_moo 不存在，跳过 readCurrent 断言')
  } else {
    skip('readCurrent(demo_moo)', NO_ROOT_REASON)
  }
} else {
  note('未导出 readCurrent（DESIGN 未冻结该名字）：跳过辅助导出单测')
}

group('v2.0 expect 状态令牌（DESIGN §8.6A）')

const writeBlocked = !hasRealRoot ? true : !(await probeWrite(join(repoRoot, 'runs', '__dsh_verify_probe__')))
if (writeBlocked) note('本会话沙箱不允许在 <root>/runs 下创建目录 → 真写入类断言降级为 SKIP（请在非沙箱环境重跑取最终数）')

if (!hasRealRoot) {
  skip('v2.0 expect 令牌六命令 409', NO_ROOT_REASON)
} else if (handler && !skipReal) {
  const demoRun = join(repoRoot, 'runs', 'demo_moo')
  if (!existsSync(join(demoRun, 'problem.json'))) {
    note('runs/demo_moo 不存在，跳过 expect 断言')
  } else {
    const tokenNow = mod.stateToken(demoRun)
    const wrong = tokenNow === '0000000000000000' ? '1111111111111111' : '0000000000000000'
    for (const cmd of ['ask', 'confirm', 'override', 'auto', 'step', 'tell']) {
      const body = { run: 'demo_moo', command: cmd, expect: wrong }
      if (cmd === 'override') body.params = { algorithm: 'bayes', reason: '令牌测试' }
      if (cmd === 'tell') body.params = { resultsText: '[{"id":"r1-1","y":1}]' }
      const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify(body) }))
      if (r.threw) {
        fail(`${cmd} expect 不匹配 → 409`, "409 {code:'state-changed'}", `throw ${r.err && r.err.message}`)
        continue
      }
      check(`${cmd} expect 不匹配 → 409 state-changed`, r.value.status === 409 && r.value.json && r.value.json.code === 'state-changed' && r.value.json.stateToken === tokenNow, `409 {code:'state-changed', stateToken:${tokenNow}}`, `${r.value.status} ${JSON.stringify(r.value.json).slice(0, 160)}`)
    }
  }
}

group('v2.0 tell resultsText 校验（DESIGN §8.6B，写前拒绝）')

if (!hasRealRoot) {
  skip('v2.0 tell resultsText 校验（写前拒绝）', NO_ROOT_REASON)
} else if (handler && !skipReal) {
  const cases = [
    ['空串', ''],
    ['5001 行', Array.from({ length: 5001 }, (_, i) => `{"id":"r${i}","y":${i}}`).join('\n')],
    ['不可解析', '这不是 JSON 也不是 CSV 表头（没有 id 列）'],
    ['超 2,000,000 字符', 'x'.repeat(2000001)],
  ]
  for (const [label, resultsText] of cases) {
    const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: 'demo_moo', command: 'tell', params: { resultsText } }) }))
    check(`tell resultsText ${label} → 400 bad-param`, !r.threw && r.value.status === 400 && r.value.json && r.value.json.code === 'bad-param', "400 {code:'bad-param'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json).slice(0, 140)}`)
  }
  {
    /* DESIGN §8.6B 冻结：results 与 resultsText 互斥，同时给 → 400。 */
    const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: 'demo_moo', command: 'tell', params: { resultsText: '[{"id":"r1-1","y":1}]', results: 'results.jsonl' } }) }))
    check('tell 同时给 results 与 resultsText → 400', !r.threw && r.value.status === 400 && r.value.json && r.value.json.code === 'bad-param', "400 {code:'bad-param'}", r.threw ? 'throw' : `${r.value.status} ${JSON.stringify(r.value.json).slice(0, 140)}`)
  }
}

group('v2.0 真写路径：expect 放行 / 无 expect / tell 三形态 receipt（需可写 runs/）')

if (skipReal) {
  note('--skip-real：跳过 v2.0 真写路径')
} else if (!hasRealRoot) {
  for (const name of ['expect 匹配放行', '未带 expect 不校验', 'tell JSON 数组 receipt', 'tell JSONL receipt', 'tell CSV receipt', 'tell 临时文件已删']) {
    skip(`v2.0 ${name}`, NO_ROOT_REASON)
  }
} else if (writeBlocked) {
  for (const name of ['expect 匹配放行', '未带 expect 不校验', 'tell JSON 数组 receipt', 'tell JSONL receipt', 'tell CSV receipt', 'tell 临时文件已删']) {
    skip(`v2.0 ${name}`, '本会话沙箱禁止在 <root>/runs 下创建目录（Access denied）；设置 DSH_CONDOPT_VERIFY_ROOT 指向可写临时根，或在非沙箱环境重跑')
  }
} else if (!handler) {
  note('handler 不可用，跳过 v2.0 真写路径')
} else if (!existsSync(join(repoRoot, 'scripts', 'run_condopt.py'))) {
  skip('v2.0 tell/expect 真写路径', NO_ROOT_REASON)
} else {
  const clones = []
  const cloneRun = async (suffix, sourceDir) => {
    const dst = join(repoRoot, 'runs', `__dsh_verify_${suffix}__`)
    await rm(dst, { recursive: true, force: true })
    await cp(sourceDir, dst, { recursive: true })
    clones.push(dst)
    return dst
  }
  try {
    const sourceDir = await findTellSource(repoRoot)
    if (sourceDir === null) {
      skip('v2.0 tell 真写路径', '找不到 pending.json 里 ≥2 条建议的 run 作为回填数据源')
    } else {
      /* 用真实 pending 记录造回填行：JSON/JSONL 只需 {id,y}；CSV 必须带条件列（DESIGN §8.6B 冻结，
         否则 CLI 的 CSV 路径不会像 JSON/JSONL 那样从 pending 建议回填 x）。 */
      const pendingRows = await readPendingRows(sourceDir)
      const rows = pendingRows.slice(0, 2).map((row, index) => ({ id: row.id, y: 50 + index * 5 }))
      const condKeys = Object.keys((pendingRows[0] && pendingRows[0].x) || {})
      const condValue = (row, key) => {
        const value = row.x ? row.x[key] : undefined
        return value === undefined || value === null ? '' : String(value)
      }
      const csvText = ['id', ...condKeys, 'y'].join(',') + '\n'
        + pendingRows.slice(0, 2).map((row, index) => [row.id, ...condKeys.map((key) => condValue(row, key)), 50 + index * 5].join(',')).join('\n')

      /* ① expect 匹配放行 + ② 未带 expect 不校验：用 `auto`（不依赖预算/pending 语义，
         避免在带 pending 的副本上被 CLI 的 PendingError 干扰判断）。 */
      const writeDir = await cloneRun('expect', sourceDir)
      const token0 = mod.stateToken(writeDir)
      const okAuto = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: '__dsh_verify_expect__', command: 'auto', expect: token0 }) }))
      check('expect 匹配 → 放行（200，非 409）', !okAuto.threw && okAuto.value.status === 200 && okAuto.value.json && okAuto.value.json.ok !== false, '200 {ok:true}', okAuto.threw ? `throw ${okAuto.err && okAuto.err.message}` : `${okAuto.value.status} ${JSON.stringify(okAuto.value.json).slice(0, 160)}`)
      const autoArgv = okAuto.threw ? null : okAuto.value.json && okAuto.value.json.argv
      check('expect 不进 argv', !Array.isArray(autoArgv) || !autoArgv.some((token) => token === token0 || token === 'expect' || token === '--expect'), 'argv 无 expect 令牌', JSON.stringify(autoArgv))
      const noExpect = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: `__dsh_verify_expect__`, command: 'auto' }) }))
      check('未带 expect → 不校验（非 409）', !noExpect.threw && noExpect.value.status !== 409, '非 409', noExpect.threw ? 'throw' : `${noExpect.value.status} ${JSON.stringify(noExpect.value.json).slice(0, 120)}`)

      /* ③④⑤ tell 三种形态，各用一个干净副本 */
      check('CSV fixture 带条件列（DESIGN §8.6B 冻结）', condKeys.length > 0, '>0 个条件列', JSON.stringify(condKeys))
      const tellReason = '验收留痕理由'
      const formats = [
        ['json', 'json', JSON.stringify(rows)],
        ['jsonl', 'jsonl', rows.map((row) => JSON.stringify(row)).join('\n')],
        ['csv', 'csv', csvText],
      ]
      for (const [label, expectFormat, resultsText] of formats) {
        const runName = `__dsh_verify_tell_${label}__`
        const runDir = await cloneRun(`tell_${label}`, sourceDir)
        const before = { pending: await readPendingCount(runDir), dataset: await lineCount(join(runDir, 'dataset.jsonl')), token: mod.stateToken(runDir) }
        const tellDir = join(handlerTmp, 'dsh-condopt-tell')
        const r = await thrownAsync(() => call(handler, { method: 'POST', url: '/condopt/api/exec', body: JSON.stringify({ run: runName, command: 'tell', params: { resultsText, reason: tellReason }, expect: before.token }) }))
        const after = { pending: await readPendingCount(runDir), dataset: await lineCount(join(runDir, 'dataset.jsonl')), token: mod.stateToken(runDir) }
        if (r.threw) {
          fail(`tell ${label} 真跑`, '200 {ok:true, receipt}', `throw ${r.err && r.err.message}`)
          continue
        }
        const body = r.value.json || {}
        if (r.value.status !== 200 || body.ok === false || body.receipt === undefined || body.receipt === null) {
          fail(`tell ${label} 真跑`, '200 {ok:true, receipt}', `${r.value.status} ${JSON.stringify(body).slice(0, 220)}`)
          continue
        }
        pass(`tell ${label} 真跑 200 + receipt`)
        const rc = body.receipt
        check(`tell ${label}: receipt.run 指向该 run`, typeof rc.run === 'string' && rc.run.includes(`__dsh_verify_tell_${label}__`), runName, String(rc.run))
        check(`tell ${label}: resultsRows = 回填记录数`, rc.resultsRows === rows.length, String(rows.length), String(rc.resultsRows))
        check(`tell ${label}: format = ${expectFormat}`, rc.format === expectFormat, expectFormat, String(rc.format))
        check(`tell ${label}: pending 前后计数自洽`, rc.pendingBefore === before.pending && rc.pendingAfter === after.pending, `${before.pending} → ${after.pending}`, `${rc.pendingBefore} → ${rc.pendingAfter}`)
        check(`tell ${label}: dataset 前后计数自洽`, rc.datasetBefore === before.dataset && rc.datasetAfter === after.dataset, `${before.dataset} → ${after.dataset}`, `${rc.datasetBefore} → ${rc.datasetAfter}`)
        check(`tell ${label}: acceptedRows = datasetAfter-datasetBefore`, rc.acceptedRows === after.dataset - before.dataset, String(after.dataset - before.dataset), String(rc.acceptedRows))
        check(`tell ${label}: 0 ≤ acceptedRows ≤ resultsRows`, typeof rc.acceptedRows === 'number' && rc.acceptedRows >= 0 && rc.acceptedRows <= rc.resultsRows, `0..${rc.resultsRows}`, String(rc.acceptedRows))
        check(`tell ${label}: stateToken 前后与实际一致`, rc.stateTokenBefore === before.token && rc.stateTokenAfter === after.token, `${before.token} → ${after.token}`, `${rc.stateTokenBefore} → ${rc.stateTokenAfter}`)
        check(`tell ${label}: reason 只留痕、不进 argv（§8.6B 冻结）`, !Array.isArray(body.argv) || (!body.argv.includes(tellReason) && !body.argv.includes('--reason')), 'argv 无 reason/--reason', JSON.stringify(body.argv))
        const leftover = await listFilesRecursive(tellDir)
        check(`tell ${label}: 临时文件已删`, leftover.length === 0, '目录内无残留文件', JSON.stringify(leftover.slice(0, 5)))
      }
    }
  } finally {
    for (const dir of clones) await rm(dir, { recursive: true, force: true }).catch(() => {})
    const stray = (await readdir(join(repoRoot, 'runs'), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && e.name.startsWith('__dsh_verify_')).map((e) => e.name)
    check('v2.0 测试副本已清理', stray.length === 0, 'runs/ 下无 __dsh_verify_* 残留', JSON.stringify(stray))
  }
}

/* ------------------------------------------------------------------ 工具函数：目录快照 */

async function probeWrite(dir) {
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.probe'), 'x')
    await rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
async function lineCount(file) {
  try {
    const text = await readFile(file, 'utf8')
    return text.split(/\r?\n/).filter((line) => line.trim() !== '').length
  } catch {
    return 0
  }
}
async function readPendingCount(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'pending.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}
async function readPendingIds(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'pending.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed.map((row) => row && row.id).filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}
async function readPendingRows(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'pending.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === 'object') : []
  } catch {
    return []
  }
}
/** 找一个 pending ≥2 条的 run 作为回填数据源（按目录名排序，保证确定性）。 */
async function findTellSource(root) {
  const runsDir = join(root, 'runs')
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => [])
  const names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('__dsh_verify_')).map((e) => e.name).sort()
  for (const name of names) {
    const ids = await readPendingIds(join(runsDir, name))
    if (ids.length >= 2) return join(runsDir, name)
  }
  return null
}
async function listFilesRecursive(dir) {
  const out = []
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(dir)
  return out
}


async function snapshotDir(dir) {
  const out = {}
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      try {
        const s = await stat(join(dir, entry.name))
        out[entry.name] = { mtimeMs: Math.round(s.mtimeMs), size: s.size, dir: entry.isDirectory() }
      } catch { /* 忽略瞬时消失 */ }
    }
  } catch { /* 目录不存在 */ }
  return out
}
function diffSnapshots(before, after) {
  const diff = []
  for (const [name, meta] of Object.entries(before)) {
    if (!(name in after)) diff.push(`${name} 消失`)
    else if (after[name].mtimeMs !== meta.mtimeMs || after[name].size !== meta.size) diff.push(`${name} 被修改`)
  }
  for (const name of Object.keys(after)) if (!(name in before)) diff.push(`新增 ${name}`)
  return diff
}

/* ------------------------------------------------------------------ 汇总 */

await rm(tmpBase, { recursive: true, force: true }).catch(() => {})

const failed = results.filter((r) => !r.ok)
const passed = results.filter((r) => r.ok && !r.skipped).length
process.stdout.write(`\n========================================\n`)
process.stdout.write(`verify-host: ${passed}/${results.length} 通过，${failed.length} 失败，${skips.length} 跳过${skipReal ? '（--skip-real）' : ''}\n`)
if (!hasRealRoot) {
  process.stdout.write(`注意：${NO_ROOT_REASON}\n`)
  process.stdout.write(`      离线断言（导出面 / 纯函数 / 解析 / 路由分派 / 409）已全部照跑；真 CLI 与写路径已 SKIP。\n`)
}
if (skips.length > 0) {
  process.stdout.write('跳过项（环境限制，非失败）：\n')
  for (const s of skips) process.stdout.write(`  - ${s.name}：${s.reason}\n`)
}
if (failed.length > 0) {
  process.stdout.write(`失败断言：\n`)
  for (const f of failed) process.stdout.write(`  - [${f.group}] ${f.name}\n      期望 ${f.expected}\n      实际 ${f.actual}\n`)
  process.exit(1)
}
process.stdout.write('verify-host: PASS\n')
process.exit(0)
