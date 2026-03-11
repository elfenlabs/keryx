/**
 * Keryx — streamd (Stream Daemon)
 *
 * Built-in daemon that acts as an internal event bus for real-time
 * agent output streaming. Consumers subscribe via the returned handle
 * and decide how to expose events (WebSocket, SSE, etc.).
 */

import type { DaemonDefinition, AgentStreamContext } from '../types.js'

/** A stream event emitted by streamd */
export type StreamEvent = {
  agentId: string
  type: 'thinking' | 'output' | 'tool_call'
  phase: 'start' | 'chunk' | 'end'
  chunk?: string
  /** Present when type === 'tool_call' */
  toolIndex?: number
  toolCallId?: string
  toolName?: string
  timestamp: Date
}

/** Callback for stream event subscribers */
export type StreamSubscriber = (event: StreamEvent) => void

/** Handle returned by streamd() — provides both the daemon and subscription API */
export type StreamdHandle = {
  /** The daemon definition to register with Keryx */
  daemon: DaemonDefinition
  /** Subscribe to stream events. Returns an unsubscribe function. */
  subscribe: (cb: StreamSubscriber) => () => void
}

/**
 * Create a stream daemon for real-time agent output observation.
 *
 * @example
 * ```ts
 * const stream = streamd()
 * const kx = createKeryx({
 *   daemons: [stream.daemon],
 *   // ...
 * })
 *
 * // In user-space (e.g. WebSocket server):
 * const unsub = stream.subscribe((event) => {
 *   wss.clients.forEach(client => client.send(JSON.stringify(event)))
 * })
 * ```
 */
export function streamd(): StreamdHandle {
  const subscribers = new Set<StreamSubscriber>()

  const emit = (ctx: AgentStreamContext): void => {
    const event: StreamEvent = {
      agentId: ctx.agentId,
      type: ctx.type,
      phase: ctx.phase,
      chunk: ctx.chunk,
      toolIndex: ctx.toolIndex,
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      timestamp: new Date(),
    }
    for (const cb of subscribers) {
      cb(event)
    }
  }

  const daemon: DaemonDefinition = {
    id: 'streamd',
    order: 0, // Early in the chain — observability first

    onAgentStream: (ctx) => {
      emit(ctx)
    },
  }

  return {
    daemon,
    subscribe(cb: StreamSubscriber): () => void {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },
  }
}
