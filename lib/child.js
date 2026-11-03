import { randomUUID } from 'node:crypto'

/**
 * Mirror one `codex_exec` run as a native DSH child conversation.
 *
 * The host packages are resolved through DSH's own plugin loader, so they are
 * imported dynamically: if this host does not expose them, the plugin degrades
 * to the plain tool card instead of failing to load.
 */
export const PROVIDER_NAME = 'codex-exec'

let modules = null

export async function loadHostModules() {
  if (modules) return modules
  try {
    const [llm, session, subagent] = await Promise.all([
      import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-session'),
      import('@deepseek-ai/dsh-subagent'),
    ])
    modules = { llm, session, subagent }
  } catch (error) {
    modules = { error: error instanceof Error ? error : new Error(String(error)) }
  }
  return modules
}

/** Sidebar address of the built-in subagent chat for one child session. */
export function subagentChatAddress(parentSessionId, childSessionId) {
  const query = new URLSearchParams({ parent: parentSessionId, mode: 'one-shot' })
  return `dsh-resource://subagentchat/session/${encodeURIComponent(childSessionId)}?${query}`
}

function clampText(text, limit = 4000) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}\n…（已截断）` : value
}

function toolName(item) {
  if (item?.type === 'command_execution') return 'commandExecution'
  if (typeof item?.name === 'string' && item.name) return item.name
  return typeof item?.type === 'string' && item.type ? item.type : 'codex-tool'
}

function toolArguments(item) {
  const args = {}
  for (const key of ['command', 'cwd', 'path', 'query', 'url']) {
    if (typeof item?.[key] === 'string' && item[key]) args[key] = item[key]
  }
  return args
}

function toolOutput(item) {
  const parts = []
  for (const key of ['aggregated_output', 'output', 'stdout']) {
    if (typeof item?.[key] === 'string' && item[key].trim()) parts.push(item[key])
  }
  if (item?.type !== 'agent_message' && typeof item?.text === 'string' && item.text.trim()) parts.push(item.text)
  return clampText(parts.join('\n').trim())
}

export class ChildMirror {
  constructor(handle, terminal, llm) {
    this.handle = handle
    this.terminal = terminal
    this.llm = llm
    this.session = handle.agent.session
    this.id = handle.agent.id
    this.turn = 0
    this.step = 0
    this.opened = false
    this.closed = false
    this.model = null
    this.toolCalls = new Map()
    this.emitted = new Set()
  }

  /** Prefer the host's own message builders; fall back to the plain shape. */
  userMessage(prompt) {
    try {
      if (this.llm?.createUserMessage) {
        return this.llm.createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
      }
    } catch {
      // Fall through to the plain shape.
    }
    return { content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }
  }

  assistantMessage(text, model) {
    const source = { provider: 'codex', model: model ? `codex/${model}` : 'codex' }
    try {
      if (this.llm?.createAssistantMessage) {
        return this.llm.createAssistantMessage({ content: [{ type: 'text', text }], source })
      }
    } catch {
      // Fall through to the plain shape.
    }
    return { role: 'assistant', content: [{ type: 'text', text }], source }
  }

  toolResultMessage(callId, isError, text) {
    const content = [{ type: 'text', text }]
    try {
      if (this.llm?.createToolResultMessage) {
        return this.llm.createToolResultMessage({ callId, isError, content })
      }
    } catch {
      // Fall through to the plain shape.
    }
    return { role: 'tool', callId, isError, content }
  }

  newCallId() {
    try {
      if (this.llm?.ToolCallId) return this.llm.ToolCallId(randomUUID())
    } catch {
      // Fall through to a plain unique string.
    }
    return randomUUID()
  }

  /**
   * Commit one assistant text block as its own step.
   *
   * The native subagent chat renders one assistant message per step, so writing
   * several messages into a single step made every new message replace the
   * previous one. One step per message keeps the workflow continuous.
   */
  appendAssistant(text) {
    if (!this.opened || this.closed || typeof text !== 'string' || !text.trim()) return
    this.emitted.add(text.trim())
    this.step += 1
    const step = this.step
    this.session.append('step/start', { turn: this.turn, step })
    const time = Date.now()
    const stream = [
      { type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time, chunk: { type: 'text-delta', index: 0, text } },
      { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } },
      { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]
    this.session.append('assistant/message', {
      turn: this.turn,
      step,
      stream,
      message: this.assistantMessage(text, this.model),
    }, { surfaceOp: 'append' })
    this.session.append('step/end', { turn: this.turn, step })
  }

  /** Show one Codex tool/command invocation as a native tool card. */
  appendToolCall(callId, name, args) {
    if (!this.opened || this.closed) return
    this.session.append('tool/call', {
      turn: this.turn,
      step: this.step,
      callId,
      name,
      arguments: JSON.stringify(args ?? {}),
    })
  }

  appendToolResult(callId, isError, text) {
    if (!this.opened || this.closed) return
    this.session.append('tool/result', {
      turn: this.turn,
      step: this.step,
      message: this.toolResultMessage(callId, isError, text),
    }, { surfaceOp: 'append' })
  }

  /**
   * Mirror one `codex exec --json` event into the child conversation as it
   * happens, so the child session shows Codex's workflow (commands, outputs,
   * intermediate messages) instead of only the final answer.
   */
  progress(event) {
    if (!this.opened || this.closed) return
    const item = event?.item
    if (!item || typeof item !== 'object') return
    const phase = event.type === 'item.started' ? 'started'
      : event.type === 'item.completed' ? 'completed'
        : null
    if (!phase) return

    if (item.type === 'agent_message') {
      if (phase === 'completed' && typeof item.text === 'string' && item.text.trim()) this.appendAssistant(item.text)
      return
    }
    if (item.type === 'reasoning') {
      if (phase === 'completed' && typeof item.text === 'string' && item.text.trim()) this.appendAssistant(`[思考] ${item.text}`)
      return
    }
    if (item.type === 'error') {
      if (phase !== 'completed') return
      const message = String(item.message ?? '')
      // Codex reports environment warnings as error items; they are noise in the
      // workflow transcript, not part of what Codex did.
      if (/under-development features|suppress_unstable_features_warning/i.test(message)) return
      this.appendAssistant(`⚠️ ${message || 'Codex reported an error'}`)
      return
    }

    // Commands and other tool work are mirrored as plain assistant text. The
    // child-session host validates tool/result pairing, and a rejected append
    // used to vanish silently; text always survives, which is what makes
    // Codex's workflow visible while it runs.
    if (phase === 'started') {
      const name = toolName(item)
      const args = toolArguments(item)
      const detail = args.command || args.path || args.query || args.url || ''
      this.appendAssistant(detail ? `→ ${name}：\`${clampText(detail, 240)}\`` : `→ ${name}`)
      return
    }

    const exitCode = item.exit_code ?? item.exitCode
    const failed = item.status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0)
    const output = toolOutput(item)
    const suffix = typeof exitCode === 'number' ? `（exit ${exitCode}）` : ''
    if (!output || output === '（无输出）') {
      this.appendAssistant(failed ? `✗ 失败${suffix}` : `✓ 完成${suffix}`)
      return
    }
    this.appendAssistant(`${failed ? '✗' : '✓'} 输出${suffix}：\n\`\`\`\n${clampText(output, 1500)}\n\`\`\``)
  }

  open(prompt, descriptor) {
    if (this.opened) return
    this.turn = 1
    // Steps are opened by appendAssistant, one per message.
    this.step = 0
    this.session.append('turn/start', { turn: this.turn })
    if (descriptor) this.session.append('subagent/descriptor', descriptor)
    this.session.append('user/message', this.userMessage(prompt), { surfaceOp: 'append' })
    this.opened = true
  }

  /**
   * Finish the turn. Streaming already wrote intermediate messages, so the final
   * text is only appended when it is actually new (a one-shot run whose only
   * output is the final answer still shows it).
   */
  close(text, ok, model) {
    if (this.closed || !this.opened) return
    if (model) this.model = model
    const body = typeof text === 'string' && text.trim()
      ? text
      : ok ? '（Codex 未返回文本）' : '（Codex 执行失败，无文本输出）'
    if (!this.emitted.has(body.trim())) this.appendAssistant(body)
    this.closed = true
    this.session.append('turn/end', {
      turn: this.turn,
      reason: ok ? { kind: 'completed' } : { kind: 'error', error: { message: 'Codex execution failed', code: 'UNKNOWN' } },
    })
  }
}

