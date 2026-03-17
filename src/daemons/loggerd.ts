/**
 * Keryx — loggerd (Logger Daemon)
 *
 * Built-in daemon that logs activations, tool calls, and errors
 * to the terminal for development feedback.
 *
 * When `verbose: true`, logs all daemon hooks with per-agent ANSI
 * colors and buffered thinking/output blocks.
 */

import type { DaemonDefinition, KeryxInstance } from '../types.js'

// ── ANSI Color Palette ──────────────────────────────────────────────────────

const COLORS = [
  '\x1b[36m',  // cyan
  '\x1b[35m',  // magenta
  '\x1b[33m',  // yellow
  '\x1b[32m',  // green
  '\x1b[34m',  // blue
  '\x1b[31m',  // red
] as const

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** Deterministic color from agent ID */
function colorFor(agentId: string): string {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash + agentId.charCodeAt(i)) | 0
  }
  return COLORS[Math.abs(hash) % COLORS.length]
}

/** Format a colored verbose log block: `[agent_id] state:\n  body` */
function fmtVerbose(agentId: string, state: string, body: string, log: (...args: unknown[]) => void): void {
  const c = colorFor(agentId)
  const header = `${c}[${agentId}] ${state}:${RESET}`
  const indented = body
    .split('\n')
    .map(line => `  ${DIM}${line}${RESET}`)
    .join('\n')
  log(`${header}\n${indented}`)
}

/** Truncate a string to maxLen chars */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s
}

// ── Options ─────────────────────────────────────────────────────────────────

export type LoggerdOptions = {
  /** Custom log function. Default: console.log */
  log?: (...args: unknown[]) => void
  /**
   * Enable verbose mode: logs tool calls, thinking, output, and
   * activation lifecycle — with per-agent ANSI colors.
   * Default: false
   */
  verbose?: boolean
}

/**
 * Create a logger daemon for development observability.
 *
 * @example
 * ```ts
 * await kx.daemons.register(loggerd())
 * await kx.daemons.register(loggerd({ verbose: true }))
 * ```
 */
export function loggerd(opts?: LoggerdOptions): DaemonDefinition {
  const log = opts?.log ?? console.log
  const verbose = opts?.verbose ?? false

  // Buffers for thinking/output chunks, keyed by agentId
  const thinkingBuffers = new Map<string, string[]>()
  const outputBuffers = new Map<string, string[]>()

  return {
    id: 'loggerd',

    onStart: (kx: KeryxInstance) => {
      // ── message:received ───────────────────────────────────────────
      kx.bus.on('message:received', (ctx) => {
        const from = ctx.message.from ?? 'external'
        const body = truncate(ctx.message.body, 60)
        const force = ctx.message.force ? ' [FORCE]' : ''

        if (verbose) {
          fmtVerbose(ctx.message.to, 'recv', `← "${body}" (from: ${from})${force}`, log)
        } else {
          log(`[${ctx.message.to}] ← "${body}" (from: ${from})${force}`)
        }
      }, 0)

      // ── activation:before (verbose only) ───────────────────────────
      if (verbose) {
        kx.bus.on('activation:before', (ctx) => {
          fmtVerbose(ctx.agentId, 'activate', `processing message from ${ctx.message.from ?? 'external'}`, log)
        }, 0)
      }

      // ── tool:before (verbose only) ─────────────────────────────────
      if (verbose) {
        kx.bus.on('tool:before', (ctx) => {
          const argsStr = truncate(JSON.stringify(ctx.args), 120)
          fmtVerbose(ctx.agentId, 'tool_call', `${ctx.toolId}(${argsStr})`, log)
        }, 0)
      }

      // ── tool:after (verbose only) ──────────────────────────────────
      if (verbose) {
        kx.bus.on('tool:after', (ctx) => {
          const resultStr = truncate(String(ctx.result), 200)
          fmtVerbose(ctx.agentId, 'tool_result', resultStr, log)
        }, 0)
      }

      // ── agent:stream (verbose only) ────────────────────────────────
      if (verbose) {
        kx.bus.on('agent:stream', (ctx) => {
          if (ctx.type === 'thinking') {
            if (ctx.phase === 'start') {
              thinkingBuffers.set(ctx.agentId, [])
            } else if (ctx.phase === 'chunk' && ctx.chunk) {
              const buf = thinkingBuffers.get(ctx.agentId)
              if (buf) buf.push(ctx.chunk)
            } else if (ctx.phase === 'end') {
              const buf = thinkingBuffers.get(ctx.agentId)
              if (buf && buf.length > 0) {
                const full = truncate(buf.join(''), 500)
                fmtVerbose(ctx.agentId, 'thinking', full, log)
              }
              thinkingBuffers.delete(ctx.agentId)
            }
          } else if (ctx.type === 'output') {
            if (ctx.phase === 'start') {
              outputBuffers.set(ctx.agentId, [])
            } else if (ctx.phase === 'chunk' && ctx.chunk) {
              const buf = outputBuffers.get(ctx.agentId)
              if (buf) buf.push(ctx.chunk)
            } else if (ctx.phase === 'end') {
              const buf = outputBuffers.get(ctx.agentId)
              if (buf && buf.length > 0) {
                const full = truncate(buf.join(''), 500)
                fmtVerbose(ctx.agentId, 'output', full, log)
              }
              outputBuffers.delete(ctx.agentId)
            }
          }
          // tool_call streaming is handled by tool:before/tool:after
        }, 0)
      }

      // ── activation:after ───────────────────────────────────────────
      kx.bus.on('activation:after', (ctx) => {
        if (ctx.error) {
          if (verbose) {
            fmtVerbose(ctx.agentId, 'error', `✗ ${ctx.error.message}`, log)
          } else {
            log(`[${ctx.agentId}] ✗ ERROR: ${ctx.error.message}`)
          }
        } else {
          const response = ctx.response ?? ''
          const body = truncate(response, 60)

          if (verbose) {
            fmtVerbose(ctx.agentId, 'done', `→ "${body}" (steps: ${ctx.steps})`, log)
          } else {
            log(`[${ctx.agentId}] → "${body}" (steps: ${ctx.steps})`)
          }
        }
      }, 0)
    },
  }
}
