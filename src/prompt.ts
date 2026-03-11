/**
 * Keryx — System Prompt Addendum Builder
 *
 * Builds the addendum prepended to agent instructions with
 * identity, registry, messaging conventions, and current message context.
 */

import type { Message } from './types.js'

export function buildPromptAddendum(opts: {
  agentId: string
  agentName: string
  registry: { id: string; name: string }[]
  message: Message
  daemonSegments: string[]
}): string {
  const { agentId, agentName, registry, message, daemonSegments } = opts

  const lines: string[] = []

  // Identity
  lines.push(`You are agent "${agentId}" (${agentName}). You communicate with other agents using the message_send (fire-and-forget) and agent_ask (blocking request-reply) tools.`)
  lines.push('')

  // Registry
  const others = registry.filter(a => a.id !== agentId)
  if (others.length > 0) {
    lines.push('Available agents:')
    for (const agent of others) {
      lines.push(`- ${agent.id}: ${agent.name}`)
    }
    lines.push('')
  }

  // Current message context
  lines.push('Current message:')
  lines.push(`- From: ${message.from ?? 'external'}`)
  if (message.replyTo) {
    lines.push(`- Reply-to: ${message.replyTo}`)
  }
  lines.push(`- Priority: ${message.priority}`)
  if (message.metadata && Object.keys(message.metadata).length > 0) {
    lines.push(`- Metadata: ${JSON.stringify(message.metadata)}`)
  }
  lines.push('- Body: (provided as user message)')
  lines.push('')

  // Daemon-injected segments
  if (daemonSegments.length > 0) {
    for (const segment of daemonSegments) {
      lines.push(segment)
    }
    lines.push('')
  }

  return lines.join('\n')
}
