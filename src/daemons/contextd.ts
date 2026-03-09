/**
 * Keryx — contextd (Context Persistence Daemon)
 *
 * Built-in daemon that persists and restores Nous context
 * between activations for agents that opt in via config.
 */

import type { SerializedContext } from '@elfenlabs/nous'
import type { DaemonDefinition } from '../types.js'

/** Storage adapter interface for context persistence */
export interface ContextStorage {
  get(agentId: string): SerializedContext | undefined
  set(agentId: string, context: SerializedContext): void
  delete(agentId: string): void
}

/** Default in-memory storage */
class InMemoryContextStorage implements ContextStorage {
  private store = new Map<string, SerializedContext>()

  get(agentId: string): SerializedContext | undefined {
    return this.store.get(agentId)
  }

  set(agentId: string, context: SerializedContext): void {
    this.store.set(agentId, context)
  }

  delete(agentId: string): void {
    this.store.delete(agentId)
  }
}

export type ContextdOptions = {
  /** Custom storage adapter. Default: in-memory Map */
  storage?: ContextStorage
}

/**
 * Create a context persistence daemon.
 *
 * Agents opt in via config:
 * ```ts
 * {
 *   id: 'manager',
 *   config: {
 *     'context': { persist: true },
 *   },
 * }
 * ```
 */
export function contextd(opts?: ContextdOptions): DaemonDefinition {
  const storage = opts?.storage ?? new InMemoryContextStorage()

  return {
    id: 'context',
    order: 5, // Before most daemons, after loggerd

    onPreActivation: (ctx) => {
      const config = ctx.agentConfig['context'] as { persist?: boolean } | undefined
      if (!config?.persist) return

      const saved = storage.get(ctx.agentId)
      if (saved) {
        // Restore saved messages into the fresh context
        for (const msg of saved.messages) {
          ctx.ctx.push(msg)
        }
      }
    },

    onPostActivation: (ctx) => {
      const config = ctx.agentConfig['context'] as { persist?: boolean } | undefined
      if (!config?.persist) return

      // Only persist on successful activations
      if (!ctx.error) {
        storage.set(ctx.agentId, ctx.ctx.serialize())
      }
    },
  }
}
