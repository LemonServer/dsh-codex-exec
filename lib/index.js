import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { ChildSessionFactory, loadHostModules, oneShotDescriptor } from './child.js'

export const name = 'dsh-codex-exec'
// Only the tool seam is injected. Child-session services are fetched lazily at
// call time: a hard `inject` on a service this host does not expose would leave
// the whole plugin pending and remove the tool from the session.
export const inject = ['tools', 'systemPrompt', 'agents', 'subagents']

const DEFAULTS = {
  codexCommand: 'codex',
  sandbox: 'workspace-write',
  timeoutMs: 900_000,
  stderrTail: 4_000,
  defaultModel: 'gpt-6-luna',
  defaultEffort: 'medium',
  defaultRole: 'executor',
  // Empty means "read Codex's own catalog". Set to a list of slugs to restrict.
  models: [],
}

/** Role presets: what Codex is allowed to do, and the instruction it starts from. */
const ROLE_PRESETS = {
  executor: {
    preamble: 'You are the EXECUTOR for this task. Implement exactly what is asked, modify files as needed, and verify your work by running commands. Do not expand scope.',
    writable: true,
  },
  reviewer: {
    preamble: 'You are a REVIEWER. Do not modify any file. Inspect the workspace read-only, then report concrete findings with file paths and severity, plus what you verified. Do not implement or fix anything.',
    writable: false,
  },
  planner: {
    preamble: 'You are a PLANNER. Do not modify any file. Produce a concrete, ordered implementation plan with the files to touch and executable acceptance checks. Do not implement.',
    writable: false,
  },
}

/**
 * Per-model reasoning levels straight from Codex's own catalog:
 * `~/.codex/models_cache.json` carries `supported_reasoning_levels` per slug and
 * is refreshed by Codex itself. Nothing here is hardcoded, so a model or level
 * added by a future Codex build appears without a plugin release.
 */
const FALLBACK_MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol']
const FALLBACK_EFFORTS = ['low', 'medium', 'high']

function readModelCatalog(config) {
  const allow = Array.isArray(config.models) && config.models.length > 0 ? new Set(config.models) : null
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'))
    const list = Array.isArray(raw?.models) ? raw.models : []
    const models = list
      .filter((entry) => entry && typeof entry.slug === 'string' && entry.slug !== 'codex-auto-review')
      .filter((entry) => !allow || allow.has(entry.slug))
      .map((entry) => {
        // Keep Codex's own order and vocabulary: no allow-list, no renaming.
        const levels = Array.isArray(entry.supported_reasoning_levels)
          ? entry.supported_reasoning_levels
            .map((level) => level?.effort)
            .filter((effort) => typeof effort === 'string' && effort.length > 0)
          : []
        const declaredDefault = typeof entry.default_reasoning_level === 'string' ? entry.default_reasoning_level : ''
        return {
          id: entry.slug,
          efforts: levels.length > 0 ? levels : FALLBACK_EFFORTS,
          defaultEffort: levels.includes(declaredDefault) ? declaredDefault : (levels[0] ?? 'medium'),
        }
      })
    if (models.length > 0) return models
  } catch {
    // Codex has not written its catalog yet; fall back to conservative defaults.
  }
  return FALLBACK_MODELS.map((id) => ({ id, efforts: FALLBACK_EFFORTS, defaultEffort: 'medium' }))
}

/**
 * Canonical ordering derived from the catalogs themselves (widest list first),
 * so an unknown level from a future Codex build still sorts sensibly.
 */
function effortOrder(models) {
  const seen = []
  for (const entry of models) {
    for (const level of entry.efforts) if (!seen.includes(level)) seen.push(level)
  }
  return seen
}

/** Keep the requested level when supported, otherwise the closest one below it. */
function clampEffort(entry, effort, order) {
  if (!entry) return effort
  if (entry.efforts.includes(effort)) return effort
  const requestedRank = order.indexOf(effort)
  if (requestedRank < 0) return entry.defaultEffort
  const usable = entry.efforts
    .filter((level) => order.indexOf(level) >= 0 && order.indexOf(level) <= requestedRank)
    .sort((a, b) => order.indexOf(b) - order.indexOf(a))
  return usable[0] ?? entry.defaultEffort
}

