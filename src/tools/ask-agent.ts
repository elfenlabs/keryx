/**
 * Keryx — ask_agent Tool Factory
 *
 * Creates the injected ask_agent Nous Tool for blocking agent-to-agent RPC.
 * Uses the same reply channel mechanism as kx.request().
 */

import { createTool } from '@elfenlabs/nous'
import type { Inbox } from '../inbox.js'
import type { Registry } from '../registry.js'
import type { ReplyChannelMap } from './send-message.js'

const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes

export function createAskAgentTool(opts: {
  fromAgentId: string
  inbox: Inbox
  registry: Registry
  replyChannels: ReplyChannelMap
}) {
  const { fromAgentId, inbox, registry, replyChannels } = opts

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

      const channelId = `ext-${crypto.randomUUID()}`

      return new Promise<string>((resolve) => {
        // Timeout handler
        const timer = setTimeout(() => {
          replyChannels.delete(channelId)
          resolve(`Error: ask_agent timed out after ${timeout}ms waiting for "${to}" to respond.`)
        }, timeout)

        // Register reply channel
        replyChannels.set(channelId, (response: string) => {
          clearTimeout(timer)
          replyChannels.delete(channelId)
          resolve(response)
        })

        // Enqueue message to target agent's inbox
        inbox.enqueue({
          id: crypto.randomUUID(),
          to,
          from: fromAgentId,
          body,
          priority: 0,
          force: false,
          replyTo: channelId,
          createdAt: new Date(),
        })
      })
    },
  })
}
