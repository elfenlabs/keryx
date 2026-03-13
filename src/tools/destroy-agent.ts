/**
 * Keryx — agent_destroy Tool Factory
 *
 * Creates the injected agent_destroy Nous Tool that allows agents
 * to destroy other agent instances at runtime.
 */

import { createTool } from '@elfenlabs/nous'
import type { KeryxInstance } from '../types.js'

export function createDestroyAgentTool(opts: {
  fromAgentId: string
  kx: KeryxInstance
}) {
  const { fromAgentId, kx } = opts

  return createTool({
    id: 'agent_destroy',
    description:
      'Destroy another agent instance. ' +
      'This removes the agent from the registry and flushes its inbox. ' +
      'Use force to interrupt an actively running agent.',
    schema: {
      id: {
        type: 'string',
        description: 'ID of the agent to destroy',
      },
      force: {
        type: 'boolean',
        description: 'Force-interrupt if the agent is currently processing (default: false)',
        required: false,
      },
    },
    execute: async (args: { id: string; force?: boolean }) => {
      const { id, force = false } = args

      // Cannot destroy yourself
      if (id === fromAgentId) {
        return 'Error: Cannot destroy yourself.'
      }

      try {
        await kx.agents.destroy(id, { force })
        return `Agent "${id}" destroyed.`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
}
