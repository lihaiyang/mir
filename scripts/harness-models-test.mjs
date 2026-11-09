#!/usr/bin/env node
/**
 * MIR Harness「从接口拉取模型」的离线测试。
 *
 * 用 esbuild 把 src/shared/harnessModels.ts 打成一个临时 ESM 模块，
 * 再起几个本地假接口，覆盖支持的几种格式（OpenAI / Anthropic / Gemini / Ollama / 通用数组）
 * 以及 401、非 JSON、超时、非法地址等失败路径。
 *
 * 运行：node scripts/harness-models-test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = mkdtempSync(join(tmpdir(), 'harness-models-test-'))
const bundlePath = join(workDir, 'harnessModels.mjs')

function bundleModule() {
  const esbuild = join(root, 'node_modules', '.bin', 'esbuild')
  execFileSync(
    esbuild,
    [
      join(root, 'src', 'shared', 'harnessModels.ts'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      '--target=node20',
      `--outfile=${bundlePath}`,
      '--log-level=warning'
    ],
    { stdio: 'inherit' }
  )
}

/* ------------------------------- 断言工具 ------------------------------- */

const results = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function equals(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`✓ ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ------------------------------- 假接口工具 ------------------------------ */

function json(res, body, status = 200) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function startServer(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.()
        server.close(done)
      })
  }
}

/* --------------------------------- 用例 --------------------------------- */

async function main() {
  bundleModule()
  const {
    discoverHarnessModels,
    parseModelListPayload,
    modelEndpointCandidates
  } = await import(pathToFileURL(bundlePath).href)

  /* -------------------------- 1. OpenAI 兼容格式 -------------------------- */
  await check('OpenAI 兼容：/v1/models + Bearer，读取 id/name', async () => {
    let seenAuth = ''
    let seenPath = ''
    const server = await startServer((req, res) => {
      seenAuth = req.headers.authorization ?? ''
      seenPath = req.url ?? ''
      if (req.url === '/v1/models') {
        json(res, {
          object: 'list',
          data: [
            { id: 'alpha', object: 'model', owned_by: 'mir' },
            { id: 'beta', object: 'model', name: 'Beta Chat' }
          ]
        })
        return
      }
      json(res, { error: 'not found' }, 404)
    })
    try {
      const result = await discoverHarnessModels({ apiBase: server.url, apiKey: 'secret-key' })
      assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
      equals(result.format, 'openai', 'format')
      equals(result.models.map((m) => m.id), ['alpha', 'beta'], 'ids')
      equals(result.models[1].name, 'Beta Chat', 'name of beta')
      equals(seenAuth, 'Bearer secret-key', 'authorization header')
      equals(seenPath, '/v1/models', 'request path')
    } finally {
      await server.close()
    }
  })

  /* -------------------- 2. 地址已带 /v1，不重复拼版本段 ------------------- */
  await check('OpenAI 兼容：地址已带 /v1 时不重复拼 /v1', async () => {
    const paths = []
    const server = await startServer((req, res) => {
      paths.push(req.url)
      if (req.url === '/v1/models') {
        json(res, { data: [{ id: 'gpt-a' }] })
        return
      }
      json(res, {}, 404)
    })
    try {
      const result = await discoverHarnessModels({ apiBase: `${server.url}/v1` })
      assert(result.ok, 'expected ok')
      equals(result.models.map((m) => m.id), ['gpt-a'], 'ids')
      assert(!paths.includes('/v1/v1/models'), `unexpected duplicate version path: ${paths.join(',')}`)
    } finally {
      await server.close()
    }
  })

  /* ------------------------- 3. Google Gemini 格式 ------------------------ */
  await check('Google Gemini：/v1beta/models?key=，去掉 models/ 前缀', async () => {
    let seenUrl = ''
    const server = await startServer((req, res) => {
      seenUrl = req.url ?? ''
      if ((req.url ?? '').startsWith('/v1beta/models')) {
        json(res, {
          models: [
            { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
            { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' }
          ]
        })
        return
      }
      json(res, {}, 404)
    })
    try {
      const result = await discoverHarnessModels({ apiBase: `${server.url}/v1beta`, apiKey: 'google-key' })
      assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
      equals(result.format, 'google', 'format')
      equals(result.models.map((m) => m.id), ['gemini-2.0-flash', 'gemini-1.5-pro'], 'ids')
      equals(result.models[0].name, 'Gemini 2.0 Flash', 'display name')
      assert(seenUrl.includes('key=google-key'), `expected key in query, got ${seenUrl}`)
    } finally {
      await server.close()
    }
  })

  /* --------------------------- 4. Anthropic 格式 -------------------------- */
  await check('Anthropic：x-api-key + anthropic-version，读取 display_name', async () => {
    let headers = {}
    const server = await startServer((req, res) => {
      headers = req.headers
      if (req.url === '/anthropic/v1/models') {
        json(res, { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] })
        return
      }
      json(res, {}, 404)
    })
    try {
      const result = await discoverHarnessModels({
        apiBase: `${server.url}/anthropic`,
        apiKey: 'anthropic-key'
      })
      assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
      equals(result.format, 'anthropic', 'format')
      equals(result.models.map((m) => m.id), ['claude-sonnet-4-5'], 'ids')
      equals(result.models[0].name, 'Claude Sonnet 4.5', 'display name')
      equals(headers['x-api-key'], 'anthropic-key', 'x-api-key header')
      equals(headers['anthropic-version'], '2023-06-01', 'anthropic-version header')
    } finally {
      await server.close()
    }
  })

  /* ------------------------------ 5. Ollama ------------------------------ */
  await check('Ollama：/v1/models 404 后回落到 /api/tags', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/api/tags') {
        json(res, { models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] })
        return
      }
      if (req.url === '/v1/models' || req.url === '/models') {
        json(res, { error: 'not found' }, 404)
        return
      }
      json(res, {}, 404)
    })
    try {
      const result = await discoverHarnessModels({ apiBase: server.url })
      assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
      equals(result.format, 'ollama', 'format')
      equals(result.models.map((m) => m.id), ['qwen2.5:7b', 'llama3.1:8b'], 'ids')
    } finally {
      await server.close()
    }
  })

  /* ---------------------------- 6. 通用 JSON 数组 ------------------------- */
  await check('通用格式：裸数组 [{ id }]', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        json(res, [{ id: 'gguf-a' }, { id: 'gguf-b', name: 'GGUF B' }])
        return
      }
      json(res, {}, 404)
    })
    try {
      const result = await discoverHarnessModels({ apiBase: server.url })
      assert(result.ok, `expected ok, got ${JSON.stringify(result)}`)
      equals(result.models.map((m) => m.id), ['gguf-a', 'gguf-b'], 'ids')
    } finally {
      await server.close()
    }
  })

  /* --------------------------- 7. 解析函数直测 --------------------------- */
  await check('parseModelListPayload：三种形状 + 去重', () => {
    const openai = parseModelListPayload({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] })
    equals(openai.models.map((m) => m.id), ['a', 'b'], 'openai dedupe')
    equals(openai.format, 'openai', 'openai format')

    const google = parseModelListPayload({ models: [{ name: 'models/g-1' }] })
    equals(google.models.map((m) => m.id), ['g-1'], 'google id strip')
    equals(google.format, 'google', 'google format')

    const array = parseModelListPayload([{ model: 'ollama-x' }])
    equals(array.models.map((m) => m.id), ['ollama-x'], 'array model field')
    equals(array.format, 'generic', 'array format')

    equals(parseModelListPayload({ data: [] }), null, 'empty list → null')
    equals(parseModelListPayload({ hello: 'world' }), null, 'unknown payload → null')
  })

  await check('modelEndpointCandidates：按地址推断格式顺序', () => {
    const google = modelEndpointCandidates('https://generativelanguage.googleapis.com/v1beta', 'k')
    equals(google[0].format, 'google', 'google first')
    assert(google[0].url.includes('/v1beta/models'), `google endpoint: ${google[0].url}`)

    const openai = modelEndpointCandidates('https://api.deepseek.com/v1', 'k')
    equals(openai[0].url, 'https://api.deepseek.com/v1/models', 'openai endpoint')
    equals(openai[0].headers.Authorization, 'Bearer k', 'openai auth header')

    const ollama = modelEndpointCandidates('http://127.0.0.1:11434', undefined)
    equals(ollama[0].format, 'ollama', 'ollama first')
    equals(ollama[0].url, 'http://127.0.0.1:11434/api/tags', 'ollama tags endpoint')
  })

  /* ------------------------------ 8. 401 -------------------------------- */
  await check('401：所有候选都 401 时给出鉴权提示', async () => {
    const server = await startServer((req, res) => json(res, { error: 'nope' }, 401))
    try {
      const result = await discoverHarnessModels({ apiBase: server.url, apiKey: 'bad' })
      assert(!result.ok, 'expected failure')
      assert(/401/.test(result.error ?? ''), `error should mention 401: ${result.error}`)
      assert(
        result.attempts.every((attempt) => attempt.error === 'unauthorized'),
        `attempts: ${JSON.stringify(result.attempts)}`
      )
    } finally {
      await server.close()
    }
  })

  /* ---------------------------- 9. 非 JSON 页面 -------------------------- */
  await check('非 JSON：返回 HTML 时报「不是 JSON」', async () => {
    const server = await startServer((req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>login</title>')
    })
    try {
      const result = await discoverHarnessModels({ apiBase: server.url })
      assert(!result.ok, 'expected failure')
      assert(/JSON/.test(result.error ?? ''), `error should mention JSON: ${result.error}`)
      assert(
        result.attempts.some((attempt) => attempt.error === 'non-json'),
        `attempts: ${JSON.stringify(result.attempts)}`
      )
    } finally {
      await server.close()
    }
  })

  /* --------------------------- 10. 超时 / 非法地址 ----------------------- */
  await check('超时：接口长时间不响应', async () => {
    const server = await startServer((req, res) => {
      setTimeout(() => {
        try {
          res.end('{}')
        } catch {
          /* 已断开 */
        }
      }, 2_000)
    })
    try {
      const result = await discoverHarnessModels({ apiBase: server.url, timeoutMs: 300 })
      assert(!result.ok, 'expected failure')
      assert(/超时/.test(result.error ?? ''), `error should mention timeout: ${result.error}`)
      assert(
        result.attempts.some((attempt) => attempt.error === 'timeout'),
        `attempts: ${JSON.stringify(result.attempts)}`
      )
    } finally {
      await server.close()
    }
  })

  await check('非法地址：非 http(s) / 空地址直接拒绝', async () => {
    const ftp = await discoverHarnessModels({ apiBase: 'ftp://example.com/models' })
    assert(!ftp.ok && /http/.test(ftp.error ?? ''), `ftp: ${JSON.stringify(ftp)}`)
    const empty = await discoverHarnessModels({ apiBase: '   ' })
    assert(!empty.ok && /接口地址/.test(empty.error ?? ''), `empty: ${JSON.stringify(empty)}`)
  })

  /* ------------------------------- 汇总 --------------------------------- */
  const failed = results.filter((item) => !item.ok)
  console.log('─'.repeat(60))
  if (failed.length === 0) {
    console.log(`ALL PASS — ${results.length} checks in ${((Date.now() - startedAt) / 1000).toFixed(2)}s`)
  } else {
    console.log(`FAILED — ${failed.length}/${results.length} checks`)
    for (const item of failed) console.log(`  ✗ ${item.name}`)
    process.exitCode = 1
  }
}

const startedAt = Date.now()

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
