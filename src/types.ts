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

// ── Agent Definition & Instance ─────────────────────────────────────────────

/** Static agent template — the reusable blueprint (no id) */
export type AgentDefinition = {
  name: string
  instruction: string
  /** Per-agent provider override. Falls back to KeryxConfig.defaultProvider. */
  provider?: Provider
  tools?: Tool<any>[]
  config?: Record<string, Record<string, unknown>>
}

/** A running agent instance — definition bound to a unique id */
export type AgentInstance = AgentDefinition & {
  id: string
  /** Tools injected by daemons at spawn time */
  spawnTools: Tool<any>[]
  /** Prompt segments injected by daemons at spawn time */
  spawnPromptSegments: string[]
}

// ── Spawn & Destroy Options ─────────────────────────────────────────────────

/** Options for spawning an agent instance */
export type SpawnOptions = {
  /** Per-instance provider override */
  provider?: Provider
  /** Per-instance config overrides (merged with definition config) */
  config?: Record<string, Record<string, unknown>>
}

/** Options for destroying an agent instance */
export type DestroyOptions = {
  /** Message priority for the destroy message (default: 0) */
  priority?: number
  /** Force-interrupt active processing (default: false) */
  force?: boolean
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

/** Context passed to onAgentSpawn hooks */
export type AgentSpawnContext = {
  agentId: string
  instance: AgentInstance
  addTools: (tools: Tool<any>[]) => void
  addPromptSegment: (segment: string) => void
}

/** Context passed to onAgentDestroy hooks */
export type AgentDestroyContext = {
  agentId: string
  instance: AgentInstance
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
  /** Called when an agent instance is spawned */
  onAgentSpawn?: (ctx: AgentSpawnContext) => void | Promise<void>
  /** Called when an agent instance is destroyed */
  onAgentDestroy?: (ctx: AgentDestroyContext) => void | Promise<void>
}

// ── Keryx Configuration ─────────────────────────────────────────────────────

/** Configuration for createKeryx() */
export type KeryxConfig = {
  /** Named catalog of agent definitions for agent_spawn tool */
  definitions?: Record<string, AgentDefinition>
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
    register: (daemon: DaemonDefinition) => Promise<void>
    deregister: (id: string) => Promise<void>
    list: () => { id: string; order: number }[]
  }
  /** Agent lifecycle and observability */
  agents: {
    spawn: (id: string, definition: AgentDefinition, opts?: SpawnOptions) => Promise<AgentInstance>
    destroy: (id: string, opts?: DestroyOptions) => Promise<void>
    list: () => AgentStatus[]
    getStatus: (id: string) => AgentStatus | undefined
    getInbox: (id: string) => Message[]
    flushInbox: (id: string) => number
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
