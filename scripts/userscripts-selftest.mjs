#!/usr/bin/env node
/**
 * MIR — 用户脚本（油猴脚本）运行器自测。
 *
 * 覆盖三件最容易回归的事：
 *   1. 元数据解析与 @match / @include / @exclude / @run-at 的匹配语义
 *   2. 主进程的 URL → 注入快照（userScriptsForUrl）是否正确挑出脚本、带上 GM 值
 *   3. webview preload 真正生成的注入包装是否语法合法、能否在最小 DOM 下跑通 GM_*
 *
 * 做法与 scripts/harness-models-test.mjs 一致：用 esbuild 把 TS 打成临时 CJS 模块，
 * 并把 electron 替换成临时 stub（运行器不依赖真实 Electron 进程）。
 *
 * 用法（仓库根目录，无需先 build）：
 *
 *   node scripts/userscripts-selftest.mjs
 *
 * 全部通过退出 0，否则退出 1。无网络、无登录。
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const esbuild = join(repoRoot, 'node_modules', '.bin', 'esbuild')

const work = mkdtempSync(join(tmpdir(), 'mir-userscripts-selftest-'))
let checks = 0

function check(label, fn) {
  try {
    fn()
    checks += 1
    console.log(`  ok  ${label}`)
  } catch (e) {
    console.error(`  FAIL ${label}`)
    throw e
  }
}

function bundle(entry, outfile, stubSource) {
  const stub = join(work, `${outfile}.stub.cjs`)
  writeFileSync(stub, stubSource)
  execFileSync(esbuild, [
    join(repoRoot, entry),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${join(work, outfile)}`,
    `--alias:electron=${stub}`
  ], { cwd: repoRoot, stdio: 'pipe' })
  return join(work, outfile)
}

/* ---------------------------------------------------------------- 主进程侧 */

const userData = join(work, 'userData')
mkdirSync(join(userData, 'userscripts'), { recursive: true })

const mainBundle = bundle('src/main/userscripts.ts', 'userscripts.cjs', `
const noop = () => {}
class Notification { static isSupported() { return false } show() {} }
module.exports = {
  app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  Notification,
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  session: { fromPartition: () => ({ fetch: async () => { throw new Error('no network in selftest') } }) },
  shell: { openPath: noop }
}
`)

const u = require(mainBundle)

const SCRIPT = `// ==UserScript==
// @name         Selftest Script
// @namespace    https://example.com/ns
// @version      1.2.3
// @description  demo script
// @author       selftest
// @match        https://github.com/*
// @match        *://*.google.com/search*
// @include      /^https:\\/\\/reddit\\.com\\/r\\/[^/]+$/
// @exclude      https://github.com/settings/*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        none
// @require      https://cdn.example.com/lib.js
// @resource     css https://cdn.example.com/a.css
// @noframes
// ==/UserScript==

GM_addStyle('body{color:red}');
GM_setValue('runs', 1);
`

console.log('元数据解析')
const parsed = u.parseUserScript(SCRIPT)
check('@name / @version 解析', () => {
  assert.equal(parsed.meta.name, 'Selftest Script')
  assert.equal(parsed.meta.version, '1.2.3')
})
check('@grant none 被过滤掉', () => assert.deepEqual(parsed.meta.grants, ['GM_setValue', 'GM_getValue']))
check('@resource 拆成 name + url', () =>
  assert.deepEqual(parsed.meta.resources, [{ name: 'css', url: 'https://cdn.example.com/a.css' }]))
check('@noframes 标记', () => assert.equal(parsed.meta.noframes, true))
check('正文保持原行号（删掉元数据块后行数不变）', () => {
  assert.equal(parsed.body.split('\n').length, SCRIPT.split('\n').length)
  assert.ok(parsed.body.includes("GM_addStyle('body{color:red}')"))
})
check('脚本 id 由 @namespace + @name 派生', () => assert.match(u.userScriptId(parsed.meta), /^[0-9a-f]{16}$/))
check('同名脚本 id 稳定', () =>
  assert.equal(u.userScriptId(parsed.meta), u.userScriptId(u.parseUserScript(SCRIPT).meta)))

