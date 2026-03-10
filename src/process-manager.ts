/**
 * Keryx — Process Manager
 *
 * The runtime core. Polls inboxes, spawns Nous instances,
 * manages serial-per-agent execution, and handles force interrupts.
 */

import { createContext, runAgent, AgentAbortError, type Tool, type AgentResult } from '@elfenlabs/nous'
import type { RunStatus } from '@elfenlabs/nous'
import type {
  AgentDefinition,
  Message,
  ActivationContext,
  PostActivationContext,
  ProviderConfig,
} from './types.js'
import type { Provider } from '@elfenlabs/nous'
import { Inbox } from './inbox.js'
import { Registry } from './registry.js'
import { DaemonManager } from './daemon.js'
import { createSendMessageTool, type ReplyChannelMap } from './tools/send-message.js'
import { createAskAgentTool } from './tools/ask-agent.js'
import { buildPromptAddendum } from './prompt.js'

export class ProcessManager {
  readonly inbox: Inbox
  readonly registry: Registry
  readonly daemons: DaemonManager
  readonly replyChannels: ReplyChannelMap

  private activeLocks = new Map<string, Promise<void>>()
  readonly abortControllers = new Map<string, AbortController>()
  private agentStates = new Map<string, RunStatus>()
  private activeMessages = new Map<string, Message>()
  private pollingTimer: ReturnType<typeof setInterval> | null = null
  private pollingInterval: number
  private createProvider: (config: ProviderConfig) => Provider
  private running = false

  // Callback for when inbox state changes (used to wake poller immediately)
  private wakePoller: (() => void) | null = null

  constructor(opts: {
    inbox: Inbox
    registry: Registry
    daemons: DaemonManager
    replyChannels: ReplyChannelMap
    pollingInterval: number
    createProvider: (config: ProviderConfig) => Provider
  }) {
    this.inbox = opts.inbox
    this.registry = opts.registry
    this.daemons = opts.daemons
    this.replyChannels = opts.replyChannels
    this.pollingInterval = opts.pollingInterval
    this.createProvider = opts.createProvider
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
    // Wait for all active agent processing to finish
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

        await this.runActivation(agentId, msg)
      }
    })()

    this.activeLocks.set(agentId, lock)
    lock.finally(() => {
      this.activeLocks.delete(agentId)
    })
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
    const toolToDaemon = new Map<string, string>()

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

    // Run onPreActivation hooks (daemons inject tools + prompt segments, restore context)
    await this.daemons.runOnPreActivation(activationCtx)

    // Build tool-to-daemon mapping for daemon tools
    for (const t of daemonTools) {
      // Find which daemon provided this tool by checking all daemons
      // For simplicity, we track during addTools which daemon is active
      // Since hooks run in order, we can associate tools with the daemon that added them
    }

    // Create the send_message and ask_agent tools for this activation
    const sendMessageTool = createSendMessageTool({
      fromAgentId: agentId,
      inbox: this.inbox,
      replyChannels: this.replyChannels,
    })

    const askAgentTool = createAskAgentTool({
      fromAgentId: agentId,
      inbox: this.inbox,
      registry: this.registry,
      replyChannels: this.replyChannels,
    })

    // Merge all tools: send_message + ask_agent + static agent tools + daemon tools
    const staticTools = agentDef.tools ?? []
    const allTools = [sendMessageTool, askAgentTool, ...staticTools, ...daemonTools]

    // Build tool routing: which tools belong to which daemon
    for (const t of daemonTools) {
      // We need to track daemon ownership — enhance ActivationContext
      // For now, daemon tools execute directly (their execute is the daemon's logic)
    }

    // Build system prompt addendum
    const addendum = buildPromptAddendum({
      agentId,
      agentName: agentDef.name,
      registry: this.registry.list(),
      message: msg,
      daemonSegments: promptSegments,
    })

    const fullInstruction = addendum + '\n' + agentDef.instruction

    // Push the message body as user message
    ctx.push({ role: 'user', content: msg.body })

    // Create abort controller for this activation
    const abortController = new AbortController()
    this.abortControllers.set(agentId, abortController)

    // Create provider instance
    const provider = this.createProvider(agentDef.provider)

    let response: string | null = null
    let error: Error | null = null
    let steps = 0

    try {
      // Store active message for observability
      this.activeMessages.set(agentId, msg)

      const run = runAgent({
        ctx,
        provider,
        instruction: fullInstruction,
        tools: allTools,
        signal: abortController.signal,
      })

      // Subscribe to live state changes for keryxd
      const unsub = run.onChange((status) => {
        this.agentStates.set(agentId, status)
      })

      const result: AgentResult = await run
      unsub()

      response = result.response
      steps = result.steps
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
            replyTo: null,
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

      // Run onPostActivation hooks
      const postCtx: PostActivationContext = {
        agentId,
        agentConfig: agentDef.config ?? {},
        message: msg,
        ctx,
        response,
        error,
        steps,
      }
      await this.daemons.runOnPostActivation(postCtx)
    }
  }
}
