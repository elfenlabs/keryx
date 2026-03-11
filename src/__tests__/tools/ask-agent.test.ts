/**
 * agent_ask Tool — Tests
 *
 * Tests for the blocking agent-to-agent RPC tool.
 */

import { describe, test, expect } from 'bun:test'
import { createKeryx } from '../../keryx.js'
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

describe('agent_ask tool', () => {
  test('agent uses agent_ask to get a response from another agent', async () => {
    let analystResult = ''
    let analystCallCount = 0

    const kx = createKeryx({
      agents: [
        makeAgent('analyst', 'Analyst'),
        makeAgent('researcher', 'Researcher'),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')

          // Analyst: use agent_ask to query researcher
          if (systemMsg.content.includes('agent "analyst"')) {
            analystCallCount++
            if (analystCallCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'agent_ask',
                  arguments: { to: 'researcher', body: 'What is the market trend?' },
                }],
              }
            }
            // After tool result: capture the researcher's response
            const toolResult = params.messages.find((m: any) => m.role === 'tool')
            analystResult = toolResult?.content ?? ''
            return { content: 'Analysis complete.' }
          }

          // Researcher: just respond with content (final output = reply)
          if (systemMsg.content.includes('agent "researcher"')) {
            return { content: 'Market is bullish on tech.' }
          }

          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'analyst', body: 'Analyze the market' })
    await wait(500)

    expect(analystResult).toBe('Market is bullish on tech.')
    await kx.stop()
  })

  test('agent_ask returns error for unknown agent', async () => {
    let toolResult = ''
    let callCount = 0

    const kx = createKeryx({
      agents: [makeAgent('solo', 'Solo Agent')],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          callCount++
          if (callCount === 1) {
            return {
              toolCalls: [{
                id: 'call-1',
                name: 'agent_ask',
                arguments: { to: 'nonexistent', body: 'Hello?' },
              }],
            }
          }
          const toolMsg = params.messages.find((m: any) => m.role === 'tool')
          toolResult = toolMsg?.content ?? ''
          return { content: 'handled error' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'solo', body: 'try asking unknown' })
    await wait(200)

    expect(toolResult).toContain('Unknown agent')
    await kx.stop()
  })

  test('agent_ask returns error when asking self', async () => {
    let toolResult = ''
    let callCount = 0

    const kx = createKeryx({
      agents: [makeAgent('narcissist', 'Narcissist')],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          callCount++
          if (callCount === 1) {
            return {
              toolCalls: [{
                id: 'call-1',
                name: 'agent_ask',
                arguments: { to: 'narcissist', body: 'Talk to myself' },
              }],
            }
          }
          const toolMsg = params.messages.find((m: any) => m.role === 'tool')
          toolResult = toolMsg?.content ?? ''
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'narcissist', body: 'go' })
    await wait(200)

    expect(toolResult).toContain('Cannot ask yourself')
    await kx.stop()
  })

  test('agent_ask times out against slow agent', async () => {
    let toolResult = ''
    let callCount = 0

    const kx = createKeryx({
      agents: [
        makeAgent('impatient', 'Impatient'),
        makeAgent('slow', 'Slow Agent'),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')

          if (systemMsg.content.includes('agent "impatient"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'agent_ask',
                  arguments: { to: 'slow', body: 'Quick!', timeout: 100 },
                }],
              }
            }
            const toolMsg = params.messages.find((m: any) => m.role === 'tool')
            toolResult = toolMsg?.content ?? ''
            return { content: 'timed out' }
          }

          if (systemMsg.content.includes('agent "slow"')) {
            await new Promise(r => setTimeout(r, 500))
            return { content: 'too slow' }
          }

          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'impatient', body: 'go' })
    await wait(800)

    expect(toolResult).toContain('timed out')
    await kx.stop()
  })

  test('agent_ask tool appears in agent tool set', async () => {
    let capturedTools: any[] = []

    const kx = createKeryx({
      agents: [makeAgent('test', 'Test')],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'test', body: 'hello' })
    await wait(200)

    const askTool = capturedTools.find((t: any) => t.name === 'agent_ask')
    expect(askTool).toBeDefined()
    expect(askTool.description).toContain('wait for their response')

    await kx.stop()
  })
})
