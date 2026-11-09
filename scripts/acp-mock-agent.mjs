#!/usr/bin/env node
/**
 * MIR — ACP mock agent (local test fixture).
 *
 * Speaks the Agent Client Protocol over stdio (newline-delimited JSON on
 * stdin/stdout) so the MIR ACP client layer and its renderer can be exercised
 * end to end with no real agent, no network and no login.
 *
 * Run it directly for a manual smoke test:
 *
 *   node scripts/acp-mock-agent.mjs < /dev/null     # exits 0
 *
 * Or let `scripts/acp-selftest.mjs` drive it as a child process.
 *
 * Only JSON-RPC frames may be written to stdout. Every human readable log line
 * goes to stderr, which MIR surfaces in the agent panel.
 */

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import path from 'node:path'

/** Delay between streamed chunks, in milliseconds. */
const CHUNK_DELAY_MS = 120

/** Number of chunks used for the canned markdown answer. */
const MESSAGE_CHUNK_COUNT = 16

/** Number of chunks used for the "slow" prompt (long enough to hit Stop). */
const SLOW_CHUNK_COUNT = 40

const AGENT_INFO = {
  name: 'mir-mock-agent',
  title: 'MIR Mock Agent',
  version: '1.0.0'
}

const AUTH_METHODS = [
  {
    id: 'mock-login',
    name: 'Mock login',
    description: 'No-op login for testing the ACP client layer'
  }
]

const AGENT_CAPABILITIES = {
  loadSession: true,
  sessionCapabilities: { list: {}, resume: {} },
  promptCapabilities: { image: false, audio: false, embeddedContext: true }
}

/** Session modes advertised by newSession / loadSession / resumeSession. */
const MODES = {
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: 'Ask', description: 'Answer questions without editing files' },
    { id: 'code', name: 'Code', description: 'Edit files in the workspace' }
  ]
}

/** Session config options advertised by newSession / loadSession. */
const CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    description: 'Model used for this session',
    category: 'model',
    type: 'select',
    currentValue: 'mock-fast',
    options: [
      { value: 'mock-fast', name: 'Mock Fast', description: 'Fastest mock model' },
      { value: 'mock-deep', name: 'Mock Deep', description: 'Deeper, slower mock model' }
    ]
  },
  {
    id: 'thought_level',
    name: 'Thinking',
    description: 'How much reasoning the mock model emits',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' }
    ]
  }
]

/** Slash commands pushed once per prompt turn. */
const AVAILABLE_COMMANDS = [
  { name: 'test', description: 'Run the mock test suite', input: { hint: '<suite>' } },
  { name: 'plan', description: 'Print a plan' }
]

/** Multi-step plan pushed once per prompt turn. */
const PLAN_ENTRIES = [
  { content: 'Inspect repo', status: 'completed', priority: 'high' },
  { content: 'Write docs', status: 'in_progress', priority: 'medium' },
  { content: 'Run tests', status: 'pending', priority: 'low' }
]

/** Reasoning text streamed as `agent_thought_chunk`. */
const THOUGHT_TEXT = [
  'Let me look at the repository before answering.',
  ' I want to understand how the ACP client is wired up,',
  ' which files it touches, and what the renderer expects.',
  ' First I will check package.json for the installed SDK version,',
  ' then I will summarise the flow in a short, friendly answer',
  ' with a little markdown so the renderer has something to chew on.'
].join('')

/** The canned markdown answer, streamed as `agent_message_chunk`. */
const MESSAGE_TEXT = [
  '# Mock answer',
  '',
  'This is a **mock** response from the MIR ACP fixture. It streams in chunks,',
  ' so the renderer can be verified end to end without a real agent.',
  '',
  '## What this exercises',
  '',
  '- Streaming markdown rendering',
  '- Inline `code` spans and **bold** text',
  '- Fenced code blocks',
  '- Headings, bullet lists and links',
  '',
  '## Example',
  '',
  '```ts',
  'const session = await conn.newSession({ cwd, mcpServers: [] })',
  'await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hi" }] })',
  '```',
  '',
  'See the [ACP documentation](https://agentclientprotocol.com) for the full protocol.',
  '',
  'That is all — no network, no login, no real model.'
].join('\n')

