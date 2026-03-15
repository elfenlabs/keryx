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
export { artifactd } from './daemons/artifactd.js'
export { secretd } from './daemons/secretd.js'
export { streamd } from './daemons/streamd.js'
export { shelld } from './daemons/shelld.js'

// Types
export type {
  Attachment,
  Message,
  AgentDefinition,
  AgentInstance,
  DaemonDefinition,
  MessageContext,
  ActivationContext,
  BeforeToolCallContext,
  AfterToolCallContext,
  AfterActivationContext,
  AgentStreamContext,
  AgentSpawnContext,
  AgentDestroyContext,
  KeryxConfig,
  KeryxInstance,
  SendOptions,
  RequestOptions,
  RequestHandle,
  SpawnOptions,
  DestroyOptions,
  AgentStatus,
} from './types.js'

export type { ContextStorage } from './daemons/contextd.js'
export type { LoggerdOptions } from './daemons/loggerd.js'
export type { CronJob, CrondOptions } from './daemons/crond.js'
export type { KeryxdConfig } from './daemons/keryxd.js'
export type { ArtifactdOptions, ArtifactStorage, ArtifactMeta, ArtifactInfo } from './daemons/artifactd.js'
export type { SecretdOptions, SecretConfig, SecretStorage } from './daemons/secretd.js'
export type { StreamEvent, StreamSubscriber, StreamdHandle } from './daemons/streamd.js'
export type { ShelldOptions, ShelldConfig, ShellDriver, ShellProcess, ShelldHandle, ShellSession } from './daemons/shelld.js'
