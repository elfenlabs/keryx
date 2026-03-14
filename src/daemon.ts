/**
 * Keryx — Daemon Manager
 *
 * Manages the ordered middleware chain of daemons.
 * Daemons subscribe to lifecycle hooks and are executed in order.
 */

import type {
  DaemonDefinition,
  MessageContext,
  ActivationContext,
  BeforeToolCallContext,
  AfterToolCallContext,
  AfterActivationContext,
  AgentStreamContext,
  AgentSpawnContext,
  AgentDestroyContext,
} from './types.js'

export class DaemonManager {
  private daemons: DaemonDefinition[] = []

  /** Register a daemon, maintaining order sort. Returns replaced daemon if re-registering. */
  register(daemon: DaemonDefinition): DaemonDefinition | undefined {
    const existing = this.daemons.find(d => d.id === daemon.id)
    this.daemons = this.daemons.filter(d => d.id !== daemon.id)
    this.daemons.push(daemon)
    this.daemons.sort((a, b) => a.order - b.order)
    return existing
  }

  /** Remove a daemon by ID. Returns removed daemon if found. */
  deregister(id: string): DaemonDefinition | undefined {
    const existing = this.daemons.find(d => d.id === id)
    this.daemons = this.daemons.filter(d => d.id !== id)
    return existing
  }

  /** Get a daemon by ID */
  get(id: string): DaemonDefinition | undefined {
    return this.daemons.find(d => d.id === id)
  }

  /** List active daemons (id + order) */
  list(): { id: string; order: number }[] {
    return this.daemons.map(d => ({ id: d.id, order: d.order }))
  }

  /** List full daemon definitions (for lifecycle hooks) */
  listDefinitions(): DaemonDefinition[] {
    return [...this.daemons]
  }

  /** Run onMessageReceived on all daemons in order */
  async runOnMessageReceived(ctx: MessageContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onMessageReceived) {
        await daemon.onMessageReceived(ctx)
      }
    }
  }

  /** Run onBeforeActivation on all daemons in order */
  async runOnBeforeActivation(ctx: ActivationContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onBeforeActivation) {
        await daemon.onBeforeActivation(ctx)
      }
    }
  }

  /** Run onBeforeToolCall on all daemons in order (broadcast — args are mutable) */
  async runOnBeforeToolCall(ctx: BeforeToolCallContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onBeforeToolCall) {
        await daemon.onBeforeToolCall(ctx)
      }
    }
  }

  /** Run onAfterToolCall on all daemons in order (broadcast — read-only) */
  async runOnAfterToolCall(ctx: AfterToolCallContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onAfterToolCall) {
        await daemon.onAfterToolCall(ctx)
      }
    }
  }

  /** Run onAfterActivation on all daemons in order */
  async runOnAfterActivation(ctx: AfterActivationContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onAfterActivation) {
        await daemon.onAfterActivation(ctx)
      }
    }
  }

  /** Run onAgentStream on all daemons synchronously (fire-and-forget, never blocks token flow) */
  runOnAgentStream(ctx: AgentStreamContext): void {
    for (const daemon of this.daemons) {
      if (daemon.onAgentStream) {
        daemon.onAgentStream(ctx)
      }
    }
  }

  /** Run onAgentSpawn on all daemons in order */
  async runOnAgentSpawn(ctx: AgentSpawnContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onAgentSpawn) {
        await daemon.onAgentSpawn(ctx)
      }
    }
  }

  /** Run onAgentDestroy on all daemons in order */
  async runOnAgentDestroy(ctx: AgentDestroyContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onAgentDestroy) {
        await daemon.onAgentDestroy(ctx)
      }
    }
  }
}
