/**
 * Keryx Integration Tests — Mocked Nous Runner
 *
 * Tests the full orchestration flow: message delivery, request-reply,
 * multi-agent messaging, force interrupts, daemon hooks, and failure notifications.
 *
 * Nous's runAgent() is mocked to simulate agent behavior without LLM calls.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { createKeryx } from '../keryx.js'
import { createTool } from '@elfenlabs/nous'
import type { KeryxInstance, AgentDefinition, DaemonDefinition } from '../types.js'
import type { Provider, GenerateResult, AgentConfig } from '@elfenlabs/nous'

// ── Mock Infrastructure ─────────────────────────────────────────────────────

/**
 * Create a mock provider that executes a scripted behavior.
 * The behavior function receives the messages and tools, and returns what
 * the "agent" should do (respond with text, or make tool calls).
 */
type MockBehavior = (params: {
  messages: { role: string; content: string }[]
  tools?: { name: string }[]
}) => GenerateResult

function createMockProvider(behavior: MockBehavior): Provider {
  return {
    generate: async (params) => behavior(params as any),
  }
}

/** Helper to create a simple agent definition */
function makeAgent(id: string, name: string, overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id,
    name,
    instruction: `You are ${name}.`,

    ...overrides,
  }
}

/**
 * Wait for async processing to complete.
 * Since Keryx processes messages asynchronously, we need small delays.
 */
