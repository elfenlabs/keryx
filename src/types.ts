/**
 * Keryx — Core Types
 *
 * All shared type definitions for the orchestrator.
 */

import type { Tool, Context, SerializedContext, Provider, ActiveToolCall } from '@elfenlabs/nous'

// ── Pending Replies ─────────────────────────────────────────────────────────

/** A pending reply awaiting an agent's response */
export type PendingReply = {
  resolve: (response: string) => void
  reject?: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** Map of pending replies keyed by message ID */
export type PendingReplyMap = Map<string, PendingReply>

// ── Messages ────────────────────────────────────────────────────────────────

/** A message routed through the Keryx message bus */
export type Message = {
  id: string
  to: string
  from: string | null
  body: string
  priority: number
  force: boolean
  metadata?: Record<string, unknown>
  createdAt: Date

  // Status timestamps (nullable — status derived from which is set)
  claimedAt?: Date
  completedAt?: Date
  failedAt?: Date
  discardedAt?: Date
}

// ── Agent Definition ────────────────────────────────────────────────────────

/** Static agent registration */
export type AgentDefinition = {
  id: string
  name: string
  instruction: string
  /** Per-agent provider override. Falls back to KeryxConfig.defaultProvider. */
  provider?: Provider
  tools?: Tool<any>[]
  config?: Record<string, Record<string, unknown>>
}

// ── Daemon Definition ───────────────────────────────────────────────────────

/** Context passed to onMessageReceived hooks */
export type MessageContext = {
  message: Message
}

/** Context passed to onBeforeActivation hooks */
export type ActivationContext = {
  agentId: string
  agentConfig: Record<string, Record<string, unknown>>
  message: Message
  ctx: Context
  addTools: (tools: Tool<any>[]) => void
  addPromptSegment: (segment: string) => void
}

/** Context passed to onBeforeToolCall hooks (broadcast, args are mutable) */
export type BeforeToolCallContext = {
  agentId: string
  toolId: string
  args: Record<string, unknown>
}

/** Context passed to onAfterToolCall hooks (broadcast, read-only) */
export type AfterToolCallContext = {
  agentId: string
  toolId: string
  args: Record<string, unknown>
  result: unknown
}

/** Context passed to onAfterActivation hooks */
export type AfterActivationContext = {
  agentId: string
  agentConfig: Record<string, Record<string, unknown>>
  message: Message
  ctx: Context
  response: string | null
  error: Error | null
  steps: number
}

/** Context passed to onAgentStream hooks */
export type AgentStreamContext = {
  agentId: string
  type: 'thinking' | 'output' | 'tool_call'
  phase: 'start' | 'chunk' | 'end'
  /** Present only when phase === 'chunk' */
  chunk?: string
  /** Present when type === 'tool_call' */
  toolIndex?: number
  toolCallId?: string
  toolName?: string
}

/** A daemon (middleware service) registered with Keryx */
export type DaemonDefinition = {
  id: string
  order: number
  onStart?: (kx: KeryxInstance) => void | Promise<void>
  onStop?: () => void | Promise<void>
  onMessageReceived?: (ctx: MessageContext) => void | Promise<void>
  onBeforeActivation?: (ctx: ActivationContext) => void | Promise<void>
  onBeforeToolCall?: (ctx: BeforeToolCallContext) => void | Promise<void>
  onAfterToolCall?: (ctx: AfterToolCallContext) => void | Promise<void>
  onAfterActivation?: (ctx: AfterActivationContext) => void | Promise<void>
  /** Synchronous streaming hook — must not block token flow */
  onAgentStream?: (ctx: AgentStreamContext) => void
}

// ── Keryx Configuration ─────────────────────────────────────────────────────

/** Configuration for createKeryx() */
export type KeryxConfig = {
  agents: AgentDefinition[]
  daemons?: DaemonDefinition[]
  /** Inbox polling interval in ms. Default: 100 */
  pollingInterval?: number
  /** Default Nous provider used by all agents unless overridden. */
  defaultProvider: Provider
}

/** Options for sending a message */
export type SendOptions = {
  to: string
  body: string
  from?: string | null
  priority?: number
  force?: boolean
  metadata?: Record<string, unknown>
}

/** Options for request-reply */
export type RequestOptions = {
  to: string
  body: string
  priority?: number
  force?: boolean
  metadata?: Record<string, unknown>
  signal?: AbortSignal
}

/** The public Keryx API surface */
export type KeryxInstance = {
  send: (opts: SendOptions) => Promise<void>
  request: (opts: RequestOptions) => Promise<string>
  start: () => void
  stop: () => Promise<void>
  daemons: {
    register: (daemon: DaemonDefinition) => void
    deregister: (id: string) => void
    list: () => { id: string; order: number }[]
  }
  /** Agent observability and management (used by keryxd) */
  agents: {
    list: () => AgentStatus[]
    getStatus: (id: string) => AgentStatus | undefined
    getInbox: (id: string) => Message[]
    flushInbox: (id: string) => number
    abort: (id: string) => boolean
  }
}

/** Agent status snapshot */
export type AgentStatus = {
  id: string
  name: string
  status: 'busy' | 'idle'
  currentMessage?: {
    from: string | null
    body: string
    claimedAt: Date
  }
  step?: number
  activeToolCalls?: ActiveToolCall[]
}
