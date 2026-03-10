/**
 * Keryx — send_message Tool Factory
 *
 * Creates the injected send_message Nous Tool for an agent activation.
 * Routes messages through the inbox, handling reply channel interception.
 */

import { createTool } from '@elfenlabs/nous'
import type { Inbox } from '../inbox.js'

export type ReplyChannelMap = Map<string, (response: string) => void>

export function createSendMessageTool(opts: {
  fromAgentId: string
  inbox: Inbox
  replyChannels: ReplyChannelMap
}) {
  const { fromAgentId, inbox, replyChannels } = opts

  return createTool({
    id: 'message_send',
    description: 'Send a message to another agent or reply to the sender.',
    schema: {
      to: {
        type: 'string',
        description: 'Target agent ID (use the replyTo value from the current message to reply)',
      },
      body: {
        type: 'string',
        description: 'Message content',
      },
      priority: {
        type: 'number',
        description: 'Priority (0=normal, higher=urgent)',
        required: false,
      },
    },
    execute: async (args: { to: string; body: string; priority?: number }) => {
      const { to, body, priority = 0 } = args

      // Check if this is a reply to an ephemeral channel (ext-*)
      if (to.startsWith('ext-')) {
        const resolver = replyChannels.get(to)
        if (resolver) {
          resolver(body)
          return 'Reply sent to external requester.'
        }
        // Stale channel — silently drop
        return 'Reply channel expired (stale). Message dropped.'
      }

      // Normal agent-to-agent message
      inbox.enqueue({
        id: crypto.randomUUID(),
        to,
        from: fromAgentId,
        body,
        priority,
        force: false,
        replyTo: fromAgentId,
        createdAt: new Date(),
      })

      return `Message sent to "${to}".`
    },
  })
}
