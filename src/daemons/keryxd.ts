/**
 * Keryx — keryxd (Agent Management Daemon)
 *
 * Built-in daemon that provides agent discoverability and management tools.
 * Agents with keryxd config can inspect system state, read inboxes,
 * flush queues, and abort running agents.
 *
 * Config format:
 * {
 *   'keryxd': {
 *     read: ['*'],                    // glob: exact ID or prefix*
 *     write: ['analyst', 'news-*'],   // glob: exact ID or prefix*
 *   }
 * }
 */

import { createTool } from '@elfenlabs/nous'
import type { DaemonDefinition, KeryxInstance } from '../types.js'

export type KeryxdConfig = {
  /** Agent IDs/patterns this agent can read (status, inbox). Supports exact ID and prefix* glob. */
  read?: string[]
  /** Agent IDs/patterns this agent can write (flush inbox, abort). Supports exact ID and prefix* glob. */
  write?: string[]
}

/** Match an agent ID against a list of glob patterns (exact match or prefix*) */
function matchesGlob(agentId: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*') return true
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      if (agentId.startsWith(prefix)) return true
    } else {
      if (agentId === pattern) return true
    }
  }
  return false
}

/**
 * Create the agent management daemon.
 *
 * @example
 * ```ts
 * await kx.daemons.register(keryxd())
 * const agent = await kx.agents.spawn('assistant', {
 *   name: 'Assistant',
 *   instruction: '...',
 *   config: {
 *     'keryxd': { read: ['*'], write: ['analyst'] },
 *   },
 * })
 * ```
 */
export function keryxd(): DaemonDefinition {
  let kxRef: KeryxInstance | null = null

  return {
    id: 'keryxd',
    capabilities: {
      writes: ['activation:before'],
      description: 'Provides agent management and observability tools',
    },

    onStart: (kx: KeryxInstance) => {
      kxRef = kx

      kx.bus.on('activation:before', (ctx) => {
        const config = ctx.agentConfig['keryxd'] as KeryxdConfig | undefined
        if (!config || !kxRef) return

        const kxInst = kxRef
        const readPatterns = config.read ?? []
        const writePatterns = config.write ?? []
        const hasRead = readPatterns.length > 0
        const hasWrite = writePatterns.length > 0

        // ── agent_list — always available if keryxd is configured ──────────

        ctx.addTools([
          createTool({
            id: 'agent_list',
            description: 'List all agents in the system with their current status (busy/idle).',
            execute: async () => {
              const agents = kxInst.agents.list()
              return JSON.stringify(agents.map(a => ({
                id: a.id,
                name: a.name,
                status: a.status,
              })))
            },
          }),
        ])

        // ── Read tools ─────────────────────────────────────────────────────

        if (hasRead) {
          ctx.addTools([
            createTool({
              id: 'agent_status',
              description: 'Get detailed status of a specific agent including current activity and tool calls.',
              schema: {
                id: { type: 'string', description: 'Agent ID to check' },
              },
              execute: async (args: { id: string }) => {
                if (!matchesGlob(args.id, readPatterns)) {
                  return `Error: No read permission for agent "${args.id}".`
                }
                const status = kxInst.agents.getStatus(args.id)
                if (!status) return `Error: Unknown agent "${args.id}".`
                return JSON.stringify(status)
              },
            }),

            createTool({
              id: 'inbox_read',
              description: 'Peek at pending messages in an agent\'s inbox without removing them.',
              schema: {
                id: { type: 'string', description: 'Agent ID whose inbox to read' },
              },
              execute: async (args: { id: string }) => {
                if (!matchesGlob(args.id, readPatterns)) {
                  return `Error: No read permission for agent "${args.id}".`
                }
                const messages = kxInst.agents.getInbox(args.id)
                return JSON.stringify({
                  count: messages.length,
                  messages: messages.map(m => ({
                    from: m.from,
                    body: m.body,
                    priority: m.priority,
                    createdAt: m.createdAt,
                  })),
                })
              },
            }),
          ])
        }

        // ── Write tools ────────────────────────────────────────────────────

        if (hasWrite) {
          ctx.addTools([
            createTool({
              id: 'inbox_flush',
              description: 'Clear all pending messages from an agent\'s inbox.',
              schema: {
                id: { type: 'string', description: 'Agent ID whose inbox to flush' },
              },
              execute: async (args: { id: string }) => {
                if (!matchesGlob(args.id, writePatterns)) {
                  return `Error: No write permission for agent "${args.id}".`
                }
                const count = kxInst.agents.flushInbox(args.id)
                return `Flushed ${count} messages from "${args.id}".`
              },
            }),

            createTool({
              id: 'agent_abort',
              description: 'Force-abort the currently running activation for an agent.',
              schema: {
                id: { type: 'string', description: 'Agent ID to abort' },
              },
              execute: async (args: { id: string }) => {
                if (!matchesGlob(args.id, writePatterns)) {
                  return `Error: No write permission for agent "${args.id}".`
                }
                const aborted = kxInst.agents.abort(args.id)
                if (aborted) {
                  return `Aborted agent "${args.id}".`
                }
                return `Agent "${args.id}" is not currently running.`
              },
            }),
          ])
        }
      }, 5) // Early — so management tools are available before most daemons
    },

    onStop: () => {
      kxRef = null
    },
  }
}
