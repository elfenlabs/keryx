/**
 * Keryx — agent_spawn Tool Factory
 *
 * Creates the injected agent_spawn Nous Tool that allows agents
 * to spawn new agent instances from named definitions in the catalog.
 */

import { createTool } from '@elfenlabs/nous'
import type { AgentDefinition, KeryxInstance } from '../types.js'

export function createSpawnAgentTool(opts: {
  fromAgentId: string
  definitions: Record<string, AgentDefinition>
  kx: KeryxInstance
}) {
  const { fromAgentId, definitions, kx } = opts

  return createTool({
    id: 'agent_spawn',
    description:
      'Spawn a new agent instance from a named definition. ' +
      'The definition must exist in the definitions catalog. ' +
      `Available definitions: ${Object.keys(definitions).join(', ') || '(none)'}. ` +
      'Returns the new agent\'s ID on success.',
    schema: {
      id: {
        type: 'string',
        description: 'Unique ID for the new agent instance',
      },
      definition: {
        type: 'string',
        description: `Name of the agent definition to use. Available: ${Object.keys(definitions).join(', ') || '(none)'}`,
      },
    },
    execute: async (args: { id: string; definition: string }) => {
      const { id, definition: defName } = args

      const def = definitions[defName]
      if (!def) {
        return `Error: Unknown definition "${defName}". Available: ${Object.keys(definitions).join(', ') || '(none)'}`
      }

      try {
        await kx.agents.spawn(id, def)
        return `Agent "${id}" spawned from definition "${defName}".`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
}
