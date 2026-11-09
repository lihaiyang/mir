#!/usr/bin/env node
/**
 * MIR — ACP client smoke test.
 *
 * Spawns `scripts/acp-mock-agent.mjs` as a real child process, drives it with
 * the real `ClientSideConnection` from @agentclientprotocol/sdk over stdio, and
 * asserts that every part of the ACP surface the MIR client depends on works:
 * initialize, session setup, prompt streaming, permissions, cancellation,
 * session listing / loading and config options.
 *
 * Usage (from the repo root, no build step required):
 *
 *   node scripts/acp-selftest.mjs
 *
 * Exits 0 when every check passes, 1 otherwise. No network, no login, no deps
 * beyond the ACP SDK and Node builtins.
 */

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const startedAt = Date.now()

/** Repo root, derived from this file so the test works from any cwd. */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Overall safety net: never hang a manual run. */
const WATCHDOG_MS = 45_000

// ---------------------------------------------------------------- test harness

let passes = 0
let failures = 0
const failureLabels = []

function ok(label, condition, detail) {
  if (condition) {
    passes += 1
    console.log(`PASS  ${label}`)
    return true
  }
  failures += 1
  failureLabels.push(label)
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

/** Run one assertion group; a thrown error becomes a single FAIL line. */
async function step(name, fn) {
  try {
    await fn()
  } catch (err) {
    failures += 1
    failureLabels.push(name)
    console.log(`FAIL  ${name} threw: ${err?.stack ?? err}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Await `promise` but never longer than `ms`; resolves `undefined` on timeout. */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Poll `predicate` until it is truthy, giving up after `ms`. Needed because
 * notifications are delivered asynchronously relative to the response of the
 * request that triggered them.
 */
async function waitFor(predicate, ms = 2_000, interval = 20) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = predicate()
    if (value || Date.now() >= deadline) return value
    await sleep(Math.min(interval, Math.max(1, deadline - Date.now())))
  }
}

function updateKinds(updates) {
  const counts = new Map()
  for (const update of updates) {
    counts.set(update.sessionUpdate, (counts.get(update.sessionUpdate) ?? 0) + 1)
  }
  return counts
}

function agentText(updates) {
  return updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => (update.content?.type === 'text' ? update.content.text : ''))
    .join('')
}

// ------------------------------------------------------------------- the client

class RecordingClient {
  constructor(agent) {
    /** Agent-side connection proxy, for symmetry with real clients. */
    this.agent = agent
    /** Every `session/update` notification, in arrival order. */
    this.updates = []
    /** Every `session/request_permission` request. */
    this.permissionRequests = []
    this.readFileRequests = []
    this.writeFileRequests = []
  }

  async sessionUpdate(params) {
    this.updates.push({ at: Date.now(), update: params.update })
  }

  async requestPermission(params) {
    this.permissionRequests.push(params)
    const allow = (params?.options ?? []).find(
      (option) => typeof option.kind === 'string' && option.kind.startsWith('allow')
    )
    return allow
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }

  async readTextFile(params) {
    this.readFileRequests.push(params)
    return { content: `mock read of ${params?.path}\n` }
  }

  async writeTextFile(params) {
    this.writeFileRequests.push(params)
    return {}
  }
}

// --------------------------------------------------------------------- the run

async function main() {
  const agentPath = fileURLToPath(new URL('./acp-mock-agent.mjs', import.meta.url))
  const child = spawn(process.execPath, [agentPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: repoRoot
  })

  const stderrChunks = []
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()))
  child.stderr.on('error', () => {})
  child.on('error', (err) => {
    failures += 1
    console.log(`FAIL  spawn mock agent — ${err?.message ?? err}`)
  })

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  let client
  const conn = new ClientSideConnection((agent) => {
    client = new RecordingClient(agent)
    return client
  }, stream)

  /** Wait for the child to exit; returns `{ code, signal }`. */
  async function waitForExit(ms) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { code: child.exitCode, signal: child.signalCode }
    }
    const exit = await withTimeout(
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      ms
    )
    if (exit) return exit
    child.kill('SIGKILL')
    return { code: child.exitCode, signal: child.signalCode }
  }

  let session = null
  let init = null
  let childExit = null
  const watchdog = setTimeout(() => {
    console.log(`\nFAIL  selftest timed out after ${WATCHDOG_MS}ms`)
    child.kill('SIGKILL')
    process.exit(1)
  }, WATCHDOG_MS)
  watchdog.unref?.()

  try {
    // 1 ---------------------------------------------------------------- initialize
    await step('initialize', async () => {
      init = await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'mir-selftest', title: 'MIR ACP selftest', version: '0.0.0' }
      })
      ok(
        'initialize returns PROTOCOL_VERSION',
        init?.protocolVersion === PROTOCOL_VERSION,
        `got ${init?.protocolVersion}`
      )
      ok('initialize returns agentCapabilities', Boolean(init?.agentCapabilities))
      ok(
        'initialize advertises loadSession + session list/resume',
        init?.agentCapabilities?.loadSession === true &&
          Boolean(init?.agentCapabilities?.sessionCapabilities?.list) &&
          Boolean(init?.agentCapabilities?.sessionCapabilities?.resume)
      )
      ok(
        'initialize advertises promptCapabilities',
        typeof init?.agentCapabilities?.promptCapabilities?.embeddedContext === 'boolean'
      )
      ok(
        'initialize returns one auth method',
        Array.isArray(init?.authMethods) && init.authMethods.length === 1,
        JSON.stringify(init?.authMethods)
      )
      if (init?.authMethods?.length) {
        const auth = await conn.authenticate({ methodId: init.authMethods[0].id })
        ok('authenticate("mock-login") resolves', auth !== undefined)
      }
    })

    // 2 ---------------------------------------------------------------- newSession
    await step('newSession', async () => {
      session = await conn.newSession({ cwd: repoRoot, mcpServers: [] })
      ok(
        'newSession returns a sessionId',
        typeof session?.sessionId === 'string' && session.sessionId.length > 0,
        JSON.stringify(session?.sessionId)
      )
      ok(
        'newSession returns modes (ask/code)',
        session?.modes?.currentModeId === 'ask' &&
          Array.isArray(session?.modes?.availableModes) &&
          session.modes.availableModes.length === 2,
        JSON.stringify(session?.modes)
      )
      ok(
        'newSession returns 2 configOptions',
        Array.isArray(session?.configOptions) && session.configOptions.length === 2,
        JSON.stringify(session?.configOptions?.map((option) => option.id))
      )
      ok(
        'configOptions carry model + thought_level select values',
        session?.configOptions?.find((option) => option.id === 'model')?.currentValue === 'mock-fast' &&
          session?.configOptions?.find((option) => option.id === 'thought_level')?.currentValue === 'medium'
      )
      const kinds = updateKinds(client.updates.map((entry) => entry.update))
      // The agent defers this notification past the `session/new` response on
      // purpose (clients map updates by sessionId), so wait for it to land.
      await waitFor(
        () =>
          client.updates.some(
            (entry) =>
              entry.update.sessionUpdate === 'session_info_update' &&
              typeof entry.update.title === 'string'
          ),
        2_000
      )
      ok(
        'newSession sends session_info_update with a title',
        client.updates.some(
          (entry) =>
            entry.update.sessionUpdate === 'session_info_update' && typeof entry.update.title === 'string'
        ),
        `saw: ${[...kinds.keys()].join(', ') || 'no updates'}`
      )
    })

    // 3 -------------------------------------------------------------------- prompt
    await step('prompt hello', async () => {
      const before = client.updates.length
      const response = await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello there' }]
      })
      const updates = client.updates.slice(before).map((entry) => entry.update)
      ok('prompt("hello") returns end_turn', response?.stopReason === 'end_turn', response?.stopReason)

      const kinds = updateKinds(updates)
      const required = [
        'agent_thought_chunk',
        'available_commands_update',
        'tool_call',
        'tool_call_update',
        'plan',
        'agent_message_chunk',
        'usage_update'
      ]
      for (const kind of required) {
        ok(`prompt streams ${kind}`, kinds.has(kind), `saw: ${[...kinds.keys()].join(', ')}`)
      }

      const toolCall = updates.find((update) => update.sessionUpdate === 'tool_call')
      ok(
        'tool_call carries id/title/locations',
        Boolean(toolCall?.toolCallId) &&
          typeof toolCall?.title === 'string' &&
          Array.isArray(toolCall?.locations) &&
          toolCall.locations.length > 0,
        JSON.stringify(toolCall)
      )
      const plan = updates.find((update) => update.sessionUpdate === 'plan')
      ok('plan carries 3 entries with statuses', plan?.entries?.length === 3, JSON.stringify(plan?.entries))
      const usage = updates.find((update) => update.sessionUpdate === 'usage_update')
      ok(
        'usage_update carries used=1234 size=200000',
        usage?.used === 1234 && usage?.size === 200000,
        JSON.stringify(usage)
      )
      const messageChunks = kinds.get('agent_message_chunk') ?? 0
      ok('markdown answer streams in >=10 chunks', messageChunks >= 10, `${messageChunks} chunks`)
      const text = agentText(updates)
      ok(
        'markdown answer contains a fence, a link and a heading',
        text.includes('```') && text.includes('https://agentclientprotocol.com') && text.includes('# Mock answer')
      )
    })

    // 4 ---------------------------------------------------------------- permission
    await step('permission flow', async () => {
      const before = client.updates.length
      const requestsBefore = client.permissionRequests.length
      const response = await conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'please ask for permission to write a file' }]
      })
      ok(
        'prompt("…permission…") triggers one requestPermission',
        client.permissionRequests.length === requestsBefore + 1,
        `${client.permissionRequests.length - requestsBefore} requests`
      )
      const request = client.permissionRequests.at(-1)
      ok(
        'requestPermission offers allow/reject options',
        Array.isArray(request?.options) &&
          request.options.some((option) => option.kind === 'allow_once') &&
          request.options.some((option) => option.kind === 'allow_always') &&
          request.options.some((option) => option.kind === 'reject_once'),
        JSON.stringify(request?.options?.map((option) => option.kind))
      )
      ok(
        'requestPermission targets a toolCall',
        typeof request?.toolCall?.toolCallId === 'string' && typeof request?.toolCall?.title === 'string'
      )
      ok('permission turn still ends with end_turn', response?.stopReason === 'end_turn', response?.stopReason)
      const text = agentText(client.updates.slice(before).map((entry) => entry.update))
      ok('agent reports the outcome as selected:allow', text.includes('selected:allow'), JSON.stringify(text))
    })

    // 5 -------------------------------------------------------------------- cancel
    await step('cancel', async () => {
      const promptStartedAt = Date.now()
      const pending = conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'go slow so I can press stop' }]
      })
      // Avoid an unhandled rejection if the turn blows up while we wait.
      pending.catch(() => {})

      await sleep(300)
      await conn.cancel({ sessionId: session.sessionId })

      const response = await withTimeout(pending, 3000)
      const elapsed = Date.now() - promptStartedAt
      ok('cancel resolves the in-flight prompt', response !== undefined, 'still pending after 3s')
      ok('cancelled prompt returns stopReason=cancelled', response?.stopReason === 'cancelled', response?.stopReason)
      ok('cancel takes effect within ~3s', elapsed < 3000, `${elapsed}ms`)
    })

    // 6 ---------------------------------------------------------- list/load session
    await step('listSessions + loadSession', async () => {
      const list = await conn.listSessions({ cwd: repoRoot })
      ok(
        'listSessions returns >=1 session',
        Array.isArray(list?.sessions) && list.sessions.length >= 1,
        `${list?.sessions?.length} sessions`
      )
      ok(
        'listSessions includes titled and untitled sessions',
        list.sessions.some((entry) => typeof entry.title === 'string' && entry.title.length > 0) &&
          list.sessions.some((entry) => entry.title === null || entry.title === undefined)
      )
      ok('listSessions reports nextCursor=null', list?.nextCursor === null, JSON.stringify(list?.nextCursor))

      const target = list.sessions[0]
      const before = client.updates.length
      const loaded = await conn.loadSession({
        sessionId: target.sessionId,
        cwd: target.cwd,
        mcpServers: []
      })
      const replayed = new Set(client.updates.slice(before).map((entry) => entry.update.sessionUpdate))
      ok(
        'loadSession replays user_message_chunk',
        replayed.has('user_message_chunk'),
        [...replayed].join(', ')
      )
      ok(
        'loadSession replays agent_message_chunk',
        replayed.has('agent_message_chunk'),
        [...replayed].join(', ')
      )
      ok('loadSession replays a tool_call', replayed.has('tool_call'), [...replayed].join(', '))
      ok(
        'loadSession returns modes + configOptions',
        (loaded?.modes?.availableModes?.length ?? 0) > 0 &&
          Array.isArray(loaded?.configOptions) &&
          loaded.configOptions.length === 2
      )
    })

    // 7 ------------------------------------------------------- session config/modes
    await step('setSessionConfigOption + setSessionMode', async () => {
      const updated = await conn.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'model',
        value: 'mock-deep'
      })
      const model = updated?.configOptions?.find((option) => option.id === 'model')
      ok(
        'setSessionConfigOption returns model.currentValue=mock-deep',
        model?.currentValue === 'mock-deep',
        JSON.stringify(model)
      )
      ok(
        'setSessionConfigOption keeps the other options intact',
        updated?.configOptions?.length === 2 &&
          updated.configOptions.find((option) => option.id === 'thought_level')?.currentValue === 'medium'
      )
      const mode = await conn.setSessionMode({ sessionId: session.sessionId, modeId: 'code' })
      ok('setSessionMode resolves', mode !== undefined && mode !== null, JSON.stringify(mode))
    })

    // 8 --------------------------------------------------------- clean shutdown path
    child.stdin.end()
    childExit = await waitForExit(2000)
    ok(
      'mock agent exits 0 when stdin closes',
      childExit?.code === 0,
      `code=${childExit?.code} signal=${childExit?.signal}`
    )
  } catch (err) {
    failures += 1
    failureLabels.push('unexpected error')
    console.log(`FAIL  unexpected error: ${err?.stack ?? err}`)
  } finally {
    clearTimeout(watchdog)
    if (!childExit && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }

  // -------------------------------------------------------------- final report

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)

  if (failures > 0) {
    const stderr = stderrChunks.join('').trim()
    if (stderr) {
      console.log('\n--- mock agent stderr ---')
      console.log(stderr)
      console.log('--- end mock agent stderr ---')
    }
  }

  console.log('')
  if (failures === 0) {
    console.log(`ALL PASS — ${passes} checks in ${elapsed}s`)
  } else {
    console.log(`FAILED — ${passes} passed, ${failures} failed in ${elapsed}s`)
    console.log(`Failed checks: ${failureLabels.join('; ')}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('selftest crashed:', err)
  process.exit(1)
})
