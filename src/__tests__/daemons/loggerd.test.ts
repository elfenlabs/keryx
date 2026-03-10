/**
 * loggerd — Tests
 *
 * Tests for the built-in logger daemon.
 */

import { describe, test, expect } from 'bun:test'
import { createKeryx } from '../../keryx.js'
import { loggerd } from '../../daemons/loggerd.js'
import type { AgentDefinition } from '../../types.js'

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
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

    const kx = createKeryx({
      agents: [makeAgent('echo', 'Echo Agent')],
      daemons: [loggerd({ log: (...args: unknown[]) => logs.push(args.join(' ')) })],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'Hello back!' }),
      },
    })

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

    const kx = createKeryx({
      agents: [makeAgent('fail', 'Fail Agent')],
      daemons: [loggerd({ log: (...args: unknown[]) => logs.push(args.join(' ')) })],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => { throw new Error('Provider error') },
      },
    })

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

    const kx = createKeryx({
      agents: [makeAgent('verbose', 'Verbose Agent')],
      daemons: [loggerd({ log: (...args: unknown[]) => logs.push(args.join(' ')) })],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'ok' }),
      },
    })

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
})
