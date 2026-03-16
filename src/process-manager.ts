/**
 * Keryx — Process Manager
 *
 * The runtime core. Polls inboxes, spawns Nous instances,
 * manages serial-per-agent execution, and handles force interrupts.
 */

import { createContext, runAgent, AgentAbortError, type Tool, type AgentResult, type ContentPart } from '@elfenlabs/nous'
import type { RunStatus } from '@elfenlabs/nous'
import type {
  AgentDefinition,
  AgentInstance,
  Attachment,
  KeryxInstance,
  Message,
  StreamEvent,
  ActivationContext,
  AfterActivationContext,
  PendingReplyMap,
} from './types.js'
import type { Provider } from '@elfenlabs/nous'
import { Inbox } from './inbox.js'
import { Registry } from './registry.js'
import { DaemonManager } from './daemon.js'
import { createSendMessageTool } from './tools/send-message.js'
import { createAskAgentTool } from './tools/ask-agent.js'
import { createSpawnAgentTool } from './tools/spawn-agent.js'
import { createDestroyAgentTool } from './tools/destroy-agent.js'
import { buildPromptAddendum } from './prompt.js'

/** Internal metadata type for destroy messages */
const DESTROY_MESSAGE_TYPE = '__destroy__'

/** Check if a MIME type matches any of the given patterns (e.g. 'image/*' matches 'image/jpeg') */
function mimeMatches(mimeType: string, patterns: string[]): boolean {
  return patterns.some(p =>
    p.endsWith('/*')
      ? mimeType.startsWith(p.slice(0, -1))  // 'image/*' → startsWith('image/')
      : mimeType === p                        // 'application/pdf' → exact match
  )
}

/** Map an Attachment to the best ContentPart variant */
function attachmentToContentPart(att: Attachment): ContentPart {
  if (att.mimeType.startsWith('image/')) {
    return { type: 'image_url', image_url: { url: att.url } }
  }
  if (att.mimeType.startsWith('video/')) {
    return { type: 'video_url', video_url: { url: att.url } }
  }
  // Generic file passthrough for provider-native non-standard types (PDF, etc.)
  return { type: 'file', file: { url: att.url, mime_type: att.mimeType, name: att.filename } }
}

export class ProcessManager {
  readonly inbox: Inbox
  readonly registry: Registry
  readonly daemons: DaemonManager
  readonly pendingReplies: PendingReplyMap

  private activeLocks = new Map<string, Promise<void>>()
  readonly abortControllers = new Map<string, AbortController>()
  private agentStates = new Map<string, RunStatus>()
  private activeMessages = new Map<string, Message>()
  private pollingTimer: ReturnType<typeof setInterval> | null = null
  private pollingInterval: number
  private defaultProvider: Provider
  private definitions: Record<string, AgentDefinition>
  private running = false

  /** Lazy reference to the KeryxInstance (set after construction) */
  private kxRef: KeryxInstance | null = null

  /** Pending destroy promises: keyed by agent id, resolved when destroy completes */
  private pendingDestroys = new Map<string, { resolve: () => void }>()

  // Callback for when inbox state changes (used to wake poller immediately)
  private wakePoller: (() => void) | null = null

  constructor(opts: {
    inbox: Inbox
    registry: Registry
    daemons: DaemonManager
    pendingReplies: PendingReplyMap
    pollingInterval: number
    defaultProvider: Provider
    definitions: Record<string, AgentDefinition>
  }) {
    this.inbox = opts.inbox
    this.registry = opts.registry
    this.daemons = opts.daemons
    this.pendingReplies = opts.pendingReplies
    this.pollingInterval = opts.pollingInterval
    this.defaultProvider = opts.defaultProvider
    this.definitions = opts.definitions
  }

  /** Set the KeryxInstance reference (called after construction) */
  setKxRef(kx: KeryxInstance): void {
    this.kxRef = kx
  }

  // ── Observability (for keryxd) ──────────────────────────────────────

  /** Get cached run state for an agent (populated via onChange) */
  getAgentState(agentId: string): RunStatus | undefined {
    return this.agentStates.get(agentId)
  }

  /** Get the message currently being processed by an agent */
  getActiveMessage(agentId: string): Message | undefined {
    return this.activeMessages.get(agentId)
  }

  /** Check if an agent is currently processing a message */
  isAgentBusy(agentId: string): boolean {
    return this.activeLocks.has(agentId)
  }

