/**
 * verify-client.mjs — dsh-condopt 浏览器侧离线验收 harness（契约：DESIGN.md v1.2 §7）
 *
 * 技法：`node:vm` 复刻 DSH web 外壳的加载方式 ——
 *   1. 造一个最小 `window`（含 `__ModuleLoader__.load`、localStorage、location、定时器）；
 *   2. `vm.runInContext` 执行 client.js，截获 `load({id, factory})` 信封；
 *   3. `factory(require)` 只喂最小 React（createElement / hooks / Fragment …）；
 *   4. `plugin.apply(假 Cordis ctx)` 收集注册项；
 *   5. 用假 React 把面板组件真的「渲染」成字符串、跑 effects、喂假 fetch。
 * 断言都是语义级（注册发生了吗、locale 键一致吗、渲染抛不抛、点按钮 POST 了什么），
 * 不做「源码里有没有某个字符串」式的假测试。
 *
 * 运行：`node dev/verify-client.mjs`
 * 退出码：0 全过；1 有断言失败；2 client.js 不存在 / 无法加载。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const clientPath = join(pluginDir, 'client.js')
const fixturesDir = join(here, 'fixtures')
const localeDir = join(pluginDir, 'locale')

/* ------------------------------------------------------------------ 断言骨架 */

/* 交互回调里的 async 函数（void loadStudy(...)）若 reject，Node 默认会直接杀进程；
   harness 收集它们作为断言。**不吞 uncaughtException**：同步崩溃必须让进程非 0 退出。 */
const unhandledRejections = []
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason && reason.stack ? reason.stack : String(reason))
})

