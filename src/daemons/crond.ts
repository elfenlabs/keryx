/**
 * Keryx — crond (Cron Daemon)
 *
 * Built-in daemon that injects messages into agent inboxes on a schedule.
 * Uses setInterval internally. Starts on kx.start(), stops on kx.stop().
 */

import type { DaemonDefinition, KeryxInstance } from '../types.js'

export type CronJob = {
  /** Job identifier */
  id: string
  /** Target agent ID */
  to: string
  /** Message body to send */
  body: string
  /** Interval in milliseconds */
  intervalMs: number
  /** Message priority (default: 0) */
  priority?: number
  /** Arbitrary metadata attached to each message */
  metadata?: Record<string, unknown>
}

export type CrondOptions = {
  jobs: CronJob[]
}

/**
 * Create a cron daemon for scheduled message delivery.
 *
 * @example
 * ```ts
 * const kx = createKeryx({
 *   daemons: [
 *     crond({
 *       jobs: [
 *         {
 *           id: 'daily-report',
 *           to: 'analyst',
 *           body: 'Generate the daily market report.',
 *           intervalMs: 24 * 60 * 60 * 1000, // 24 hours
 *         },
 *       ],
 *     }),
 *   ],
 *   // ...
 * })
 * ```
 */
export function crond(opts: CrondOptions): DaemonDefinition {
  const timers: Map<string, ReturnType<typeof setInterval>> = new Map()

  return {
    id: 'crond',
    order: 90, // Late in the chain — most daemons should run before cron

    onStart: (kx: KeryxInstance) => {
      for (const job of opts.jobs) {
        const timer = setInterval(() => {
          kx.send({
            to: job.to,
            body: job.body,
            from: 'crond',
            priority: job.priority ?? 0,
            metadata: {
              ...job.metadata,
              cronJobId: job.id,
              type: 'cron',
            },
          }).catch((err) => {
            // Log and skip — consistent with Keryx error policy
            console.error(`[crond] Job "${job.id}" failed: ${err.message}`)
          })
        }, job.intervalMs)

        timers.set(job.id, timer)
      }
    },

    onStop: () => {
      for (const [, timer] of timers) {
        clearInterval(timer)
      }
      timers.clear()
    },
  }
}