function effortFor(models, model, effort) {
  const entry = models.find((candidate) => candidate.id === model) ?? models[0]
  if (!entry) return { model, effort, entry: null }
  return { model: entry.id, effort: clampEffort(entry, effort, effortOrder(models)), entry }
}

/**
 * Authoritative catalog from Codex's own app-server (`model/list`). The
 * `~/.codex/models_cache.json` file is only a snapshot and can lag behind or be
 * filtered per account, which made the selector look incomplete.
 */
function queryAppServerModels(config) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(resolveCodexCommand(config.codexCommand), ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch {
      resolve(null)
      return
    }
    let buffer = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 8000)
    child.on('error', () => { clearTimeout(timer); finish(null) })
    child.on('exit', () => { clearTimeout(timer); finish(null) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('{')) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 2) {
          clearTimeout(timer)
          finish(message.result?.data ?? [])
          return
        }
      }
    })
    const send = (payload) => {
      try { child.stdin.write(`${JSON.stringify(payload)}\n`) } catch {}
    }
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'dsh-codex-exec', version: '0.3.0' }, capabilities: { experimentalApi: true } },
    })
    send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })
  })
}

function mapAppServerModels(data, config) {
  const allow = Array.isArray(config.models) && config.models.length > 0 ? new Set(config.models) : null
  const models = (Array.isArray(data) ? data : [])
    .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== 'codex-auto-review' && entry.hidden !== true)
    .filter((entry) => !allow || allow.has(entry.id))
    .map((entry) => {
      const efforts = (entry.supportedReasoningEfforts ?? [])
        .map((level) => level?.reasoningEffort)
        .filter((effort) => typeof effort === 'string' && effort.length > 0)
      const declared = typeof entry.defaultReasoningEffort === 'string' ? entry.defaultReasoningEffort : ''
      return {
        id: entry.id,
        efforts: efforts.length > 0 ? efforts : FALLBACK_EFFORTS,
        defaultEffort: efforts.includes(declared) ? declared : (efforts[0] ?? 'medium'),
      }
    })
  return models.length > 0 ? models : null
}

const CATALOG_TTL_MS = 5 * 60 * 1000
let catalogCache = { at: 0, models: null }

async function ensureCatalog(config) {
  if (catalogCache.models && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models
  const fromAppServer = mapAppServerModels(await queryAppServerModels(config), config)
  const models = fromAppServer ?? readModelCatalog(config)
  catalogCache = { at: Date.now(), models }
  return models
}

function buildPrompt(role, task) {
  const preset = ROLE_PRESETS[role] ?? ROLE_PRESETS.executor
  return `${preset.preamble}\n\n----- TASK -----\n${task}`
}

const jsonOutput = {
  // Full JSON Schema: this plugin registers a plain descriptor, so the host
  // validates it verbatim and rejects defineTool's `{ type: 'json' }` shorthand.
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: renderCard(value) }],
}

/**
 * The user-facing card for one delegation: which model ran, whose job it was,
 * and what came back. This is what makes the Codex work explicit in the DSH
 * session instead of hiding it inside a JSON blob.
 */
function renderCard(value) {
  const result = value ?? {}
  const lines = []
  const status = result.ok ? '成功' : '失败'
  const seconds = typeof result.durationMs === 'number' ? `${(result.durationMs / 1000).toFixed(1)}s` : 'n/a'
  const roleLabel = result.role ? { executor: '执行者', reviewer: '审查者', planner: '规划者' }[result.role] ?? result.role : '执行者'
  lines.push(`**Codex ${roleLabel}** · 模型 \`${result.model ?? '未知'}\` · effort \`${result.effort ?? '默认'}\` · ${status} · ${seconds}`)
  if (result.scope) lines.push(`- 负责范围：${result.scope}`)
  if (result.subagent?.childId) lines.push(`- 子会话：\`${result.subagent.childId}\`（右侧栏 Codex 会话）`)
  else if (result.subagentError) lines.push(`- 子会话：未创建（${result.subagentError}）`)
  if (result.threadId) lines.push(`- 会话线程：\`${result.threadId}\``)
  if (result.usage) {
    lines.push(`- 用量：${result.usage.input_tokens ?? '?'} in / ${result.usage.output_tokens ?? '?'} out`)
  }
  const changed = Array.isArray(result.changedFiles) ? result.changedFiles.filter(Boolean) : null
  lines.push(`- 工作区改动：${changed ? (changed.join('、') || '（无）') : '（非 git 工作区，未采集）'}`)
  if (result.finalMessage) {
    const text = String(result.finalMessage).trim()
    lines.push(`- Codex 自述：${text.length > 700 ? `${text.slice(0, 700)}…` : text}`)
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    lines.push(`- 告警：${result.errors.join('；').slice(0, 300)}`)
  }
  if (!result.ok) lines.push('- ⚠️ 未成功，不要把它当成已完成；需要排查或重试。')
  return lines.join('\n')
}

