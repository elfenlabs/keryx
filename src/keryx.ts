/**
 * Keryx — Public API
 *
 * createKeryx() is the main entry point. Returns a KeryxInstance
 * that manages agents, daemons, and the message bus.
 */

import type {
  AgentDefinition,
  AgentInstance,
  KeryxConfig,
  KeryxInstance,
  SendOptions,
  RequestOptions,
  SpawnOptions,
  DestroyOptions,
  DaemonDefinition,
  PendingReplyMap,
} from './types.js'
import type { Tool } from '@elfenlabs/nous'
import { Inbox } from './inbox.js'
import { Registry } from './registry.js'
import { DaemonManager } from './daemon.js'
import { ProcessManager } from './process-manager.js'

/**
 * Create a Keryx orchestrator instance.
 *
 * @example
 * ```ts
 * const kx = createKeryx({
 *   defaultProvider: myProvider,
 *   definitions: {
 *     analyst: { name: 'Analyst', instruction: '...' },
 *   },
 * })
 *
 * await kx.daemons.register(loggerd())
 * const agent = await kx.agents.spawn('analyst-1', definitions.analyst)
 * kx.start()
 * await kx.send({ to: 'analyst-1', body: 'Hello!' })
 * ```
 */
export function createKeryx(config: KeryxConfig): KeryxInstance {
  const inbox = new Inbox()
  const registry = new Registry()
  const daemonManager = new DaemonManager()
  const pendingReplies: PendingReplyMap = new Map()
  const pollingInterval = config.pollingInterval ?? 100
  const definitions = config.definitions ?? {}

  // Create the process manager
  const pm = new ProcessManager({
    inbox,
    registry,
    daemons: daemonManager,
    pendingReplies,
    pollingInterval,
    defaultProvider: config.defaultProvider,
    definitions,
  })

  // ── Public API ──────────────────────────────────────────────────────────

  const instance: KeryxInstance = {
    /** Fire-and-forget message delivery */
    async send(opts: SendOptions): Promise<void> {
      const msg = {
        id: crypto.randomUUID(),
        to: opts.to,
        from: opts.from ?? null,
        body: opts.body,
        priority: opts.priority ?? 0,
        force: opts.force ?? false,
        metadata: opts.metadata,
        createdAt: new Date(),
      }

      if (!registry.has(msg.to)) {
        throw new Error(`Unknown agent: "${msg.to}"`)
      }

      await pm.enqueueAndProcess(msg)
    },

    /**
     * Request-reply: send a message and wait for a response.
     * Registers a pending reply keyed by message ID, resolved when the agent finishes.
     */
    async request(opts: RequestOptions): Promise<string> {
      const msgId = crypto.randomUUID()

      return new Promise<string>((resolve, reject) => {
        // Handle abort signal
        if (opts.signal) {
          if (opts.signal.aborted) {
            reject(new Error('Request aborted'))
            return
          }
          opts.signal.addEventListener('abort', () => {
            pendingReplies.delete(msgId)
            reject(new Error('Request aborted'))
          }, { once: true })
        }

        // Register the pending reply
        pendingReplies.set(msgId, { resolve, reject })

        // Build and enqueue the message
        const msg = {
          id: msgId,
          to: opts.to,
          from: null,
          body: opts.body,
          priority: opts.priority ?? 0,
          force: opts.force ?? false,
          metadata: opts.metadata,
          createdAt: new Date(),
        }

        if (!registry.has(msg.to)) {
          pendingReplies.delete(msgId)
          reject(new Error(`Unknown agent: "${msg.to}"`))
          return
        }

        pm.enqueueAndProcess(msg).catch((err) => {
          pendingReplies.delete(msgId)
          reject(err)
        })
      })
    },

    /** Start the inbox poller */
    start(): void {
      pm.start()
    },

    /** Stop daemon background processes and drain active work */
    async stop(): Promise<void> {
      // Stop daemon background processes (reverse order)
      const defs = daemonManager.listDefinitions()
      for (let i = defs.length - 1; i >= 0; i--) {
        const d = defs[i]!
        if (d.onStop) await d.onStop()
      }
      await pm.stop()
    },

    daemons: {
      async register(daemon: DaemonDefinition): Promise<void> {
        const replaced = daemonManager.register(daemon)
        // Hot-reload: stop old, start new
        if (replaced?.onStop) await replaced.onStop()
        if (daemon.onStart) await daemon.onStart(instance)
      },
      async deregister(id: string): Promise<void> {
        const removed = daemonManager.deregister(id)
        if (removed?.onStop) await removed.onStop()
      },
      list(): { id: string; order: number }[] {
        return daemonManager.list()
      },
    },

    /** Agent lifecycle and observability */
    agents: {
      async spawn(id: string, definition: AgentDefinition, opts?: SpawnOptions): Promise<AgentInstance> {
        if (registry.has(id)) {
          throw new Error(`Agent "${id}" is already registered`)
        }

        // Build the instance
        const agentInstance: AgentInstance = {
          ...definition,
          id,
          // Apply per-instance overrides
          provider: opts?.provider ?? definition.provider,
          config: opts?.config
            ? { ...definition.config, ...opts.config }
            : definition.config,
          spawnTools: [],
          spawnPromptSegments: [],
        }

        // Collect spawn-time tools and prompt segments via daemon hooks
        const spawnTools: Tool<any>[] = []
        const spawnPromptSegments: string[] = []

        await daemonManager.runOnAgentSpawn({
          agentId: id,
          instance: agentInstance,
          addTools: (tools: Tool<any>[]) => {
            for (const t of tools) {
              spawnTools.push(t)
            }
          },
          addPromptSegment: (segment: string) => {
            spawnPromptSegments.push(segment)
          },
        })

        // Store injected tools and segments on the instance
        agentInstance.spawnTools = spawnTools
        agentInstance.spawnPromptSegments = spawnPromptSegments

        // Register in the registry
        registry.register(agentInstance)

        return agentInstance
      },

      async destroy(id: string, opts?: DestroyOptions): Promise<void> {
        if (!registry.has(id)) {
          throw new Error(`Unknown agent: "${id}"`)
        }

        await pm.enqueueDestroy(id, {
          priority: opts?.priority ?? 0,
          force: opts?.force ?? false,
        })
      },

      list() {
        return registry.list().map(({ id, name }) => {
          const busy = pm.isAgentBusy(id)
          const result: import('./types.js').AgentStatus = { id, name, status: busy ? 'busy' : 'idle' }
          if (busy) {
            const msg = pm.getActiveMessage(id)
            if (msg) {
              result.currentMessage = { from: msg.from, body: msg.body, claimedAt: msg.claimedAt ?? msg.createdAt }
            }
            const state = pm.getAgentState(id)
            if (state) {
              result.step = state.step
              result.activeToolCalls = state.activeToolCalls
            }
          }
          return result
        })
      },

      getStatus(id: string) {
        const agentDef = registry.get(id)
        if (!agentDef) return undefined
        const busy = pm.isAgentBusy(id)
        const result: import('./types.js').AgentStatus = { id, name: agentDef.name, status: busy ? 'busy' : 'idle' }
        if (busy) {
          const msg = pm.getActiveMessage(id)
          if (msg) {
            result.currentMessage = { from: msg.from, body: msg.body, claimedAt: msg.claimedAt ?? msg.createdAt }
          }
          const state = pm.getAgentState(id)
          if (state) {
            result.step = state.step
            result.activeToolCalls = state.activeToolCalls
          }
        }
        return result
      },

      getInbox(id: string) {
        return inbox.peekAll(id)
      },

      flushInbox(id: string) {
        return inbox.flush(id)
      },
    },
  }

  // Wire the lazy kx reference for spawn/destroy tools
  pm.setKxRef(instance)

  return instance
}