  /** Start polling inboxes for pending messages */
  start(): void {
    if (this.running) return
    this.running = true
    this.poll() // immediate first poll
    this.pollingTimer = setInterval(() => this.poll(), this.pollingInterval)
  }

  /** Stop polling and wait for active agents to finish */
  async stop(): Promise<void> {
    this.running = false
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer)
      this.pollingTimer = null
    }
    // Abort all running agents so their LLM calls terminate
    for (const controller of this.abortControllers.values()) {
      controller.abort()
    }
    // Wait for all active agent processing to finish (should resolve quickly after abort)
    const activeLocks = [...this.activeLocks.values()]
    if (activeLocks.length > 0) {
      await Promise.all(activeLocks)
    }
  }

  /** Enqueue a message and trigger processing */
  async enqueueAndProcess(msg: Message): Promise<void> {
    // Run onMessageReceived on all daemons
    await this.daemons.runOnMessageReceived({ message: msg })

    this.inbox.enqueue(msg)

    // If force message, handle interrupt immediately
    if (msg.force) {
      const controller = this.abortControllers.get(msg.to)
      if (controller) {
        controller.abort()
      }
    }

    // Trigger processing for this agent
    this.processAgent(msg.to)
  }

  /**
   * Enqueue a destroy message for an agent.
   * Returns a promise that resolves when the agent is fully destroyed.
   */
  async enqueueDestroy(agentId: string, opts?: { priority?: number; force?: boolean }): Promise<void> {
    const priority = opts?.priority ?? 0
    const force = opts?.force ?? false

    // Create the destroy promise
    const destroyPromise = new Promise<void>((resolve) => {
      this.pendingDestroys.set(agentId, { resolve })
    })

    // Enqueue the destroy message
    const msg: Message = {
      id: crypto.randomUUID(),
      to: agentId,
      from: 'system',
      body: `Destroy agent "${agentId}"`,
      priority,
      force,
      metadata: { type: DESTROY_MESSAGE_TYPE },
      createdAt: new Date(),
    }

    await this.enqueueAndProcess(msg)

    // Wait for the destroy to complete
    return destroyPromise
  }

  /** Poll all inboxes for pending messages */
  private poll(): void {
    if (!this.running) return
    const agents = this.inbox.agentsWithPending()
    for (const agentId of agents) {
      this.processAgent(agentId)
    }
  }

  /** Process the inbox for a specific agent (serial lock) */
  private processAgent(agentId: string): void {
    if (this.activeLocks.has(agentId)) return // already running

    const lock = (async () => {
      while (this.inbox.hasPending(agentId)) {
        // Prefer force messages
        let msg: Message | undefined
        if (this.inbox.hasForceMessage(agentId)) {
          msg = this.inbox.dequeueForce(agentId)
        } else {
          msg = this.inbox.dequeue(agentId)
        }
        if (!msg) break

        // Check for destroy message
        if (msg.metadata?.type === DESTROY_MESSAGE_TYPE) {
          await this.executeDestroy(agentId)
          break // Agent is gone, stop processing
        }

        await this.runActivation(agentId, msg)
      }
    })()

    this.activeLocks.set(agentId, lock)
    lock.finally(() => {
      this.activeLocks.delete(agentId)
    })
  }

  /** Execute the destroy flow for an agent */
  private async executeDestroy(agentId: string): Promise<void> {
    const instance = this.registry.get(agentId)
    if (!instance) return

    // Flush all remaining messages from inbox
    this.inbox.flush(agentId)

    // Run onAgentDestroy daemon hooks
    await this.daemons.runOnAgentDestroy({ agentId, instance })

    // Deregister from the registry
    this.registry.deregister(agentId)

    // Resolve the pending destroy promise
    const pending = this.pendingDestroys.get(agentId)
    if (pending) {
      this.pendingDestroys.delete(agentId)
      pending.resolve()
    }
  }

  /** Run a single activation for an agent with a message */
  private async runActivation(agentId: string, msg: Message): Promise<void> {
    const agentDef = this.registry.get(agentId)
    if (!agentDef) {
      msg.failedAt = new Date()
      return
    }

    // Mark as claimed
    msg.claimedAt = new Date()

    // Create fresh context
    const ctx = createContext()

    // Collect daemon-provisioned tools and prompt segments
    const daemonTools: Tool<any>[] = []
    const promptSegments: string[] = []

    const activationCtx: ActivationContext = {
      agentId,
      agentConfig: agentDef.config ?? {},
      message: msg,
      ctx,
      addTools: (tools: Tool<any>[]) => {
        for (const t of tools) {
          daemonTools.push(t)
        }
      },
      addPromptSegment: (segment: string) => {
        promptSegments.push(segment)
      },
    }

    // Run onBeforeActivation hooks (daemons inject tools + prompt segments, restore context)
    await this.daemons.runOnBeforeActivation(activationCtx)

    // Create the send_message and ask_agent tools for this activation
    const sendMessageTool = createSendMessageTool({
      fromAgentId: agentId,
      inbox: this.inbox,
    })

    const askAgentTool = createAskAgentTool({
      fromAgentId: agentId,
      inbox: this.inbox,
      registry: this.registry,
      pendingReplies: this.pendingReplies,
    })

    // Create spawn/destroy tools (only if kx ref is available)
    const lifecycleTools: Tool<any>[] = []
    if (this.kxRef) {
      lifecycleTools.push(createSpawnAgentTool({
        fromAgentId: agentId,
        definitions: this.definitions,
        kx: this.kxRef,
      }))
      lifecycleTools.push(createDestroyAgentTool({
        fromAgentId: agentId,
        kx: this.kxRef,
      }))
    }

    // Merge all tools: send_message + ask_agent + lifecycle + spawn-time tools + static agent tools + daemon tools
    const staticTools = agentDef.tools ?? []
    const spawnTools = agentDef.spawnTools ?? []
    const allTools = [sendMessageTool, askAgentTool, ...lifecycleTools, ...spawnTools, ...staticTools, ...daemonTools]

    // Build system prompt addendum — include both spawn-time and per-activation prompt segments
    const allPromptSegments = [...(agentDef.spawnPromptSegments ?? []), ...promptSegments]

    const addendum = buildPromptAddendum({
      agentId,
      agentName: agentDef.name,
      registry: this.registry.list(),
      message: msg,
      daemonSegments: allPromptSegments,
    })

    const fullInstruction = addendum + '\n' + agentDef.instruction

    // Push the message body as user message (prefix with sender for inter-agent clarity)
    const isAgentSender = msg.from ? this.registry.has(msg.from) : false
    const body = isAgentSender ? `[From ${msg.from}]\n${msg.body}` : msg.body

    // Resolve provider early — needed for supportedMedia check
    const provider = agentDef.provider ?? this.defaultProvider
    const supported = provider.supportedMedia ?? []

    // Assemble attachments using the 3-tier fallback:
    //   1. Provider supports mimeType → ContentPart (image_url, video_url, or file)
    //   2. Daemon handled it in onBeforeActivation → already removed from attachments
    //   3. Nobody handles it → inject unsupported notice as text
    const attachments = (msg.metadata?.attachments ?? []) as Attachment[]
    const nativeParts: ContentPart[] = []
    const unsupported: Attachment[] = []

    for (const att of attachments) {
      if (mimeMatches(att.mimeType, supported)) {
        nativeParts.push(attachmentToContentPart(att))
      } else {
        unsupported.push(att)
      }
    }

    // Build unsupported notice for tier 3
    if (unsupported.length > 0) {
      const notices = unsupported
        .map(a => `[Unsupported attachment: ${a.filename ?? 'unnamed'} (${a.mimeType})]`)
        .join('\n')
      const textWithNotice = body ? `${body}\n\n${notices}` : notices
      if (nativeParts.length > 0) {
        const parts: ContentPart[] = [{ type: 'text', text: textWithNotice }, ...nativeParts]
        ctx.push({ role: 'user', content: parts })
      } else {
        ctx.push({ role: 'user', content: textWithNotice })
      }
    } else if (nativeParts.length > 0) {
      const parts: ContentPart[] = []
      if (body) parts.push({ type: 'text', text: body })
      parts.push(...nativeParts)
      ctx.push({ role: 'user', content: parts })
    } else {
      ctx.push({ role: 'user', content: body })
    }

    // Create abort controller for this activation
    const abortController = new AbortController()
    this.abortControllers.set(agentId, abortController)

    // Provider already resolved above

    let response: string | null = null
    let error: Error | null = null
    let steps = 0
    let agentUsage: import('@elfenlabs/nous').Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

    try {
      // Store active message for observability
      this.activeMessages.set(agentId, msg)

      const run = runAgent({
        ctx,
        provider,
        instruction: fullInstruction,
        tools: allTools,
        signal: abortController.signal,
        onThinkingStart: () => {
          this.daemons.runOnAgentStream({ agentId, type: 'thinking', phase: 'start' })
        },
        onThinking: (chunk) => {
          this.daemons.runOnAgentStream({ agentId, type: 'thinking', phase: 'chunk', chunk })
          const pending = this.pendingReplies.get(msg.id)
          if (pending?.pushEvent) {
            pending.pushEvent({ type: 'thinking', agentId, content: chunk })
          }
        },
        onThinkingEnd: () => {
          this.daemons.runOnAgentStream({ agentId, type: 'thinking', phase: 'end' })
        },
        onOutputStart: () => {
          this.daemons.runOnAgentStream({ agentId, type: 'output', phase: 'start' })
        },
        onOutput: (chunk) => {
          this.daemons.runOnAgentStream({ agentId, type: 'output', phase: 'chunk', chunk })
          // Pipe structured event to pending reply stream
          const pending = this.pendingReplies.get(msg.id)
          if (pending?.pushEvent) {
            pending.pushEvent({ type: 'text', agentId, content: chunk })
          }
        },
        onOutputEnd: () => {
          this.daemons.runOnAgentStream({ agentId, type: 'output', phase: 'end' })
        },
        onToolCall: (index, id, name) => {
          this.daemons.runOnAgentStream({
            agentId, type: 'tool_call', phase: 'start',
            toolIndex: index, toolCallId: id, toolName: name,
          })
        },
        onToolCallArgs: (index, argChunk) => {
          this.daemons.runOnAgentStream({
            agentId, type: 'tool_call', phase: 'chunk',
            toolIndex: index, chunk: argChunk,
          })
        },
        onBeforeToolCall: async (tool, args) => {
          await this.daemons.runOnBeforeToolCall({ agentId, toolId: tool.id, args })
          const pending = this.pendingReplies.get(msg.id)
          if (pending?.pushEvent) {
            pending.pushEvent({ type: 'tool_call', agentId, name: tool.id, args })
          }
        },
        onAfterToolCall: async (tool, args, result) => {
          await this.daemons.runOnAfterToolCall({ agentId, toolId: tool.id, args, result })
          const pending = this.pendingReplies.get(msg.id)
          if (pending?.pushEvent) {
            pending.pushEvent({ type: 'tool_result', agentId, name: tool.id, result: String(result) })
          }
        },
      })

      // Subscribe to live state changes for keryxd
      const unsub = run.onChange((status) => {
        this.agentStates.set(agentId, status)
      })

      const result: AgentResult = await run
      unsub()

      response = result.response
      steps = result.steps
      agentUsage = result.usage
      msg.completedAt = new Date()
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))

      if (err instanceof AgentAbortError) {
        msg.discardedAt = new Date()
      } else {
        msg.failedAt = new Date()

        // Send failure notification back to sender (if from an agent)
        if (msg.from && this.registry.has(msg.from)) {
          this.inbox.enqueue({
            id: crypto.randomUUID(),
            to: msg.from,
            from: 'system',
            body: `Message to "${msg.to}" failed: ${error.message}`,
            priority: 0,
            force: false,
            metadata: {
              type: 'delivery_failure',
              originalMessageId: msg.id,
              targetAgent: msg.to,
              error: error.constructor.name,
            },
            createdAt: new Date(),
          })
        }
      }
    } finally {
      // Cleanup state tracking
      this.abortControllers.delete(agentId)
      this.agentStates.delete(agentId)
      this.activeMessages.delete(agentId)

      // Run onAfterActivation hooks
      const postCtx: AfterActivationContext = {
        agentId,
        agentConfig: agentDef.config ?? {},
        message: msg,
        ctx,
        response,
        error,
        steps,
      }
      await this.daemons.runOnAfterActivation(postCtx)

      // Resolve pending reply with agent's final output (used by kx.request and agent_ask)
      const pending = this.pendingReplies.get(msg.id)
      if (pending) {
        this.pendingReplies.delete(msg.id)
        // Store usage for RequestResult (if usageRef is present)
        if (pending.usageRef) {
          pending.usageRef.value = agentUsage
        }
        if (error) {
          pending.errorStream?.(error)
          pending.reject?.(error)
        } else {
          pending.closeStream?.()
          pending.resolve(response ?? '')
        }
      }
    }
  }
}
