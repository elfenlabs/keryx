/**
 * Built-in Daemons — Tests
 *
 * Tests for loggerd and contextd with mocked infrastructure.
 */

import { describe, test, expect, mock } from 'bun:test'
import { createKeryx } from '../keryx.js'
import { loggerd } from '../daemons/loggerd.js'
import { contextd } from '../daemons/contextd.js'
import type { AgentDefinition } from '../types.js'

function makeAgent(id: string, name: string, config?: Record<string, Record<string, unknown>>): AgentDefinition {
  return {
    id,
    name,
    instruction: `You are ${name}.`,
    provider: { url: 'http://mock', model: 'mock' },
    config,
  }
}

function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── loggerd Tests ───────────────────────────────────────────────────────────

describe('loggerd', () => {
  test('logs message arrival and response', async () => {
    const logs: string[] = []

    const kx = createKeryx({
      agents: [makeAgent('echo', 'Echo Agent')],
      daemons: [loggerd({ log: (...args: unknown[]) => logs.push(args.join(' ')) })],
      pollingInterval: 10,
      createProvider: () => ({
        generate: async () => ({ content: 'Hello back!' }),
      }),
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
      createProvider: () => ({
        generate: async () => { throw new Error('Provider error') },
      }),
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
      createProvider: () => ({
        generate: async () => ({ content: 'ok' }),
      }),
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

// ── contextd Tests ──────────────────────────────────────────────────────────

describe('contextd', () => {
  test('context restored across activations when persist=true', async () => {
    const allMessages: any[][] = []

    const kx = createKeryx({
      agents: [makeAgent('stateful', 'Stateful Agent', {
        'context': { persist: true },
      })],
      daemons: [contextd()],
      pollingInterval: 10,
      createProvider: () => ({
        generate: async (params: any) => {
          // Track what messages the agent sees
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          allMessages.push(userMsgs.map((m: any) => m.content))
          return { content: 'Noted.' }
        },
      }),
    })

    kx.start()

    // First message
    await kx.send({ to: 'stateful', body: 'First message' })
    await wait(200)

    // Second message — should see context from first activation
    await kx.send({ to: 'stateful', body: 'Second message' })
    await wait(200)

    // First activation should only see "First message"
    expect(allMessages[0]).toEqual(['First message'])

    // Second activation should see previous context + new message
    expect(allMessages[1]).toContain('First message')
    expect(allMessages[1]).toContain('Second message')

    await kx.stop()
  })

  test('context NOT restored when persist is not configured', async () => {
    const allMessages: any[][] = []

    const kx = createKeryx({
      agents: [makeAgent('stateless', 'Stateless Agent')], // no config
      daemons: [contextd()],
      pollingInterval: 10,
      createProvider: () => ({
        generate: async (params: any) => {
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          allMessages.push(userMsgs.map((m: any) => m.content))
          return { content: 'Done.' }
        },
      }),
    })

    kx.start()

    await kx.send({ to: 'stateless', body: 'First message' })
    await wait(200)

    await kx.send({ to: 'stateless', body: 'Second message' })
    await wait(200)

    // Both activations should only see their own message
    expect(allMessages[0]).toEqual(['First message'])
    expect(allMessages[1]).toEqual(['Second message'])

    await kx.stop()
  })

  test('context not persisted on error', async () => {
    let callCount = 0
    const allMessages: any[][] = []

    const kx = createKeryx({
      agents: [makeAgent('flaky', 'Flaky Agent', {
        'context': { persist: true },
      })],
      daemons: [contextd()],
      pollingInterval: 10,
      createProvider: () => ({
        generate: async (params: any) => {
          callCount++
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          allMessages.push(userMsgs.map((m: any) => m.content))

          // First call succeeds, second fails, third succeeds
          if (callCount === 2) {
            throw new Error('Temporary failure')
          }
          return { content: 'ok' }
        },
      }),
    })

    kx.start()

    // 1st message — succeeds, context persisted
    await kx.send({ to: 'flaky', body: 'Good message' })
    await wait(200)

    // 2nd message — fails, context should NOT be updated
    await kx.send({ to: 'flaky', body: 'Bad message' })
    await wait(200)

    // 3rd message — should see context from 1st (not 2nd)
    await kx.send({ to: 'flaky', body: 'Recovery message' })
    await wait(200)

    // Third activation should see "Good message" context but not "Bad message"
    const thirdActivation = allMessages[2]!
    expect(thirdActivation).toContain('Good message')
    expect(thirdActivation).not.toContain('Bad message')
    expect(thirdActivation).toContain('Recovery message')

    await kx.stop()
  })
})
