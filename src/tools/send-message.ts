/**
 * Keryx — send_message Tool Factory
 *
 * Creates the injected send_message Nous Tool for an agent activation.
 * Routes messages through the inbox for agent-to-agent communication.
 */

import { createTool } from '@elfenlabs/nous'
import type { Inbox } from '../inbox.js'

export function createSendMessageTool(opts: {
  fromAgentId: string
  inbox: Inbox
}) {
  const { fromAgentId, inbox } = opts

  return createTool({
    id: 'message_send',
    description: 'Send a message to another agent.',
    schema: {
      to: {
        type: 'string',
        description: 'Target agent ID',
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

      // Agent-to-agent message
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