console.log('URL 匹配')
for (const [url, want] of [
  ['https://github.com/foo/bar', true],
  ['https://github.com/settings/profile', false], // @exclude 优先
  ['http://github.com/x', false],                  // scheme 不匹配
  ['https://www.google.com/search?q=1', true],     // *://*.google.com/search*
  ['https://google.com/search?q=1', true],         // 子域通配允许裸域
  ['https://mail.google.com/mail', false],         // path 不匹配
  ['https://reddit.com/r/programming', true],      // /正则/ 形式 @include
  ['https://reddit.com/r/programming/top', false],
  ['https://example.org/', false]
]) {
  check(`match ${url} -> ${want}`, () => assert.equal(u.userScriptMatches(url, parsed.meta), want))
}

console.log('解析错误')
for (const [label, src] of [
  ['没有元数据块', 'console.log(1)'],
  ['缺 @name', '// ==UserScript==\n// @match https://a.com/*\n// ==/UserScript=='],
  ['缺 @match/@include', '// ==UserScript==\n// @name x\n// ==/UserScript==']
]) {
  check(`${label} 应报错`, () => assert.throws(() => u.parseUserScript(src)))
}

console.log('@run-at 归一')
check('document-body -> document-start', () =>
  assert.equal(
    u.parseUserScript('// ==UserScript==\n// @name a\n// @match https://a.com/*\n// @run-at document-body\n// ==/UserScript==').meta.runAt,
    'document-start'
  ))
check('未声明 -> document-idle', () =>
  assert.equal(
    u.parseUserScript('// ==UserScript==\n// @name a\n// @match https://a.com/*\n// ==/UserScript==').meta.runAt,
    'document-idle'
  ))

console.log('URL -> 注入快照')
const scriptId = u.userScriptId(u.parseUserScript(SCRIPT).meta)
writeFileSync(join(userData, 'userscripts', `${scriptId}.user.js`), SCRIPT)
const payload = u.userScriptsForUrl('https://github.com/foo/bar')
check('命中页面拿到 1 个脚本', () => assert.equal(payload.scripts.length, 1))
check('快照带 id / runAt / 正文', () => {
  assert.equal(payload.scripts[0].id, scriptId)
  assert.equal(payload.scripts[0].runAt, 'document-end')
  assert.ok(payload.scripts[0].code.includes("GM_setValue('runs', 1)"))
})
check('快照带 GM 值桶', () => assert.deepEqual(payload.values[scriptId], {}))
check('未命中页面为空', () => assert.equal(u.userScriptsForUrl('https://other.com/').scripts.length, 0))
check('特殊协议直接跳过', () => assert.equal(u.userScriptsForUrl('about:blank').scripts.length, 0))

/* ------------------------------------------------------------- preload 侧 */

const preloadBundle = bundle('src/preload/webview.ts', 'webview.cjs', `
// esbuild 会把 stub 内联进 bundle，所以用 globalThis 与测试脚本共享状态
const g = globalThis
g.__injected = g.__injected || []
g.__bridge = g.__bridge || {}
module.exports = {
  webFrame: { executeJavaScript(code) { g.__injected.push(code); return Promise.resolve() } },
  contextBridge: { exposeInMainWorld(name, api) { g.__bridge[name] = api; if (g.window) g.window[name] = api } },
  ipcRenderer: {
    sendSync() { return JSON.parse(g.__payloadJson || '{"url":"","scripts":[],"values":{}}') },
    send() {}, sendToHost() {}, invoke() { return Promise.resolve({}) }, on() {}
  }
}
`)

