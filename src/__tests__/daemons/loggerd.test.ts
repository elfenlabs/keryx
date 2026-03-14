/**
 * loggerd — Tests
 *
 * Tests for the built-in logger daemon.
 */

import { describe, test, expect } from 'bun:test'
import { createKeryx } from '../../keryx.js'
import { loggerd } from '../../daemons/loggerd.js'
import type { AgentDefinition } from '../../types.js'

function makeAgent(name: string): AgentDefinition {
  return {
    name,
    instruction: `You are ${name}.`,
  }
}

function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

describe('loggerd', () => {
  test('logs message arrival and response', async () => {
    const logs: string[] = []

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'Hello back!' }),
      },
    })

    await kx.daemons.register(loggerd({ log: (...args: unknown[]) => logs.push(args.join(' ')) }))

    await kx.agents.spawn('echo', makeAgent('Echo Agent'))

    kx.start()
    await kx.send({ to: 'echo', body: 'Hello world' })
    await wait(200)

    // Should have logged arrival
    const arrivalLog = logs.find(l => l.includes('←'))
    expect(arrivalLog).toBeDefined()
    expect(arrivalLog).toContain('[echo]')
    expect(arrivalLog).toContain('Hello world')
    expect(arrivalLog).toContain('external')

    // Should have logged response
    const responseLog = logs.find(l => l.includes('→'))
    expect(responseLog).toBeDefined()
    expect(responseLog).toContain('[echo]')
    expect(responseLog).toContain('Hello back!')

    await kx.stop()
  })

  test('logs errors on agent failure', async () => {
    const logs: string[] = []

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async () => { throw new Error('Provider error') },
      },
    })

    await kx.daemons.register(loggerd({ log: (...args: unknown[]) => logs.push(args.join(' ')) }))

    await kx.agents.spawn('fail', makeAgent('Fail Agent'))

    kx.start()
    await kx.send({ to: 'fail', body: 'crash' })
    await wait(200)

    const errorLog = logs.find(l => l.includes('ERROR'))
    expect(errorLog).toBeDefined()
    expect(errorLog).toContain('Provider error')

    await kx.stop()
  })

  test('truncates long messages in logs', async () => {
    const logs: string[] = []

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'ok' }),
      },
    })

    await kx.daemons.register(loggerd({ log: (...args: unknown[]) => logs.push(args.join(' ')) }))

    await kx.agents.spawn('verbose', makeAgent('Verbose Agent'))

    kx.start()
    const longBody = 'A'.repeat(200)
    await kx.send({ to: 'verbose', body: longBody })
    await wait(200)

    const arrivalLog = logs.find(l => l.includes('←'))
    expect(arrivalLog).toBeDefined()
    // Should be truncated with ...
    expect(arrivalLog).toContain('...')
    expect(arrivalLog!.length).toBeLessThan(longBody.length + 50)

    await kx.stop()
  })

  // ── Verbose mode tests ──────────────────────────────────────────────

  test('verbose: logs tool calls and results', async () => {
    const logs: string[] = []
    let callCount = 0

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async () => {
          callCount++
          if (callCount === 1) {
            return {
              toolCalls: [{ id: 'tc1', name: 'greet', arguments: { name: 'World' } }],
            }
          }
          return { content: 'Done greeting.' }
        },
      },
    })

    await kx.daemons.register(loggerd({ verbose: true, log: (...args: unknown[]) => logs.push(args.join(' ')) }))

    await kx.agents.spawn('worker', {
      ...makeAgent('Worker'),
      tools: [{
        id: 'greet',
        description: 'Says hello',
        schema: { name: { type: 'string' as const, description: 'Name' } },
        execute: async (args: { name: string }) => `Hello, ${args.name}!`,
      }],
    })

    kx.start()
    await kx.send({ to: 'worker', body: 'Say hi' })
    await wait(500)

    const toolCallLog = logs.find(l => l.includes('tool_call:'))
    expect(toolCallLog).toBeDefined()
    expect(toolCallLog).toContain('greet')

    const toolResultLog = logs.find(l => l.includes('tool_result:'))
    expect(toolResultLog).toBeDefined()
    expect(toolResultLog).toContain('Hello, World!')

    await kx.stop()
  })

  test('verbose: output contains ANSI color codes', async () => {
    const logs: string[] = []

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'Colored response' }),
      },
    })

    await kx.daemons.register(loggerd({ verbose: true, log: (...args: unknown[]) => logs.push(args.join(' ')) }))

    await kx.agents.spawn('colortest', makeAgent('Color Agent'))

    kx.start()
    await kx.send({ to: 'colortest', body: 'Test colors' })
    await wait(200)

    // Verbose logs should contain ANSI escape codes
    const hasAnsi = logs.some(l => l.includes('\x1b['))
    expect(hasAnsi).toBe(true)

    await kx.stop()
  })

  test('verbose: non-verbose mode produces no ANSI codes', async () => {
    const logs: string[] = []

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'Plain response' }),
      },
    })

    await kx.daemons.register(loggerd({ log: (...args: unknown[]) => logs.push(args.join(' ')) }))

    await kx.agents.spawn('plain', makeAgent('Plain Agent'))

    kx.start()
    await kx.send({ to: 'plain', body: 'No colors' })
    await wait(200)

    const hasAnsi = logs.some(l => l.includes('\x1b['))
    expect(hasAnsi).toBe(false)

    await kx.stop()
  })
})
