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
  RequestHandle,
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
        activationId: crypto.randomUUID(),
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
     * Request-reply: send a message and get a streaming handle.
     *
     * Returns a RequestHandle that supports both streaming and await:
     * - `handle.stream` — async iterable of StreamEvent objects
     * - `handle.result` — resolves to RequestResult when done
     * - `handle.abort()` — kills the agent's Nous loop
     * - `await handle` — returns RequestResult (via .then())
     */
    request(opts: RequestOptions): RequestHandle {
      const msgId = crypto.randomUUID()
      const agentId = opts.to

      // ── Stream infrastructure (async generator) ─────────────────────
      // Buffer for events that arrive before the consumer starts iterating
      let eventBuffer: import('./types.js').StreamEvent[] = []
      let chunkResolve: (() => void) | null = null
      let streamDone = false
      let streamError: Error | null = null

      // Accumulate all events for RequestResult
      const allEvents: import('./types.js').StreamEvent[] = []

      function pushEvent(event: import('./types.js').StreamEvent): void {
        if (streamDone) return
        allEvents.push(event)
        eventBuffer.push(event)
        if (chunkResolve) {
          chunkResolve()
          chunkResolve = null
        }
      }

      function closeStream(): void {
        streamDone = true
        if (chunkResolve) {
          chunkResolve()
          chunkResolve = null
        }
      }

      function errorStream(err: Error): void {
        streamError = err
        streamDone = true
        if (chunkResolve) {
          chunkResolve()
          chunkResolve = null
        }
      }

      async function* streamGenerator(): AsyncGenerator<import('./types.js').StreamEvent> {
        while (true) {
          // Yield any buffered events
          while (eventBuffer.length > 0) {
            yield eventBuffer.shift()!
          }

          // If done, check for trailing error
          if (streamDone) {
            if (streamError) throw streamError
            return
          }

          // Wait for next event or completion
          await new Promise<void>(resolve => { chunkResolve = resolve })
        }
      }

      // ── Usage ref (mutable — filled by process-manager) ────────────
      const usageRef = { value: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }

      // ── Result promise ──────────────────────────────────────────────
      const result = new Promise<import('./types.js').RequestResult>((resolve, reject) => {
        // Register the pending reply with stream hooks
        pendingReplies.set(msgId, {
          resolve: (responseText: string) => {
            // Build RequestResult from accumulated data
            resolve({
              activationId: msgId,
              response: responseText,
              events: allEvents,
              usage: usageRef.value,
            })
          },
          reject,
          pushEvent,
          closeStream,
          errorStream,
          usageRef,
        })

        // Build and enqueue the message
        const msg = {
          id: msgId,
          activationId: msgId,
          to: agentId,
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

      // ── Abort ───────────────────────────────────────────────────────
      let aborted = false
      function abort(): void {
        if (aborted) return
        aborted = true
        // Kill the agent's Nous loop
        const controller = pm.abortControllers.get(agentId)
        if (controller) {
          controller.abort()
        }
        // Clean up pending reply (process-manager's finally block
        // will also try, but we pre-empt to avoid races)
        const pending = pendingReplies.get(msgId)
        if (pending) {
          pendingReplies.delete(msgId)
          errorStream(new Error('Request aborted'))
          pending.reject?.(new Error('Request aborted'))
        }
      }

      // Wire external AbortSignal to abort()
      if (opts.signal) {
        if (opts.signal.aborted) {
          abort()
        } else {
          opts.signal.addEventListener('abort', () => abort(), { once: true })
        }
      }

      // ── Build handle ────────────────────────────────────────────────
      const handle: RequestHandle = {
        stream: streamGenerator(),
        result,
        abort,
        then: (onfulfilled, onrejected) => result.then(onfulfilled, onrejected),
      }

      return handle
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

      abort(id: string): boolean {
        const controller = pm.abortControllers.get(id)
        if (!controller) return false
        controller.abort()
        return true
      },
    },
  }

  // Wire the lazy kx reference for spawn/destroy tools
  pm.setKxRef(instance)

  return instance
}