console.log('注入包装')
globalThis.__payloadJson = JSON.stringify({
  url: 'https://example.com/page',
  scripts: [{
    id: 'abc123',
    name: 'E2E Demo',
    runAt: 'document-start',
    grants: [], // 未声明 @grant：运行器按「全部开放」处理
    requireCode: 'var __reqMarker = 42;',
    code: `
      window.__result = { reqMarker: __reqMarker }
      GM_addStyle('body{color:red}')
      GM_setValue('runs', (GM_getValue('runs', 0) || 0) + 1)
      GM_addElement('div', { id: 'injected', textContent: 'hi' })
      var menuId = GM_registerMenuCommand('Do it', function () { window.__result.clicked = true })
      var cmd = window.__mirUserScriptMenu['abc123::' + menuId]
      window.__result.menuWired = typeof cmd === 'function'
      if (cmd) cmd()
      window.__result.info = GM_info.script.name
      window.__result.resource = GM_getResourceText('css')
    `,
    resources: { css: 'body{}' },
    info: {
      script: { name: 'E2E Demo', namespace: 'demo', version: '1.0.0', description: '', author: '', matches: [], grants: [], runAt: 'document-start' },
      scriptHandler: 'MIR Userscripts',
      version: '0.0.0',
      scriptMetaStr: ''
    }
  }],
  values: { abc123: { runs: 3 } }
})

// 最小 DOM 模拟，够 GM_addStyle / GM_addElement 用
const appended = []
const makeEl = tag => ({
  tagName: tag.toUpperCase(), attrs: {}, style: {}, textContent: '',
  setAttribute(k, v) { this.attrs[k] = v }, remove() {}
})
globalThis.window = globalThis
globalThis.document = {
  readyState: 'loading',
  createElement: makeEl,
  head: { appendChild: el => { appended.push(el) } },
  documentElement: { appendChild: el => { appended.push(el) } },
  body: { appendChild: el => { appended.push(el) } },
  addEventListener() {},
  execCommand() { return true }
}
globalThis.location = { href: 'https://example.com/page' }
globalThis.addEventListener = () => {}
globalThis.setTimeout = fn => { fn(); return 0 }
globalThis.atob = s => Buffer.from(s, 'base64').toString('binary')

require(preloadBundle)

check('serviceWorker patch + 脚本各注入一次', () => assert.equal(globalThis.__injected.length, 2))
const wrapper = globalThis.__injected.find(c => c.includes('__mirRunScript'))
check('包装代码语法合法', () => {
  assert.ok(wrapper, 'wrapper not found')
  new Function(wrapper)
})
check('@require 已内联、正文完整、runAt 传入', () => {
  assert.ok(wrapper.includes('var __reqMarker = 42;'))
  assert.ok(wrapper.includes("GM_addStyle('body{color:red}')"))
  assert.ok(wrapper.includes('document-start'))
})
check('GM 桥通过 contextBridge 暴露', () =>
  assert.ok(globalThis.__bridge.__mirUserscriptBridge))

// document-start：注入时同步执行
require('node:vm').runInThisContext(wrapper)
const r = globalThis.window.__result
check('GM_getValue 读到快照', () => assert.equal(r.reqMarker, 42))
check('GM_setValue 写穿到主进程通道', () =>
  assert.equal(globalThis.__bridge.__mirUserscriptBridge.getValue('abc123', 'runs', 0), 4))
check('GM_addStyle 插入 style', () => assert.equal(appended[0].tagName, 'STYLE'))
check('GM_addElement 插入元素', () => assert.ok(appended.some(el => el.attrs.id === 'injected')))
check('菜单回调可取到并执行', () => {
  assert.equal(r.menuWired, true)
  assert.equal(r.clicked, true)
})
check('GM_info / GM_getResourceText', () => {
  assert.equal(r.info, 'E2E Demo')
  assert.equal(r.resource, 'body{}')
})

rmSync(work, { recursive: true, force: true })
console.log(`\n全部通过（${checks} 项检查）`)
