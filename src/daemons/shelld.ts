/**
 * Keryx — shelld (Shell Session Broker Daemon)
 *
 * Bridges agents to pre-provisioned shell hosts. Agents execute arbitrary
 * commands, paginate output, and interact with running processes via stdin.
 * Access is gated by a per-agent hostId allow-list in config.
 *
 * The actual runtime (Docker, local subprocess, remote API, etc.) is injected
 * via the ShellDriver adapter — no hard dependencies on container runtimes.
 *
 * Config format:
 * {
 *   'shelld': {
 *     hosts: ['dev-box', 'staging-*'],
 *   }
 * }
 */

import { createTool } from '@elfenlabs/nous'
import type { DaemonDefinition, KeryxInstance } from '../types.js'

// ── Driver Interface ────────────────────────────────────────────────────────

/** A handle to a spawned process inside a host */
export type ShellProcess = {
  /** Write to the process stdin */
  write(data: string): void
  /** Subscribe to stdout/stderr data */
  onData(cb: (chunk: string) => void): void
  /** Subscribe to process exit */
  onExit(cb: (exitCode: number) => void): void
  /** Kill the process (used during cleanup) */
  kill(): void
}

/** Pluggable driver — implemented by consumers (Docker, local, remote, etc.) */
export type ShellDriver = {
  /** Connect to a pre-provisioned host */
  connect(hostId: string): Promise<void>
  /** Spawn a process with PTY. Returns a handle with stdin/stdout streams. */
  spawn(hostId: string, command: string): Promise<ShellProcess>
  /** Disconnect from a host */
  disconnect(hostId: string): Promise<void>
}

// ── Config & Options ────────────────────────────────────────────────────────

/** Per-agent config — which hosts they can access */
export type ShelldConfig = {
  hosts: string[]
}

/** Options for creating shelld */
export type ShelldOptions = {
  driver: ShellDriver
  /** Number of characters for the head truncation (default: 500) */
  headChars?: number
  /** Number of characters for the tail truncation (default: 500) */
  tailChars?: number
}

// ── Session State ───────────────────────────────────────────────────────────

/** A shell session tracked by the daemon */
export type ShellSession = {
  commandId: string
  hostId: string
  command: string
  status: 'running' | 'done'
  exitCode: number | null
  /** Growing output buffer (array of chunks) */
  output: string[]
  totalBytes: number
  process: ShellProcess
  createdAt: Date
}

/** Handle returned by shelld() */
export type ShelldHandle = {
  /** The daemon definition to register with Keryx */
  daemon: DaemonDefinition
  /** Read-only view of active sessions for external observability */
  sessions: ReadonlyMap<string, ShellSession>
}

// ── Glob Matching ───────────────────────────────────────────────────────────

/** Match a hostId against a list of glob patterns (exact match or prefix*) */
function matchesGlob(hostId: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*') return true
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      if (hostId.startsWith(prefix)) return true
    } else {
      if (hostId === pattern) return true
    }
  }
  return false
}

// ── Output Formatting ───────────────────────────────────────────────────────

type TruncatedOutput =
  | { content: string; totalBytes: number }
  | { head: string; tail: string; totalBytes: number }