const results = []
let groupName = 'general'
function group(name) { groupName = name; process.stdout.write(`\n== ${name} ==\n`) }
function pass(name, detail) { results.push({ ok: true, name, group: groupName }); process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ''}\n`) }
function fail(name, expected, actual) { results.push({ ok: false, name, group: groupName, expected, actual }); process.stdout.write(`  FAIL ${name}\n       期望: ${expected}\n       实际: ${actual}\n`) }
function check(name, cond, expected, actual) { if (cond) pass(name); else fail(name, expected, actual) }
function eq(name, actual, expected) { check(name, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(expected), JSON.stringify(actual)) }
function note(message) { process.stdout.write(`  NOTE ${message}\n`) }
/* JSON.stringify(undefined) 返回 undefined，直接 .slice 会崩；统一兜底。 */
const rawStringify = JSON.stringify
JSON.stringify = (value, ...rest) => {
  const out = rawStringify(value, ...rest)
  return out === undefined ? String(value) : out
}

process.stdout.write(`dsh-condopt client harness\n  plugin : ${pluginDir}\n`)

if (!existsSync(clientPath)) {
  process.stdout.write(`\n[缺失] ${clientPath} 不存在 —— 浏览器侧实现尚未落地，无法验收（这是预期内的“文件不存在”）。\n`)
  process.stdout.write('       等 client-dev 交付 client.js 后重跑：node dev/verify-client.mjs\n')
  process.exit(2)
}

const source = readFileSync(clientPath, 'utf8')

/* 看门狗：被测文件若在 vm 里死循环 / 交互链挂住，harness 不能无限挂起 —— 打点并非 0 退出。 */
const WATCHDOG_MS = Number(process.env.DSH_CONDOPT_WATCHDOG_MS || 300000)
const watchdog = setTimeout(() => {
  process.stderr.write(`\n[watchdog] verify-client 超过 ${WATCHDOG_MS}ms 未结束（可能是被测 client.js 死循环或交互未收敛），强制退出。\n`)
  process.exit(3)
}, WATCHDOG_MS)
watchdog.unref?.()

/* ------------------------------------------------------------------ window / document 桩 */

let loadArgument
let loadError
const styleNodes = []
const appendedNodes = []
const shadowRoots = []
const shadowWrites = []
const storage = new Map()
const fetchCalls = []
const windowListeners = new Map()
const liveIntervals = new Set()
const liveTimeouts = new Set()
const requires = []

function addWindowListener(type, listener) {
  const set = windowListeners.get(type) || new Set()
  set.add(listener)
  windowListeners.set(type, set)
}
function removeWindowListener(type, listener) {
  const set = windowListeners.get(type)
  if (set) set.delete(listener)
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    dataset: {},
    style: {},
    attributes: {},
    childNodes: [],
    children: [],
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    id: '',
    checked: false,
    disabled: false,
    parentNode: null,
    setAttribute(k, v) { this.attributes[String(k)] = String(v); if (String(k).startsWith('data-')) this.dataset[String(k).slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = String(v) },
    getAttribute(k) { return this.attributes[String(k)] },
    removeAttribute(k) { delete this.attributes[String(k)] },
    hasAttribute(k) { return String(k) in this.attributes },
    appendChild(child) { this.children.push(child); this.childNodes.push(child); if (child && typeof child === 'object') child.parentNode = this; appendedNodes.push({ parent: this, child }); return child },
    append(...kids) { for (const kid of kids) this.appendChild(kid) },
    insertBefore(child) { this.children.unshift(child); if (child && typeof child === 'object') child.parentNode = this; return child },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); this.childNodes = this.childNodes.filter((c) => c !== child) },
    replaceChildren(...kids) { this.children = [...kids]; this.childNodes = [...kids] },
    remove() { this.removed = true; if (this.parentNode && this.parentNode.removeChild) this.parentNode.removeChild(this) },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
    querySelector() { return null }, querySelectorAll() { return [] },
    closest() { return null }, contains() { return false },
    attachShadow(options) {
      const root = makeElement('#shadow-root')
      root.mode = (options && options.mode) || 'open'
      let html = ''
      Object.defineProperty(root, 'innerHTML', {
        configurable: true,
        get() { return html },
        set(v) { html = String(v); root._html = html; shadowWrites.push({ root, value: html }) },
      })
      this.shadowRoot = root
      shadowRoots.push(root)
      return root
    },
    focus() {}, blur() {}, click() { if (typeof this.onclick === 'function') this.onclick({ preventDefault() {}, stopPropagation() {} }) },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 } },
    cloneNode() { return makeElement(tag) },
    setSelectionRange() {}, scrollIntoView() {}, animate() { return { cancel() {}, finished: Promise.resolve() } },
  }
  return el
}

const headEl = makeElement('head')
headEl.appendChild = function recordStyle(child) {
  styleNodes.push(child)
  appendedNodes.push({ parent: headEl, child })
  return child
}
const fakeDocument = {
  createElement: (tag) => makeElement(tag),
  createElementNS: (_ns, tag) => makeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
  createTreeWalker() { return { nextNode() { return null } } },
  head: headEl,
  body: makeElement('body'),
  documentElement: makeElement('html'),
  title: '',
}

function shadowContent() {
  const parts = shadowWrites.map((w) => w.value)
  for (const root of shadowRoots) {
    for (const child of root.children || []) {
      parts.push(String(child.textContent || ''), String(child.innerHTML || ''))
    }
  }
  return parts.join('\n')
}

/* ------------------------------------------------------------------ fetch 桩 */

const FIX = {
  studies: JSON.parse(readFileSync(join(fixturesDir, 'studies.json'), 'utf8')),
  spec: JSON.parse(readFileSync(join(fixturesDir, 'spec.json'), 'utf8')),
  view: JSON.parse(readFileSync(join(fixturesDir, 'view.json'), 'utf8')),
  study: JSON.parse(readFileSync(join(fixturesDir, 'study.json'), 'utf8')),
  exec: JSON.parse(readFileSync(join(fixturesDir, 'exec-ask.json'), 'utf8')),
  tell: JSON.parse(readFileSync(join(fixturesDir, 'tell.json'), 'utf8')),
  conflict: JSON.parse(readFileSync(join(fixturesDir, 'conflict.json'), 'utf8')),
  tellRows: readFileSync(join(fixturesDir, 'tell-rows.jsonl'), 'utf8'),
  health: JSON.parse(readFileSync(join(fixturesDir, 'health.json'), 'utf8')),
}
let runsMode = 'normal'
let healthMode = 'normal'
let clientExecMode = 'normal'
/* 空令牌（未知）：DESIGN §8.6A 定稿——客户端不当成 expect 参与比较。 */
let tokenOverride = null
const WRITE_COMMANDS = ['ask', 'confirm', 'override', 'auto', 'step', 'tell']

function responseOf(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => null, has: () => false, forEach() {} },
    async json() { return data },
    async text() { return typeof data === 'string' ? data : JSON.stringify(data) },
    async arrayBuffer() { return new ArrayBuffer(0) },
    clone() { return this },
  }
}

async function fakeFetch(input, init) {
  const options = init || {}
  const rawUrl = typeof input === 'string' ? input : (input && input.url) || ''
  const method = String(options.method || (input && input.method) || 'GET').toUpperCase()
  const call = { url: rawUrl, method, body: options.body, headers: options.headers, init: options }
  fetchCalls.push(call)

  let path = rawUrl
  try {
    if (/^https?:\/\//i.test(rawUrl)) path = new URL(rawUrl).pathname + (new URL(rawUrl).search || '')
  } catch { /* 保持原样 */ }

  if (runsMode === 'fail') throw new Error('fixture: network down')
  if (method === 'POST' && path.startsWith('/condopt/api/exec')) {
    let parsedBody = null
    try { parsedBody = typeof options.body === 'string' ? JSON.parse(options.body) : options.body } catch { parsedBody = null }
    const command = parsedBody && parsedBody.command
    if (clientExecMode === 'conflict' && WRITE_COMMANDS.includes(command)) return responseOf(FIX.conflict, 409)
    if (command === 'tell') return responseOf(FIX.tell)
    return responseOf(FIX.exec)
  }
  if (path.startsWith('/condopt/api/studies')) return responseOf(runsMode === 'empty' ? { root: '', runs: [] } : FIX.studies)
  if (path.startsWith('/condopt/api/spec')) return responseOf(FIX.spec)
  if (path.startsWith('/condopt/api/view')) return responseOf(FIX.view)
  if (path.startsWith('/condopt/api/study')) return responseOf(tokenOverride === null ? FIX.study : { ...FIX.study, stateToken: tokenOverride, current: FIX.study.current })
  if (path.startsWith('/condopt/api/health')) return responseOf(healthMode === 'exec-disabled' ? { ...FIX.health, allowExec: false } : FIX.health)
  return responseOf({ error: `fixture: no route for ${path}`, code: 'not-found' }, 404)
}

/* ------------------------------------------------------------------ window */

const fakeWindow = {
  __ModuleLoader__: { load(argument) { loadArgument = argument } },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  setTimeout(fn, ms, ...args) {
    if ((ms || 0) >= 30000) { const id = { fake: true, ms }; liveTimeouts.add(id); return id }
    const id = setTimeout(fn, ms, ...args)
    liveTimeouts.add(id)
    return id
  },
  clearTimeout(id) { liveTimeouts.delete(id); try { clearTimeout(id) } catch { /* fake id */ } },
  setInterval(fn, ms) { const id = { fake: true, ms, fn }; liveIntervals.add(id); return id },
  clearInterval(id) { liveIntervals.delete(id) },
  requestAnimationFrame(fn) { return fakeWindow.setTimeout(() => fn(Date.now()), 0) },
  cancelAnimationFrame(id) { fakeWindow.clearTimeout(id) },
  addEventListener: addWindowListener,
  removeEventListener: removeWindowListener,
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'dsh-verify-client' },
  location: { origin: 'http://127.0.0.1:59280', href: 'http://127.0.0.1:59280/', protocol: 'http:', host: '127.0.0.1:59280', pathname: '/' },
  fetch: fakeFetch,
  getComputedStyle() { return { getPropertyValue: () => '' } },
  matchMedia() { return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } },
  alert() {}, confirm() { return true }, prompt() { return '验收用覆写理由' },
  document: fakeDocument,
  innerWidth: 1280,
  innerHeight: 800,
}

/* ------------------------------------------------------------------ React 桩（跨渲染持久的 hook 槽） */

/* hooks 按「组件函数身份」分槽：嵌套组件（ShadowHtml 等）不会互相踩槽位，
   这样 setState（子页签切换）在离线渲染里能真实生效。 */
const storeByFn = new Map()
let currentStore = null

function beginComponent(fn) {
  let store = storeByFn.get(fn)
  if (store === undefined) {
    store = { idx: 0, memoIdx: 0, slots: [], refs: [], memo: [] }
    storeByFn.set(fn, store)
  }
  store.idx = 0
  store.memoIdx = 0
  const prev = currentStore
  currentStore = store
  return prev
}
function endComponent(prev) { currentStore = prev }
function resetAllHooks() { storeByFn.clear(); effectQueue.length = 0; currentStore = null }

const effectQueue = []
const refErrors = []
let renderCount = 0

const React = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) }
  },
  Fragment: Symbol.for('react.fragment'),
  StrictMode: 'StrictMode',
  useState(initial) {
    const s = currentStore
    const i = s.idx++
    if (!(i in s.slots)) s.slots[i] = typeof initial === 'function' ? initial() : initial
    const setState = (value) => { s.slots[i] = typeof value === 'function' ? value(s.slots[i]) : value }
    return [s.slots[i], setState]
  },
  useReducer(reducer, initial, initFn) {
    const s = currentStore
    const i = s.idx++
    if (!(i in s.slots)) s.slots[i] = initFn ? initFn(initial) : initial
    const dispatch = (action) => { s.slots[i] = reducer(s.slots[i], action) }
    return [s.slots[i], dispatch]
  },
  useEffect(fn, deps) { effectQueue.push({ fn, deps }) },
  useLayoutEffect(fn, deps) { effectQueue.push({ fn, deps }) },
  useInsertionEffect(fn) { effectQueue.push({ fn }) },
  useRef(value) {
    const s = currentStore
    const i = s.idx++
    if (!(i in s.refs)) s.refs[i] = { current: value }
    return s.refs[i]
  },
  useMemo(fn, _deps) { const s = currentStore; const i = s.memoIdx++; if (!s.memo[i]) s.memo[i] = { value: fn() }; return s.memo[i].value },
  useCallback(fn, _deps) { const s = currentStore; const i = s.memoIdx++; if (!s.memo[i]) s.memo[i] = { value: fn }; return s.memo[i].value },
  useContext(context) { return context && context._currentValue !== undefined ? context._currentValue : undefined },
  createContext(value) {
    return {
      _currentValue: value,
      Provider(props) { return props && props.children },
      Consumer(props) { return props && typeof props.children === 'function' ? props.children(value) : null },
    }
  },
  memo(type) { return type },
  forwardRef(render) { return (props) => render(props, props && props.ref) },
  useSyncExternalStore(subscribe, getSnapshot) { try { subscribe(() => {}) } catch { /* 忽略 */ } return getSnapshot() },
  useId() { return `id-${Math.random().toString(36).slice(2)}` },
  Children: {
    toArray(children) { return Array.isArray(children) ? children : (children === undefined || children === null ? [] : [children]) },
    map(children, fn) { return React.Children.toArray(children).map(fn) },
    count(children) { return React.Children.toArray(children).length },
    only(child) { return child },
  },
  cloneElement(element, props, ...children) {
    return { ...element, props: { ...element.props, ...props }, children: children.length ? children : element.children }
  },
  isValidElement(element) { return Boolean(element && element.type !== undefined) },
}
const ReactDom = { createPortal(node) { return node }, flushSync(fn) { if (typeof fn === 'function') fn() } }

/* ------------------------------------------------------------------ 执行 client.js */

let plugin
{
  const context = {
    window: fakeWindow,
    document: fakeDocument,
    console,
    fetch: fakeFetch,
    navigator: fakeWindow.navigator,
    localStorage: fakeWindow.localStorage,
    location: fakeWindow.location,
    performance: { now: () => Date.now() },
    requestAnimationFrame: fakeWindow.requestAnimationFrame,
    cancelAnimationFrame: fakeWindow.cancelAnimationFrame,
    setTimeout: fakeWindow.setTimeout,
    clearTimeout: fakeWindow.clearTimeout,
    setInterval: fakeWindow.setInterval,
    clearInterval: fakeWindow.clearInterval,
    addEventListener: addWindowListener,
    removeEventListener: removeWindowListener,
    getComputedStyle: fakeWindow.getComputedStyle,
    matchMedia: fakeWindow.matchMedia,
    AbortController: globalThis.AbortController || undefined,
    AbortSignal: globalThis.AbortSignal || undefined,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    queueMicrotask: (fn) => queueMicrotask(fn),
    structuredClone: globalThis.structuredClone,
    Buffer,
    Map, Set, WeakMap, WeakSet, Promise, Date, Math, JSON, String, Number, Boolean, Object, Array, Error, TypeError,
    ArrayBuffer, Uint8Array, RegExp, Symbol, Intl,
  }
  context.globalThis = context
  vm.createContext(context)
  try {
    vm.runInContext(source, context, { filename: 'client.js', timeout: 30000 })
  } catch (err) {
    process.stdout.write(`\n[加载失败] vm.runInContext(client.js) 抛错：${err && err.stack ? err.stack : err}\n`)
    process.exit(2)
  }
  if (loadError !== undefined && loadArgument === undefined) {
    process.stdout.write(`\n[加载失败] __ModuleLoader__.load 未被调用，load 内部错误：${loadError}\n`)
    process.exit(2)
  }
}

group('信封与 factory（DESIGN §7）')
check('window.__ModuleLoader__.load 被调用', loadArgument !== undefined, 'load({id, factory})', JSON.stringify(loadArgument && { id: loadArgument.id, factory: typeof loadArgument.factory }))
check('module id = dsh-condopt', loadArgument && loadArgument.id === 'dsh-condopt', 'dsh-condopt', String(loadArgument && loadArgument.id))

if (loadArgument && typeof loadArgument.factory === 'function') {
  try {
    plugin = loadArgument.factory((specifier) => {
      requires.push(specifier)
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
      if (specifier === 'react-dom') return ReactDom
      throw new Error(`unexpected require("${specifier}")`)
    })
  } catch (err) {
    fail('factory(require) 可执行', '返回 {apply}', `throw ${err && err.message}`)
  }
}
check('factory 只 require react（不引入构建链）', requires.every((s) => s === 'react' || s === 'react/jsx-runtime' || s === 'react-dom'), "['react']", JSON.stringify(requires))
check('plugin.apply 是函数', plugin !== undefined && typeof plugin.apply === 'function', 'function', typeof (plugin && plugin.apply))

/* ------------------------------------------------------------------ 假 Cordis ctx */

group('注册面（slots / sidebarRightTabs / commandUi / locale / 样式）')

const slotsRegistrations = []
const localeDictionaries = []
const sidebarTabRegistrations = []
const commandRegistrations = []
const layoutCalls = []
const openedTabs = []
const scopeEffects = []
const injectedNames = []

const services = {
  layout: { openRightbar: (...args) => layoutCalls.push(args) },
  sidebarRight: { openTab: (kind) => openedTabs.push(kind) },
  sidebarRightTabs: { register: (definition) => { sidebarTabRegistrations.push(definition); return () => {} } },
}
function makeScope() {
  const scope = {
    get: (name) => services[name],
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') scopeEffects.push(cleanup); return () => {} },
    commandUi: { register: (contribution) => { commandRegistrations.push(contribution); return () => {} } },
    locale: fakeCtxLocale,
    slots: fakeCtxSlots,
    webServer: undefined,
  }
  for (const [name, value] of Object.entries(services)) scope[name] = value
  return scope
}
const fakeCtxSlots = {
  inject(name, callback) { injectedNames.push(name); if (typeof callback === 'function') callback(); return () => {} },
  register(options, component) { slotsRegistrations.push({ options, component }); return () => {} },
}
const fakeCtxLocale = {
  register(namespace, dicts) { localeDictionaries.push({ namespace, dicts }); return () => {} },
  bind(namespace) { return (key, params) => translate(namespace, key, params) },
}
const ctx = {
  get: (name) => services[name],
  effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') scopeEffects.push(cleanup); return () => {} },
  inject(names, callback) { if (Array.isArray(names)) injectedNames.push(...names); const scope = makeScope(); if (typeof callback === 'function') callback(scope); return () => {} },
  locale: fakeCtxLocale,
  slots: fakeCtxSlots,
}

let applyError = null
try {
  plugin.apply(ctx)
} catch (err) {
  applyError = err
}
check('plugin.apply(ctx) 不抛', applyError === null, '不抛', applyError ? String(applyError && applyError.stack) : 'ok')

const slotKeys = slotsRegistrations.map((r) => r.options && r.options.name)
check('注册 sidebar.right.pane.tab', slotKeys.includes('sidebar.right.pane.tab'), 'sidebar.right.pane.tab', JSON.stringify(slotKeys))
check('注册 tool.call.toolview', slotKeys.includes('tool.call.toolview'), 'tool.call.toolview', JSON.stringify(slotKeys))
const panelReg = slotsRegistrations.find((r) => r.options && r.options.name === 'sidebar.right.pane.tab')
check('面板 slot key = dsh-condopt/panel', panelReg && panelReg.options.key === 'dsh-condopt/panel', 'dsh-condopt/panel', String(panelReg && panelReg.options.key))
check('面板 slot locale = condopt', panelReg && panelReg.options.locale === 'condopt', 'condopt', String(panelReg && panelReg.options.locale))
check('面板组件是函数', panelReg && typeof panelReg.component === 'function', 'function', typeof (panelReg && panelReg.component))
const toolReg = slotsRegistrations.find((r) => r.options && r.options.name === 'tool.call.toolview')
check('工具卡 slot key = condopt_view', toolReg && toolReg.options.key === 'condopt_view', 'condopt_view', String(toolReg && toolReg.options.key))

check('sidebarRightTabs.register 调用一次', sidebarTabRegistrations.length === 1, '1 次', String(sidebarTabRegistrations.length))
const tabDef = sidebarTabRegistrations[0] || {}
check('tab id = dsh-condopt/panel', tabDef.id === 'dsh-condopt/panel', 'dsh-condopt/panel', String(tabDef.id))
check('tab kind = condopt', tabDef.kind === 'condopt', 'condopt', String(tabDef.kind))
check('tab title 是函数', typeof tabDef.title === 'function', 'function', typeof tabDef.title)

check('commandUi.register 调用一次', commandRegistrations.length === 1, '1 次', String(commandRegistrations.length))
const command = commandRegistrations[0] || {}
check('命令名 = condopt', command.name === 'condopt', 'condopt', String(command.name))
check('命令 ui.kind = action', command.ui && command.ui.kind === 'action', 'action', JSON.stringify(command.ui && command.ui.kind))
check('命令 ui.run 是函数', command.ui && typeof command.ui.run === 'function', 'function', typeof (command.ui && command.ui.run))

{
  const beforeLayout = layoutCalls.length
  const beforeTabs = openedTabs.length
  let runError = null
  try { if (command.ui && typeof command.ui.run === 'function') await command.ui.run({ sessionId: 'verify' }) } catch (err) { runError = err }
  await settle()
  check('命令 run() 不抛', runError === null, '不抛', runError ? String(runError && runError.message) : 'ok')
  check('命令打开右栏 layout.openRightbar', layoutCalls.length > beforeLayout, 'openRightbar 被调用', JSON.stringify(layoutCalls))
  check("命令 openTab('condopt')", openedTabs.slice(beforeTabs).includes('condopt'), "openedTabs 含 'condopt'", JSON.stringify(openedTabs))
}

/* locale */
function flattenKeys(obj, prefix = '') {
  const out = []
  if (obj === null || typeof obj !== 'object') return out
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(...flattenKeys(value, path))
    else out.push(path)
  }
  return out
}
function flattenValues(obj) {
  const out = []
  if (obj === null || typeof obj !== 'object') return out
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(...flattenValues(value))
    else out.push(String(value))
  }
  return out
}
function translate(namespace, key, params) {
  const found = localeDictionaries.find((entry) => entry.namespace === namespace)
  const dict = found && found.dicts ? found.dicts.zh || {} : {}
  let text = dict[key] !== undefined ? dict[key] : key
  if (params && typeof params === 'object') for (const [name, value] of Object.entries(params)) text = String(text).replaceAll(`{${name}}`, String(value))
  return text
}

check('locale.register(namespace=condopt) 调用', localeDictionaries.some((e) => e.namespace === 'condopt'), "namespace 'condopt'", JSON.stringify(localeDictionaries.map((e) => e.namespace)))
{
  const entry = localeDictionaries.find((e) => e.namespace === 'condopt')
  const zh = entry && entry.dicts && entry.dicts.zh
  const en = entry && entry.dicts && entry.dicts.en
  check('locale 字典含 zh 与 en', zh && typeof zh === 'object' && en && typeof en === 'object', '{zh,en}', JSON.stringify(entry && entry.dicts && Object.keys(entry.dicts)))
  if (zh && en) {
    const zhKeys = flattenKeys(zh).sort()
    const enKeys = flattenKeys(en).sort()
    const onlyZh = zhKeys.filter((k) => !enKeys.includes(k))
    const onlyEn = enKeys.filter((k) => !zhKeys.includes(k))
    check('zh/en 键集合完全一致', onlyZh.length === 0 && onlyEn.length === 0, '两字典键相同', `onlyZh=${JSON.stringify(onlyZh)} onlyEn=${JSON.stringify(onlyEn)}`)
    check('locale 字典非空', zhKeys.length > 0, '>0 键', String(zhKeys.length))
  }
}
{
  /* locale/*.json 是 DESIGN §1 的交付物，两份文件的键集合也必须一致 */
  for (const file of ['zh.json', 'en.json']) {
    const p = join(localeDir, file)
    check(`locale/${file} 存在且是合法 JSON`, existsSync(p) && (() => { try { JSON.parse(readFileSync(p, 'utf8')); return true } catch { return false } })(), '存在 + 合法 JSON', existsSync(p) ? '存在' : '缺失')
  }
  if (existsSync(join(localeDir, 'zh.json')) && existsSync(join(localeDir, 'en.json'))) {
    try {
      const zhFile = JSON.parse(readFileSync(join(localeDir, 'zh.json'), 'utf8'))
      const enFile = JSON.parse(readFileSync(join(localeDir, 'en.json'), 'utf8'))
      const onlyZh = flattenKeys(zhFile).filter((k) => !flattenKeys(enFile).includes(k))
      const onlyEn = flattenKeys(enFile).filter((k) => !flattenKeys(zhFile).includes(k))
      check('locale/*.json 两文件键集合一致', onlyZh.length === 0 && onlyEn.length === 0, '键集合相同', `onlyZh=${JSON.stringify(onlyZh)} onlyEn=${JSON.stringify(onlyEn)}`)
    } catch (err) {
      fail('locale/*.json 解析', '合法 JSON', String(err && err.message))
    }
  }
}

/* 样式注入 */
{
  const marked = styleNodes.filter((node) => {
    const attr = node.attributes && node.attributes['data-plugin-css']
    const ds = node.dataset && node.dataset.pluginCss
    return (attr && String(attr).includes('dsh-condopt')) || (ds && String(ds).includes('dsh-condopt'))
  })
  check('注入带 data-plugin-css="dsh-condopt…" 的样式', marked.length >= 1 || styleNodes.length >= 1, '至少一个 <style data-plugin-css> 注入', `styleNodes=${styleNodes.length}, marked=${marked.length}, attrs=${JSON.stringify(styleNodes.map((n) => n.attributes || n.dataset))}`)
}

/* ------------------------------------------------------------------ 渲染面板 */

group('面板渲染（DESIGN §7 视图/参数/决策 + 防御式）')

function render(node, refElements = []) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => render(child, refElements)).join('')
  if (typeof node.type === 'function') {
    renderCount += 1
    const prev = beginComponent(node.type)
    try {
      return render(node.type({ ...node.props, children: node.children }), refElements)
    } finally {
      endComponent(prev)
    }
  }
  /* 宿主元素：造一个带 attachShadow 的假节点，并把 ref 回调按真实 React 的时机调一次，
     这样 ShadowHtml（用 ref 拿节点再 attachShadow）这条路径才能被离线覆盖。 */
  const element = makeElement(node.type)
  refElements.push(element)
  if (typeof node.props.ref === 'function') {
    try { node.props.ref(element) } catch (err) { refErrors.push(err) }
  }
  const children = node.children !== undefined && node.children.length > 0 ? node.children : node.props.children
  return render(children, refElements)
}
function flushEffects() {
  let guard = 0
  while (effectQueue.length > 0) {
    if (guard++ > 500) throw new Error('effect flush 不收敛')
    const { fn } = effectQueue.shift()
    const cleanup = fn()
    if (typeof cleanup === 'function') scopeEffects.push(cleanup)
  }
}
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0))
}
function renderPanel(props = {}) {
  let html = ''
  let error = null
  try { html = render(React.createElement(panelReg.component, { t: (key, params) => translate('condopt', key, params), ...props })) } catch (err) { error = err }
  return { html, error }
}

{
  resetAllHooks()
  const first = renderPanel()
  check('面板首次渲染不抛', first.error === null, '不抛', first.error ? String(first.error && first.error.stack) : 'ok')
  check('面板首次渲染有内容', typeof first.html === 'string' && first.html.length > 0, 'html 非空', `len=${first.html.length}`)
  let flushError = null
  try { flushEffects() } catch (err) { flushError = err }
  check('面板 effects 可 flush', flushError === null, '收敛', flushError ? String(flushError.message) : 'ok')
  await settle()
  const second = renderPanel()
  check('数据到达后面板再次渲染不抛', second.error === null, '不抛', second.error ? String(second.error && second.error.stack) : 'ok')
  try { flushEffects() } catch { /* 第二次 effect：run 已选中 → 拉 view/spec/study */ }
  await settle(4)
  const third = renderPanel()
  check('view 数据到达后第三次渲染不抛', third.error === null, '不抛', third.error ? String(third.error && third.error.stack) : 'ok')
  try { flushEffects() } catch { /* 第三次 effect：画 shadow */ }
  await settle(4)

  const apiCalls = fetchCalls.filter((c) => c.url.includes('/condopt/api/'))
  const requested = apiCalls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0])
  check('面板请求 /condopt/api/studies', requested.some((p) => p === '/condopt/api/studies'), '/condopt/api/studies', JSON.stringify(requested))
  check('面板请求 /condopt/api/view（或 spec）', requested.some((p) => p === '/condopt/api/view' || p === '/condopt/api/spec'), 'view/spec', JSON.stringify(requested))
  check('所有请求都在 /condopt/api/ 前缀下', apiCalls.every((c) => c.url.includes('/condopt/api/')) && apiCalls.length > 0, '全部命中前缀', JSON.stringify(apiCalls.map((c) => c.url).slice(0, 10)))

  const shadow = shadowContent()
  const rendered = third.html + '\n' + second.html + '\n' + shadow + '\n' + first.html
  check('视图 css/html 进入 shadow DOM', shadow.includes('FIXTURE_VIEW_BODY') || rendered.includes('FIXTURE_VIEW_BODY'), 'shadow 内出现 FIXTURE_VIEW_BODY', `shadowRoots=${shadowRoots.length} shadowWrites=${shadowWrites.length} shadowLen=${shadow.length}`)
  check('shadow 内同时注入 css 与 html', shadow.includes('FIXTURE_STYLE_ONE') && shadow.includes('FIXTURE_VIEW_BODY'), 'css + html 都在 shadow', `shadowLen=${shadow.length}`)
  check('shadow DOM 未污染全局 document（R1）', !fakeDocument.body.innerHTML.includes('FIXTURE_VIEW_BODY'), 'body 不含 dash 内容', String(fakeDocument.body.innerHTML).slice(0, 80))
  check('面板显示 study/run 信息', rendered.includes('demo_moo') || /demo_moo/.test(shadow), '出现 demo_moo', rendered.slice(0, 200))

  /* 空态 */
  resetAllHooks()
  runsMode = 'empty'
  const empty = renderPanel()
  check('空 runs 空态渲染不抛', empty.error === null, '不抛', empty.error ? String(empty.error && empty.error.message) : 'ok')
  try { flushEffects() } catch { /* 忽略 */ }
  await settle(4)
  const empty2 = renderPanel()
  check('空态渲染有内容', empty2.error === null && empty2.html.length > 0, 'html 非空', `len=${empty2.html.length}`)
  check('空态给出 init 引导（可复制命令）', /init/.test(empty2.html + shadowContent()), '出现 init 提示', (empty2.html + shadowContent()).slice(0, 160))
  runsMode = 'normal'

  /* 网络失败态 */
  resetAllHooks()
  runsMode = 'fail'
  const bad = renderPanel()
  check('网络失败首次渲染不抛', bad.error === null, '不抛', bad.error ? String(bad.error && bad.error.stack) : 'ok')
  try { flushEffects() } catch { /* 忽略 */ }
  await settle(4)
  const bad2 = renderPanel()
  check('网络失败后再次渲染不抛（组件不外溢异常）', bad2.error === null, '不抛', bad2.error ? String(bad2.error && bad2.error.message) : 'ok')
  runsMode = 'normal'
}

/* ------------------------------------------------------------------ 交互：POST /api/exec */

group('参数页交互（生成待测批 → POST /condopt/api/exec）')

function buildTree(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const item of node) buildTree(item, out); return out }
  if (typeof node === 'string' || typeof node === 'number') return out
  if (typeof node.type === 'function') {
    const prev = beginComponent(node.type)
    try { buildTree(node.type({ ...node.props, children: node.children }), out) } catch { /* 交互树尽力而为 */ }
    finally { endComponent(prev) }
    return out
  }
  out.push({ type: node.type, props: node.props || {}, children: node.children || [] })
  buildTree(node.children, out)
  return out
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return textOf(node.children)
}

if (panelReg && typeof panelReg.component === 'function') {
  resetAllHooks()
  renderPanel()
  try { flushEffects() } catch { /* 忽略 */ }
  await settle()
  renderPanel()
  try { flushEffects() } catch { /* 忽略 */ }
  await settle()

  fetchCalls.length = 0
  const props = { t: (key, params) => translate('condopt', key, params) }
  const allLabels = []
  const clicked = new Set()
  const clickErrors = []
  const clickable = []

  /* 参数页按钮要先把子页签切到「参数」、并等 /api/spec 回来才出现。
     所以按页签驱动：切到某页 → 重渲染 → 收集该页新增的动作按钮 → 点掉它们。
     文案优先取插件自己注册的 locale（键名未在契约里冻结，因此同时按中文语义兜底）。 */
  const zhStrings = (() => {
    const entry = localeDictionaries.find((e) => e.namespace === 'condopt')
    return entry && entry.dicts && entry.dicts.zh ? flattenValues(entry.dicts.zh) : []
  })()
  function loc(key, ...fallbackPatterns) {
    const value = translate('condopt', key)
    if (value !== key && value !== '') return value
    for (const pattern of fallbackPatterns) {
      const hit = zhStrings.find((s) => new RegExp(pattern).test(s))
      if (hit !== undefined) return hit
    }
    return key
  }
  const LABEL = {
    refresh: loc('panel.refresh', '刷新'),
    view: loc('subtab.view', '^视图$'),
    params: loc('subtab.params', '^参数$'),
    decisions: loc('subtab.decisions', '^决策$'),
    force: loc('panel.force', '强制'),
    retry: loc('panel.retry', '重试'),
  }
  const tabLabels = new Set([LABEL.refresh, LABEL.view, LABEL.params, LABEL.decisions, LABEL.force, LABEL.retry, 'panel.refresh', 'subtab.view', 'subtab.params', 'subtab.decisions', 'panel.force'])

  async function rerender() {
    const panel = renderPanel()
    try { flushEffects() } catch { /* 忽略 */ }
    await settle(6)
    return panel
  }
  async function clickLabel(label) {
    const tree = buildTree(React.createElement(panelReg.component, props))
    const button = tree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && textOf(n.children).includes(label))
    if (!button) return false
    allLabels.push(label)
    try { await button.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch (err) { clickErrors.push(`${label}: ${err && err.message}`) }
    await settle(4)
    return true
  }

  {
    const firstTree = buildTree(React.createElement(panelReg.component, props))
    const firstButtons = firstTree.filter((n) => n.type === 'button' && typeof n.props.onClick === 'function')
    check('面板存在可点击按钮', firstButtons.length > 0, '≥1 个 button[onClick]', `buttons=${firstTree.filter((n) => n.type === 'button').length}`)
    clickable.push(...firstButtons.map((b) => textOf(b.children)))
  }
  if (process.env.DSH_CONDOPT_DEBUG === '1') note(`初始按钮：${JSON.stringify(clickable)}`)

  const switched = await clickLabel(LABEL.params)
  check('可切到「参数」子页签', switched === true, `button「${LABEL.params}」`, 'not found')
  await rerender()
  await rerender() /* 等 spec 落地后再渲染一次 */

  /* 该页上的动作按钮（排除结构性按钮）逐个点击 */
  {
    const tree = buildTree(React.createElement(panelReg.component, props))
    const actions = tree.filter((n) => n.type === 'button' && typeof n.props.onClick === 'function' && !tabLabels.has(textOf(n.children)))
    check('参数页出现动作按钮（ask/confirm/override/auto/step/复制命令）', actions.length > 0, '≥3 个动作按钮', `actions=${JSON.stringify(actions.map((b) => textOf(b.children)))}`)
    for (const button of actions) {
      const label = textOf(button.children)
      if (clicked.has(label)) continue
      clicked.add(label)
      allLabels.push(label)
      try { await button.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch (err) { clickErrors.push(`${label}: ${err && err.message}`) }
      await settle(4)
    }
    await rerender()
  }

  /* 决策页（/api/study 数据源） */
  await clickLabel(LABEL.decisions)
  await rerender()

  const execPosts = fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/condopt/api/exec'))
  check('点击动作向 /condopt/api/exec 发 POST', execPosts.length > 0, '≥1 个 POST exec', JSON.stringify(fetchCalls.map((c) => `${c.method} ${c.url}`).slice(0, 12)))

  const parsed = execPosts.map((c) => {
    if (typeof c.body !== 'string') return { body: c.body }
    try { return JSON.parse(c.body) } catch { return { body: c.body } }
  })
  const askPosts = parsed.filter((b) => b && b.command === 'ask')
  check('存在 command=ask 的 exec 请求（「生成待测批」）', askPosts.length > 0, "body.command === 'ask'", JSON.stringify(parsed.map((b) => b && b.command)))
  const askBody = askPosts[0]
  if (askBody) {
    check('exec body 形状 {run, command, params}', typeof askBody.run === 'string' && askBody.run.length > 0 && typeof askBody.command === 'string' && (askBody.params === undefined || (askBody.params !== null && typeof askBody.params === 'object')), '{run:string, command:string, params?:object}', JSON.stringify(askBody).slice(0, 200))
    check('exec body 不含直传 argv 数组', !Array.isArray(askBody.argv), '无 argv', JSON.stringify(askBody.argv))
  }
  check('点击回调无未捕获异常', clickErrors.length === 0, '无 throw', JSON.stringify(clickErrors.slice(0, 5)))
  check('交互过程中无未处理的 Promise 拒绝', unhandledRejections.length === 0, '0 个 unhandledRejection', JSON.stringify(unhandledRejections.slice(0, 2)))
  const studyGets = fetchCalls.filter((c) => c.method === 'GET' && c.url.includes('/condopt/api/study'))
  check('切到决策页会 GET /condopt/api/study', studyGets.length > 0, '≥1 个 GET /condopt/api/study', JSON.stringify(fetchCalls.filter((c) => c.url.includes('/study')).map((c) => `${c.method} ${c.url}`).slice(0, 6)))
  check('点击后所有请求仍在 /condopt/api/ 前缀下', fetchCalls.every((c) => c.url.includes('/condopt/api/')), '全部命中前缀', JSON.stringify(fetchCalls.map((c) => c.url).filter((u) => !u.includes('/condopt/api/')).slice(0, 6)))
  note(`已点击按钮文案：${JSON.stringify(allLabels.slice(0, 16))}`)
  note(`首次可见按钮：${JSON.stringify(clickable.slice(0, 10))}`)
}

/* ------------------------------------------------------------------ v1.3 health.allowExec=false */

group('v1.3 执行开关（health.allowExec=false 打开面板即置灰）')

if (panelReg && typeof panelReg.component === 'function') {
  const props = { t: (key, params) => translate('condopt', key, params) }
  const tabLabels = new Set([translate('condopt', 'panel.refresh'), translate('condopt', 'subtab.view'), translate('condopt', 'subtab.params'), translate('condopt', 'subtab.decisions')])
  const zhStrings = (() => {
    const entry = localeDictionaries.find((e) => e.namespace === 'condopt')
    return entry && entry.dicts && entry.dicts.zh ? flattenValues(entry.dicts.zh) : []
  })()
  const loc = (key, pattern) => {
    const value = translate('condopt', key)
    if (value !== key && value !== '') return value
    return zhStrings.find((s) => new RegExp(pattern).test(s)) || key
  }
  const paramsLabel = loc('subtab.params', '^参数$')
  const disabledHint = loc('panel.execDisabled', '禁用|关闭')

  resetAllHooks()
  healthMode = 'exec-disabled'
  for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }
  const tabTree = buildTree(React.createElement(panelReg.component, props))
  const paramsTab = tabTree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && textOf(n.children).includes(paramsLabel))
  check('找到「参数」子页签（allowExec=false 场景）', paramsTab !== undefined, `button「${paramsLabel}」`, 'not found')
  if (paramsTab) { try { await paramsTab.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } }
  await settle(4)
  for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }

  const panelHtml = renderPanel().html
  const tree = buildTree(React.createElement(panelReg.component, props))
  const entries = zhStrings.length > 0 ? zhStrings : []
  const actionLabels = ['ask', 'confirm', 'override', 'auto', 'step'].map((name) => {
    const direct = translate('condopt', `action.${name}`)
    if (direct !== `action.${name}`) return direct
    const fallback = { ask: '生成待测批', confirm: '确认复孔', override: '覆写算法', auto: '恢复自动', step: '下一步' }[name]
    return entries.find((s) => s === fallback) || fallback
  })
  const actionButtons = tree.filter((n) => n.type === 'button' && typeof n.props.onClick === 'function' && actionLabels.some((label) => textOf(n.children).includes(label)))
  check('allowExec=false 时五个写动作按钮全部 disabled', actionButtons.length >= 3 && actionButtons.every((b) => b.props.disabled === true), 'ask/confirm/override/auto/step 全 disabled', JSON.stringify(actionButtons.map((b) => ({ label: textOf(b.children), disabled: b.props.disabled === true }))))
  check('显示 execDisabled 提示文案', panelHtml.includes(disabledHint), `含「${disabledHint}」`, panelHtml.slice(0, 160))

  fetchCalls.length = 0
  const allClickable = tree.filter((n) => n.type === 'button' && typeof n.props.onClick === 'function' && !tabLabels.has(textOf(n.children)))
  for (const button of allClickable) {
    try { await button.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ }
    await settle(3)
  }
  const posts = fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/condopt/api/exec'))
  check('置灰按钮点击不发 POST /api/exec', posts.length === 0, '0 个 POST', JSON.stringify(posts.map((c) => c.url)))
  healthMode = 'normal'
}

/* ------------------------------------------------------------------ v1.2 override 内层 params */

group('v1.2 override 内层 params（schema 控件改动 → 请求体一致）')

if (panelReg && typeof panelReg.component === 'function') {
  const props = { t: (key, params) => translate('condopt', key, params) }
  const zhStrings = (() => {
    const entry = localeDictionaries.find((e) => e.namespace === 'condopt')
    return entry && entry.dicts && entry.dicts.zh ? flattenValues(entry.dicts.zh) : []
  })()
  const loc = (key, pattern) => {
    const value = translate('condopt', key)
    if (value !== key && value !== '') return value
    return zhStrings.find((s) => new RegExp(pattern).test(s)) || key
  }
  const paramsLabel = loc('subtab.params', '^参数$')
  const overrideLabel = loc('action.override', '覆写')

  resetAllHooks()
  healthMode = 'normal'
  for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }
  const tabTree = buildTree(React.createElement(panelReg.component, props))
  const paramsTab = tabTree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && textOf(n.children).includes(paramsLabel))
  if (paramsTab) { try { await paramsTab.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } }
  await settle(4)
  for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }

  /* 1) 把 spec schema 的 choice 控件（kernel: rbf/matern52/matern32）改成 rbf */
  let select = buildTree(React.createElement(panelReg.component, props)).find((n) => n.type === 'select' && (n.children || []).some((c) => c && c.props && String(c.props.value || '') === 'rbf'))
  if (select) { try { select.props.onChange({ target: { value: 'rbf' } }) } catch { /* 忽略 */ } ; await settle(3) }

  /* 2) 把所有空的文本控件（含 textarea 的 reason）填上理由 */
  const emptyInputs = buildTree(React.createElement(panelReg.component, props)).filter((n) => (n.type === 'input' || n.type === 'textarea') && typeof n.props.onChange === 'function' && String(n.props.value === undefined ? '' : n.props.value) === '')
  for (const input of emptyInputs) { try { input.props.onChange({ target: { value: '验收理由' } }) } catch { /* 忽略 */ } }
  await settle(3)
  for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }

  /* 3) 点「覆写算法」 */
  fetchCalls.length = 0
  const overrideTree = buildTree(React.createElement(panelReg.component, props))
  const overrideButton = overrideTree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && textOf(n.children).includes(overrideLabel))
  check('找到「覆写算法」按钮', overrideButton !== undefined, `button「${overrideLabel}」`, 'not found')
  if (overrideButton) { try { await overrideButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } ; await settle(5) }

  const parsed = fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/condopt/api/exec')).map((c) => { try { return JSON.parse(c.body) } catch { return null } })
  const ov = parsed.find((b) => b && b.command === 'override')
  if (select === undefined) {
    note('未在参数页找到 schema choice 控件（select 含 rbf option）；override 内层 params 无法端到端断言，记为 NOTE')
  } else {
    check('override 请求出现', ov !== undefined, "body.command==='override'", JSON.stringify(parsed.map((b) => b && b.command)))
    if (ov) {
      check('override.params.params.kernel === 改动值 rbf', ov.params && ov.params.params && ov.params.params.kernel === 'rbf', "{params:{kernel:'rbf'}}", JSON.stringify(ov.params))
      check('override.params.algorithm 与 reason 齐全', ov.params && typeof ov.params.algorithm === 'string' && ov.params.algorithm !== '' && typeof ov.params.reason === 'string' && ov.params.reason.length > 0, '{algorithm:string, reason:非空}', JSON.stringify(ov.params))
      check('override 请求不含直传 argv', !Array.isArray(ov.argv), '无 argv', JSON.stringify(ov.argv))
    }
  }
}

/* ------------------------------------------------------------------ 工具卡 */

group('tool.call.toolview 卡（condopt_view）')

if (toolReg && typeof toolReg.component === 'function') {
  const args = { run: 'demo_moo', root: '<condopt-root>', include: ['report'] }
  const block = {
    args: { text: (key) => (args[key] === undefined ? '' : String(args[key])), value: (key) => args[key] },
    call: {
      id: 'call-1',
      state: 'result',
      args,
      result: { text: '# condopt demo_moo\n- 预算 24/24', run: 'demo_moo', root: args.root, warnings: [] },
      error: null,
      output: { text: '# condopt demo_moo\n- 预算 24/24', run: 'demo_moo', root: args.root, warnings: [] },
    },
  }
  let toolError = null
  let toolHtml = ''
  try {
    const prev = beginComponent(toolReg.component)
    try { toolHtml = render(React.createElement(toolReg.component, { t: (key, params) => translate('condopt', key, params), block, call: block.call, args, value: block.call.result })) } finally { endComponent(prev) }
  } catch (err) { toolError = err }
  if (toolError) note(`工具卡渲染在最小 block 桩上抛错（block 形状未在契约中冻结，记为 NOTE）：${toolError && toolError.message}`)
  else {
    check('工具卡渲染不抛且有内容', typeof toolHtml === 'string' && toolHtml.length > 0, 'html 非空', `len=${toolHtml.length}`)
    check('工具卡未把整份 dashboard 塞进来', !toolHtml.includes('<!doctype') && !toolHtml.includes('FIXTURE_VIEW_BODY'), '无整份 HTML', toolHtml.slice(0, 160))
  }
} else {
  fail('tool.call.toolview 组件可用', 'function', typeof (toolReg && toolReg.component))
}

/* ------------------------------------------------------------------ v2.0 垂直切片（DESIGN §8.6C） */

group('v2.0 参数页四块 / override diff / expect / tell 回填 / 409 / 工具卡交接（DESIGN §8.6C）')

if (panelReg && typeof panelReg.component === 'function') {
  const props = { t: (key, params) => translate('condopt', key, params) }
  const zhStrings = (() => {
    const entry = localeDictionaries.find((e) => e.namespace === 'condopt')
    return entry && entry.dicts && entry.dicts.zh ? flattenValues(entry.dicts.zh) : []
  })()
  const loc = (key, pattern) => {
    const value = translate('condopt', key)
    if (value !== key && value !== '') return value
    return zhStrings.find((s) => new RegExp(pattern).test(s)) || key
  }
  const paramsLabel = loc('subtab.params', '^参数$')
  const token = String(FIX.study.stateToken)
  const token8 = token.slice(0, 8)

  async function mountPanel(rounds = 2) {
    resetAllHooks()
    for (let i = 0; i < rounds; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }
  }
  async function gotoParams() {
    const tree = buildTree(React.createElement(panelReg.component, props))
    const tab = tree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && textOf(n.children).includes(paramsLabel))
    if (tab) { try { await tab.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } }
    await settle(4)
    for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }
    return renderPanel().html
  }
  function treeNow() { return buildTree(React.createElement(panelReg.component, props)) }
  function actionButtons(tree) {
    const tabLabels = new Set([paramsLabel, loc('subtab.view', '^视图$'), loc('subtab.decisions', '^决策$'), loc('panel.refresh', '刷新')])
    return tree.filter((n) => n.type === 'button' && typeof n.props.onClick === 'function' && !tabLabels.has(textOf(n.children)) && !/复制/.test(textOf(n.children)))
  }
  function fillEmptyReason(tree) {
    for (const node of tree) {
      /* 只填「理由」这种自由文本：checkbox 会被 onChange 翻转、number 填中文会让 ask 校验失败。 */
      const freeText = node.type === 'textarea' || (node.type === 'input' && (node.props.type === undefined || node.props.type === 'text'))
      if (freeText && typeof node.props.onChange === 'function' && String(node.props.value === undefined ? '' : node.props.value) === '') {
        try { node.props.onChange({ target: { value: '验收理由' } }) } catch { /* 忽略 */ }
      }
    }
  }
  const parsedPosts = () => fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/condopt/api/exec'))
    .map((c) => { try { return JSON.parse(c.body) } catch { return null } })

  /* ① 四块参数页 */
  {
    await mountPanel(2)
    const html = await gotoParams()
    const blocks = [
      ['当前 study', loc('params.current', '当前'), /当前/],
      ['下一批参数', loc('params.nextBatch', '下一批'), /下一批/],
      ['算法覆写', loc('params.override', '覆写'), /覆写/],
      ['新建 study', loc('params.newStudy', '新建'), /新建/],
    ]
    for (const [label, expected, pattern] of blocks) {
      check(`参数页有「${label}」块`, html.includes(expected) || pattern.test(html), `含 ${label}`, html.slice(0, 200))
    }
    check('当前 study 块显示 stateToken 前 8 位', html.includes(token8), token8, html.slice(0, 200))
    check('当前 study 块显示 current.algorithm', html.includes(String(FIX.study.current.algorithm)), FIX.study.current.algorithm, html.slice(0, 200))
    check('新建 study 默认只「复制命令」（不直接执行）', /复制/.test(html), '含复制命令按钮', html.slice(0, 160))
  }

  /* ② override diff：没改 → 不带内层 params；改一个字段 → 只带该字段 */
  {
    await mountPanel(2); await gotoParams()
    fetchCalls.length = 0
    let tree = treeNow()
    fillEmptyReason(tree)
    await settle(3)
    for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(4) }
    tree = treeNow()
    const overrideButton = tree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && /覆写/.test(textOf(n.children)))
    check('找到「覆写算法」按钮（v2.0）', overrideButton !== undefined, 'button 覆写', 'not found')
    if (overrideButton) { try { await overrideButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } ; await settle(4) }
    const noChange = parsedPosts().find((b) => b && b.command === 'override')
    check('未改字段 → override 请求不带内层 params', noChange !== undefined && (noChange.params === undefined || noChange.params.params === undefined || Object.keys(noChange.params.params || {}).length === 0), 'params.params 缺省/空', JSON.stringify(noChange && noChange.params))

    /* 改一个 schema 字段（kernel → rbf，非默认 matern52） */
    await mountPanel(2); await gotoParams()
    fetchCalls.length = 0
    let tree2 = treeNow()
    const select = tree2.find((n) => n.type === 'select' && (n.children || []).some((c) => c && c.props && String(c.props.value || '') === 'rbf'))
    check('参数页有 schema choice 控件（kernel）', select !== undefined, 'select 含 rbf', 'not found')
    if (select) { try { select.props.onChange({ target: { value: 'rbf' } }) } catch { /* 忽略 */ } ; await settle(3) }
    tree2 = treeNow()
    fillEmptyReason(tree2)
    await settle(3)
    for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(4) }
    tree2 = treeNow()
    const override2 = tree2.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && /覆写/.test(textOf(n.children)))
    if (override2) { try { await override2.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } ; await settle(4) }
    const changed = parsedPosts().find((b) => b && b.command === 'override')
    if (select !== undefined) {
      const inner = changed && changed.params ? changed.params.params : undefined
      check('改过字段才进 override diff（只含 kernel）', inner !== undefined && Object.keys(inner).length === 1 && inner.kernel === 'rbf', "{kernel:'rbf'} 仅此一项", JSON.stringify(inner))
      check('override diff 不含未改动的 spec 默认字段', inner === undefined || !('length_scale' in inner), '无 length_scale', JSON.stringify(inner))
    }
  }

  /* ③ expect 随五个写动作发送 */
  {
    await mountPanel(2); await gotoParams()
    fetchCalls.length = 0
    let tree = treeNow()
    fillEmptyReason(tree)
    await settle(3)
    for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(4) }
    tree = treeNow()
    const buttons = actionButtons(tree)
    for (const button of buttons) {
      try { await button.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ }
      await settle(4)
    }
    const posts = parsedPosts().filter(Boolean)
    const writePosts = posts.filter((b) => WRITE_COMMANDS.includes(b.command))
    const covered = new Set(writePosts.map((b) => b.command))
    check('五个写动作都发出 POST（ask/confirm/override/auto/step）', ['ask', 'confirm', 'override', 'auto', 'step'].every((cmd) => covered.has(cmd)), 'ask,confirm,override,auto,step', JSON.stringify([...covered]))
    check('每个写动作都在 body 顶层带 expect = study.stateToken（params 内不得再放）', writePosts.length > 0 && writePosts.every((b) => b.expect === token && !(b.params && b.params.expect !== undefined)), `顶层 expect===${token}`, JSON.stringify(writePosts.map((b) => ({ command: b.command, expect: b.expect, paramsExpect: b.params && b.params.expect }))))
  }

  /* ③b 空令牌（未知）→ 不把 expect 发出去（DESIGN §8.6A 定稿） */
  {
    tokenOverride = ''
    await mountPanel(2)
    await gotoParams()
    fetchCalls.length = 0
    let tree = treeNow()
    fillEmptyReason(tree)
    await settle(3)
    for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(4) }
    tree = treeNow()
    const ask = tree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && /生成/.test(textOf(n.children)))
    if (ask) { try { await ask.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } ; await settle(4) }
    const askPost = parsedPosts().find((b) => b && b.command === 'ask')
    check('study.stateToken 为空（未知）→ 写动作不发 expect', askPost !== undefined && askPost.expect === undefined, 'expect 缺省', JSON.stringify(askPost && { command: askPost.command, expect: askPost.expect }))
    tokenOverride = null
  }

  /* ④ tell 预览 + 确认回填 */
  {
    await mountPanel(2); await gotoParams()
    fetchCalls.length = 0
    let tree = treeNow()
    const askButton = tree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && /生成/.test(textOf(n.children)))
    check('找到「生成下一批」按钮', askButton !== undefined, 'button 生成', 'not found')
    if (askButton) { try { await askButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } ; await settle(5) }
    for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(5) }
    tree = treeNow()
    const textarea = tree.find((n) => n.type === 'textarea' && typeof n.props.onChange === 'function')
    check('ask 成功后出现回填 textarea', textarea !== undefined, 'textarea', JSON.stringify(tree.filter((n) => n.type === 'textarea').length))
    if (textarea) {
      try { textarea.props.onChange({ target: { value: FIX.tellRows } }) } catch { /* 忽略 */ }
      await settle(4)
      for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(5) }
      const html = renderPanel().html
      check('tell 预览显示行数（2）', /\b2\b/.test(html), '含 2 行', html.slice(0, 200))
      check('tell 预览显示解析形态 jsonl', /jsonl/i.test(html), 'jsonl', html.slice(0, 200))
      check('tell 预览显示令牌前 8 位', html.includes(token8), token8, html.slice(0, 200))

      fetchCalls.length = 0
      const tree3 = treeNow()
      const confirmTell = tree3.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && /回填/.test(textOf(n.children)))
      check('找到「确认回填」按钮', confirmTell !== undefined, 'button 回填', 'not found')
      if (confirmTell) { try { await confirmTell.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } ; await settle(5) }
      const tellPost = parsedPosts().find((b) => b && b.command === 'tell')
      /* DESIGN §8.6A 定稿：expect 在 body 顶层（Lead 2026-11-20 确认，params 内不接受）。 */
      check('确认回填发 POST tell（顶层 expect + params.resultsText 原文）', tellPost !== undefined && tellPost.expect === token && tellPost.params && tellPost.params.resultsText === FIX.tellRows && tellPost.params.expect === undefined, "{expect:'…', command:'tell', params:{resultsText:原文}}", JSON.stringify(tellPost).slice(0, 240))
      const receiptShown = /acceptedRows|receipt|26/.test(renderPanel().html)
      check('回执/计数回显出现在面板', receiptShown, 'acceptedRows/dataset 计数', renderPanel().html.slice(0, 200))
    }
  }

  /* ⑤ 409 state-changed：提示 + 刷新 + 不重试 */
  {
    await mountPanel(2); await gotoParams()
    clientExecMode = 'conflict'
    fetchCalls.length = 0
    const tree = treeNow()
    const askButton = tree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && /生成/.test(textOf(n.children)))
    if (askButton) { try { await askButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ } ; await settle(6) }
    for (let i = 0; i < 2; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }
    const posts = fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('/condopt/api/exec'))
    check('409 后不重试（该次点击只有 1 个 POST）', posts.length === 1, '1 个 POST', String(posts.length))
    const html = renderPanel().html
    check('409 提示「状态已变化/已刷新」', /状态已变化|已刷新|state-changed/.test(html), '状态已变化提示', html.slice(0, 200))
    const postIndex = fetchCalls.findIndex((c) => c.method === 'POST' && c.url.includes('/condopt/api/exec'))
    const refreshIndex = fetchCalls.findIndex((c, i) => i > postIndex && c.method === 'GET' && (c.url.includes('/condopt/api/study') || c.url.includes('/condopt/api/view')))
    check('409 后刷新 study/view', refreshIndex > postIndex, 'POST 之后出现 GET study/view', JSON.stringify(fetchCalls.map((c) => `${c.method} ${c.url}`).slice(0, 8)))
    clientExecMode = 'normal'
  }
}

/* 工具卡「在条件优化面板中打开」 */
if (toolReg && typeof toolReg.component === 'function') {
  const props = { t: (key, params) => translate('condopt', key, params) }
  const targetRun = 'demo'
  const args = { run: targetRun, root: '<condopt-root>', include: ['report'] }
  const block = {
    args: { text: (key) => (args[key] === undefined ? '' : String(args[key])), value: (key) => args[key] },
    call: { id: 'call-2', state: 'result', args, result: { text: '# condopt demo', run: targetRun, root: args.root, warnings: [] }, error: null },
  }
  const tree = (() => {
    const out = []
    const walk = (node) => {
      if (node === null || node === undefined) return
      if (Array.isArray(node)) { for (const item of node) walk(item); return }
      if (typeof node === 'string' || typeof node === 'number') return
      if (typeof node.type === 'function') {
        const prev = beginComponent(node.type)
        try { walk(node.type({ ...node.props, children: node.children })) } catch { /* 尽力而为 */ } finally { endComponent(prev) }
        return
      }
      out.push({ type: node.type, props: node.props || {}, children: node.children || [] })
      walk(node.children)
    }
    for (let round = 0; round < 3; round += 1) {
      out.length = 0
      walk(React.createElement(toolReg.component, { ...props, block, call: block.call, args, value: block.call.result, phase: 'result' }))
      if (out.some((n) => n.type === 'button')) break
    }
    return out
  })()
  const openButton = tree.find((n) => n.type === 'button' && typeof n.props.onClick === 'function' && /面板|打开|open/i.test(textOf(n.children)))
  check('工具卡有「在条件优化面板中打开」按钮', openButton !== undefined, 'button 面板/打开', JSON.stringify(tree.filter((n) => n.type === 'button').map((b) => textOf(b.children))))
  if (openButton) {
    const layoutBefore = layoutCalls.length
    const tabsBefore = openedTabs.length
    try { await openButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} }) } catch { /* 忽略 */ }
    await settle(5)
    check('工具卡按钮触发 layout.openRightbar', layoutCalls.length > layoutBefore, 'openRightbar 被调用', JSON.stringify(layoutCalls))
    check("工具卡按钮触发 openTab('condopt')", openedTabs.slice(tabsBefore).includes('condopt'), "'condopt'", JSON.stringify(openedTabs.slice(tabsBefore)))
    /* 带 run：挂载面板后应按该 run 取视图，而不是 studies 的第一条 demo_moo */
    resetAllHooks()
    fetchCalls.length = 0
    for (let i = 0; i < 3; i += 1) { renderPanel(); try { flushEffects() } catch { /* 忽略 */ } await settle(6) }
    const viewCalls = fetchCalls.filter((c) => c.url.includes('/condopt/api/view')).map((c) => c.url)
    check('工具卡交接的 run 被面板采用（demo，非 demo_moo）', viewCalls.some((u) => u.includes(targetRun) && !u.includes('demo_moo')), `view?run=*${targetRun}*`, JSON.stringify(viewCalls.slice(0, 5)))
  }
}

/* ------------------------------------------------------------------ 卸载 / 清理 */

group('teardown')

{
  let teardownError = null
  for (const cleanup of scopeEffects) {
    try { cleanup() } catch (err) { teardownError = err }
  }
  check('effects cleanup 可执行不抛', teardownError === null, '不抛', teardownError ? String(teardownError && teardownError.message) : `cleanups=${scopeEffects.length}`)
  const removedStyle = styleNodes.some((n) => n.removed === true)
  note(removedStyle ? '样式节点在 teardown 时被移除' : '样式节点未被显式移除（DESIGN 说 teardown 时移除，记为 NOTE）')
  for (const id of liveIntervals) { try { fakeWindow.clearInterval(id) } catch { /* 忽略 */ } }
  for (const id of liveTimeouts) { try { fakeWindow.clearTimeout(id) } catch { /* 忽略 */ } }
}

/* ------------------------------------------------------------------ 汇总 */

const failed = results.filter((r) => !r.ok)
const passed = results.length - failed.length
/* 任何阶段新增的未处理拒绝都必须在最终结果里留痕（交互组跑完之后才出现的也算）。 */
if (unhandledRejections.length > 0 && !failed.some((r) => r.name === '全程无未处理的 Promise 拒绝')) {
  fail('全程无未处理的 Promise 拒绝', '0 个 unhandledRejection', JSON.stringify(unhandledRejections.slice(0, 3)))
}
const failedFinal = results.filter((r) => !r.ok)
process.stdout.write(`\n========================================\n`)
process.stdout.write(`verify-client: ${results.length - failedFinal.length}/${results.length} 通过，${failedFinal.length} 失败\n`)
if (failedFinal.length > 0) {
  process.stdout.write('失败断言：\n')
  for (const f of failedFinal) process.stdout.write(`  - [${f.group}] ${f.name}\n      期望 ${f.expected}\n      实际 ${f.actual}\n`)
  process.exit(1)
}
process.stdout.write('verify-client: PASS\n')
process.exit(0)