export class ChildSessionFactory {
  constructor(agents, subagents, modules) {
    this.agents = agents
    this.subagents = subagents
    this.modules = modules
    this.children = new Map()
    this.unregister = null
  }

  register() {
    const factory = this
    const provider = {
      name: PROVIDER_NAME,
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
      async start(request) {
        return factory.startProvider(request)
      },
    }
    this.unregister = this.subagents.registerProvider(provider)
    return this
  }

  async startProvider(request) {
    const parent = request.parent
    const { SessionId } = this.modules.session
    const { childSessionMeta } = this.modules.subagent
    const id = SessionId(randomUUID())
    const depth = Number(parent?.session?.header?.delegationDepth ?? 0) + 1
    const inherited = parent?.ctx
      ? childSessionMeta(parent, depth, false)
      : {
        cwd: parent?.session?.header?.cwd,
        parentSession: parent?.id,
        origin: 'subagent',
        delegationDepth: depth,
      }
    const handle = await this.agents.create({
      sessionId: id,
      parentAgent: parent,
      signal: request.signal,
      meta: {
        ...inherited,
        agentPreset: inherited.agentPreset ?? parent?.session?.header?.agentPreset ?? 'standard',
      },
    })
    const mirror = new ChildMirror(handle, request.descriptor, this.modules.llm)
    this.children.set(id, mirror)
    return {
      id,
      localAgent: handle.agent,
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: async () => {
        this.children.delete(id)
        try {
          await handle.dispose()
        } catch {
          // Disposing a child must not mask the run's own outcome.
        }
      },
    }
  }

