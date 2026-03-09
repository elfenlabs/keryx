/**
 * Keryx — loggerd (Logger Daemon)
 *
 * Built-in daemon that logs activations, tool calls, and errors
 * to the terminal for development feedback.
 */

import type { DaemonDefinition } from '../types.js'

export type LoggerdOptions = {
  /** Custom log function. Default: console.log */
  log?: (...args: unknown[]) => void
}

/**
 * Create a logger daemon for development observability.
 *
 * @example
 * ```ts
 * const kx = createKeryx({
 *   daemons: [loggerd()],
 *   // ...
 * })
 * ```
 *
 * Output:
 * ```
 * [summarizer] ← "Summarize this article..." (from: ext-abc123)
 * [summarizer] → "Here is the summary: ..." (steps: 2)
 * ```
 */
export function loggerd(opts?: LoggerdOptions): DaemonDefinition {
  const log = opts?.log ?? console.log

  return {
    id: 'loggerd',
    order: 0, // First in the chain

    onMessageReceived: (ctx) => {
      const from = ctx.message.from ?? 'external'
      const body = ctx.message.body.length > 60
        ? ctx.message.body.slice(0, 60) + '...'
        : ctx.message.body
      const force = ctx.message.force ? ' [FORCE]' : ''
      log(`[${ctx.message.to}] ← "${body}" (from: ${from})${force}`)
    },

    onPostActivation: (ctx) => {
      if (ctx.error) {
        log(`[${ctx.agentId}] ✗ ERROR: ${ctx.error.message}`)
      } else {
        const response = ctx.response ?? ''
        const body = response.length > 60
          ? response.slice(0, 60) + '...'
          : response
        log(`[${ctx.agentId}] → "${body}" (steps: ${ctx.steps})`)
      }
    },
  }
}
