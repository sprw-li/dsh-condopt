/**
 * dsh-condopt 宿主侧（host half）。
 *
 * 为什么是单文件、零依赖：DSH 插件由 cordis 条目加载，`index.js` 是唯一入口。
 * 插件刻意只用 node 内置模块——desktop profile 里 `link:` 之后不需要 npm install，
 * 也不会和 DSH 自身的依赖树打架；`apply` 之前也不会 import 任何第三方包。
 *
 * 它只做三件事：
 *   1. 把 condopt 仓库的 CLI（`scripts/run_condopt.py`）包成 HTTP API：
 *      `GET /condopt/api/health|studies|spec|view|study`、`POST /condopt/api/exec`。
 *      默认零写入：凡是有 `--out` 的子命令（render/pareto/export/digest）一律显式
 *      指向 `os.tmpdir()`，`step`（会写 run/step.json）只在显式请求时调（DESIGN §5 不变量）；
 *   2. 暴露唯一 agent 工具 `condopt_view`：把 study 状态压成紧凑 Markdown（DESIGN §6），
 *      绝不把整份 dashboard HTML 塞进模型上下文；
 *   3. 把「condopt 根目录解析 / run 路径越界 / exec 白名单与参数校验」实现为语义清晰的
 *      纯函数并导出，供离线 harness 单测（DESIGN §2/§5、A2）。
 *
 * 一切子进程都走 `spawn(prog, argvArray, {cwd, env})`，任何情况下不经 shell：
 * 路径里可能有中文与空格（DESIGN R6），shell 拼接一定会碎。`--json` 命令的
 * stdout 与 stderr 都会尝试解析（DESIGN R3：出错时 JSON 可能落在 stderr）。
 *
 * 白名单按 DESIGN v1.2（2026-11-19 两次修订：先按 cli.py 实测口径修正 17 条命令，
 * 再给 override 补可选 --params 并给 override/auto/knee-weights 补 --json）实现。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

/** webServer 提供 HTTP 前缀路由；tools 提供 condopt_view。两者都做 feature detect。 */
export const inject = ['webServer', 'tools']

/** HTTP 前缀（DESIGN §0：`/condopt`，客户端调 `/condopt/api/*`）。 */
const ROUTE_PREFIX = '/condopt'
const API_PREFIX = `${ROUTE_PREFIX}/api`
const RUNS_DIR = 'runs'
/** condopt 根目录的两个标志性文件（DESIGN §2 合法性判据）。 */
const CLI_SCRIPT = ['scripts', 'run_condopt.py']
const CLI_MODULE = ['src', 'condopt', 'cli.py']
/** 默认子进程超时；render 慢得多（DESIGN R2：demo_moo 实测约 2s，但冷启动要留余量）。 */
const DEFAULT_TIMEOUT_MS = 60000
const RENDER_TIMEOUT_MS = 120000
/** 十进制参数上限（DESIGN §5）。 */
const MAX_DECIMAL = 100000
/** `limit` 的专用上界（DESIGN v1.4：1000，避免一次拉全量决策日志）。 */
const MAX_LIMIT = 1000
/** 渲染缓存根目录名（位于 os.tmpdir() 之下，绝不落 run 目录）。 */
const VIEW_CACHE_DIR = 'dsh-condopt-view'
/** tell resultsText 的临时落盘目录名（DESIGN §8.6B：调用结束即删）。 */
const TELL_TMP_DIR = 'dsh-condopt-tell'
/** `stateToken` 参与哈希的四个文件（DESIGN §8.6A，顺序固定）。 */
const STATE_TOKEN_FILES = ['pending.json', 'dataset.jsonl', 'rounds.json', 'config.json']
/** resultsText 上限（DESIGN §8.6B）。 */
const MAX_RESULTS_TEXT_CHARS = 2_000_000
const MAX_RESULTS_LINES = 5000
/** 会写 run 目录的命令：带 `expect` 时做状态令牌校验（DESIGN §8.6A）。 */
const WRITE_COMMANDS = new Set(['ask', 'confirm', 'override', 'auto', 'step', 'tell'])
/** 缓存失效判定使用的输入文件（DESIGN §4.2）。 */
const VIEW_INPUT_FILES = [
  'problem.json', 'config.json', 'dataset.jsonl', 'rounds.json',
  'pending.json', 'decisions.jsonl', 'step.json', 'decision.json',
]
/** 生成 Study.mtime 时参与取最大值的文件（含 DESIGN §3 判定 study 的两个标志文件）。 */
const STUDY_MTIME_FILES = [...VIEW_INPUT_FILES, 'opt_state.json', 'suggestions.csv']
/** 普通字符串参数正则（DESIGN §5 v1.1：不含 `,`/`=`）。 */
const STRING_RE = /^[A-Za-z0-9_.:\-\\/\u4e00-\u9fa5 ]{0,200}$/
/** knee-weights 权重串正则（DESIGN §5 v1.1 原文）。 */
const WEIGHTS_RE = /^[\w\u4e00-\u9fa5]+=[0-9.]+(,[\w\u4e00-\u9fa5]+=[0-9.]+)*$/
/**
 * 本插件自身目录（`dsh-plugin/`）。DESIGN §2 第 4 条把它的**父目录**列为根目录候选：
 * 以 `link:` 装进 profile 时父目录正好是 condopt 仓库根（开箱即用），从 npm 装时
 * 父目录不是合法根，会被合法性检查自动跳过。
 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
/** 计数类参数（DESIGN v1.4：`< 1` 一律 400；`limit` 另有 1000 上界）。 */
const COUNT_PARAMS = new Set(['n', 'batch', 'budget', 'limit', 'top_k', 'after_batches', 'start_top_k', 'prior', 'objectives', 'constraints'])

/**
 * 带错误码的异常：HTTP 层按 `.status`/`.code` 直接映射成响应体 `{error, code}`，
 * 纯函数（resolveRunDir / buildExecArgv / renderView）也用它表达失败。
 */