function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Keryx Integration', () => {
  // Track what the mock provider receives
  let providerCalls: { agentId: string; messages: any[]; tools: any[] }[]
  let providerBehaviors: Map<string, MockBehavior>

  function setupKeryx(
    agents: AgentDefinition[],
    daemons?: DaemonDefinition[],
  ): KeryxInstance {
    providerCalls = []
    providerBehaviors = new Map()

    const kx = createKeryx({
      agents,
      daemons,
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          // Record the call
          providerCalls.push({
            agentId: 'agent',
            messages: params.messages,
            tools: params.tools ?? [],
          })

          // Look up behavior by the last user message
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          const lastUserMsg = userMsgs[userMsgs.length - 1]?.content ?? ''

          // Check agent-specific behavior
          for (const [key, behavior] of providerBehaviors) {
            if (lastUserMsg.includes(key)) {
              return behavior(params as any)
            }
          }

          // Default: simple text response
          return { content: `Processed: ${lastUserMsg}` }
        },
      },
    })

    return kx
  }

  // ─── Basic Message Delivery ───────────────────────────────────────────

  test('send() delivers message and agent processes it', async () => {
    const kx = setupKeryx([makeAgent('echo', 'Echo Agent')])
    kx.start()

    await kx.send({ to: 'echo', body: 'Hello world' })
    await wait(200)

    expect(providerCalls.length).toBeGreaterThanOrEqual(1)
    const call = providerCalls[0]!
    // System prompt should contain agent identity
    const systemMsg = call.messages.find((m: any) => m.role === 'system')
    expect(systemMsg.content).toContain('You are agent "echo"')
    // User message should be the body
    const userMsg = call.messages.find((m: any) => m.role === 'user')
    expect(userMsg.content).toBe('Hello world')

    await kx.stop()
  })

  test('send() throws for unknown agent', async () => {
    const kx = setupKeryx([makeAgent('echo', 'Echo')])
    kx.start()

    await expect(kx.send({ to: 'nonexistent', body: 'hi' })).rejects.toThrow('Unknown agent')

    await kx.stop()
  })

  // ─── Request-Reply ────────────────────────────────────────────────────

  test('request() returns agent response via ephemeral channel', async () => {
    // The agent needs to call message_send with the replyTo channel
    providerBehaviors = new Map()
    let replyCallCount = 0

    const kx = createKeryx({
      agents: [makeAgent('responder', 'Responder')],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          replyCallCount++
          // First call: make a tool call to reply via message_send
          if (replyCallCount === 1) {
            // Extract the replyTo from the system prompt
            const systemMsg = params.messages.find((m: any) => m.role === 'system')
            const replyMatch = systemMsg.content.match(/message_send with to="(ext-[^"]+)"/)
            const replyTo = replyMatch?.[1] ?? 'unknown'
            return {
              toolCalls: [{
                id: 'call-1',
                name: 'message_send',
                arguments: { to: replyTo, body: 'The answer is 42' },
              }],
            }
          }
          // Second call (after tool result): final response
          return { content: 'Done.' }
        },
      },
    })

    kx.start()
    const response = await kx.request({ to: 'responder', body: 'What is the answer?' })
    expect(response).toBe('The answer is 42')

    await kx.stop()
  })

  test('request() rejects on abort', async () => {
    const kx = createKeryx({
      agents: [makeAgent('slow', 'Slow Agent')],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          // Simulate a slow agent — but respect abort signal
          const signal = params.signal as AbortSignal | undefined
          for (let i = 0; i < 20; i++) {
            if (signal?.aborted) {
              throw new Error('Agent was aborted')
            }
            await new Promise(r => setTimeout(r, 10))
          }
          return { content: 'too late' }
        },
      },
    })

    kx.start()
    const controller = new AbortController()
    const promise = kx.request({
      to: 'slow',
      body: 'test',
      signal: controller.signal,
    })

    // Abort after a short delay
    await wait(30)
    controller.abort()

    await expect(promise).rejects.toThrow('Request aborted')
    // Wait for agent to finish processing the abort before stopping
    await wait(100)
    await kx.stop()
  })


  // ─── Multi-Agent Messaging ────────────────────────────────────────────

  test('agent A sends message to agent B via message_send tool', async () => {
    const agentBReceived: string[] = []
    let msgCallCount = 0

    const kx = createKeryx({
      agents: [
        makeAgent('agent-a', 'Agent A'),
        makeAgent('agent-b', 'Agent B'),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          const lastUserMsg = userMsgs[userMsgs.length - 1]?.content ?? ''
          const systemMsg = params.messages.find((m: any) => m.role === 'system')

          // Agent A: forward message to Agent B via tool call
          if (systemMsg.content.includes('agent "agent-a"')) {
            msgCallCount++
            if (msgCallCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'message_send',
                  arguments: { to: 'agent-b', body: 'Hello from A!' },
                }],
              }
            }
            return { content: 'Forwarded to B.' }
          }

          // Agent B: just respond
          agentBReceived.push(lastUserMsg)
          return { content: 'Got it from A.' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'agent-a', body: 'Start chain' })
    await wait(500)

    expect(agentBReceived).toContain('Hello from A!')
    await kx.stop()
  })

  // ─── System Prompt Addendum ───────────────────────────────────────────

  test('system prompt contains agent registry', async () => {
    let capturedSystemPrompt = ''

    const kx = createKeryx({
      agents: [
        makeAgent('manager', 'Manager'),
        makeAgent('worker', 'Worker'),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          capturedSystemPrompt = systemMsg.content
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'manager', body: 'test' })
    await wait(200)

    // Should contain agent identity
    expect(capturedSystemPrompt).toContain('You are agent "manager"')
    // Should list available agents (minus self)
    expect(capturedSystemPrompt).toContain('worker: Worker')
    // Should not list self in available agents
    expect(capturedSystemPrompt).not.toMatch(/^- manager:/m)

    await kx.stop()
  })

  test('system prompt contains message_send tool', async () => {
    let capturedTools: any[] = []

    const kx = createKeryx({
      agents: [makeAgent('test-agent', 'Test')],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'test-agent', body: 'test' })
    await wait(200)

    const sendTool = capturedTools.find((t: any) => t.name === 'message_send')
    expect(sendTool).toBeDefined()
    expect(sendTool.description).toContain('Send a message')

    await kx.stop()
  })

  // ─── Daemon Hooks ─────────────────────────────────────────────────────

  test('daemon hooks fire in correct order', async () => {
    const hookLog: string[] = []

    const daemon1: DaemonDefinition = {
      id: 'first',
      order: 1,
      onMessageReceived: () => { hookLog.push('first:onMessageReceived') },
      onPreActivation: () => { hookLog.push('first:onPreActivation') },
      onPostActivation: () => { hookLog.push('first:onPostActivation') },
    }

    const daemon2: DaemonDefinition = {
      id: 'second',
      order: 2,
      onMessageReceived: () => { hookLog.push('second:onMessageReceived') },
      onPreActivation: () => { hookLog.push('second:onPreActivation') },
      onPostActivation: () => { hookLog.push('second:onPostActivation') },
    }

    const kx = createKeryx({
      agents: [makeAgent('test', 'Test')],
      daemons: [daemon2, daemon1], // deliberately out of order
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'ok' }),
      },
    })

    kx.start()
    await kx.send({ to: 'test', body: 'hello' })
    await wait(200)

    // Hooks should fire in order (1 before 2)
    expect(hookLog).toEqual([
      'first:onMessageReceived',
      'second:onMessageReceived',
      'first:onPreActivation',
      'second:onPreActivation',
      'first:onPostActivation',
      'second:onPostActivation',
    ])

    await kx.stop()
  })

  test('daemon can inject tools via onPreActivation', async () => {
    let capturedTools: any[] = []

    const daemon: DaemonDefinition = {
      id: 'tool-injector',
      order: 10,
      onPreActivation: (ctx) => {
        ctx.addTools([
          createTool({
            id: 'custom_tool',
            description: 'A daemon-injected tool',
            execute: async () => 'custom result',
          }),
        ])
      },
    }

    const kx = createKeryx({
      agents: [makeAgent('test', 'Test')],
      daemons: [daemon],
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

    const customTool = capturedTools.find((t: any) => t.name === 'custom_tool')
    expect(customTool).toBeDefined()
    expect(customTool.description).toBe('A daemon-injected tool')

    await kx.stop()
  })

  test('daemon can inject prompt segments', async () => {
    let capturedSystemPrompt = ''

    const daemon: DaemonDefinition = {
      id: 'prompt-injector',
      order: 10,
      onPreActivation: (ctx) => {
        ctx.addPromptSegment('You have access to the Thesauros knowledge graph.')
      },
    }

    const kx = createKeryx({
      agents: [makeAgent('test', 'Test')],
      daemons: [daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedSystemPrompt = params.messages.find((m: any) => m.role === 'system').content
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'test', body: 'test' })
    await wait(200)

    expect(capturedSystemPrompt).toContain('You have access to the Thesauros knowledge graph.')
    await kx.stop()
  })

  // ─── Runtime Daemon Management ────────────────────────────────────────

  test('daemons.register/deregister/list work at runtime', () => {
    const kx = createKeryx({
      agents: [makeAgent('test', 'Test')],
      pollingInterval: 100,
      defaultProvider: {
        generate: async () => ({ content: 'ok' }),
      },
    })

    expect(kx.daemons.list()).toEqual([])

    kx.daemons.register({ id: 'test-daemon', order: 5 })
    expect(kx.daemons.list()).toEqual([{ id: 'test-daemon', order: 5 }])

    kx.daemons.register({ id: 'another', order: 1 })
    // Should be sorted by order
    expect(kx.daemons.list()).toEqual([
      { id: 'another', order: 1 },
      { id: 'test-daemon', order: 5 },
    ])

    kx.daemons.deregister('test-daemon')
    expect(kx.daemons.list()).toEqual([{ id: 'another', order: 1 }])
  })

  // ─── Failure Notification ─────────────────────────────────────────────

  test('failure notification sent back to sender agent', async () => {
    const receivedByA: string[] = []

    const kx = createKeryx({
      agents: [
        makeAgent('agent-a', 'Agent A'),
        makeAgent('agent-b', 'Agent B'),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          const lastUserMsg = userMsgs[userMsgs.length - 1]?.content ?? ''

          // Agent B: always throws
          if (systemMsg.content.includes('agent "agent-b"')) {
            throw new Error('Agent B crashed')
          }

          // Agent A: track messages received
          receivedByA.push(lastUserMsg)
          return { content: 'A processed it.' }
        },
      },
    })

    kx.start()
    // Send a message from agent-a to agent-b (simulated via from field)
    await kx.send({ to: 'agent-b', body: 'Do something', from: 'agent-a' })
    await wait(500)

    // Agent A should have received a failure notification
    const failureMsg = receivedByA.find(m => m.includes('failed'))
    expect(failureMsg).toBeDefined()
    expect(failureMsg).toContain('Agent B crashed')

    await kx.stop()
  })

  // ─── Serial Per-Agent Execution ───────────────────────────────────────

  test('agent processes messages one at a time (serial)', async () => {
    let concurrentCount = 0
    let maxConcurrent = 0

    const kx = createKeryx({
      agents: [makeAgent('serial', 'Serial Agent')],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => {
          concurrentCount++
          maxConcurrent = Math.max(maxConcurrent, concurrentCount)
          await wait(50) // simulate work
          concurrentCount--
          return { content: 'done' }
        },
      },
    })

    kx.start()

    // Send 3 messages rapidly
    await kx.send({ to: 'serial', body: 'msg1' })
    await kx.send({ to: 'serial', body: 'msg2' })
    await kx.send({ to: 'serial', body: 'msg3' })

    await wait(500)

    // Should never have had more than 1 concurrent execution
    expect(maxConcurrent).toBe(1)

    await kx.stop()
  })

  // ─── PostActivation Context ───────────────────────────────────────────

  test('onPostActivation receives response and steps', async () => {
    let capturedResponse = ''
    let capturedSteps = 0

    const daemon: DaemonDefinition = {
      id: 'spy',
      order: 0,
      onPostActivation: (ctx) => {
        capturedResponse = ctx.response ?? ''
        capturedSteps = ctx.steps
      },
    }

    const kx = createKeryx({
      agents: [makeAgent('test', 'Test')],
      daemons: [daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'The response text', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }),
      },
    })

    kx.start()
    await kx.send({ to: 'test', body: 'test' })
    await wait(200)

    expect(capturedResponse).toBe('The response text')
    expect(capturedSteps).toBe(1)

    await kx.stop()
  })

  test('onPostActivation receives error on failure', async () => {
    let capturedError: Error | null = null

    const daemon: DaemonDefinition = {
      id: 'spy',
      order: 0,
      onPostActivation: (ctx) => {
        capturedError = ctx.error
      },
    }

    const kx = createKeryx({
      agents: [makeAgent('fail', 'Fail Agent')],
      daemons: [daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => { throw new Error('Boom!') },
      },
    })

    kx.start()
    await kx.send({ to: 'fail', body: 'crash' })
    await wait(200)

    expect(capturedError).not.toBeNull()
    expect(capturedError!.message).toBe('Boom!')

    await kx.stop()
  })
})
