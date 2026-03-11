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
} from './types.js'

export class DaemonManager {
  private daemons: DaemonDefinition[] = []

  constructor(initial?: DaemonDefinition[]) {
    if (initial) {
      for (const d of initial) {
        this.register(d)
      }
    }
  }

  /** Register a daemon, maintaining order sort */
  register(daemon: DaemonDefinition): void {
    // Remove existing daemon with same ID (allows re-registration)
    this.daemons = this.daemons.filter(d => d.id !== daemon.id)
    this.daemons.push(daemon)
    this.daemons.sort((a, b) => a.order - b.order)
  }

  /** Remove a daemon by ID */
  deregister(id: string): void {
    this.daemons = this.daemons.filter(d => d.id !== id)
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
}


