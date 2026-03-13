/**
 * contextd — Tests
 *
 * Tests for the built-in context persistence daemon.
 */

import { describe, test, expect } from 'bun:test'
import { createKeryx } from '../../keryx.js'
import { contextd } from '../../daemons/contextd.js'
import type { AgentDefinition } from '../../types.js'

function makeAgent(name: string, config?: Record<string, Record<string, unknown>>): AgentDefinition {
  return {
    name,
    instruction: `You are ${name}.`,
    config,
  }
}

function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

describe('contextd', () => {
  test('context restored across activations when persist=true', async () => {
    const allMessages: any[][] = []

    const kx = createKeryx({
      daemons: [contextd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          // Track what messages the agent sees
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          allMessages.push(userMsgs.map((m: any) => m.content))
          return { content: 'Noted.' }
        },
      },
    })

    await kx.agents.spawn('stateful', makeAgent('Stateful Agent', {
      'context': { persist: true },
    }))

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
      daemons: [contextd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          allMessages.push(userMsgs.map((m: any) => m.content))
          return { content: 'Done.' }
        },
      },
    })

    await kx.agents.spawn('stateless', makeAgent('Stateless Agent')) // no config

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
      daemons: [contextd()],
      pollingInterval: 10,
      defaultProvider: {
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
      },
    })

    await kx.agents.spawn('flaky', makeAgent('Flaky Agent', {
      'context': { persist: true },
    }))

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
