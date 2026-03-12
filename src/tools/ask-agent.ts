/**
 * Keryx — ask_agent Tool Factory
 *
 * Creates the injected ask_agent Nous Tool for blocking agent-to-agent RPC.
 * Uses the same reply channel mechanism as kx.request().
 */

import { createTool } from '@elfenlabs/nous'
import type { Inbox } from '../inbox.js'
import type { Registry } from '../registry.js'
import type { PendingReplyMap } from '../types.js'

const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes

export function createAskAgentTool(opts: {
  fromAgentId: string
  inbox: Inbox
  registry: Registry
  pendingReplies: PendingReplyMap
}) {
  const { fromAgentId, inbox, registry, pendingReplies } = opts

  return createTool({
    id: 'agent_ask',
    description:
      'Send a message to another agent and wait for their response. ' +
      'Use this when you need a result before continuing. ' +
      'For fire-and-forget messaging, use message_send instead.',
    schema: {
      to: {
        type: 'string',
        description: 'Target agent ID to ask',
      },
      body: {
        type: 'string',
        description: 'Message content / question',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
        required: false,
      },
    },
    execute: async (args: { to: string; body: string; timeout?: number }) => {
      const { to, body, timeout = DEFAULT_TIMEOUT_MS } = args

      // Validate target agent exists
      if (!registry.has(to)) {
        return `Error: Unknown agent "${to}". Check available agents and try again.`
      }

      // Cannot ask yourself
      if (to === fromAgentId) {
        return 'Error: Cannot ask yourself. Use a different agent.'
      }

      return new Promise<string>((resolve) => {
        const msgId = crypto.randomUUID()

        // Timeout handler
        const timer = setTimeout(() => {
          pendingReplies.delete(msgId)
          resolve(`Error: ask_agent timed out after ${timeout}ms waiting for "${to}" to respond.`)
        }, timeout)

        // Register pending reply
        pendingReplies.set(msgId, {
          resolve: (response: string) => {
            clearTimeout(timer)
            resolve(response)
          },
          timer,
        })

        // Enqueue message to target agent's inbox
        inbox.enqueue({
          id: msgId,
          to,
          from: fromAgentId,
          body,
          priority: 0,
          force: false,
          createdAt: new Date(),
        })
      })
    },
  })
}
