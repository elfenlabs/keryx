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
  PreToolCallContext,
  PostToolCallContext,
  PostActivationContext,
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

  /** Run onPreActivation on all daemons in order */
  async runOnPreActivation(ctx: ActivationContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onPreActivation) {
        await daemon.onPreActivation(ctx)
      }
    }
  }

  /** Run onPreToolCall on all daemons in order (broadcast — args are mutable) */
  async runOnPreToolCall(ctx: PreToolCallContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onPreToolCall) {
        await daemon.onPreToolCall(ctx)
      }
    }
  }

  /** Run onPostToolCall on all daemons in order (broadcast — read-only) */
  async runOnPostToolCall(ctx: PostToolCallContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onPostToolCall) {
        await daemon.onPostToolCall(ctx)
      }
    }
  }

  /** Run onPostActivation on all daemons in order */
  async runOnPostActivation(ctx: PostActivationContext): Promise<void> {
    for (const daemon of this.daemons) {
      if (daemon.onPostActivation) {
        await daemon.onPostActivation(ctx)
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


