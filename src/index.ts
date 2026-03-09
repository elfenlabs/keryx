/**
 * Keryx — Agent Orchestrator
 *
 * Process manager and message bus for autonomous AI agents.
 *
 * @module @elfenlabs/keryx
 */

// Public API
export { createKeryx } from './keryx.js'

// Built-in daemons
export { loggerd } from './daemons/loggerd.js'
export { contextd } from './daemons/contextd.js'

// Types
export type {
  Message,
  AgentDefinition,
  ProviderConfig,
  DaemonDefinition,
  MessageContext,
  ActivationContext,
  ToolCallContext,
  PostActivationContext,
  KeryxConfig,
  KeryxInstance,
  SendOptions,
  RequestOptions,
} from './types.js'

export type { ContextStorage } from './daemons/contextd.js'
export type { LoggerdOptions } from './daemons/loggerd.js'
