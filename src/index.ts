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
export { crond } from './daemons/crond.js'
export { keryxd } from './daemons/keryxd.js'

// Types
export type {
  Message,
  AgentDefinition,
  DaemonDefinition,
  MessageContext,
  ActivationContext,
  ToolCallContext,
  PostActivationContext,
  KeryxConfig,
  KeryxInstance,
  SendOptions,
  RequestOptions,
  AgentStatus,
} from './types.js'

export type { ContextStorage } from './daemons/contextd.js'
export type { LoggerdOptions } from './daemons/loggerd.js'
export type { CronJob, CrondOptions } from './daemons/crond.js'
export type { KeryxdConfig } from './daemons/keryxd.js'
