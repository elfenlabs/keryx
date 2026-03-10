/**
 * Keryx — Inbox (Priority Queue)
 *
 * In-memory message queue per agent. Messages are dequeued in
 * priority order (highest first, FIFO within same priority).
 */

import type { Message } from './types.js'

export class Inbox {
  private queues = new Map<string, Message[]>()

  /** Insert a message into the target agent's queue in sorted position */
  enqueue(msg: Message): void {
    let queue = this.queues.get(msg.to)
    if (!queue) {
      queue = []
      this.queues.set(msg.to, queue)
    }

    // Insert in sorted position: higher priority first, then earlier createdAt
    let i = queue.length
    while (i > 0) {
      const existing = queue[i - 1]!
      if (
        existing.priority > msg.priority ||
        (existing.priority === msg.priority && existing.createdAt <= msg.createdAt)
      ) {
        break
      }
      i--
    }
    queue.splice(i, 0, msg)
  }

  /** Pop the highest priority message for the agent */
  dequeue(agentId: string): Message | undefined {
    const queue = this.queues.get(agentId)
    if (!queue || queue.length === 0) return undefined
    return queue.shift()
  }

  /** Peek at the highest priority message without removing */
  peek(agentId: string): Message | undefined {
    const queue = this.queues.get(agentId)
    if (!queue || queue.length === 0) return undefined
    return queue[0]
  }

  /** Check if the agent has any pending messages */
  hasPending(agentId: string): boolean {
    const queue = this.queues.get(agentId)
    return !!queue && queue.length > 0
  }

  /** Check if the agent has any force messages */
  hasForceMessage(agentId: string): boolean {
    const queue = this.queues.get(agentId)
    if (!queue) return false
    return queue.some(m => m.force)
  }

  /** Dequeue the first force message for the agent */
  dequeueForce(agentId: string): Message | undefined {
    const queue = this.queues.get(agentId)
    if (!queue) return undefined
    const idx = queue.findIndex(m => m.force)
    if (idx === -1) return undefined
    return queue.splice(idx, 1)[0]
  }

  /** Get all agent IDs that have pending messages */
  agentsWithPending(): string[] {
    const result: string[] = []
    for (const [agentId, queue] of this.queues) {
      if (queue.length > 0) result.push(agentId)
    }
    return result
  }

  /** Peek at all pending messages for an agent (read-only copy) */
  peekAll(agentId: string): Message[] {
    const queue = this.queues.get(agentId)
    if (!queue) return []
    return [...queue]
  }

  /** Flush (clear) all pending messages for an agent. Returns count removed. */
  flush(agentId: string): number {
    const queue = this.queues.get(agentId)
    if (!queue) return 0
    const count = queue.length
    queue.length = 0
    return count
  }
}
