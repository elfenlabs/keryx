/**
 * Keryx — Core Types
 *
 * All shared type definitions for the orchestrator.
 */

import type { Tool, Context, SerializedContext, Provider } from '@elfenlabs/nous'

// ── Messages ────────────────────────────────────────────────────────────────

/** A message routed through the Keryx message bus */
export type Message = {
  id: string
  to: string
  from: string | null
  body: string
  priority: number
  force: boolean
  replyTo: string | null
  metadata?: Record<string, unknown>
  createdAt: Date

  // Status timestamps (nullable — status derived from which is set)
  claimedAt?: Date
  completedAt?: Date
  failedAt?: Date
  discardedAt?: Date
}

// ── Agent Definition ────────────────────────────────────────────────────────

/** Provider configuration for an agent's LLM backend */
export type ProviderConfig = {
  url: string
  model: string
  apiKey?: string
}

/** Static agent registration */
export type AgentDefinition = {
  id: string
  name: string
  instruction: string
  provider: ProviderConfig
  tools?: Tool<any>[]
  config?: Record<string, Record<string, unknown>>
}

// ── Daemon Definition ───────────────────────────────────────────────────────

/** Context passed to onMessageReceived hooks */
export type MessageContext = {
  message: Message
}

/** Context passed to onPreActivation hooks */
export type ActivationContext = {
  agentId: string
  agentConfig: Record<string, Record<string, unknown>>
  message: Message
  ctx: Context
  addTools: (tools: Tool<any>[]) => void
  addPromptSegment: (segment: string) => void
}

/** Context passed to onToolCall hooks */
export type ToolCallContext = {
  agentId: string
  toolId: string
  args: Record<string, unknown>
}

/** Context passed to onPostActivation hooks */
export type PostActivationContext = {
  agentId: string
  agentConfig: Record<string, Record<string, unknown>>
  message: Message
  ctx: Context
  response: string | null
  error: Error | null
  steps: number
}

/** A daemon (middleware service) registered with Keryx */
export type DaemonDefinition = {
  id: string
  order: number
  onMessageReceived?: (ctx: MessageContext) => void | Promise<void>
  onPreActivation?: (ctx: ActivationContext) => void | Promise<void>
  onToolCall?: (ctx: ToolCallContext) => unknown | Promise<unknown>
  onPostActivation?: (ctx: PostActivationContext) => void | Promise<void>
}

// ── Keryx Configuration ─────────────────────────────────────────────────────

/** Configuration for createKeryx() */
export type KeryxConfig = {
  agents: AgentDefinition[]
  daemons?: DaemonDefinition[]
  /** Inbox polling interval in ms. Default: 100 */
  pollingInterval?: number
  /** Factory for creating a Nous provider from agent config. User-supplied. */
  createProvider: (config: ProviderConfig) => Provider
}

/** Options for sending a message */
export type SendOptions = {
  to: string
  body: string
  from?: string | null
  priority?: number
  force?: boolean
  replyTo?: string | null
  metadata?: Record<string, unknown>
}

/** Options for request-reply */
export type RequestOptions = {
  to: string
  body: string
  priority?: number
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
}