  /**
   * Create the child conversation for one execution and write its opening
   * turn. Returns null when this host cannot host child sessions.
   */
  async open({ parent, prompt, label, descriptor }) {
    if (!this.agents || !this.subagents || !this.modules || this.modules.error) return null
    if (typeof this.subagents.registerProvider !== 'function' || typeof this.agents.create !== 'function') return null
    try {
      const run = await this.startProvider({
        parent,
        label,
        prompt: [{ type: 'text', text: prompt }],
        signal: undefined,
        descriptor,
      })
      const mirror = this.children.get(run.id)
      if (!mirror) return null
      mirror.open(prompt, descriptor)
      const parentSession = parent?.session
      if (parentSession?.append && descriptor) {
        parentSession.append('subagent/catalog', {
          version: 0,
          childId: mirror.id,
          childCreatedAt: mirror.session?.header?.createdAt,
          mode: 'one-shot',
          label,
        })
      }
      return {
        childId: mirror.id,
        address: parent?.session?.id ? subagentChatAddress(parent.session.id, mirror.id) : null,
        // Streaming is the whole point: without this the caller's
        // `child?.progress(event)` silently no-ops and the child session only
        // ever shows the final answer.
        progress: (event) => mirror.progress(event),
        finish: (text, ok, model) => mirror.close(text, ok, model),
        dispose: run.dispose,
      }
    } catch {
      // A host that rejects child sessions still gets the execution result.
      return null
    }
  }
}

/** Snapshot used by the host to describe a one-shot child in its catalog. */
export function oneShotDescriptor(modules, label) {
  try {
    return modules?.subagent?.snapshotSubagentDescriptor
      ? modules.subagent.snapshotSubagentDescriptor({ mode: 'one-shot', provider: PROVIDER_NAME, label })
      : null
  } catch {
    return null
  }
}