export class CondoptError extends Error {
  constructor(message, code, status = 400, extra = {}) {
    super(message)
    this.name = 'CondoptError'
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

/** 只认普通对象（数组/null/日期都不算），避免把畸形的请求体当配置用。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 由任意值取可读错误文本。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** run 绝对路径 → 相对 root 的 posix 风格路径（统一用 `/`，前端与 argv 都稳定）。 */
function relToRoot(root, abs) {
  return relative(root, abs).split(sep).join('/')
}

/** sha1 前 16 位，用作缓存目录名（DESIGN §4.1）。 */
function shortHash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

/**
 * 解析「python 解释器 + 前置参数」。DESIGN §2：`process.env.CONDOPT_PYTHON`，
 * 默认 win32 用 `py -3`、其它用 `python3`。允许写入 `"py -3"` 或带引号的路径，
 * 但只做空格/引号切分——绝不交给 shell。
 */
function splitCommand(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return []
  const out = []
  let current = ''
  let quote = ''
  for (const ch of text) {
    if (quote !== '') {
      if (ch === quote) quote = ''
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current !== '') {
        out.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current !== '') out.push(current)
  return out
}

/** python 调用描述：{prog, prefix, display}。config.python 优先于环境变量。 */
export function pythonSpec(env = process.env, config = {}) {
  const configured = isPlainObject(config) && typeof config.python === 'string' ? config.python : ''
  const raw = configured.trim() !== '' ? configured : (typeof env?.CONDOPT_PYTHON === 'string' ? env.CONDOPT_PYTHON : '')
  const tokens = splitCommand(raw)
  if (tokens.length > 0) return { prog: tokens[0], prefix: tokens.slice(1), display: tokens.join(' ') }
  if (process.platform === 'win32') return { prog: 'py', prefix: ['-3'], display: 'py -3' }
  return { prog: 'python3', prefix: [], display: 'python3' }
}

/** 逐层解包可能的 `{get()}` 配置源（cordis 的 volatile 字段会这样送进来）。 */
function unwrapConfigValue(value, fallback) {
  let current = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === undefined || current === null) return fallback
    if (isPlainObject(current) && typeof current.get === 'function') {
      try {
        current = current.get()
        continue
      } catch {
        return fallback
      }
    }
    break
  }
  return current === undefined || current === null ? fallback : current
}

/**
 * 跑一次 condopt CLI。返回 `{ok, code, stdout, stderr, timedOut, error}`。
 *
 * - `spawnImpl` 可注入（harness 用假 spawn）；若它直接返回 Promise，也接受那个
 *   已经结算的结果对象，这样单测不必伪造 EventEmitter 手柄。
 * - 超时先结算再 kill：调用方一定能拿到 504 语义的结果，不会吊死在子进程上。
 */
export async function runCli(argv, options = {}) {
  const root = options.root
  const env = isPlainObject(options.env) ? options.env : process.env
  const spec = options.python !== undefined && options.python !== null
    ? options.python
    : pythonSpec(env, options.config)
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const scriptPath = join(String(root || ''), ...CLI_SCRIPT)
  const args = [...(Array.isArray(spec.prefix) ? spec.prefix : []), scriptPath, ...argv]
  const shared = { root, env: { ...env, PYTHONUTF8: '1' }, windowsHide: true, timeoutMs }
  const first = await spawnCaptured(spawnImpl, spec.prog, args, shared, 'pipe')
  /* 受限环境（DSH 沙箱的 confined 模式）不允许创建命名管道，Node 用默认
     stdio:'pipe' 捕获子进程输出会得到 `spawn EPERM`。此时退化为「文件重定向」
     捕获：`stdio: ['ignore', fd, fd]`，仍然是 spawn(argv 数组)、仍然不经 shell，
     只是用临时文件代替管道。正常环境下不会走这条路，所以零额外开销。 */
  if (first.error !== undefined && /\bEPERM\b/.test(first.error)) {
    const second = await spawnCaptured(spawnImpl, spec.prog, args, shared, 'files')
    if (second.error === undefined) return second
    return { ...second, error: `${second.error}（管道捕获 EPERM，改用文件重定向仍失败）` }
  }
  return first
}

/**
 * 按指定捕获方式跑一次子进程并等待结果。
 *
 * @param {'pipe'|'files'} mode pipe=常规 stdout/stderr 管道；files=临时文件重定向
 */
async function spawnCaptured(spawnImpl, prog, args, shared, mode) {
  const { root, env, timeoutMs } = shared
  let files = null
  let stdio = 'pipe'
  if (mode === 'files') {
    files = await openCaptureFiles().catch(() => null)
    if (files === null) {
      return { ok: false, code: null, stdout: '', stderr: '', timedOut: false, error: '无法建立输出重定向临时文件' }
    }
    stdio = ['ignore', files.outFd, files.errFd]
  }
  let handle
  try {
    handle = spawnImpl(prog, args, { cwd: root, env, windowsHide: true, shell: false, stdio })
  } catch (error) {
    await closeCaptureFiles(files)
    return { ok: false, code: null, stdout: '', stderr: '', timedOut: false, error: `无法启动 Python：${errorText(error)}` }
  }
  /* 假 spawn 可以直接返回结果对象（Promise），省去手柄模拟。 */
  if (handle !== null && typeof handle === 'object' && typeof handle.then === 'function') {
    const settled = await handle
    await closeCaptureFiles(files)
    return normalizeOutcome(settled)
  }
  if (handle === null || typeof handle !== 'object' || typeof handle.on !== 'function') {
    await closeCaptureFiles(files)
    return { ok: false, code: null, stdout: '', stderr: '', timedOut: false, error: 'spawn 返回的句柄不可用（缺少 on()）' }
  }
  return await new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = async (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (files !== null) {
        const captured = await readCaptureFiles(files)
        await closeCaptureFiles(files)
        if (result.stdout === '') result.stdout = captured.stdout
        if (result.stderr === '') result.stderr = captured.stderr
      }
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      try {
        handle.kill()
      } catch {
        /* 已经退出的进程 kill 失败无所谓 */
      }
      void finish({ ok: false, code: null, stdout, stderr, timedOut: true, error: `超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    if (handle.stdout && typeof handle.stdout.on === 'function') {
      handle.stdout.on('data', (chunk) => { stdout += chunkToString(chunk) })
    }
    if (handle.stderr && typeof handle.stderr.on === 'function') {
      handle.stderr.on('data', (chunk) => { stderr += chunkToString(chunk) })
    }
    handle.on('error', (error) => {
      void finish({ ok: false, code: null, stdout, stderr, timedOut: false, error: `无法启动 Python：${errorText(error)}` })
    })
    handle.on('close', (code) => {
      void finish({ ok: code === 0, code: typeof code === 'number' ? code : null, stdout, stderr, timedOut: false })
    })
  })
}

/** 为文件重定向模式开两个临时文件（返回 {outFd, errFd, outPath, errPath}）。 */
async function openCaptureFiles() {
  const dir = join(tmpdir(), 'dsh-condopt-spawn')
  await mkdir(dir, { recursive: true })
  const stamp = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const outPath = join(dir, `${stamp}.out`)
  const errPath = join(dir, `${stamp}.err`)
  const outHandle = await open(outPath, 'w')
  const errHandle = await open(errPath, 'w')
  return { outFd: outHandle.fd, errFd: errHandle.fd, outHandle, errHandle, outPath, errPath }
}

/** 读回文件重定向捕获的输出；读失败给空串（超时被杀时文件可能仍在写入）。 */
async function readCaptureFiles(files) {
  let stdout = ''
  let stderr = ''
  try {
    stdout = await readFile(files.outPath, 'utf8')
  } catch {
    stdout = ''
  }
  try {
    stderr = await readFile(files.errPath, 'utf8')
  } catch {
    stderr = ''
  }
  return { stdout, stderr }
}

/** 关闭句柄并删除临时文件（全部 best effort）。 */
async function closeCaptureFiles(files) {
  if (files === null) return
  for (const handle of [files.outHandle, files.errHandle]) {
    try {
      await handle.close()
    } catch {
      /* 已关闭 */
    }
  }
  for (const path of [files.outPath, files.errPath]) {
    try {
      await unlink(path)
    } catch {
      /* 已删除 */
    }
  }
}

/** 把注入式 spawn 的返回统一成 runCli 的结果形状。 */
function normalizeOutcome(value) {
  if (!isPlainObject(value)) {
    return { ok: false, code: null, stdout: '', stderr: '', timedOut: false, error: '注入的 spawn 未返回结果对象' }
  }
  const code = typeof value.code === 'number' ? value.code : (Number.isFinite(value.exitCode) ? value.exitCode : null)
  const ok = value.ok !== undefined ? Boolean(value.ok) : code === 0
  return {
    ok,
    code,
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
    timedOut: value.timedOut === true,
    error: typeof value.error === 'string' ? value.error : undefined,
  }
}

/** Buffer/Uint8Array/string 一律转 utf8 文本（PYTHONUTF8=1 保证字节是 UTF-8）。 */
function chunkToString(chunk) {
  if (typeof chunk === 'string') return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8')
  return String(chunk)
}

/**
 * 宽松解析 JSON：DESIGN R3 要求 stdout/stderr 都试。
 *
 * 先逐个候选做严格 `JSON.parse`；失败则从靠后的 `{`/`[` 截到最后一个 `}`/`]`
 * 再试（CLI 出错时 traceback 在前面、真正的结果 JSON 在最后）。全部失败返回
 * `null`——调用方据 `null` 记 warning，绝不抛。
 */
export function parseJsonLoose(...texts) {
  const candidates = texts.filter((text) => typeof text === 'string' && text.trim() !== '')
  for (const text of candidates) {
    const trimmed = text.trim()
    const direct = tryParseJson(trimmed)
    if (direct.ok) return direct.value
    const starts = []
    for (let index = 0; index < trimmed.length; index += 1) {
      const ch = trimmed[index]
      if (ch === '{' || ch === '[') starts.push(index)
    }
    const lastBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    /* 只从最后 32 个起点试：JSON 结果总在噪声之后，且限制次数避免 O(n²)。 */
    for (const start of starts.slice(-32)) {
      if (lastBrace <= start) continue
      const attempt = tryParseJson(trimmed.slice(start, lastBrace + 1))
      if (attempt.ok) return attempt.value
    }
  }
  return null
}

/** JSON.parse 的 {ok, value} 包装，避免异常控制流打断扫描。 */
function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, value: undefined }
  }
}

/**
 * 解析 condopt 根目录（DESIGN §2 v1.4）。
 *
 * 顺序固定：① 参数 root → ② env.CONDOPT_ROOT → ③ config.projectRoot →
 * ④ 插件自身目录的上一级（`link:` 安装 = 仓库根） → ⑤ 会话工作目录 →
 * ⑥ workspaceRegistry 的工作区列表 → ⑦ process.cwd()。
 * 合法性 = 目录下同时存在 `scripts/run_condopt.py` 与 `src/condopt/cli.py`。
 * 全部候选都不合法时**不抛**，返回 `{root: null, source: 'none', code: 'root-not-found'}`，
 * 便于 harness 直接断言，也便于 HTTP 层映射成 409。
 *
 * ④ 是「装进 profile 后无参也开箱可用」的关键候选：它不依赖会话 cwd、也不依赖配置。
 * ⑤⑥ 依赖运行时的 DSH 服务，由 `apply` 注入（`opts.sessionCwd` / `opts.workspaces`），
 * 拿不到就自然跳过；两者都是防御式调用，服务缺失或抛错都不影响其它候选。
 *
 * @param {object|string} options `{root, env, config, cwd, sessionCwd, selfDir, workspaces,
 *        workspaceRegistry, ctx, isRoot?}`；`workspaces` 可为数组、取值函数或 `{list()}`
 * @param {string} [sessionCwd] 会话工作目录（老式位置参数写法）
 */
export function resolveRoot(options = {}, sessionCwd) {
  const opts = typeof options === 'string' ? { root: options } : (isPlainObject(options) ? options : {})
  const env = isPlainObject(opts.env) ? opts.env : process.env
  const config = isPlainObject(opts.config) ? opts.config : {}
  const isRoot = typeof opts.isRoot === 'function' ? opts.isRoot : defaultIsRoot
  const candidates = []
  const push = (value, source) => {
    if (typeof value !== 'string' || value.trim() === '') return
    candidates.push({ dir: resolve(value.trim()), source })
  }
  push(opts.root, 'arg')
  push(env.CONDOPT_ROOT, 'env')
  push(unwrapConfigValue(config.projectRoot, undefined), 'config')
  /* ④ 插件自身目录的上一级：自持位置，不依赖任何运行时服务。 */
  const selfDir = typeof opts.selfDir === 'string' && opts.selfDir.trim() !== '' ? opts.selfDir.trim() : PLUGIN_DIR
  push(resolve(selfDir, '..'), 'self')
  /* ⑤ 会话工作目录：显式 cwd/位置参数优先，其次 apply 注入的 sessionCwd。 */
  push(opts.cwd, 'session')
  push(sessionCwd, 'session')
  push(opts.sessionCwd, 'session')
  /* ⑥ workspaceRegistry 的工作区列表：接受数组 / 取值函数 / {list()} / ctx 四种形态。 */
  const listed = workspaceEntries(opts)
  if (Array.isArray(listed)) {
    for (const entry of listed) push(workspacePathOf(entry), 'workspace')
  }
  /* ⑦ 进程 cwd。 */
  push(process.cwd(), 'cwd')
  for (const candidate of candidates) {
    if (isRoot(candidate.dir)) return { root: candidate.dir, source: candidate.source }
  }
  return {
    root: null,
    source: 'none',
    code: 'root-not-found',
    error: '未找到 condopt 根目录（需要同时存在 scripts/run_condopt.py 与 src/condopt/cli.py）；'
      + '可用请求参数 root、环境变量 CONDOPT_ROOT 或插件配置 projectRoot 指定。',
  }
}

/** 调一个可能抛错/不存在的取值函数，失败给回退值。 */
function safeCall(fn, fallback) {
  try {
    const value = fn()
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * 取工作区候选列表（DESIGN §2 第 6 条）。
 *
 * 为了让 harness 能按自己顺手的方式注入，`opts` 里以下四种写法都接受：
 * `workspaces: [...]`、`workspaces: () => [...]`、`workspaceRegistry: {list()}`、
 * `ctx`（内部走 `ctx.get('workspaceRegistry')`）。取不到就返回 undefined，候选自然跳过。
 */
function workspaceEntries(opts) {
  for (const source of [opts.workspaces, opts.workspaceRegistry]) {
    const list = workspaceListFrom(source)
    if (Array.isArray(list)) return list
  }
  const ctx = isPlainObject(opts.ctx) ? opts.ctx : undefined
  if (ctx !== undefined && typeof ctx.get === 'function') {
    return workspaceListFrom(safeCall(() => ctx.get('workspaceRegistry'), undefined))
  }
  return undefined
}

/** 单个来源 → 数组：数组本身 / 返回数组的函数 / 带 list() 的对象。 */
function workspaceListFrom(source) {
  if (Array.isArray(source)) return source
  if (typeof source === 'function') {
    const value = safeCall(source, undefined)
    return Array.isArray(value) ? value : undefined
  }
  if (isPlainObject(source) && typeof source.list === 'function') {
    const value = safeCall(() => source.list(), undefined)
    return Array.isArray(value) ? value : undefined
  }
  return undefined
}

/** workspaceRegistry 的条目可能是字符串或对象（字段名随版本漂移），统一取路径字符串。 */
function workspacePathOf(entry) {
  if (typeof entry === 'string') return entry
  if (!isPlainObject(entry)) return undefined
  return firstString([entry.cwd, entry.root, entry.path, entry.dir, entry.workspace])
}

/** 默认合法性判据：两个标志文件都在。 */
function defaultIsRoot(dir) {
  try {
    return existsSync(join(dir, ...CLI_SCRIPT)) && existsSync(join(dir, ...CLI_MODULE))
  } catch {
    return false
  }
}

/**
 * 把请求里的 run 参数解析成绝对路径，并强制它落在 `<root>/runs` 之内（DESIGN §3）。
 *
 * 容忍三种写法：`demo_moo`、`runs/demo_moo`、`D:\...\runs\demo_moo`——`runs/` 前缀
 * 会被剥掉再拼，避免客户端把 studies 返回的 `rel` 直接回传时拼成 `runs/runs/...`。
 * 逃逸或空值抛 `CondoptError{code:'run-out-of-root'}`。
 */
export function resolveRunDir(root, run) {
  const rootAbs = resolve(String(root || ''))
  const runsRoot = resolve(rootAbs, RUNS_DIR)
  let raw = typeof run === 'string' ? run.trim() : ''
  if (raw === '') throw new CondoptError('缺少 run 参数', 'bad-param', 400)
  if (/^runs[\\/]/i.test(raw)) raw = raw.slice(RUNS_DIR.length + 1)
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(runsRoot, raw)
  if (abs !== runsRoot && !abs.startsWith(runsRoot + sep)) {
    throw new CondoptError(`run 越出 runs 目录：${run}`, 'run-out-of-root', 400)
  }
  return abs
}

/** 读取并统计一组文件的最大 mtime（毫秒）。读不到的文件忽略。 */
async function maxMtimeOf(dir, names, readStat) {
  let newest = 0
  const targets = [dir, ...names.map((name) => join(dir, name))]
  for (const target of targets) {
    const info = await readStatSafe(target, readStat)
    if (info === null) continue
    const ms = mtimeMsOf(info)
    if (ms > newest) newest = ms
  }
  return newest
}

/** stat 的安全包装：任何失败都当作「不存在」。 */
async function readStatSafe(path, readStat) {
  try {
    return await readStat(path)
  } catch {
    return null
  }
}

/** 兼容 {mtimeMs} 与 {mtime: Date} 两种 stat 形状。 */
function mtimeMsOf(info) {
  if (info === null || typeof info !== 'object') return 0
  if (typeof info.mtimeMs === 'number' && Number.isFinite(info.mtimeMs)) return info.mtimeMs
  if (info.mtime instanceof Date) return info.mtime.getTime()
  if (typeof info.mtime === 'string') {
    const parsed = Date.parse(info.mtime)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** 读文件为 utf8 文本；失败返回 null（调用方据此判断「存在」）。 */
async function readTextSafe(path, readFileImpl) {
  try {
    return await readFileImpl(path, 'utf8')
  } catch {
    return null
  }
}

/** 读并解析 JSON；失败返回 null。 */
async function readJsonSafe(path, readFileImpl) {
  const text = await readTextSafe(path, readFileImpl)
  if (text === null) return null
  const parsed = parseJsonLoose(text)
  return parsed === null ? null : parsed
}

/** 数字或 null（不接受 NaN / Infinity / 字符串数字的畸形表示）。 */
function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value.trim())
    return Number.isFinite(num) ? num : null
  }
  return null
}

/**
 * 把 problem.json 的 objective 描述成一行人类可读文本（client 下拉里要显示）。
 * 支持：字符串、`{name, direction}`、`{objectives: [...], directions: [...]}`。
 */
function describeObjective(objective) {
  if (typeof objective === 'string') return objective
  if (!isPlainObject(objective)) return ''
  const names = Array.isArray(objective.objectives) ? objective.objectives.map(String) : []
  const directions = Array.isArray(objective.directions) ? objective.directions.map(String) : []
  if (names.length > 0) {
    return names.map((name, index) => `${name}${directions[index] === 'min' ? '↓' : directions[index] === 'max' ? '↑' : ''}`).join(', ')
  }
  const name = typeof objective.name === 'string' ? objective.name : ''
  const direction = typeof objective.direction === 'string' ? objective.direction : ''
  return direction === '' ? name : `${name}${direction === 'min' ? '↓' : direction === 'max' ? '↑' : ''}`
}

/**
 * 扫描 `<root>/runs/*` 列出 study（DESIGN §3 的 Study 形状，**恰好 8 个键**）。
 *
 * 只收含 `problem.json` 或 `dataset.jsonl` 的目录；按 mtime 倒序。mtime 取
 * 关键文件与目录本身的最大值（目录 mtime 在 Windows 上不随文件内容更新，所以
 * 不能只 stat 目录）。`best` 优先取 rounds.json 里最后一个有限的 `best`，
 * 单目标 study 没有 rounds.json 时退化为数据集上的极值。
 *
 * @param {string} root condopt 根目录
 * @param {object} [opts] `{fsImpl, fs}` 可注入 fs 便于 harness 造 fixture
 */
export async function listStudies(root, opts = {}) {
  const dir = resolve(String(root || ''), RUNS_DIR)
  const injected = isPlainObject(opts.fsImpl) ? opts.fsImpl : (isPlainObject(opts.fs) ? opts.fs : {})
  const readdirImpl = typeof injected.readdir === 'function' ? injected.readdir : readdir
  const readFileImpl = typeof injected.readFile === 'function' ? injected.readFile : readFile
  const statImpl = typeof injected.stat === 'function' ? injected.stat : stat
  let entries
  try {
    entries = await readdirImpl(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const studies = []
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : (entry && typeof entry.name === 'string' ? entry.name : '')
    if (name === '' || name.startsWith('.')) continue
    if (typeof entry !== 'string' && entry && typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue
    const abs = join(dir, name)
    const study = await readStudy(root, abs, name, readFileImpl, statImpl)
    if (study !== null) studies.push(study)
  }
  studies.sort((left, right) => right.mtime - left.mtime)
  return studies
}

/** 读一个 run 目录并压成 Study；不含必要文件则返回 null。 */
async function readStudy(root, abs, id, readFileImpl, statImpl) {
  const problem = await readJsonSafe(join(abs, 'problem.json'), readFileImpl)
  const datasetText = await readTextSafe(join(abs, 'dataset.jsonl'), readFileImpl)
  if (problem === null && datasetText === null) return null
  const config = (await readJsonSafe(join(abs, 'config.json'), readFileImpl)) || {}
  const rounds = (await readJsonSafe(join(abs, 'rounds.json'), readFileImpl)) || null
  const optState = (await readJsonSafe(join(abs, 'opt_state.json'), readFileImpl)) || {}
  const context = isPlainObject(config.context) ? config.context : {}
  const observations = countLines(datasetText)
  const nObservations = observations !== null
    ? observations
    : (numberOrNull(context.n_observations) ?? 0)
  const algorithm = firstString([
    config.algorithm,
    optState.algorithm,
    isPlainObject(problem) ? problem.algorithm : undefined,
  ])
  const budget = numberOrNull(isPlainObject(problem) ? problem.budget : undefined)
    ?? numberOrNull(context.budget_total)
    ?? null
  const objective = describeObjective(isPlainObject(problem) ? problem.objective : undefined)
  const mtime = await maxMtimeOf(abs, STUDY_MTIME_FILES, statImpl)
  return {
    id,
    rel: `${RUNS_DIR}/${id}`,
    abs,
    mtime,
    nObservations,
    algorithm,
    objective,
    budget,
    best: bestOf(rounds, datasetText, isPlainObject(problem) ? problem.objective : undefined),
  }
}

/** 数据集行数（空行不算）；文本为 null 时返回 null（表示没有数据集文件）。 */
function countLines(text) {
  if (typeof text !== 'string') return null
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') count += 1
  }
  return count
}

/** 取第一个非空字符串。 */
function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * 估算 study 最优值。
 *
 * 首选 rounds.json 里最后一个有限的 `best`（CLI 自己算的，多目标也适用）；
 * 没有 rounds.json 时，对单目标数据集按 direction 取极值。
 */
function bestOf(rounds, datasetText, objective) {
  if (Array.isArray(rounds)) {
    for (let index = rounds.length - 1; index >= 0; index -= 1) {
      const row = rounds[index]
      const value = isPlainObject(row) ? numberOrNull(row.best) : null
      if (value !== null) return value
    }
  }
  if (typeof datasetText !== 'string' || !isPlainObject(objective)) return null
  const names = Array.isArray(objective.objectives) ? objective.objectives.map(String) : []
  if (names.length !== 1) return null
  const directions = Array.isArray(objective.directions) ? objective.directions.map(String) : []
  const wantMax = directions[0] !== 'min' && objective.direction !== 'min'
  let best = null
  for (const line of datasetText.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const row = parseJsonLoose(line)
    if (!isPlainObject(row) || !isPlainObject(row.objectives)) continue
    const value = numberOrNull(row.objectives[names[0]])
    if (value === null) continue
    if (best === null || (wantMax ? value > best : value < best)) best = value
  }
  return best
}

/**
 * 同步读文本；失败返回 null。v2.0 的令牌/当前状态读取是「请求内顺手做的小动作」，
 * 用同步读避免为几个小文件引入一串 await（文件都不大，读取成本可忽略）。
 */
function readTextFileSync(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 同步读 JSON；失败/非法返回 null。 */
function readJsonFileSync(path) {
  const text = readTextFileSync(path)
  if (text === null) return null
  const parsed = parseJsonLoose(text)
  return parsed === null ? null : parsed
}

/**
 * run 目录的**状态令牌**（DESIGN §8.6A）。
 *
 * 对 `pending.json` / `dataset.jsonl` / `rounds.json` / `config.json` 的
 * `${mtimeMs}:${size}` 串做 sha1 取前 16 位；缺文件记 `-`。run 目录不存在/不是目录
 * 时返回空串。客户端把令牌随写请求回传（`expect`），面板因此不会把「已经过期的手上
 * 状态」写进 run 目录——这是 ask→tell 闭环里唯一的并发保护。
 *
 * 同步实现（4 次 statSync）是刻意的：契约写成 `stateToken(runDir) -> string`，
 * harness 可以直接比较字符串，handler 也能在 spawn 前后各取一次做回执。
 */
export function stateToken(runDir) {
  const dir = typeof runDir === 'string' ? runDir.trim() : ''
  if (dir === '') return ''
  let info
  try {
    info = statSync(dir)
  } catch {
    return ''
  }
  if (!info.isDirectory()) return ''
  const parts = []
  for (const name of STATE_TOKEN_FILES) {
    try {
      const file = statSync(join(dir, name))
      parts.push(`${file.mtimeMs}:${file.size}`)
    } catch {
      /* 缺失文件按契约记 `-`，这样「某文件被删」同样会改变令牌 */
      parts.push('-')
    }
  }
  return shortHash(parts.join('\n'))
}

/** pending.json 的记录数；文件不存在/不可解析给 null。 */
function pendingCountOf(runDir) {
  const pending = readJsonFileSync(join(runDir, 'pending.json'))
  if (Array.isArray(pending)) return pending.length
  if (isPlainObject(pending) && Array.isArray(pending.pending)) return pending.pending.length
  return pending === null ? null : 0
}

/** dataset.jsonl 的记录数；文件不存在给 null。 */
function datasetRowsOf(runDir) {
  const text = readTextFileSync(join(runDir, 'dataset.jsonl'))
  return text === null ? null : countLines(text)
}

/**
 * 解析 resultsText（DESIGN §8.6B）：JSON 数组 / JSONL / 带 `id` 列的 CSV（含 TSV）。
 *
 * 「宽松但必须至少 1 条记录」：先试整体 JSON 数组，再试逐行 JSON，最后试
 * 分隔符表头（含 id 列）。任一成功即返回 `{format, ext, rows}`；全部失败或
 * 长度/行数越界抛 `CondoptError{code:'bad-param'}`（HTTP 400）。
 * `format`/`ext` 决定临时文件后缀；宿主始终把**原文**写盘，不做重排以免丢字段。
 */
export function parseResultsText(text) {
  if (typeof text !== 'string') {
    throw new CondoptError('resultsText 必须是字符串内容（不是路径）', 'bad-param', 400)
  }
  if (text.length < 1 || text.trim() === '') {
    throw new CondoptError('resultsText 不能为空', 'bad-param', 400)
  }
  if (text.length > MAX_RESULTS_TEXT_CHARS) {
    throw new CondoptError(`resultsText 超过 ${MAX_RESULTS_TEXT_CHARS} 字符`, 'bad-param', 400)
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length > MAX_RESULTS_LINES) {
    throw new CondoptError(`resultsText 超过 ${MAX_RESULTS_LINES} 行`, 'bad-param', 400)
  }

  /* ① 整体 JSON 数组 */
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    const parsed = tryParseJson(trimmed)
    if (parsed.ok && Array.isArray(parsed.value) && parsed.value.length >= 1) {
      return { format: 'json', ext: 'json', rows: parsed.value.length }
    }
  }
  /* ② JSONL：每个非空行都是一个 JSON 对象 */
  let jsonlRows = 0
  let jsonlOk = lines.length >= 1
  for (const line of lines) {
    const parsed = tryParseJson(line.trim())
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      jsonlOk = false
      break
    }
    jsonlRows += 1
  }
  if (jsonlOk && jsonlRows >= 1) return { format: 'jsonl', ext: 'jsonl', rows: jsonlRows }
  /* ③ CSV / TSV：首行表头含 id 列，且至少 1 条数据行 */
  const header = lines.length >= 1 ? lines[0] : ''
  for (const delimiter of ['\t', ',', ';']) {
    if (!header.includes(delimiter)) continue
    const columns = header.split(delimiter).map((name) => name.trim().replace(/^"|"$/g, '').toLowerCase())
    if (!columns.includes('id')) continue
    const rows = Math.max(0, lines.length - 1)
    if (rows >= 1) return { format: 'csv', ext: 'csv', rows }
  }
  throw new CondoptError(
    'resultsText 无法解析为 JSON 数组 / JSONL / 带 id 列的 CSV（至少需要 1 条记录）',
    'bad-param',
    400,
  )
}

/**
 * `GET /api/study` 的 `current`（DESIGN §8.6A）：从 run 目录的文件读出「当前生效状态」，
 * 供面板展示「当前 study」块。**读不到一律给 null，绝不伪造**。
 */
export function readCurrent(runDir) {
  const dir = typeof runDir === 'string' ? runDir : ''
  const problem = readJsonFileSync(join(dir, 'problem.json'))
  const config = readJsonFileSync(join(dir, 'config.json'))
  const context = isPlainObject(config) && isPlainObject(config.context) ? config.context : {}
  const objectiveNode = isPlainObject(problem) ? problem.objective : undefined
  const described = describeObjective(objectiveNode)
  const directions = isPlainObject(objectiveNode) && Array.isArray(objectiveNode.directions)
    ? objectiveNode.directions.map(String)
    : []
  const direction = (isPlainObject(objectiveNode) && typeof objectiveNode.direction === 'string' && objectiveNode.direction !== '')
    ? objectiveNode.direction
    : (directions.length > 0 ? directions[0] : null)
  const budget = numberOrNull(isPlainObject(problem) ? problem.budget : undefined)
    ?? numberOrNull(context.budget_total)
    ?? null
  const batch = numberOrNull(isPlainObject(config) ? config.batch_size : undefined)
    ?? numberOrNull(context.batch_size)
    ?? null
  const nObservations = datasetRowsOf(dir)
  const pendingCount = pendingCountOf(dir)
  return {
    algorithm: isPlainObject(config) && typeof config.algorithm === 'string' && config.algorithm !== '' ? config.algorithm : null,
    params: isPlainObject(config) && isPlainObject(config.params) ? config.params : null,
    objective: described === '' ? null : described,
    direction,
    budget,
    batch,
    nObservations,
    pendingCount,
    remaining: budget !== null && nObservations !== null ? Math.max(0, budget - nObservations) : null,
  }
}

/** tell 临时文件目录：`<tmpBase>/dsh-condopt-tell/<sha1(runAbs)[0:16]>/`。 */
function tellTempDir(runAbs, tmpBase) {
  const base = typeof tmpBase === 'string' && tmpBase !== '' ? tmpBase : tmpdir()
  return join(base, TELL_TMP_DIR, shortHash(resolve(String(runAbs))))
}


/**
 * 切分 condopt 渲染出的 dashboard.html（DESIGN §4.4）。
 *
 * - `css`：所有 `<style ...>…</style>` 的内容，按出现顺序用换行拼接；
 * - `html`：`<body ...>` 与 `</body>` 之间；无 body 时取 `</head>` 之后全文，
 *   连 `</head>` 都没有时取全文。
 *
 * 纯字符串函数，harness 可以直接喂 fixture。
 */
export function splitDashboardHtml(text) {
  const source = typeof text === 'string' ? text : ''
  const cssParts = []
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  let match
  while ((match = styleRe.exec(source)) !== null) {
    const body = match[1]
    if (body !== undefined && body.trim() !== '') cssParts.push(body.trim())
  }
  const css = cssParts.join('\n')

  let html = ''
  const bodyOpen = /<body\b[^>]*>/i.exec(source)
  if (bodyOpen !== null && bodyOpen.index !== undefined) {
    const start = bodyOpen.index + bodyOpen[0].length
    const closeIndex = source.toLowerCase().indexOf('</body>', start)
    html = closeIndex === -1 ? source.slice(start) : source.slice(start, closeIndex)
  } else {
    const headClose = /<\/head\s*>/i.exec(source)
    html = headClose !== null && headClose.index !== undefined
      ? source.slice(headClose.index + headClose[0].length)
      : source
  }
  return { css, html: html.trim() }
}

/** 视图缓存目录（DESIGN §4.1）：`<tmpBase>/dsh-condopt-view/<sha1(runAbs)[0:16]>/`。 */
export function viewCacheDir(runAbs, tmpBase) {
  return join(typeof tmpBase === 'string' && tmpBase !== '' ? tmpBase : tmpdir(), VIEW_CACHE_DIR, shortHash(resolve(String(runAbs))))
}

/**
 * 保证某个输出文件的父目录存在。
 *
 * CLI 侧一律用 `path.open('w')` 直接写文件、不自建父目录（实测
 * `pareto --out <不存在的目录>/x.csv` 直接 FileNotFoundError），所以凡是把
 * `--out` 指到 `<tmp>/dsh-condopt-view/<hash>/` 的地方都得先建目录。
 */
async function ensureParentDir(filePath, mkdirImpl = mkdir) {
  try {
    await mkdirImpl(dirname(filePath), { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * 渲染并切分 study 视图（DESIGN §4）。
 *
 * 流程：缓存失效判定（关键输入最大 mtime 对比 meta.json）→ 必要时跑
 * `render --run <rel-run> --out <cacheDir> --no-png --json`（**不写 run 目录**）
 * → 读 dashboard.html → 切分。渲染失败一律上抛，绝不回退成自造 HTML。
 *
 * @param {string} root condopt 根目录
 * @param {string} runDir run 目录（绝对或相对 root）
 * @param {object} [opts] `{force, relRun, tmpDir, spawnImpl, fsImpl, python, env, config, now, timeoutMs}`
 * @returns {Promise<{run: string, rel: string, abs: string, generatedAt: string, cached: boolean, bytes: number, css: string, html: string, warnings: string[]}>}
 */
export async function renderView(root, runDir, opts = {}) {
  const rootAbs = resolve(String(root || ''))
  const runAbs = isAbsolute(String(runDir)) ? resolve(String(runDir)) : resolve(rootAbs, String(runDir))
  const relRun = typeof opts.relRun === 'string' && opts.relRun !== '' ? opts.relRun : relToRoot(rootAbs, runAbs)
  const tmpBase = typeof opts.tmpDir === 'string' && opts.tmpDir !== '' ? opts.tmpDir : tmpdir()
  const cacheDir = viewCacheDir(runAbs, tmpBase)
  const dashboardPath = join(cacheDir, 'dashboard.html')
  const metaPath = join(cacheDir, 'meta.json')
  const injected = isPlainObject(opts.fsImpl) ? opts.fsImpl : (isPlainObject(opts.fs) ? opts.fs : {})
  const readFileImpl = typeof injected.readFile === 'function' ? injected.readFile : readFile
  const statImpl = typeof injected.stat === 'function' ? injected.stat : stat
  const mkdirImpl = typeof injected.mkdir === 'function' ? injected.mkdir : mkdir
  const writeFileImpl = typeof injected.writeFile === 'function' ? injected.writeFile : writeFile
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const force = opts.force === true || opts.force === 1 || opts.force === '1'
  const newestInput = await maxMtimeOf(runAbs, VIEW_INPUT_FILES, statImpl)

  if (!force) {
    const meta = await readJsonSafe(metaPath, readFileImpl)
    if (meta !== null && meta.run === runAbs && numberOrNull(meta.mtime) !== null && Number(meta.mtime) >= newestInput) {
      const cachedText = await readTextSafe(dashboardPath, readFileImpl)
      if (cachedText !== null && cachedText !== '') {
        const split = splitDashboardHtml(cachedText)
        if (split.css !== '' || split.html !== '') {
          return {
            run: relRun,
            rel: relRun,
            abs: runAbs,
            generatedAt: typeof meta.generatedAt === 'string' ? meta.generatedAt : new Date(now()).toISOString(),
            cached: true,
            bytes: Buffer.byteLength(cachedText, 'utf8'),
            css: split.css,
            html: split.html,
            warnings: Array.isArray(meta.warnings) ? meta.warnings.map(String) : [],
          }
        }
      }
    }
  }

  try {
    await mkdirImpl(cacheDir, { recursive: true })
  } catch (error) {
    throw new CondoptError(`无法创建渲染缓存目录：${errorText(error)}`, 'render-failed', 502)
  }

  const argv = ['render', '--run', relRun, '--out', cacheDir, '--no-png', '--json']
  const outcome = await runCli(argv, {
    root: rootAbs,
    python: opts.python,
    config: opts.config,
    env: opts.env,
    spawnImpl: opts.spawnImpl,
    timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : RENDER_TIMEOUT_MS,
  })
  if (outcome.timedOut) {
    throw new CondoptError('渲染超时（render 超过 120s）', 'timeout', 504, { stdout: outcome.stdout, stderr: outcome.stderr })
  }
  if (!outcome.ok) {
    throw new CondoptError(
      `渲染失败（退出码 ${outcome.code === null ? '?' : outcome.code}）：${firstLine(outcome.stderr) || firstLine(outcome.stdout) || outcome.error || ''}`,
      'render-failed',
      502,
      { stdout: outcome.stdout, stderr: outcome.stderr },
    )
  }
  const data = parseJsonLoose(outcome.stdout, outcome.stderr)
  const warnings = isPlainObject(data) && Array.isArray(data.warnings) ? data.warnings.map(String) : []
  const target = isPlainObject(data) && typeof data.dashboard === 'string' && data.dashboard !== ''
    ? data.dashboard
    : dashboardPath
  const text = await readTextSafe(target, readFileImpl)
  if (text === null || text === '') {
    throw new CondoptError(`渲染器没有产出 dashboard.html（期望 ${target}）`, 'view-empty', 500, { stdout: outcome.stdout, stderr: outcome.stderr })
  }
  const split = splitDashboardHtml(text)
  if (split.css === '' && split.html === '') {
    throw new CondoptError('dashboard.html 里没有可用的 css/html', 'view-empty', 500, { stdout: outcome.stdout, stderr: outcome.stderr })
  }
  const generatedAt = new Date(now()).toISOString()
  const bytes = Buffer.byteLength(text, 'utf8')
  try {
    await writeFileImpl(metaPath, JSON.stringify({ run: runAbs, mtime: newestInput, generatedAt, bytes, warnings }), 'utf8')
  } catch {
    /* 缓存元数据写不进去不影响本次结果，只影响下次是否重渲 */
  }
  return {
    run: relRun,
    rel: relRun,
    abs: runAbs,
    generatedAt,
    cached: false,
    bytes,
    css: split.css,
    html: split.html,
    warnings,
  }
}

/** 取一段文本的第一行（用于错误摘要，避免把 traceback 全塞进 HTTP 错误体）。 */
function firstLine(text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  const line = text.trim().split(/\r?\n/)[0]
  return line.length > 500 ? `${line.slice(0, 500)}…` : line
}

/* ------------------------------------------------------------------ *
 * exec 白名单（DESIGN §5 v1.2）
 * ------------------------------------------------------------------ */

/** 取 argv 里的 run 值：ctx.run 原样（不在这里 resolve，路径安全由路由层负责）。 */
function runOf(ctx) {
  const run = isPlainObject(ctx) && typeof ctx.run === 'string' ? ctx.run.trim() : ''
  if (run === '') throw new CondoptError('缺少 run 参数', 'bad-param', 400)
  return run
}

/** render 需要 --out：默认零写入要求它指向 os.tmpdir() 下的缓存目录。 */
function cacheDirOf(ctx) {
  const dir = isPlainObject(ctx) && typeof ctx.cacheDir === 'string' ? ctx.cacheDir.trim() : ''
  if (dir === '') {
    throw new CondoptError('render 需要 ctx.cacheDir（默认零写入：指向 os.tmpdir()）', 'bad-param', 400)
  }
  return dir
}

/**
 * 需要 `--out` 的命令（pareto/export/digest）统一写 `<tmpdir>/<文件名>`。
 *
 * DESIGN §5 的零写入不变量：这些命令默认会写进 run 目录，argv 必须显式改道。
 * 用 `<tmpdir>` 直接落文件而不是子目录，是因为 CLI 不会自建父目录。
 */
function tmpOut(ctx, name) {
  const base = isPlainObject(ctx) && typeof ctx.tmpDir === 'string' && ctx.tmpDir.trim() !== ''
    ? ctx.tmpDir.trim()
    : tmpdir()
  return join(base, name)
}

/**
 * exec 白名单表：command → {json, needsRun, params, argv}。
 *
 * 表即契约（DESIGN §5 v1.2，已按 `src/condopt/cli.py` 实测口径修正）。
 * **不接受调用方直接传 argv**：只查表 + 校验参数后拼数组。
 */
export const EXEC_COMMANDS = {
  route: {
    json: true,
    /* route 是「按问题上下文推荐算法」，不针对某个 run。 */
    needsRun: false,
    params: {
      space: { type: 'path' },
      budget: { type: 'number', max: MAX_DECIMAL },
      batch: { type: 'number', max: MAX_DECIMAL },
      smoothness: { type: 'enum', choices: ['smooth', 'mixed', 'rough'] },
      noise: { type: 'enum', choices: ['none', 'low', 'medium', 'high'] },
      domain: { type: 'enum', choices: ['chemistry', 'materials', 'process', 'generic'] },
    },
    argv(params) {
      const argv = ['route']
      if (params.space !== undefined) argv.push('--space', params.space)
      if (params.budget !== undefined) argv.push('--budget', String(params.budget))
      if (params.batch !== undefined) argv.push('--batch', String(params.batch))
      if (params.smoothness !== undefined) argv.push('--smoothness', params.smoothness)
      if (params.noise !== undefined) argv.push('--noise', params.noise)
      if (params.domain !== undefined) argv.push('--domain', params.domain)
      argv.push('--json')
      return argv
    },
  },
  init: {
    json: true,
    params: {
      space: { type: 'path', required: true },
      objective: { type: 'text', required: true },
      budget: { type: 'number', required: true, max: MAX_DECIMAL },
      batch: { type: 'number', required: true, max: MAX_DECIMAL },
      algorithm: { type: 'text' },
      params: { type: 'json' },
    },
    argv(params, ctx) {
      const argv = [
        'init', '--run', runOf(ctx),
        '--space', params.space,
        '--objective', params.objective,
        '--budget', String(params.budget),
        '--batch', String(params.batch),
      ]
      if (params.algorithm !== undefined) argv.push('--algorithm', params.algorithm)
      if (params.params !== undefined) argv.push('--params', params.params)
      argv.push('--json')
      return argv
    },
  },
  ask: {
    json: true,
    params: {
      n: { type: 'number', max: MAX_DECIMAL },
      plate: { type: 'text' },
    },
    argv(params, ctx) {
      const argv = ['ask', '--run', runOf(ctx)]
      if (params.n !== undefined) argv.push('--n', String(params.n))
      if (params.plate !== undefined) argv.push('--plate', params.plate)
      argv.push('--json')
      return argv
    },
  },
  tell: {
    json: true,
    params: {
      /* v2.0：`results`（root 内文件路径）与 `resultsText`（内容）二选一。 */
      results: { type: 'path' },
      resultsText: { type: 'content' },
      /* 可选审计理由（≤200，通用字符串正则已限长）；CLI 没有对应 flag，仅校验。 */
      reason: { type: 'text' },
    },
    argv(params, ctx) {
      let resultsPath = params.results !== undefined ? params.results : ''
      /* resultsText 由宿主写进 tmpdir 再把路径交进来（DESIGN §8.6B）。 */
      if (resultsPath === '' && isPlainObject(ctx) && typeof ctx.resultsPath === 'string') {
        resultsPath = ctx.resultsPath
      }
      if (resultsPath === '') {
        throw new CondoptError('tell 需要 params.results（root 内文件）或 params.resultsText（内容）', 'bad-param', 400)
      }
      return ['tell', '--run', runOf(ctx), '--results', resultsPath, '--json']
    },
    /* 两者语义重叠（一个是路径、一个是内容），同时给会让「用了哪份数据」不可判定。 */
    check(params) {
      if (params.results !== undefined && params.resultsText !== undefined) {
        throw new CondoptError('tell 只能给 results 或 resultsText 之一', 'bad-param', 400)
      }
    },
  },
  confirm: {
    json: true,
    params: {
      n: { type: 'number', max: MAX_DECIMAL },
    },
    argv(params, ctx) {
      const argv = ['confirm', '--run', runOf(ctx)]
      if (params.n !== undefined) argv.push('--n', String(params.n))
      argv.push('--json')
      return argv
    },
  },
  override: {
    json: true,
    params: {
      algorithm: { type: 'text' },
      /* v1.2：可选算法参数表（JSON 对象 → 紧凑重排后作为 --params）。 */
      params: { type: 'json' },
      reason: { type: 'text', required: true },
    },
    argv(params, ctx) {
      const argv = ['override', '--run', runOf(ctx), '--algorithm', params.algorithm]
      if (params.params !== undefined) argv.push('--params', params.params)
      argv.push('--reason', params.reason, '--json')
      return argv
    },
  },
  auto: {
    json: true,
    params: {},
    argv(_params, ctx) {
      return ['auto', '--run', runOf(ctx), '--json']
    },
  },
  step: {
    json: true,
    params: {},
    argv(_params, ctx) {
      return ['step', '--run', runOf(ctx), '--json']
    },
  },
  recommend: {
    json: true,
    params: {},
    argv(_params, ctx) {
      return ['recommend', '--run', runOf(ctx), '--json']
    },
  },
  predict: {
    json: true,
    params: {
      config: { type: 'json', required: true },
    },
    argv(params, ctx) {
      return ['predict', '--run', runOf(ctx), '--config', params.config, '--json']
    },
  },
  'knee-weights': {
    json: true,
    params: {
      weights: { type: 'text', required: true, pattern: WEIGHTS_RE },
    },
    argv(params, ctx) {
      return ['knee-weights', '--run', runOf(ctx), '--weights', params.weights, '--json']
    },
  },
  digest: {
    json: true,
    params: {
      format: { type: 'enum', choices: ['md', 'html'] },
    },
    argv(params, ctx) {
      /* format 缺省时按 CLI 默认 md 落盘，保证 `--out` 的扩展名与实际格式一致。 */
      const format = params.format === undefined ? 'md' : params.format
      return [
        'digest', '--run', runOf(ctx),
        '--out', tmpOut(ctx, `digest.${format}`),
        '--format', format,
        '--json',
      ]
    },
  },
  export: {
    json: true,
    params: {},
    argv(_params, ctx) {
      return ['export', '--run', runOf(ctx), '--out', tmpOut(ctx, 'dataset_export.csv'), '--json']
    },
  },
  pareto: {
    json: true,
    params: {},
    argv(_params, ctx) {
      return ['pareto', '--run', runOf(ctx), '--out', tmpOut(ctx, 'pareto_front.csv'), '--json']
    },
  },
  doctor: {
    json: true,
    params: {},
    argv(_params, ctx) {
      return ['doctor', '--run', runOf(ctx), '--json']
    },
  },
  decisions: {
    json: true,
    params: {
      limit: { type: 'number', max: MAX_DECIMAL },
      action: { type: 'text' },
    },
    argv(params, ctx) {
      const argv = ['decisions', '--run', runOf(ctx)]
      if (params.limit !== undefined) argv.push('--limit', String(params.limit))
      if (params.action !== undefined) argv.push('--action', params.action)
      argv.push('--json')
      return argv
    },
  },
  render: {
    json: true,
    params: {},
    argv(_params, ctx) {
      return ['render', '--run', runOf(ctx), '--out', cacheDirOf(ctx), '--no-png', '--json']
    },
  },
}

/**
 * 校验并规范化 exec 参数（DESIGN §5）。
 *
 * 规则：数字必须有限且是整数（≤ 100000）；枚举查 choices；普通字符串走通用正则
 * （或参数自带的 pattern）；JSON 类参数（`config`/`params`）先 `JSON.parse` 再
 * 紧凑重排——从而保证 argv 里绝不出现换行与多余空格；路径类参数必须落在
 * `<root>` 内（只有 ctx.root 已知时才强制——纯函数单测常常只给 run，此时不做
 * 无意义的拒绝）；表里没写的参数名一律拒绝，防止调用方绕过白名单。
 */
export function validateExecParams(command, params = {}, ctx = {}) {
  const spec = EXEC_COMMANDS[command]
  const defs = spec.params || {}
  const input = isPlainObject(params) ? params : {}
  const out = {}
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(defs, key)) {
      throw new CondoptError(`命令 ${command} 不接受参数 ${key}`, 'bad-param', 400)
    }
  }
  for (const [name, def] of Object.entries(defs)) {
    const raw = input[name]
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (def.required === true) {
        throw new CondoptError(`命令 ${command} 缺少必填参数 ${name}`, 'bad-param', 400)
      }
      continue
    }
    if (def.type === 'number') {
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        throw new CondoptError(`参数 ${name} 必须是整数（收到 ${JSON.stringify(raw)}）`, 'bad-param', 400)
      }
      /* 计数类参数（n/batch/budget/limit/…）下界是 1：`ask --n -1` 这类值只会让
         CLI 报错或语义走样，必须在入口就拒绝（DESIGN v1.4）。 */
      if (COUNT_PARAMS.has(name) && num < 1) {
        throw new CondoptError(`参数 ${name} 必须 ≥ 1（收到 ${num}）`, 'bad-param', 400)
      }
      if (name === 'limit' && num > MAX_LIMIT) {
        throw new CondoptError(`参数 limit 超过上限 ${MAX_LIMIT}`, 'bad-param', 400)
      }
      if (def.max !== undefined && Math.abs(num) > def.max) {
        throw new CondoptError(`参数 ${name} 超过上限 ${def.max}`, 'bad-param', 400)
      }
      out[name] = num
      continue
    }
    if (def.type === 'enum') {
      const text = String(raw).trim()
      if (!Array.isArray(def.choices) || !def.choices.includes(text)) {
        throw new CondoptError(`参数 ${name} 只能是 ${(def.choices || []).join(' / ')}`, 'bad-param', 400)
      }
      out[name] = text
      continue
    }
    if (def.type === 'json') {
      out[name] = compactJson(raw, name)
      continue
    }
    if (def.type === 'content') {
      /* 内容型参数（v2.0 的 `resultsText`）：校验交给解析器，绝不进 argv。 */
      out[name] = typeof raw === 'string' ? raw : String(raw)
      if (name === 'resultsText') parseResultsText(out[name])
      continue
    }
    const text = String(raw).trim()
    const pattern = def.pattern instanceof RegExp ? def.pattern : STRING_RE
    if (!pattern.test(text)) {
      throw new CondoptError(`参数 ${name} 含非法字符或过长（≤200 字）`, 'bad-param', 400)
    }
    if (def.type === 'path') assertInsideRoot(text, ctx, name)
    out[name] = text
  }
  return out
}

/**
 * JSON 类参数：接受对象或 JSON 字符串，解析后紧凑重排（无空格无换行）。
 * 只接受 JSON 对象——`config`/`params` 在 CLI 里都是「参数表」语义。
 */
function compactJson(raw, name) {
  let parsed = raw
  if (typeof raw === 'string') {
    parsed = tryParseJson(raw.trim()).value
  }
  if (!isPlainObject(parsed)) {
    throw new CondoptError(`参数 ${name} 必须是 JSON 对象`, 'bad-param', 400)
  }
  try {
    const text = JSON.stringify(parsed)
    if (typeof text !== 'string' || text === '' || /[\r\n]/.test(text)) throw new Error('无法序列化')
    return text
  } catch (error) {
    throw new CondoptError(`参数 ${name} 无法序列化：${errorText(error)}`, 'bad-param', 400)
  }
}

/** 路径类参数必须落在 ctx.root 内（ctx.root 缺失时跳过，交由调用方保证）。 */
function assertInsideRoot(value, ctx, name) {
  const root = isPlainObject(ctx) && typeof ctx.root === 'string' && ctx.root.trim() !== ''
    ? resolve(ctx.root.trim())
    : ''
  if (root === '') return
  const abs = isAbsolute(value) ? resolve(value) : resolve(root, value)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new CondoptError(`参数 ${name} 越出 condopt 根目录：${value}`, 'bad-param', 400)
  }
}

/**
 * 由命令名 + 参数生成 argv 数组（DESIGN §5）。
 *
 * - 未列入白名单的命令 → throw `{code:'command-not-allowed'}`（HTTP 403）；
 * - 参数校验失败 → throw `{code:'bad-param'}`（HTTP 400）；
 * - 返回值是裸数组，逐项精确，供 harness `deepStrictEqual`；
 * - `ctx = {run, cacheDir?, root?, tmpDir?}`，argv 里 `--run` 用 `ctx.run` 原样。
 */
export function buildExecArgv(command, params = {}, ctx = {}) {
  const name = typeof command === 'string' ? command.trim() : ''
  const spec = EXEC_COMMANDS[name]
  if (spec === undefined) {
    throw new CondoptError(
      `命令不在白名单：${name || '(空)'}（可用：${Object.keys(EXEC_COMMANDS).join(', ')}）`,
      'command-not-allowed',
      403,
    )
  }
  const clean = validateExecParams(name, params, ctx)
  if (typeof spec.check === 'function') spec.check(clean)
  const argv = spec.argv(clean, isPlainObject(ctx) ? ctx : {})
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new CondoptError(`命令 ${name} 的 argv 生成失败`, 'bad-param', 400)
  }
  for (const item of argv) {
    if (typeof item !== 'string' || item === '') {
      throw new CondoptError(`命令 ${name} 的 argv 出现空项`, 'bad-param', 400)
    }
  }
  return argv
}

/* ------------------------------------------------------------------ *
 * HTTP 层
 * ------------------------------------------------------------------ */

/** 统一的 JSON 响应：不依赖 writeHead，兼容真 res 与 harness 的假 res。 */
function sendJson(res, status, payload) {
  const raw = JSON.stringify(payload)
  if (res === null || typeof res !== 'object') return
  try {
    res.statusCode = status
  } catch {
    /* 假 res 可能不允许写 statusCode，忽略 */
  }
  if (typeof res.setHeader === 'function') {
    try {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
    } catch {
      /* 同上 */
    }
  }
  if (typeof res.end === 'function') res.end(raw)
}

/** 把任意异常映射成 HTTP 响应：CondoptError 用自己的 code/status，其余 500。 */
function sendError(res, error) {
  if (error instanceof CondoptError) {
    const payload = { error: error.message, code: error.code }
    if (typeof error.stdout === 'string' && error.stdout !== '') payload.stdout = error.stdout
    if (typeof error.stderr === 'string' && error.stderr !== '') payload.stderr = error.stderr
    sendJson(res, error.status, payload)
    return
  }
  sendJson(res, 500, { error: errorText(error), code: 'internal' })
}

/** 读请求体：优先 `req.body`（harness 常用），否则按流读；非 JSON 对象返回 null。 */
function readJsonBody(req) {
  if (req !== null && typeof req === 'object' && isPlainObject(req.body)) return Promise.resolve(req.body)
  return new Promise((resolvePromise) => {
    if (req === null || typeof req !== 'object' || typeof req.on !== 'function') {
      resolvePromise({})
      return
    }
    let text = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolvePromise(value)
    }
    req.on('data', (chunk) => {
      text += chunkToString(chunk)
      if (text.length > 4_000_000) finish(null)
    })
    req.on('error', () => finish(null))
    req.on('end', () => {
      if (text.trim() === '') {
        finish({})
        return
      }
      const parsed = parseJsonLoose(text)
      finish(isPlainObject(parsed) ? parsed : null)
    })
  })
}

/** 从 pyproject.toml 读 `version = "..."`；读不到给空串（DESIGN §3）。 */
async function readVersion(root, readFileImpl) {
  const text = await readTextSafe(join(root, 'pyproject.toml'), readFileImpl)
  if (text === null) return ''
  const match = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(text)
  return match === null ? '' : match[1]
}

/**
 * 汇总 tell 的输入来源（DESIGN §8.6B）。
 *
 * - `resultsText`（内容）：解析形态 → 写 `<tmpdir>/dsh-condopt-tell/<hash>/results-<ts>.<ext>`
 *   → 把临时路径交回调用方（spawn 后由调用方删除）。宿主只把文本当内容，**从不**
 *   把用户给的字符串当路径拼接；
 * - `results`（root 内文件）：不落盘，仅尽力读一份用于回执的 `rows/format`（读不到给 null）。
 */
async function prepareTellResults(params, runAbs, rootAbs, tmpBase, io) {
  if (typeof params.resultsText === 'string') {
    const parsed = parseResultsText(params.resultsText)
    const dir = tellTempDir(runAbs, tmpBase)
    await io.mkdirImpl(dir, { recursive: true })
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const tempPath = join(dir, `results-${stamp}.${parsed.ext}`)
    await io.writeFileImpl(tempPath, params.resultsText, 'utf8')
    return { rows: parsed.rows, format: parsed.format, tempPath }
  }
  if (typeof params.results === 'string' && params.results.trim() !== '') {
    const abs = isAbsolute(params.results) ? resolve(params.results) : resolve(String(rootAbs || ''), params.results)
    const text = readTextFileSync(abs)
    if (text === null) return { rows: null, format: null, resultsPath: params.results }
    const parsed = safeCall(() => parseResultsText(text), null)
    return {
      rows: parsed === null ? null : parsed.rows,
      format: parsed === null ? null : parsed.format,
      resultsPath: params.results,
    }
  }
  return { rows: null, format: null }
}

/** 计算 `acceptedRows`：`datasetAfter - datasetBefore`（≥0，且 ≤ resultsRows）。 */
function acceptedRowsOf(datasetBefore, datasetAfter, resultsRows) {
  if (datasetBefore === null || datasetAfter === null) return null
  let accepted = Math.max(0, datasetAfter - datasetBefore)
  if (resultsRows !== null) accepted = Math.min(accepted, Math.max(0, resultsRows))
  return accepted
}

/** 组装 tell 的执行回执（DESIGN §8.6B）；所有前后计数都在调用前后由宿主实读。 */
function buildTellReceipt({ run, runAbs, resultsMeta, countsBefore, tokenBefore }) {
  const datasetAfter = datasetRowsOf(runAbs)
  const pendingAfter = pendingCountOf(runAbs)
  return {
    run,
    resultsRows: resultsMeta.rows,
    format: resultsMeta.format,
    pendingBefore: countsBefore.pending,
    pendingAfter,
    datasetBefore: countsBefore.dataset,
    datasetAfter,
    acceptedRows: acceptedRowsOf(countsBefore.dataset, datasetAfter, resultsMeta.rows),
    stateTokenBefore: tokenBefore,
    stateTokenAfter: stateToken(runAbs),
  }
}

/**
 * 构造 HTTP handler。deps 全部可注入，便于 harness 用假 req/res + 假 spawn 测路由：
 * `{config, env, cwd, spawnImpl, fsImpl, tmpDir, now, python, selfDir, workspaces, sessionCwdOf}`。
 */
export function createHandler(deps = {}) {
  const config = isPlainObject(deps.config) ? deps.config : {}
  const env = isPlainObject(deps.env) ? deps.env : process.env
  const cwd = typeof deps.cwd === 'string' ? deps.cwd : undefined
  const spawnImpl = typeof deps.spawnImpl === 'function' ? deps.spawnImpl : spawn
  const injectedFs = isPlainObject(deps.fsImpl) ? deps.fsImpl : {}
  const readFileImpl = typeof injectedFs.readFile === 'function' ? injectedFs.readFile : readFile
  const mkdirImpl = typeof injectedFs.mkdir === 'function' ? injectedFs.mkdir : mkdir
  const writeFileImpl = typeof injectedFs.writeFile === 'function' ? injectedFs.writeFile : writeFile
  const unlinkImpl = typeof injectedFs.unlink === 'function' ? injectedFs.unlink : unlink
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const tmpBase = typeof deps.tmpDir === 'string' && deps.tmpDir !== '' ? deps.tmpDir : tmpdir()
  const allowExec = config.allowExec !== false
  const selfDir = typeof deps.selfDir === 'string' && deps.selfDir !== '' ? deps.selfDir : PLUGIN_DIR
  const workspaces = deps.workspaces
  const sessionCwdOf = typeof deps.sessionCwdOf === 'function' ? deps.sessionCwdOf : null

  /** 每次请求按 DESIGN §2 顺序解析根目录；带了 sessionId 就能用上会话工作目录。 */
  const resolveRootHere = (hint, sessionId) => resolveRoot({
    root: hint,
    config,
    cwd,
    env,
    selfDir,
    workspaces,
    sessionCwd: sessionCwdOf !== null && typeof sessionId === 'string' && sessionId !== ''
      ? safeCall(() => sessionCwdOf(sessionId), undefined)
      : undefined,
  })
  /* rootRef 只在单次请求内使用：先解析 root，再让 callCli 拿到它。 */
  const rootRef = { root: '' }
  const callCli = (argv, timeoutMs) => runCli(argv, {
    root: rootRef.root,
    python: deps.python,
    config,
    env,
    spawnImpl,
    timeoutMs,
  })

  /** GET /api/study 的四个（可选五个）子调用：任一失败记 warning，整体仍 200。 */
  async function gatherStudy(relRun, runAbs, wantStep) {
    const warnings = []
    const result = { run: relRun, report: null, decisions: null, pareto: null, pending: null, step: null, warnings }
    const paretoOut = join(viewCacheDir(runAbs, tmpBase), 'pareto_front.csv')
    const jobs = [
      ['report', ['report', '--run', relRun, '--json']],
      ['decisions', ['decisions', '--run', relRun, '--limit', '20', '--json']],
      ['pending', ['pending', '--run', relRun, '--json']],
      /* pareto 默认会把 CSV 写进 run 目录，与 DESIGN §5「零写入不变量」冲突；
         这里显式 --out 到 tmp 缓存目录。 */
      ['pareto', ['pareto', '--run', relRun, '--out', paretoOut, '--json']],
    ]
    if (wantStep) jobs.push(['step', ['step', '--run', relRun, '--json']])
    await ensureParentDir(paretoOut, mkdirImpl)
    for (const [field, argv] of jobs) {
      const outcome = await callCli(argv, DEFAULT_TIMEOUT_MS)
      if (outcome.timedOut) {
        warnings.push(`${field}: 超时`)
        continue
      }
      if (!outcome.ok) {
        warnings.push(`${field}: ${firstLine(outcome.stderr) || firstLine(outcome.stdout) || outcome.error || '调用失败'}`)
        continue
      }
      const data = parseJsonLoose(outcome.stdout, outcome.stderr)
      if (data === null) {
        warnings.push(`${field}: 输出不是 JSON`)
        continue
      }
      result[field] = data
    }
    return result
  }

  return async function condoptHandler(req, res) {
    let url
    try {
      url = new URL(req !== null && typeof req === 'object' && typeof req.url === 'string' ? req.url : ROUTE_PREFIX, 'http://127.0.0.1')
    } catch {
      url = new URL(ROUTE_PREFIX, 'http://127.0.0.1')
    }
    const method = String(req !== null && typeof req === 'object' && req.method ? req.method : 'GET').toUpperCase()
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        sendJson(res, 405, { error: '只支持 GET/POST', code: 'method-not-allowed' })
        return
      }
      if (!pathname.startsWith(API_PREFIX)) {
        sendJson(res, 404, { error: '没有这个地址', code: 'not-found' })
        return
      }
      const route = pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
      if (method === 'POST') {
        if (route !== '/exec') {
          sendJson(res, 404, { error: '没有这个地址', code: 'not-found' })
          return
        }
        const payload = await readJsonBody(req)
        if (payload === null) {
          sendJson(res, 400, { error: '请求体必须是 JSON 对象', code: 'bad-json' })
          return
        }
        const resolved = resolveRootHere(payload.root)
        if (resolved.root === null) {
          sendJson(res, 409, { error: resolved.error, code: resolved.code })
          return
        }
        if (!allowExec) {
          sendJson(res, 403, { error: '插件配置 allowExec=false，已禁用写操作', code: 'exec-disabled' })
          return
        }
        rootRef.root = resolved.root
        const command = typeof payload.command === 'string' ? payload.command.trim() : ''
        const spec = EXEC_COMMANDS[command]
        /* 先判白名单再解析 run：未知命令必须是 403，而不是被 run 校验抢成 400。 */
        if (spec === undefined) {
          sendJson(res, 403, {
            error: `命令不在白名单：${command || '(空)'}（可用：${Object.keys(EXEC_COMMANDS).join(', ')}）`,
            code: 'command-not-allowed',
          })
          return
        }
        const ctx = { run: '', root: resolved.root, tmpDir: tmpBase }
        let runAbs = ''
        if (spec.needsRun !== false) {
          runAbs = resolveRunDir(resolved.root, typeof payload.run === 'string' ? payload.run : '')
          ctx.run = relToRoot(resolved.root, runAbs)
          if (command === 'render') {
            ctx.cacheDir = viewCacheDir(runAbs, tmpBase)
            try {
              await mkdirImpl(ctx.cacheDir, { recursive: true })
            } catch {
              /* 让 render 自己报错 */
            }
          }
        }
        const params = isPlainObject(payload.params) ? { ...payload.params } : {}
        if (payload.reason !== undefined && params.reason === undefined) params.reason = payload.reason
        /* v2.0 A：`expect` 是 body 顶层字段（也容忍塞在 params 里），属于宿主语义，绝不进 argv。 */
        let expect = typeof payload.expect === 'string' ? payload.expect.trim() : ''
        if (expect === '' && typeof params.expect === 'string') expect = params.expect.trim()
        delete params.expect
        if (expect !== '' && WRITE_COMMANDS.has(command)) {
          const actual = stateToken(runAbs)
          if (actual !== expect) {
            sendJson(res, 409, {
              error: 'run 状态已变化，请刷新「当前 study」后重新确认（state-changed）',
              code: 'state-changed',
              stateToken: actual,
            })
            return
          }
        }
        /* v2.0 B：resultsText 只当内容——写 tmpdir 文件，spawn 结束（含失败/超时）即删。 */
        let tellTempPath = null
        let resultsMeta = { rows: null, format: null }
        if (command === 'tell') {
          try {
            resultsMeta = await prepareTellResults(params, runAbs, resolved.root, tmpBase, {
              mkdirImpl,
              writeFileImpl,
            })
          } catch (error) {
            sendError(res, error)
            return
          }
          if (typeof resultsMeta.tempPath === 'string') {
            tellTempPath = resultsMeta.tempPath
            /* 关键一步：把宿主写好的临时文件交给 argv 构建器（CLI 只认路径）。 */
            ctx.resultsPath = tellTempPath
          } else if (typeof resultsMeta.resultsPath === 'string') {
            ctx.resultsPath = resultsMeta.resultsPath
          }
        }
        /* 回执的「前」计数一律由宿主自己读 run 目录得出，不信任 CLI 的 stdout。 */
        const tokenBefore = command === 'tell' ? stateToken(runAbs) : ''
        const countsBefore = command === 'tell'
          ? { pending: pendingCountOf(runAbs), dataset: datasetRowsOf(runAbs) }
          : null
        let argv = []
        let outcome
        try {
          argv = buildExecArgv(command, params, ctx)
          outcome = await callCli(argv, command === 'render' ? RENDER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
        } finally {
          if (tellTempPath !== null) {
            try {
              await unlinkImpl(tellTempPath)
            } catch {
              /* 已删或删不掉都不影响本次结果；路径只落在 tmpdir 下 */
            }
          }
        }
        const receipt = command === 'tell' ? buildTellReceipt({
          run: ctx.run,
          runAbs,
          resultsMeta,
          countsBefore,
          tokenBefore,
        }) : undefined
        if (outcome.timedOut) {
          sendJson(res, 504, {
            error: `命令超时（${command}）`,
            code: 'timeout',
            argv,
            exitCode: null,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            data: null,
            ...(receipt === undefined ? {} : { receipt }),
          })
          return
        }
        if (outcome.error !== undefined && outcome.code === null) {
          sendJson(res, 502, {
            error: outcome.error,
            code: 'spawn-failed',
            argv,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            ...(receipt === undefined ? {} : { receipt }),
          })
          return
        }
        sendJson(res, 200, {
          ok: outcome.ok,
          argv,
          exitCode: outcome.code,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          data: parseJsonLoose(outcome.stdout, outcome.stderr),
          ...(receipt === undefined ? {} : { receipt }),
        })
        return
      }

      /* 只读路由：GET/HEAD 同一个代码路径（HEAD 不写 body 也无妨，路由语义一致）。 */
      if (route === '/health') {
        const resolved = resolveRootHere(url.searchParams.get('root'), url.searchParams.get('sessionId'))
        if (resolved.root === null) {
          sendJson(res, 409, { error: resolved.error, code: resolved.code })
          return
        }
        const spec = pythonSpec(env, config)
        sendJson(res, 200, {
          ok: true,
          root: resolved.root,
          python: spec.display,
          version: await readVersion(resolved.root, readFileImpl),
          runsDir: join(resolved.root, RUNS_DIR),
          cli: join(resolved.root, ...CLI_SCRIPT),
          /* v1.3：面板要「打开即禁用写操作按钮」，而不是等第一次 POST /exec 才吃 403。 */
          allowExec,
        })
        return
      }
      if (route === '/studies') {
        const resolved = resolveRootHere(url.searchParams.get('root'), url.searchParams.get('sessionId'))
        if (resolved.root === null) {
          sendJson(res, 409, { error: resolved.error, code: resolved.code })
          return
        }
        rootRef.root = resolved.root
        sendJson(res, 200, { root: resolved.root, runs: await listStudies(resolved.root, { fsImpl: injectedFs }) })
        return
      }
      if (route === '/spec') {
        const resolved = resolveRootHere(url.searchParams.get('root'), url.searchParams.get('sessionId'))
        if (resolved.root === null) {
          sendJson(res, 409, { error: resolved.error, code: resolved.code })
          return
        }
        rootRef.root = resolved.root
        const outcome = await callCli(['spec', '--json'], DEFAULT_TIMEOUT_MS)
        if (outcome.timedOut) {
          sendJson(res, 504, { error: 'spec 超时', code: 'timeout' })
          return
        }
        const data = parseJsonLoose(outcome.stdout, outcome.stderr)
        if (!outcome.ok || data === null) {
          sendJson(res, 502, {
            error: firstLine(outcome.stderr) || firstLine(outcome.stdout) || outcome.error || 'spec 调用失败',
            code: 'spec-failed',
            stdout: outcome.stdout,
            stderr: outcome.stderr,
          })
          return
        }
        sendJson(res, 200, data)
        return
      }
      if (route === '/view') {
        const resolved = resolveRootHere(url.searchParams.get('root'), url.searchParams.get('sessionId'))
        if (resolved.root === null) {
          sendJson(res, 409, { error: resolved.error, code: resolved.code })
          return
        }
        rootRef.root = resolved.root
        const runAbs = resolveRunDir(resolved.root, url.searchParams.get('run') || '')
        const view = await renderView(resolved.root, runAbs, {
          force: url.searchParams.get('force') === '1',
          relRun: relToRoot(resolved.root, runAbs),
          tmpDir: tmpBase,
          spawnImpl,
          python: deps.python,
          config,
          env,
          now,
        })
        sendJson(res, 200, view)
        return
      }
      if (route === '/study') {
        const resolved = resolveRootHere(url.searchParams.get('root'), url.searchParams.get('sessionId'))
        if (resolved.root === null) {
          sendJson(res, 409, { error: resolved.error, code: resolved.code })
          return
        }
        rootRef.root = resolved.root
        const runAbs = resolveRunDir(resolved.root, url.searchParams.get('run') || '')
        const relRun = relToRoot(resolved.root, runAbs)
        const study = await gatherStudy(relRun, runAbs, url.searchParams.get('step') === '1')
        /* v2.0 A：面板靠 `stateToken`（写请求回传的 expect）+ `current` 显示「当前 study」。 */
        study.stateToken = stateToken(runAbs)
        study.current = readCurrent(runAbs)
        sendJson(res, 200, study)
        return
      }
      sendJson(res, 404, { error: '没有这个地址', code: 'not-found' })
    } catch (error) {
      sendError(res, error)
    }
  }
}

/* ------------------------------------------------------------------ *
 * agent 工具 condopt_view（DESIGN §6）
 * ------------------------------------------------------------------ */

/** 工具允许的 include 取值。 */
const TOOL_INCLUDES = ['report', 'step', 'pending', 'decisions', 'pareto']
/** 默认 include：全部只读字段；`step` 会写 run/step.json，故默认不含（DESIGN R4）。 */
const TOOL_DEFAULT_INCLUDES = ['report', 'pending', 'decisions', 'pareto']

/** 每个 include 字段对应的 CLI 调用（`step` 是唯一会写 run 目录的一个）。 */
function toolFieldArgv(field, relRun, runAbs, tmpBase) {
  if (field === 'report') return ['report', '--run', relRun, '--json']
  if (field === 'step') return ['step', '--run', relRun, '--json']
  if (field === 'pending') return ['pending', '--run', relRun, '--json']
  if (field === 'decisions') return ['decisions', '--run', relRun, '--limit', '5', '--json']
  if (field === 'pareto') {
    return ['pareto', '--run', relRun, '--out', join(viewCacheDir(runAbs, tmpBase), 'pareto_front.csv'), '--json']
  }
  return null
}

/** 数字格式化：null → '—'，其余保留 6 位有效数字（避免 89.95560808793654 刷屏）。 */
function fmtNumber(value) {
  const num = numberOrNull(value)
  if (num === null) return '—'
  if (Number.isInteger(num)) return String(num)
  return num.toPrecision(6).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 把采集到的 study 状态压成紧凑 Markdown（DESIGN §6：study 基本信息 → 预算/最优 →
 * 下一步行动 → 待回填批次数 → 最近 5 条决策 → 失败/降级说明）。
 * 绝不包含 dashboard HTML 本体。
 */
export function buildStudyText({ root, relRun, view, warnings }) {
  const report = isPlainObject(view?.report) ? view.report : null
  const step = isPlainObject(view?.step) ? view.step : null
  const pending = isPlainObject(view?.pending) ? view.pending : null
  const decisions = isPlainObject(view?.decisions) ? view.decisions : null
  const pareto = isPlainObject(view?.pareto) ? view.pareto : null
  const lines = []
  lines.push(`## condopt study: ${basename(relRun) || relRun}`)
  lines.push(`- run: ${relRun}`)
  lines.push(`- root: ${root}`)
  if (report !== null) {
    const algorithm = typeof report.algorithm === 'string' ? report.algorithm : '—'
    lines.push(`- 算法: ${algorithm}${report.manual_override === true ? '（人工覆写中）' : ''}`)
    lines.push(`- 预算: ${fmtNumber(report.budget)} 已观测 ${fmtNumber(report.used)} 剩余 ${fmtNumber(report.remaining)}`)
    const best = isPlainObject(report.best) ? report.best : null
    const bestX = best !== null && isPlainObject(best.x) ? JSON.stringify(best.x) : ''
    lines.push(`- 最优: ${fmtNumber(report.best_score)}${bestX === '' ? '' : ` @ ${bestX}`}`)
    if (isPlainObject(report.decision) && typeof report.decision.selection_basis === 'string') {
      lines.push(`- 选点依据: ${report.decision.selection_basis}${typeof report.decision.selection_reason === 'string' ? `（${report.decision.selection_reason}）` : ''}`)
    }
  } else {
    lines.push('- 报告: 未取到（见下方警告）')
  }
  if (step !== null) {
    lines.push(`- 下一步: ${typeof step.action === 'string' ? step.action : '—'}${typeof step.reason === 'string' ? `（${step.reason}）` : ''}`)
    if (typeof step.next_command === 'string' && step.next_command !== '') lines.push(`  - 命令: ${step.next_command}`)
    if (step.should_stop === true) lines.push(`  - 应停止: ${typeof step.stop_reason === 'string' ? step.stop_reason : '—'}`)
  }
  const pendingCount = pending !== null && numberOrNull(pending.n_pending) !== null
    ? numberOrNull(pending.n_pending)
    : (Array.isArray(pending?.pending) ? pending.pending.length : null)
  if (pendingCount !== null) lines.push(`- 待回填: ${pendingCount} 条`)
  if (pareto !== null && numberOrNull(pareto.n_front) !== null) {
    lines.push(`- Pareto 前沿: ${pareto.n_front} 个点`)
  }
  const rows = decisions !== null && Array.isArray(decisions.decisions) ? decisions.decisions : []
  if (rows.length > 0) {
    lines.push(`- 最近决策（${rows.length} 条）:`)
    for (const row of rows.slice(-5)) {
      if (!isPlainObject(row)) continue
      const action = typeof row.action === 'string' ? row.action : '?'
      const algorithm = typeof row.algorithm === 'string' && row.algorithm !== '' ? ` ${row.algorithm}` : ''
      const reason = typeof row.reason === 'string' ? row.reason : ''
      lines.push(`  - ${action}${algorithm}${reason === '' ? '' : ` — ${reason}`}`)
    }
  }
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push('- 警告:')
    for (const warning of warnings) lines.push(`  - ${warning}`)
  }
  return lines.join('\n')
}

/** condopt_view 的工具声明（形状与 council 的 ctx.tools.register 对齐）。 */
function condoptViewTool(config, deps = {}) {
  return {
    name: 'condopt_view',
    description: '读取某个 condopt study 的优化内容视图（进度报告、下一步行动、待回填批次、审计决策、Pareto），'
      + '用于 agent 在调项目材料时拿到最新优化状态。只读，不写 run 目录。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'condopt 仓库根目录；省略=按 resolveRoot 解析' },
        run: { type: 'string', description: 'runs 下的 study，如 demo / demo_moo；省略=取最近修改的一个' },
        include: {
          type: 'array',
          items: { type: 'string', enum: TOOL_INCLUDES },
          description: '省略=全部（step 会写 run/step.json，故默认不含；显式要才给）',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          run: { type: 'string' },
          root: { type: 'string' },
          view: { type: 'object' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'run', 'root'],
      },
      render: (_args, value) => [{ type: 'text', text: isPlainObject(value) && typeof value.text === 'string' ? value.text : String(value) }],
      presentationMeta: (_args, value) => ({ run: isPlainObject(value) ? value.run : '', root: isPlainObject(value) ? value.root : '' }),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 180000,
    async execute(args, exec) {
      const input = isPlainObject(args) ? args : {}
      const sessionCwd = cwdFromExec(exec)
      /* 根目录解析与 HTTP 侧同一套顺序（DESIGN §2）：插件自持候选 + 会话候选 + 工作区候选。 */
      const resolved = resolveRoot({
        root: input.root,
        config,
        cwd: sessionCwd,
        env: process.env,
        selfDir: typeof deps.selfDir === 'string' && deps.selfDir !== '' ? deps.selfDir : PLUGIN_DIR,
        workspaces: deps.workspaces,
      })
      if (resolved.root === null) throw new CondoptError(resolved.error, resolved.code, 409)
      const root = resolved.root
      let relRun = ''
      if (typeof input.run === 'string' && input.run.trim() !== '') {
        relRun = relToRoot(root, resolveRunDir(root, input.run.trim()))
      } else {
        const studies = await listStudies(root)
        if (studies.length === 0) {
          throw new CondoptError('runs/ 下没有可用的 study（需要含 problem.json 或 dataset.jsonl）', 'run-not-found', 404)
        }
        relRun = studies[0].rel
      }
      const runAbs = resolve(root, relRun)
      const include = Array.isArray(input.include) && input.include.length > 0
        ? input.include.filter((field) => TOOL_INCLUDES.includes(field))
        : TOOL_DEFAULT_INCLUDES
      const tmpBase = tmpdir()
      const warnings = []
      const view = { report: null, step: null, pending: null, decisions: null, pareto: null }
      /* pareto 的 --out 落在 <tmp>/dsh-condopt-view/<hash>/ 下，CLI 不会自建父目录。 */
      await ensureParentDir(join(viewCacheDir(runAbs, tmpBase), 'pareto_front.csv'))
      for (const field of include) {
        const argv = toolFieldArgv(field, relRun, runAbs, tmpBase)
        if (argv === null) continue
        const outcome = await runCli(argv, {
          root,
          config,
          env: process.env,
          timeoutMs: field === 'pareto' ? RENDER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
        })
        if (outcome.timedOut) {
          warnings.push(`${field}: 超时`)
          continue
        }
        if (!outcome.ok) {
          warnings.push(`${field}: ${firstLine(outcome.stderr) || firstLine(outcome.stdout) || outcome.error || '调用失败'}`)
          continue
        }
        const data = parseJsonLoose(outcome.stdout, outcome.stderr)
        if (data === null) {
          warnings.push(`${field}: 输出不是 JSON`)
          continue
        }
        view[field] = data
      }
      const text = buildStudyText({ root, relRun, view, warnings })
      return { text, run: relRun, root, view, warnings }
    },
  }
}

/** 从工具执行上下文里尽力取会话工作目录（DSH 版本间字段名可能漂移）。 */
function cwdFromExec(exec) {
  if (!isPlainObject(exec)) return undefined
  const agent = isPlainObject(exec.agent) ? exec.agent : undefined
  const session = agent !== undefined && isPlainObject(agent.session) ? agent.session : undefined
  const header = session !== undefined && isPlainObject(session.header) ? session.header : undefined
  const candidates = [
    exec.cwd,
    exec.workspaceCwd,
    agent !== undefined ? agent.cwd : undefined,
    header !== undefined ? header.cwd : undefined,
    header !== undefined ? header.workingDirectory : undefined,
    session !== undefined ? session.cwd : undefined,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/**
 * 注册一个条目：优先走 `ctx.effect`（DSH 在插件卸载时自动清理），没有 effect
 * 就退化为直接注册——新版 DSH 挪动了服务名时插件不应该整个炸掉（DESIGN R5）。
 */
function registerEntry(ctx, service, label, factory) {
  if (ctx === null || typeof ctx !== 'object') return
  const target = ctx[service]
  if (target === null || typeof target !== 'object' || typeof target.register !== 'function') return
  if (typeof ctx.effect === 'function') {
    ctx.effect(factory, label)
    return
  }
  try {
    factory()
  } catch {
    /* 服务存在但注册失败：不要影响其它条目 */
  }
}

/**
 * 从 DSH 服务里读一次工作区列表（DESIGN §2 第 6 条候选）。
 *
 * `ctx.get('workspaceRegistry')` 随版本可能不存在、`list()` 也可能抛错，所以
 * 全程 optional chaining + try。返回数组或 undefined，交给 resolveRoot 逐项校验。
 */
function workspaceListOf(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return undefined
  let registry
  try {
    registry = ctx.get('workspaceRegistry')
  } catch {
    return undefined
  }
  if (registry === null || typeof registry !== 'object' || typeof registry.list !== 'function') return undefined
  try {
    const list = registry.list()
    return Array.isArray(list) ? list : undefined
  } catch {
    return undefined
  }
}

/**
 * 由 sessionId 找会话工作目录（DESIGN §2 第 5 条候选）。
 *
 * **必须用 `ctx.get('agents')` 软访问**：本插件 `inject` 只有 `['webServer','tools']`，
 * cordis 对属性式访问（`ctx.agents`）会直接抛
 * `cannot get property "agents" without inject`，整个条目就激活失败（真机 A7 实测）。
 * `ctx.get(name)` 是文档化的软访问：服务不在依赖里时返回 undefined / 抛错，两种都当
 * 「拿不到」处理，第 5 级自然跳过，其余六级不受影响。
 *
 * 层级全部 optional：`agents.get(id)` → `session` → `header.cwd`（也接受
 * `workingDirectory`）。老版本 DSH 没有这些字段时返回 undefined。
 */
function sessionCwdResolver(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return null
  let agents
  try {
    agents = ctx.get('agents')
  } catch {
    return null
  }
  if (agents === null || typeof agents !== 'object' || typeof agents.get !== 'function') return null
  return (sessionId) => {
    const agent = safeCall(() => agents.get(sessionId), undefined)
    if (agent === null || typeof agent !== 'object') return undefined
    const session = agent.session
    const header = session !== null && typeof session === 'object' ? session.header : undefined
    const candidates = [
      header !== null && typeof header === 'object' ? header.cwd : undefined,
      header !== null && typeof header === 'object' ? header.workingDirectory : undefined,
      session !== null && typeof session === 'object' ? session.cwd : undefined,
    ]
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }
}

/**
 * 插件入口。
 *
 * 配置（全部可选，缺失不报错）：`config.projectRoot`、`config.allowExec`（默认 true）、
 * `config.python`；环境变量 `CONDOPT_ROOT`、`CONDOPT_PYTHON`。
 * 这里刻意不声明 schemastery Config：避免给零依赖插件引入额外依赖；缺字段按默认走。
 *
 * 两个 DSH 服务（会话工作目录、工作区注册表）只用于「无参时也能定位 condopt 根」，
 * 拿不到就跳过——插件自持的 `dsh-plugin/` 父目录候选已经能让 `link:` 安装开箱可用。
 *
 * **激活期只碰 `effect` 与 inject 里的 `webServer`/`tools`**：两个可选服务一律以
 * 惰性 thunk + `ctx.get(...)` 软访问交付，apply 阶段不读取它们（真机 A7 曾因
 * `ctx.agents` 属性式访问直接激活失败：`cannot get property "agents" without inject`）。
 */
export function apply(ctx, config = {}) {
  const cfg = isPlainObject(config) ? config : {}
  const handlerDeps = {
    config: cfg,
    /* 惰性：每次请求才去问服务，激活期不触碰。 */
    workspaces: () => workspaceListOf(ctx),
    sessionCwdOf: (sessionId) => {
      const resolver = sessionCwdResolver(ctx)
      return resolver === null ? undefined : resolver(sessionId)
    },
  }
  registerEntry(ctx, 'webServer', 'condopt: HTTP API', () =>
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createHandler(handlerDeps) }))
  registerEntry(ctx, 'tools', 'condopt: condopt_view 工具', () =>
    ctx.tools.register(condoptViewTool(cfg, { workspaces: () => workspaceListOf(ctx) })))
}