/** Per-session mutable state. */
class Session {
  constructor({ sessionId, cwd, title = null }) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.title = title
    this.modes = structuredClone(MODES)
    this.configOptions = structuredClone(CONFIG_OPTIONS)
    /** Set by `cancel`, cleared at the start of every prompt turn. */
    this.cancelled = false
    /** Callbacks fired when `cancel` lands, used to abort pending sleeps. */
    this.cancelListeners = new Set()
  }
}

/** Internal signal: the turn was cancelled or the client went away. */
class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

/** Write one log line to stderr (never stdout — that is the JSON-RPC channel). */
function log(line) {
  try {
    process.stderr.write(`[mock-agent] ${line}\n`)
  } catch {
    // stderr may already be closed; logging must never take the agent down.
  }
}

function truncate(text, max = 48) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Concatenate the text blocks of a prompt. */
function promptText(prompt) {
  return (prompt ?? [])
    .map((block) => (block && block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Split `text` into roughly `count` chunks, cutting on whitespace so streamed
 * markdown always stays well formed.
 */
function splitIntoChunks(text, count) {
  if (count <= 1 || text.length === 0) return [text]
  const words = text.split(/(?<=\s)/)
  const perChunk = Math.max(1, Math.ceil(words.length / count))
  const chunks = []
  for (let i = 0; i < words.length; i += perChunk) {
    chunks.push(words.slice(i, i + perChunk).join(''))
  }
  return chunks.length > 0 ? chunks : [text]
}

class MockAgent {
  #conn
  #sessions = new Map()
  #counter = 0

  constructor(conn) {
    this.#conn = conn
  }

  // ---------------------------------------------------------------- lifecycle

  async initialize(params) {
    return this.#run(
      'initialize',
      `protocolVersion=${params?.protocolVersion} client=${params?.clientInfo?.name ?? 'unknown'}`,
      async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: AGENT_CAPABILITIES,
        agentInfo: AGENT_INFO,
        authMethods: AUTH_METHODS
      })
    )
  }

  async authenticate(params) {
    return this.#run('authenticate', `method=${params?.methodId}`, async () => ({}))
  }

  // ------------------------------------------------------------------ sessions

  async newSession(params) {
    return this.#run(
      'newSession',
      `cwd=${params?.cwd} mcpServers=${(params?.mcpServers ?? []).length}`,
      async () => {
        const session = this.#createSession({ cwd: params.cwd, title: 'Mock session' })
        // Announce the title on the next macrotask so the `session/new` response
        // is written first — a client maps updates by sessionId, and real agents
        // never reference a session the client has not been told about yet.
        this.#emitAfterResponse(session, {
          sessionUpdate: 'session_info_update',
          title: session.title,
          updatedAt: new Date().toISOString()
        })
        return {
          sessionId: session.sessionId,
          modes: structuredClone(session.modes),
          configOptions: structuredClone(session.configOptions)
        }
      }
    )
  }

  async loadSession(params) {
    return this.#run(
      'loadSession',
      `session=${params?.sessionId} cwd=${params?.cwd}`,
      async () => {
        const session = this.#getOrCreateSession({
          sessionId: params.sessionId,
          cwd: params.cwd,
          title: 'Mock session'
        })
        session.cancelled = false

        // Replay a tiny conversation so the client has history to render.
        await this.#emit(session, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Replayed user message: what is in this repo?' }
        })
        await this.#emit(session, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Replayed user message: and how does the ACP client work?' }
        })
        await this.#emit(session, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Replayed agent answer: this is the MIR Electron app.' }
        })
        await this.#emit(session, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Replayed agent answer: the ACP client lives in the main process.' }
        })
        await this.#emit(session, {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-replay-1',
          title: 'Reading package.json',
          kind: 'read',
          status: 'completed',
          locations: [{ path: path.join(session.cwd, 'package.json'), line: 1 }]
        })

        return {
          modes: structuredClone(session.modes),
          configOptions: structuredClone(session.configOptions)
        }
      }
    )
  }

  async resumeSession(params) {
    return this.#run(
      'resumeSession',
      `session=${params?.sessionId} cwd=${params?.cwd}`,
      async () => {
        const session = this.#getOrCreateSession({
          sessionId: params.sessionId,
          cwd: params.cwd,
          title: 'Mock session'
        })
        session.cancelled = false
        return {
          modes: structuredClone(session.modes),
          configOptions: structuredClone(session.configOptions)
        }
      }
    )
  }

  async listSessions(params) {
    return this.#run(
      'listSessions',
      `cwd=${params?.cwd ?? '(all)'} cursor=${params?.cursor ?? '(none)'}`,
      async () => {
        const cwd = params?.cwd ?? process.cwd()
        const now = Date.now()
        const sessions = [
          {
            sessionId: 'mock-history-1',
            cwd,
            title: 'Fix the ACP integration',
            updatedAt: new Date(now - 60 * 60 * 1000).toISOString()
          },
          {
            sessionId: 'mock-history-2',
            cwd,
            updatedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
          },
          {
            sessionId: 'mock-history-3',
            cwd,
            title: 'A session title that is long enough to need truncation in the sidebar',
            updatedAt: new Date(now - 26 * 60 * 60 * 1000).toISOString()
          }
        ]
        return { sessions, nextCursor: null }
      }
    )
  }

  async setSessionMode(params) {
    return this.#run(
      'setSessionMode',
      `session=${params?.sessionId} mode=${params?.modeId}`,
      async () => {
        const session = this.#sessions.get(params.sessionId)
        const known = session?.modes.availableModes.some((mode) => mode.id === params.modeId)
        if (session && known) {
          session.modes.currentModeId = params.modeId
          try {
            await this.#emit(session, {
              sessionUpdate: 'current_mode_update',
              currentModeId: params.modeId
            })
          } catch (err) {
            log(`current_mode_update not delivered: ${err?.message ?? err}`)
          }
        }
        return {}
      }
    )
  }

  async setSessionConfigOption(params) {
    return this.#run(
      'setSessionConfigOption',
      `session=${params?.sessionId} ${params?.configId}=${JSON.stringify(params?.value)}`,
      async () => {
        const session = this.#sessions.get(params.sessionId)
        if (!session) {
          throw RequestError.invalidParams({ sessionId: params.sessionId }, 'unknown session')
        }
        const option = session.configOptions.find((entry) => entry.id === params.configId)
        if (!option) {
          throw RequestError.invalidParams({ configId: params.configId }, 'unknown config option')
        }
        if (option.type === 'boolean') {
          option.currentValue = Boolean(params.value)
        } else {
          option.currentValue = String(params.value)
        }
        log(`config option ${option.id} currentValue=${JSON.stringify(option.currentValue)}`)
        return { configOptions: structuredClone(session.configOptions) }
      }
    )
  }

  // -------------------------------------------------------------------- turns

  async prompt(params) {
    const session = this.#sessions.get(params?.sessionId)
    const text = promptText(params?.prompt)
    return this.#run(
      'prompt',
      `session=${params?.sessionId} text="${truncate(text)}"`,
      async () => {
        if (!session) {
          throw RequestError.invalidParams({ sessionId: params?.sessionId }, 'unknown session')
        }

        // A fresh turn always starts uncancelled.
        session.cancelled = false

        if (/\bfail\b/i.test(text)) {
          log('prompt -> refusal (prompt contained "fail")')
          return { stopReason: 'refusal' }
        }

        try {
          await this.#streamText(session, 'agent_thought_chunk', THOUGHT_TEXT, 6)

          if (text.includes('permission')) {
            await this.#runPermissionFlow(session)
          }

          if (text.includes('slow')) {
            await this.#streamSlow(session)
          } else {
            await this.#emit(session, {
              sessionUpdate: 'available_commands_update',
              availableCommands: structuredClone(AVAILABLE_COMMANDS)
            })
            await this.#emitToolCall(session)
            await this.#emitPlan(session)
            await this.#streamText(session, 'agent_message_chunk', MESSAGE_TEXT, MESSAGE_CHUNK_COUNT)
          }

          await this.#emit(session, { sessionUpdate: 'usage_update', used: 1234, size: 200000 })
          return { stopReason: 'end_turn' }
        } catch (err) {
          if (err instanceof CancelledError) {
            log(`prompt cancelled session=${session.sessionId}`)
            return { stopReason: 'cancelled' }
          }
          throw err
        }
      }
    )
  }

  /** `session/cancel` is a notification: flip the flag and wake pending sleeps. */
  async cancel(params) {
    await this.#run('cancel', `session=${params?.sessionId}`, async () => {
      const session = this.#sessions.get(params?.sessionId)
      if (!session) {
        log(`cancel for unknown session ${params?.sessionId}`)
        return
      }
      session.cancelled = true
      const listeners = [...session.cancelListeners]
      session.cancelListeners.clear()
      for (const listener of listeners) {
        try {
          listener()
        } catch (err) {
          log(`cancel listener failed: ${err?.message ?? err}`)
        }
      }
    })
  }

  // --------------------------------------------------------------- emit helpers

  async #emitToolCall(session) {
    const locationPath = path.join(session.cwd, 'package.json')
    await this.#emit(session, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Reading package.json',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: locationPath, line: 1 }],
      rawInput: { path: locationPath }
    })
    await this.#sleep(CHUNK_DELAY_MS, session)
    await this.#emit(session, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      content: [
        { type: 'content', content: { type: 'text', text: '{"name":"mir","version":"0.0.0","private":true…' } }
      ]
    })
    await this.#sleep(CHUNK_DELAY_MS, session)
    await this.#emit(session, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      rawOutput: { name: 'mir', private: true }
    })
  }

  async #emitPlan(session) {
    await this.#emit(session, {
      sessionUpdate: 'plan',
      entries: structuredClone(PLAN_ENTRIES)
    })
  }

  /** Ask the client for permission, then report the decision back as a chunk. */
  async #runPermissionFlow(session) {
    const toolCall = {
      toolCallId: 'tool-permission-1',
      title: 'Write file',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: path.join(session.cwd, 'mock-write.txt'), line: 1 }],
      rawInput: { path: path.join(session.cwd, 'mock-write.txt') }
    }

    await this.#emit(session, { sessionUpdate: 'tool_call', ...toolCall })

    const cancelWaiter = this.#waitForCancel(session)
    let response
    try {
      response = await Promise.race([
        this.#conn.requestPermission({
          sessionId: session.sessionId,
          toolCall,
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
          ]
        }),
        cancelWaiter.promise
      ])
    } catch (err) {
      if (err instanceof CancelledError) throw err
      // The client went away (or rejected the request); treat it as cancelled
      // rather than tearing down the JSON-RPC stream.
      log(`requestPermission failed: ${err?.message ?? err}`)
      return
    } finally {
      cancelWaiter.dispose()
    }

    const outcome = response?.outcome
    const decision =
      outcome?.outcome === 'selected' ? `selected:${outcome.optionId}` : (outcome?.outcome ?? 'cancelled')
    log(`permission decision=${decision}`)

    await this.#emit(session, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Permission decision: ${decision}\n` }
    })
    await this.#emit(session, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-permission-1',
      status: decision.startsWith('selected:') ? 'completed' : 'failed'
    })
  }

  /** Stream `count` numbered chunks, honouring cancellation between chunks. */
  async #streamSlow(session) {
    for (let index = 0; index < SLOW_CHUNK_COUNT; index += 1) {
      this.#throwIfCancelled(session)
      await this.#emit(session, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `chunk ${index + 1}/${SLOW_CHUNK_COUNT} ` }
      })
      await this.#sleep(CHUNK_DELAY_MS, session)
    }
  }

  /** Stream `text` as `count` roughly equal chunks of `updateKind`. */
  async #streamText(session, updateKind, text, count) {
    for (const chunk of splitIntoChunks(text, count)) {
      this.#throwIfCancelled(session)
      await this.#emit(session, {
        sessionUpdate: updateKind,
        content: { type: 'text', text: chunk }
      })
      await this.#sleep(CHUNK_DELAY_MS, session)
    }
  }

  async #emit(session, update) {
    if (this.#conn.signal?.aborted) throw new CancelledError('connection closed')
    try {
      await this.#conn.sessionUpdate({ sessionId: session.sessionId, update })
    } catch (err) {
      // The pipe is gone or the client rejected the update. Stop the turn; the
      // JSON-RPC stream itself stays intact.
      log(`sessionUpdate(${update?.sessionUpdate}) failed: ${err?.message ?? err}`)
      throw new CancelledError('session update could not be delivered')
    }
  }

  /**
   * Fire-and-forget an update on the next macrotask, i.e. strictly after the
   * response of the request currently being handled has been written. A client
   * maps updates by sessionId, so the `session/new` response must win the race.
   */
  #emitAfterResponse(session, update) {
    setTimeout(() => {
      this.#emit(session, update).catch((err) => {
        if (!(err instanceof CancelledError)) {
          log(`deferred ${update?.sessionUpdate} failed: ${err?.stack ?? err}`)
        }
      })
    }, 0)
  }

  /** Resolve after `ms`, or reject with CancelledError when the turn is cancelled. */
  #sleep(ms, session) {
    return new Promise((resolve, reject) => {
      if (session.cancelled || this.#conn.signal?.aborted) {
        reject(new CancelledError())
        return
      }
      const onCancel = () => {
        clearTimeout(timer)
        reject(new CancelledError())
      }
      const timer = setTimeout(() => {
        session.cancelListeners.delete(onCancel)
        resolve()
      }, ms)
      session.cancelListeners.add(onCancel)
    })
  }

  /** A promise that rejects as soon as the session is cancelled. */
  #waitForCancel(session) {
    let onCancel = null
    const promise = new Promise((_resolve, reject) => {
      onCancel = () => reject(new CancelledError())
      if (session.cancelled) {
        onCancel()
        return
      }
      session.cancelListeners.add(onCancel)
    })
    return {
      promise,
      dispose: () => {
        if (onCancel) session.cancelListeners.delete(onCancel)
      }
    }
  }

  #throwIfCancelled(session) {
    if (session.cancelled || this.#conn.signal?.aborted) {
      throw new CancelledError()
    }
  }

  // ------------------------------------------------------------------ utilities

  #createSession({ cwd, title = null, sessionId = null }) {
    this.#counter += 1
    const id = sessionId ?? `mock-${this.#counter}-${Math.random().toString(36).slice(2, 10)}`
    const session = new Session({ sessionId: id, cwd: cwd ?? process.cwd(), title })
    this.#sessions.set(id, session)
    return session
  }

  #getOrCreateSession({ sessionId, cwd, title }) {
    return this.#sessions.get(sessionId) ?? this.#createSession({ cwd, title, sessionId })
  }

  /**
   * Log one inbound request, run the handler, and turn any unexpected throw into
   * a proper JSON-RPC error (the SDK does that too, but we want the stack trace
   * on stderr as well).
   */
  async #run(name, summary, fn) {
    log(`${name}${summary ? ` ${summary}` : ''}`)
    try {
      return await fn()
    } catch (err) {
      if (err instanceof RequestError) {
        log(`${name} rejected: ${err.code} ${err.message}`)
        throw err
      }
      log(`ERROR in ${name}: ${err?.stack ?? err}`)
      throw RequestError.internalError(
        { details: String(err?.message ?? err) },
        `mock agent ${name} failed`
      )
    }
  }
}

// --------------------------------------------------------------------- runtime

let shuttingDown = false

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  // Let any already-scheduled stdout write settle before leaving.
  setTimeout(() => process.exit(code), 0)
}

function main() {
  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  const conn = new AgentSideConnection((connection) => new MockAgent(connection), stream)

  process.stdin.on('end', () => {
    log('stdin ended, exiting')
    shutdown(0)
  })
  process.stdin.on('close', () => shutdown(0))
  process.stdin.on('error', (err) => {
    log(`stdin error: ${err?.message ?? err}`)
    shutdown(0)
  })

  process.on('SIGTERM', () => {
    log('SIGTERM, exiting')
    shutdown(0)
  })
  process.on('SIGINT', () => {
    log('SIGINT, exiting')
    shutdown(0)
  })

  // A fixture should never take the editor down: log loudly, then leave.
  process.on('uncaughtException', (err) => {
    log(`uncaughtException: ${err?.stack ?? err}`)
    shutdown(0)
  })
  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection: ${reason?.stack ?? reason}`)
  })

  conn.closed.then(
    () => {
      log('connection closed')
      shutdown(0)
    },
    (err) => {
      log(`connection closed with error: ${err?.message ?? err}`)
      shutdown(0)
    }
  )
}

main()
