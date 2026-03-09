/**
 * Keryx — Public API
 *
 * createKeryx() is the main entry point. Returns a KeryxInstance
 * that manages agents, daemons, and the message bus.
 */

import type {
  KeryxConfig,
  KeryxInstance,
  SendOptions,
  RequestOptions,
  DaemonDefinition,
} from './types.js'
import { Inbox } from './inbox.js'
import { Registry } from './registry.js'
import { DaemonManager } from './daemon.js'
import { ProcessManager } from './process-manager.js'
import type { ReplyChannelMap } from './tools/send-message.js'

/**
 * Create a Keryx orchestrator instance.
 *
 * @example
 * ```ts
 * const kx = createKeryx({
 *   createProvider: (config) => createOpenAIProvider({ url: config.url, model: config.model }),
 *   agents: [
 *     { id: 'manager', name: 'Manager', instruction: '...', provider: { url: '...', model: '...' } },
 *   ],
 *   daemons: [loggerd()],
 * })
 *
 * await kx.send({ to: 'manager', body: 'Hello!' })
 * kx.start()
 * ```
 */
export function createKeryx(config: KeryxConfig): KeryxInstance {
  const inbox = new Inbox()
  const registry = new Registry()
  const daemonManager = new DaemonManager(config.daemons)
  const replyChannels: ReplyChannelMap = new Map()
  const pollingInterval = config.pollingInterval ?? 100

  // Register all agents
  for (const agent of config.agents) {
    registry.register(agent)
  }

  // Create the process manager
  const pm = new ProcessManager({
    inbox,
    registry,
    daemons: daemonManager,
    replyChannels,
    pollingInterval,
    createProvider: config.createProvider,
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
        replyTo: opts.replyTo ?? null,
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
     * Creates an ephemeral reply channel that the agent replies to.
     */
    async request(opts: RequestOptions): Promise<string> {
      const channelId = `ext-${crypto.randomUUID()}`

      return new Promise<string>((resolve, reject) => {
        // Handle abort signal
        if (opts.signal) {
          if (opts.signal.aborted) {
            reject(new Error('Request aborted'))
            return
          }
          opts.signal.addEventListener('abort', () => {
            replyChannels.delete(channelId)
            reject(new Error('Request aborted'))
          }, { once: true })
        }

        // Register the reply channel
        replyChannels.set(channelId, (response: string) => {
          replyChannels.delete(channelId)
          resolve(response)
        })

        // Send the message with the reply channel
        instance.send({
          to: opts.to,
          body: opts.body,
          priority: opts.priority ?? 0,
          replyTo: channelId,
          metadata: opts.metadata,
        }).catch((err) => {
          replyChannels.delete(channelId)
          reject(err)
        })
      })
    },

    /** Start polling inboxes and daemon background processes */
    start(): void {
      // Start daemon background processes (in order)
      for (const d of daemonManager.listDefinitions()) {
        if (d.onStart) d.onStart(instance)
      }
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

    /** Runtime daemon management */
    daemons: {
      register(daemon: DaemonDefinition): void {
        daemonManager.register(daemon)
      },
      deregister(id: string): void {
        daemonManager.deregister(id)
      },
      list(): { id: string; order: number }[] {
        return daemonManager.list()
      },
    },
  }

  return instance
}
