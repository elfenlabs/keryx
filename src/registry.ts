/**
 * Keryx — Agent Registry
 *
 * Simple storage for agent definitions. Validates uniqueness.
 */

import type { AgentDefinition } from './types.js'

export class Registry {
  private agents = new Map<string, AgentDefinition>()

  /** Register an agent definition. Throws on duplicate ID. */
  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" is already registered`)
    }
    this.agents.set(agent.id, agent)
  }

  /** Get an agent definition by ID */
  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id)
  }

  /** Check if an agent ID is registered */
  has(id: string): boolean {
    return this.agents.has(id)
  }

  /** List all registered agents (id + name) */
  list(): { id: string; name: string }[] {
    return [...this.agents.values()].map(a => ({ id: a.id, name: a.name }))
  }

  /** Get all agent definitions */
  all(): AgentDefinition[] {
    return [...this.agents.values()]
  }
}
