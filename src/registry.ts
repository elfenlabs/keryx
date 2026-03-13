/**
 * Keryx — Agent Registry
 *
 * Simple storage for agent instances. Validates uniqueness.
 */

import type { AgentInstance } from './types.js'

export class Registry {
  private agents = new Map<string, AgentInstance>()

  /** Register an agent instance. Throws on duplicate ID. */
  register(agent: AgentInstance): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" is already registered`)
    }
    this.agents.set(agent.id, agent)
  }

  /** Deregister an agent instance by ID. Returns true if removed. */
  deregister(id: string): boolean {
    return this.agents.delete(id)
  }

  /** Get an agent instance by ID */
  get(id: string): AgentInstance | undefined {
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

  /** Get all agent instances */
  all(): AgentInstance[] {
    return [...this.agents.values()]
  }
}