function formatOutput(
  chunks: string[],
  totalBytes: number,
  headChars: number,
  tailChars: number,
): TruncatedOutput {
  const full = chunks.join('')
  const maxInline = headChars + tailChars

  if (full.length <= maxInline) {
    return { content: full, totalBytes }
  }

  return {
    head: full.slice(0, headChars),
    tail: full.slice(-tailChars),
    totalBytes,
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a shell session broker daemon.
 *
 * @example
 * ```ts
 * const shell = shelld({ driver: myDockerDriver })
 * await kx.daemons.register(shell.daemon)
 *
 * const agent = await kx.agents.spawn('coder', {
 *   name: 'Coder',
 *   instruction: '...',
 *   config: { 'shelld': { hosts: ['dev-box'] } },
 * })
 * ```
 */
export function shelld(opts: ShelldOptions): ShelldHandle {
  const { driver } = opts
  const headChars = opts.headChars ?? 500
  const tailChars = opts.tailChars ?? 500

  const sessions = new Map<string, ShellSession>()
  const connectedHosts = new Set<string>()

  // ── helpers ─────────────────────────────────────────────────────────────

  /** Ensure a host is connected (idempotent) */
  async function ensureConnected(hostId: string): Promise<void> {
    if (!connectedHosts.has(hostId)) {
      await driver.connect(hostId)
      connectedHosts.add(hostId)
    }
  }

  /** Find a session by commandId and verify host access */
  function getSessionWithAccess(
    commandId: string,
    allowedHosts: string[],
  ): ShellSession | string {
    const session = sessions.get(commandId)
    if (!session) {
      return `Error: Unknown command "${commandId}".`
    }
    if (!matchesGlob(session.hostId, allowedHosts)) {
      return `Error: No access to host "${session.hostId}" for command "${commandId}".`
    }
    return session
  }

  // ── daemon definition ───────────────────────────────────────────────────

  const daemon: DaemonDefinition = {
    id: 'shelld',

    onStart: (kx: KeryxInstance) => {
      kx.bus.on('activation:before', (ctx) => {
        const config = ctx.agentConfig['shelld'] as ShelldConfig | undefined
        if (!config || !config.hosts || config.hosts.length === 0) return

        const allowedHosts = config.hosts

        ctx.addTools([
          // ── shell_exec ──────────────────────────────────────────────────
          createTool({
            id: 'shell_exec',
            description:
              'Execute a shell command on a host. Returns a commandId for tracking. ' +
              'Output is truncated for large results — use shell_output to paginate.',
            schema: {
              hostId: { type: 'string', description: 'Target host ID' },
              command: { type: 'string', description: 'Shell command to execute' },
              timeout: {
                type: 'number',
                description: 'Max ms to wait before returning (default: 5000). The command continues running if it exceeds this.',
                required: false,
              },
            },
            execute: async (args: { hostId: string; command: string; timeout?: number }) => {
              if (!matchesGlob(args.hostId, allowedHosts)) {
                return `Error: No access to host "${args.hostId}".`
              }

              const timeout = args.timeout ?? 5000
              const commandId = crypto.randomUUID()

              // Ensure host is connected
              await ensureConnected(args.hostId)

              // Spawn the process
              const process = await driver.spawn(args.hostId, args.command)

              const session: ShellSession = {
                commandId,
                hostId: args.hostId,
                command: args.command,
                status: 'running',
                exitCode: null,
                output: [],
                totalBytes: 0,
                process,
                createdAt: new Date(),
              }

              sessions.set(commandId, session)

              // Accumulate output
              process.onData((chunk: string) => {
                session.output.push(chunk)
                session.totalBytes += chunk.length
              })

              // Track exit + resolve wait in a single callback
              let resolveWait: (() => void) | null = null

              process.onExit((exitCode: number) => {
                session.status = 'done'
                session.exitCode = exitCode
                if (resolveWait) resolveWait()
              })

              // Wait up to timeout for completion
              await new Promise<void>((resolve) => {
                // Already done (instant process)
                if (session.status === 'done') {
                  resolve()
                  return
                }

                resolveWait = () => {
                  clearTimeout(timer)
                  resolve()
                }

                const timer = setTimeout(() => {
                  resolveWait = null
                  resolve()
                }, timeout)
              })

              return JSON.stringify({
                commandId,
                status: session.status,
                exitCode: session.exitCode,
                output: formatOutput(session.output, session.totalBytes, headChars, tailChars),
              })
            },
          }),

          // ── shell_output ────────────────────────────────────────────────
          createTool({
            id: 'shell_output',
            description:
              'Read output from a running or completed command. Use offset and length to paginate large outputs.',
            schema: {
              commandId: { type: 'string', description: 'Command ID from shell_exec' },
              offset: {
                type: 'number',
                description: 'Character offset to start reading from (default: 0)',
                required: false,
              },
              length: {
                type: 'number',
                description: 'Number of characters to read (default: 4000)',
                required: false,
              },
            },
            execute: async (args: { commandId: string; offset?: number; length?: number }) => {
              const result = getSessionWithAccess(args.commandId, allowedHosts)
              if (typeof result === 'string') return result

              const session = result
              const full = session.output.join('')
              const offset = args.offset ?? 0
              const length = args.length ?? 4000
              const content = full.slice(offset, offset + length)

              return JSON.stringify({
                content,
                offset,
                length: content.length,
                totalBytes: session.totalBytes,
                status: session.status,
                exitCode: session.exitCode,
              })
            },
          }),

          // ── shell_input ─────────────────────────────────────────────────
          createTool({
            id: 'shell_input',
            description:
              'Write to stdin of a running command. Use "\\x03" to send Ctrl+C (SIGINT).',
            schema: {
              commandId: { type: 'string', description: 'Command ID from shell_exec' },
              input: { type: 'string', description: 'String to write to stdin' },
            },
            execute: async (args: { commandId: string; input: string }) => {
              const result = getSessionWithAccess(args.commandId, allowedHosts)
              if (typeof result === 'string') return result

              const session = result
              if (session.status === 'done') {
                return `Error: Command "${args.commandId}" has already exited (code ${session.exitCode}).`
              }

              session.process.write(args.input)
              return JSON.stringify({ ok: true })
            },
          }),
        ])
      }, 50)
    },

    onStop: async () => {
      // Kill all active sessions
      for (const session of sessions.values()) {
        if (session.status === 'running') {
          session.process.kill()
        }
      }
      sessions.clear()

      // Disconnect all hosts
      for (const hostId of connectedHosts) {
        await driver.disconnect(hostId)
      }
      connectedHosts.clear()
    },
  }

  return {
    daemon,
    sessions: sessions as ReadonlyMap<string, ShellSession>,
  }
}
