/**
 * Keryx — Core Types
 *
 * All shared type definitions for the orchestrator.
 */

import type { Tool, Context, SerializedContext, Provider, ActiveToolCall, Usage } from '@elfenlabs/nous'

// ── Stream Events ───────────────────────────────────────────────────────────

/** A structured event emitted through a RequestHandle stream */
export type StreamEvent =
  | { type: 'text',        activationId: string, agentId: string, content: string }
  | { type: 'thinking',    activationId: string, agentId: string, content: string }
  | { type: 'tool_call',   activationId: string, agentId: string, name: string, args: Record<string, unknown> }
  | { type: 'tool_result', activationId: string, agentId: string, name: string, result: string }

/** The full result of a completed request */
export type RequestResult = {
  /** The activation ID that scopes this entire causal chain */
  activationId: string
  /** Final text output from the root agent (convenience) */
  response: string
  /** Full ordered list of all events in the chain */
  events: StreamEvent[]
  /** Aggregated token usage */
  usage: Usage
}

// ── Pending Replies ─────────────────────────────────────────────────────────

/** Handle returned by kx.request() — supports both streaming and await */
export type RequestHandle = {
  /** Async iterable of structured stream events */
  stream: AsyncGenerator<StreamEvent>
  /** Resolves to the full RequestResult when done */
  result: Promise<RequestResult>
  /** Abort the request (kills the agent's Nous loop) */
  abort: () => void
  /** Thenable — makes `await kx.request(...)` return RequestResult */
  then: <T1 = RequestResult, T2 = never>(
    onfulfilled?: ((value: RequestResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ) => Promise<T1 | T2>
}

/** A pending reply awaiting an agent's response */
export type PendingReply = {
  resolve: (response: string) => void
  reject?: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  /** Push a structured event to the stream */
  pushEvent?: (event: StreamEvent) => void
  /** Close the stream (called when response is complete) */
  closeStream?: () => void
  /** Error the stream (called on failure) */
  errorStream?: (error: Error) => void
  /** Mutable ref for process-manager to store usage */
  usageRef?: { value: Usage }
}

/** Map of pending replies keyed by message ID */
export type PendingReplyMap = Map<string, PendingReply>

// ── Messages ────────────────────────────────────────────────────────────────

/** A message routed through the Keryx message bus */
export type Message = {
  id: string
  /** Causal chain ID — all messages in the same activation share this */
  activationId: string
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

/**
 * An attachment transported via message metadata.
 *
 * Convention: messages carry attachments in `metadata.attachments: Attachment[]`.
 * The bus itself stays text-only — attachments are assembled into Nous
 * ContentPart[] at activation time by the process manager (for native types
 * like images/video) or by daemons (for formats requiring pre-processing).
 */
export type Attachment = {
  /** HTTPS URL or data:... base64 URI */
  url: string
  /** MIME type, e.g. 'image/jpeg', 'video/mp4' */
  mimeType: string
  /** Optional original filename */
  filename?: string
  /** Optional byte size (for budget/quota decisions) */
  sizeBytes?: number
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
  request: (opts: RequestOptions) => RequestHandle
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
