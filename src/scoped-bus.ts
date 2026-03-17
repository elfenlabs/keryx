/**
 * Keryx — ScopedBus
 *
 * A capability-enforcing wrapper around AgoraGroup.
 * Daemons receive this instead of the raw bus — it checks
 * declared reads/writes/emits on every subscription and emission.
 *
 * - reads: handler receives a frozen shallow copy (mutation methods stripped)
 * - writes: handler receives the full mutable payload
 * - emits: allows calling emit() for declared events
 * - undeclared access: throws at registration time
 */

import type { EventMap, Handler, Unsubscribe } from '@elfenlabs/agora'
import type { AgoraGroup, Agora } from '@elfenlabs/agora'

/** Fields that represent mutation methods on event payloads */
const MUTATION_METHODS = ['addTools', 'addPromptSegment'] as const

export class ScopedBus<E extends EventMap = EventMap> {
  private reads: Set<string>
  private writesSet: Set<string>
  private emitsSet: Set<string>

  constructor(
    private group: AgoraGroup<E>,
    private daemonId: string,
    reads: string[],
    writes: string[],
    emits: string[],
    private bus: Agora<E>,
  ) {
    this.reads = new Set(reads)
    this.writesSet = new Set(writes)
    this.emitsSet = new Set(emits)
  }

  /**
   * Subscribe to an event. Checks capability declarations:
   * - If event is in writes: full mutable access
   * - If event is in reads only: frozen copy, mutation methods stripped
   * - If event is in neither: throws
   */
  on<K extends keyof E & string>(
    event: K,
    handler: Handler<E[K]>,
    order?: number,
  ): Unsubscribe {
    const canWrite = this.writesSet.has(event)
    const canRead = this.reads.has(event)

    if (!canWrite && !canRead) {
      throw new Error(
        `[keryx] Daemon "${this.daemonId}" has no capability for event "${event}". ` +
        `Declare it in capabilities.reads or capabilities.writes.`,
      )
    }

    if (canWrite) {
      // Full mutable access — pass handler through to the group
      return this.group.on(event, handler, order)
    }

    // Read-only: wrap handler to receive a frozen shallow copy
    const readOnlyHandler = ((payload: E[K]) => {
      const copy = { ...(payload as any) }
      // Strip mutation methods
      for (const method of MUTATION_METHODS) {
        if (method in copy) {
          copy[method] = () => {
            throw new Error(
              `[keryx] Daemon "${this.daemonId}" has read-only access to "${event}". ` +
              `Cannot call ${method}(). Declare "${event}" in capabilities.writes to mutate.`,
            )
          }
        }
      }
      Object.freeze(copy)
      handler(copy as E[K])
    }) as Handler<E[K]>

    return this.group.on(event, readOnlyHandler, order)
  }

  /**
   * Emit an event. Only allowed if event is declared in capabilities.emits.
   */
  async emit<K extends keyof E & string>(event: K, payload: E[K]): Promise<void> {
    if (!this.emitsSet.has(event)) {
      throw new Error(
        `[keryx] Daemon "${this.daemonId}" cannot emit "${event}". ` +
        `Declare it in capabilities.emits.`,
      )
    }
    await this.bus.emit(event, payload)
  }
}