/**
 * Codex Desktop keeps a complete toolchain (codex.exe + codex-code-mode-host.exe
 * + command runner) under a per-version directory. A codex binary without that
 * host cannot execute any tool at all, so prefer one that has it and fall back
 * to the configured path.
 */
function resolveCodexCommand(configured) {
  const complete = (candidate) => {
    try {
      return existsSync(candidate) && existsSync(join(dirname(candidate), 'codex-code-mode-host.exe'))
    } catch {
      return false
    }
  }

  if (typeof configured === 'string' && complete(configured)) return configured

  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin'),
  ]
  for (const root of roots) {
    try {
      if (root.endsWith('bin') && complete(join(root, 'codex.exe'))) return join(root, 'codex.exe')
      const candidates = readdirSync(root)
        .map((entry) => join(root, entry, 'codex.exe'))
        .filter(complete)
        .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (candidates.length > 0) return candidates[0].file
    } catch {
      // Try the next known root.
    }
  }

  return configured
}

/**
 * Run `codex exec --json` in `cwd` and reduce its event stream to the last
 * agent message plus usage. stdin is `ignore`: codex appends piped stdin to the
 * prompt, and an inherited handle would make it wait for EOF forever.
 */
function runCodex(config, args, exec, onEvent) {
  const task = typeof args?.task === 'string' ? args.task.trim() : ''
  if (!task) throw new Error('codex_exec requires a non-empty task')

  const cwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : process.cwd()
  const role = ROLE_PRESETS[args?.role] ? args.role : config.defaultRole
  const preset = ROLE_PRESETS[role] ?? ROLE_PRESETS.executor
  // Reviewers and planners are read-only by construction, never just by prompt.
  const requestedSandbox = typeof args?.sandbox === 'string' && args.sandbox ? args.sandbox : config.sandbox
  const sandbox = preset.writable ? requestedSandbox : 'read-only'
  const requestedModel = (typeof args?.model === 'string' && args.model.trim()) || config.defaultModel
  const requestedEffort = typeof args?.effort === 'string' && args.effort.trim() ? args.effort.trim() : config.defaultEffort
  // Clamp to what the chosen model actually supports (luna has no `ultra`).
  const catalog = Array.isArray(config.modelCatalog) && config.modelCatalog.length > 0
    ? config.modelCatalog
    : readModelCatalog(config)
  const { model, effort } = effortFor(catalog, requestedModel, requestedEffort)
  const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : config.timeoutMs

  const argv = ['exec', '--json', '--skip-git-repo-check', '-s', sandbox, '-C', cwd]
  if (model) argv.push('-m', model)
  if (effort) argv.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`)
  argv.push(buildPrompt(role, task))
  const command = resolveCodexCommand(config.codexCommand)
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.max(5_000, timeoutMs))

    const onAbort = () => child.kill()
    if (exec?.signal) {
      if (exec.signal.aborted) onAbort()
      else exec.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let pending = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (typeof onEvent !== 'function') return
      // codex exec emits one JSON object per line; mirror each event as soon as
      // its line is complete so the child session shows live progress.
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line.startsWith('{')) {
          try {
            onEvent(JSON.parse(line))
          } catch {
            // A malformed line is diagnostics, not a session event.
          }
        }
        newline = pending.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (exec?.signal) exec.signal.removeEventListener?.('abort', onAbort)
      fn()
    }

    child.on('error', (error) => {
      finish(() => reject(new Error(`failed to spawn ${command}: ${error.message}`)))
    })

    child.on('close', (code, signal) => {
      finish(async () => {
        try {
          resolve(await summarize({
            code,
            signal,
            timedOut,
            stdout,
            stderr,
            config,
            cwd,
            command,
            startedAt,
            model,
            effort,
            role,
            scope: typeof args?.scope === 'string' ? args.scope.trim() : null,
          }))
        } catch (error) {
          reject(error)
        }
      })
    })
  })
}

function parseEvents(stdout) {
  const events = []
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      events.push(JSON.parse(text))
    } catch {
      // A partial or non-JSON line is diagnostic noise, not a result.
    }
  }
  return events
}

function gitStatus(cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    const timer = setTimeout(() => child.kill(), 5_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : null)
    })
  })
}

async function summarize({ code, signal, timedOut, stdout, stderr, config, cwd, command, startedAt, model, scope, effort, role }) {
  const events = parseEvents(stdout)
  let threadId = null
  let finalMessage = null
  let usage = null
  const errors = []
  let toolEvents = 0

  for (const event of events) {
    if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id
    if (event.type === 'turn.completed' && event.usage) usage = event.usage
    if (event.type !== 'item.completed' || !event.item) continue
    const item = event.item
    if (item.type === 'agent_message' && typeof item.text === 'string') finalMessage = item.text
    else if (item.type === 'error') errors.push(String(item.message ?? 'unknown error'))
    else toolEvents += 1
  }

  const changedFiles = await gitStatus(cwd)
  const tail = stderr.trim().slice(-Math.max(200, config.stderrTail))

  return {
    ok: code === 0 && !timedOut,
    exitCode: code,
    signal: signal ?? null,
    timedOut,
    model: model ?? null,
    effort: effort ?? null,
    role: role ?? null,
    scope: scope ?? null,
    durationMs: Date.now() - startedAt,
    codexCommand: command,
    threadId,
    finalMessage,
    usage,
    toolEvents,
    errors,
    stderrTail: tail || null,
    changedFiles,
  }
}

export const DELEGATION_SECTION_NAME = 'plugin:dsh-codex-exec:delegation'
export const DELEGATION_SECTION_ORDER = 195

/**
 * The model-facing contract that makes each delegation explicit in the
 * transcript: announce the model and the responsibility BEFORE the call, and
 * never present Codex's self-report as verification.
 */
const DELEGATION_GUIDANCE = [
  'DSH CODEX EXECUTION POLICY (dsh-codex-exec)',
  'This session can hand write-capable execution to Codex through the `codex_exec` tool. DSH remains the planner and the reviewer; Codex only executes the bounded task you give it.',
  'Before every `codex_exec` call, state one line in the conversation: 「委托 Codex(<model> @ <effort>, <role>) 执行：<一句话范围>」. State the EFFECTIVE values (after defaults), never a value the call does not use.',
  'Three knobs are selectable per call: `model` (e.g. gpt-6-luna), `effort` (low|medium|high|xhigh|max) and `role` (executor|reviewer|planner). When the user names any of them, pass exactly those values. When the user has not chosen, use the plugin defaults and say which defaults you used. Never silently change a value the user chose.',
  'Roles are enforced, not just prompted: reviewer and planner run in a read-only sandbox and cannot modify files; executor may write. Delegate a review to role=reviewer and an implementation to role=executor.',
  'Always pass `scope`: a short, user-visible statement of what Codex is responsible for in this call (files or area + the change). It is rendered into the result card.',
  '`task` must be self-contained: Codex cannot see this conversation, cannot ask questions, and cannot read the plan unless you include it.',
  'After the call, report what Codex actually produced and what YOU verified independently (files, tests, real command output). Never treat the returned `finalMessage` as proof of correctness, and never claim a check ran when it did not.',
  'If the result has `ok: false`, say so plainly and diagnose; do not present partial work as done.',
  'Prefer one delegation per coherent unit of work. Do not delegate trivial edits that DSH can do directly.',
].join('\n')

export function apply(ctx, raw) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const state = {
    factory: null,
    modules: null,
    setupError: null,
    attempted: false,
    // Live selection driven by the composer widget; falls back to config defaults.
    selection: {
      model: config.defaultModel,
      effort: config.defaultEffort,
      role: config.defaultRole,
    },
  }

  // Out-of-band breadcrumb: if the tool never appears, this file proves whether
  // apply() ran at all. Only `tools` is injected, so optional services are read
  // through ctx.get(): touching an uninjected property throws inside cordis.
  try {
    writeFileSync(join(tmpdir(), 'dsh-codex-exec-apply.json'), JSON.stringify({
      at: new Date().toISOString(),
      version: '0.2.0',
      tools: Boolean(ctx?.tools?.register),
      systemPrompt: Boolean(ctx?.get?.('systemPrompt')),
      agents: Boolean(ctx?.get?.('agents')),
      subagents: Boolean(ctx?.get?.('subagents')),
      config,
    }, null, 2))
  } catch (error) {
    try {
      console.error('[dsh-codex-exec] breadcrumb failed:', error instanceof Error ? error.message : String(error))
    } catch {
      // Nothing else to do if even stderr is unavailable.
    }
  }

  /** Build the child-session factory on first use, never during apply(). */
  const ensureFactory = async () => {
    if (state.factory || state.attempted) return state.factory
    state.attempted = true
    try {
      const modules = await loadHostModules()
      state.modules = modules
      if (!modules || modules.error) {
        state.setupError = modules?.error?.message ?? 'host modules unavailable'
        return null
      }
      const agents = ctx.agents ?? ctx.get?.('agents')
      const subagents = ctx.subagents ?? ctx.get?.('subagents')
      if (!agents || !subagents) {
        state.setupError = 'agents/subagents service unavailable'
        return null
      }
      state.factory = new ChildSessionFactory(agents, subagents, modules).register()
      return state.factory
    } catch (error) {
      state.setupError = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  // The tool is registered first and unconditionally: every optional capability
  // below may fail without taking the tool away from the session.
  const dispose = ctx.tools.register({
    name: 'codex_exec',
    description: 'Hand a self-contained execution task to Codex (codex exec) and return its final message, usage and working-tree changes. Use this when DSH has already produced the plan: DSH plans and reviews, Codex performs the write-capable execution. The task must be complete and self-contained because Codex cannot ask follow-up questions. Codex runs in `cwd` under the given sandbox mode; it will not see this conversation. The result card shows the model and the scope, so the user can see exactly which Codex model did what, plus the child session it was mirrored into. Inspect the returned changedFiles and message before claiming the work is done.',
    // Full JSON Schema, not defineTool's shorthand: this descriptor is sent to
    // the model provider verbatim, and a parameters object without
    // `type: "object"` is rejected there (the whole session's requests fail).
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, self-contained instruction for Codex. Include paths, constraints and acceptance criteria.' },
        model: { type: 'string', description: 'Codex model slug for this run, e.g. gpt-6-luna. Defaults to the plugin config (gpt-6-luna).' },
        effort: { type: 'string', description: 'Reasoning effort id, exactly as Codex names it (currently low|medium|high|xhigh|max|ultra, per-model). Unknown or unsupported levels are clamped to the closest level the chosen model supports. Defaults to the current selector value.' },
        role: { type: 'string', enum: Object.keys(ROLE_PRESETS), description: 'executor (may write files), reviewer (read-only findings), or planner (read-only plan). Defaults to the plugin config (executor). Reviewers and planners are forced to a read-only sandbox.' },
        scope: { type: 'string', description: 'Short user-visible statement of what Codex is responsible for (area + change). Rendered into the result card and used as the child session label.' },
        cwd: { type: 'string', description: 'Absolute working directory for Codex. Defaults to the host process cwd.' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Codex sandbox mode. Defaults to the plugin config (workspace-write).' },
        timeoutMs: { type: 'number', description: 'Override the execution timeout in milliseconds.' },
      },
      required: ['task', 'scope'],
      additionalProperties: false,
    },
    output: jsonOutput,
    timeoutMs: config.timeoutMs,
    execute: async (args, exec) => {
      const factory = await ensureFactory()
      const child = factory
        ? await factory.open({
          parent: exec?.agent,
          prompt: args.task,
          label: args.scope || String(args.task).slice(0, 72),
          descriptor: oneShotDescriptor(state.modules, args.scope || 'Codex 执行'),
        })
        : null
      try {
        // The composer widget's live selection overrides the static defaults; an
        // explicit argument on the call still wins over both.
        // Refresh from the app-server so an execution never uses a model list
        // that only came from a stale snapshot.
        const models = await ensureCatalog(config)
        catalog = models
        const result = await runCodex({
          ...config,
          defaultModel: state.selection.model,
          defaultEffort: state.selection.effort,
          defaultRole: state.selection.role,
          modelCatalog: models,
        }, args, exec, (event) => {
          try {
            child?.progress(event)
          } catch {
            // Live mirroring must never fail the execution itself.
          }
        })
        child?.finish(result.finalMessage, result.ok, result.model)
        return child
          ? { ...result, subagent: { childId: child.childId, address: child.address } }
          : { ...result, subagent: null, subagentError: state.setupError }
      } catch (error) {
        child?.finish(error instanceof Error ? error.message : String(error), false, args?.model)
        throw error
      } finally {
        await child?.dispose?.()
      }
    },
  })

  let disposePrompt = () => undefined
  try {
    const systemPrompt = ctx.systemPrompt ?? ctx.get?.('systemPrompt')
    if (typeof systemPrompt?.section === 'function') {
      disposePrompt = systemPrompt.section({
        name: DELEGATION_SECTION_NAME,
        order: DELEGATION_SECTION_ORDER,
        text: DELEGATION_GUIDANCE,
      }) ?? disposePrompt
    }
  } catch {
    // A host without the prompt seam still gets the tool.
  }

  // Composer widget bridge: read the current selection and update it. The route
  // is authenticated by DSH's connection layer; it carries no secrets.
  // Seed from the local snapshot; the first widget call refreshes it from the
  // app-server, which is the authoritative source.
  let catalog = readModelCatalog(config)
  {
    const clamped = effortFor(catalog, state.selection.model, state.selection.effort)
    if (clamped.entry) {
      state.selection.model = clamped.model
      state.selection.effort = clamped.effort
    }
  }
  const snapshot = (models = catalog) => ({ selection: { ...state.selection }, models, roles: Object.keys(ROLE_PRESETS) })
  const registerRoute = (owner) => {
    const connection = Reflect.get(owner, 'connection') ?? owner?.get?.('connection')
    if (typeof connection?.rpc?.handle !== 'function') return { dispose () {} }
    return connection.rpc.handle('/dsh-codex-exec', async (endpoint, payload) => {
      if (endpoint === 'state') {
        catalog = await ensureCatalog(config)
        return { ok: true, value: snapshot() }
      }
      if (endpoint === 'select') {
        const next = payload?.args ?? {}
        catalog = await ensureCatalog(config)
        if (ROLE_PRESETS[next.role]) state.selection.role = next.role
        const order = effortOrder(catalog)
        if (catalog.some((entry) => entry.id === next.model)) state.selection.model = next.model
        const target = catalog.find((entry) => entry.id === state.selection.model)
        if (typeof next.effort === 'string') {
          // An explicitly requested level is clamped against the (possibly new)
          // model: luna@ultra becomes luna@max instead of silently dropping intent.
          state.selection.effort = clampEffort(target, next.effort, order)
        } else {
          // Switching models re-clamps the carried level to the new model.
          state.selection.effort = clampEffort(target, state.selection.effort, order)
        }
        return { ok: true, value: snapshot() }
      }
      return { ok: false, error: { code: 'dsh-codex-exec/not-found', message: 'unknown endpoint', details: {} } }
    })
  }

  let routeDisposer = null
  try {
    if (typeof ctx.inject === 'function') {
      // Never gate on ctx.get('webServer'): during a cold boot the web server is
      // not mounted yet, which used to send this down the fallback branch and
      // silently drop the route (the client then got HTTP 405 for `state`).
      // ctx.inject defers until both services exist.
      routeDisposer = ctx.inject(['connection', 'webServer'], (owner) =>
        registerRoute(owner.extend({ webServer: owner.get('webServer') })))
    } else {
      routeDisposer = registerRoute(ctx)
    }
  } catch {
    // Without the HTTP bridge the selector stays hidden; the tool still works.
    routeDisposer = null
  }

  // Warm the catalog so the widget's first `state` call is instant.
  void ensureCatalog(config).catch(() => {})

  return () => {
    try {
      dispose?.()
    } catch {
      // Disposal must never fail the plugin teardown.
    }
    try {
      disposePrompt?.()
    } catch {
      // Same for the prompt section.
    }
    try {
      routeDisposer?.dispose?.()
    } catch {
      // Route teardown is best effort.
    }
    try {
      state.factory?.unregister?.()
    } catch {
      // Provider unregistration is best effort during teardown.
    }
  }
}
