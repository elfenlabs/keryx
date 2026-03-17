/**
 * Keryx Integration Tests — Mocked Nous Runner
 *
 * Tests the full orchestration flow: message delivery, request-reply,
 * multi-agent messaging, force interrupts, daemon hooks, failure notifications,
 * and dynamic agent spawn/destroy lifecycle.
 *
 * Nous's runAgent() is mocked to simulate agent behavior without LLM calls.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { createKeryx } from '../keryx.js'
import { createTool } from '@elfenlabs/nous'
import type { KeryxInstance, AgentDefinition, DaemonDefinition, StreamEvent } from '../types.js'
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

/** Helper to create a simple agent definition (template — no id) */
function makeAgent(name: string, overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
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

  async function setupKeryx(
    agents: { id: string; def: AgentDefinition }[],
    daemons?: DaemonDefinition[],
  ): Promise<KeryxInstance> {
    providerCalls = []
    providerBehaviors = new Map()

    const kx = createKeryx({
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

    // Register daemons via runtime API
    if (daemons) {
      for (const d of daemons) {
        await kx.daemons.register(d)
      }
    }

    // Spawn all agents
    for (const { id, def } of agents) {
      await kx.agents.spawn(id, def)
    }

    return kx
  }

  // ─── Basic Message Delivery ───────────────────────────────────────────

  test('send() delivers message and agent processes it', async () => {
    const kx = await setupKeryx([{ id: 'echo', def: makeAgent('Echo Agent') }])
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
    const kx = await setupKeryx([{ id: 'echo', def: makeAgent('Echo') }])
    kx.start()

    await expect(kx.send({ to: 'nonexistent', body: 'hi' })).rejects.toThrow('Unknown agent')

    await kx.stop()
  })

  // ─── Request-Reply ────────────────────────────────────────────────────

  test('request() returns agent response via final output', async () => {
    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => {
          return { content: 'The answer is 42', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
        },
      },
    })

    await kx.agents.spawn('responder', makeAgent('Responder'))
    kx.start()
    const result = await kx.request({ to: 'responder', body: 'What is the answer?' })
    expect(result.response).toBe('The answer is 42')
    expect(result.events).toBeDefined()
    expect(result.usage.totalTokens).toBe(15)

    await kx.stop()
  })

  test('request() rejects on abort', async () => {
    const kx = createKeryx({
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

    await kx.agents.spawn('slow', makeAgent('Slow Agent'))
    kx.start()
    const controller = new AbortController()
    const handle = kx.request({
      to: 'slow',
      body: 'test',
      signal: controller.signal,
    })

    // Abort after a short delay
    await wait(30)
    controller.abort()

    await expect(handle.result).rejects.toThrow('Request aborted')
    // Wait for agent to finish processing the abort before stopping
    await wait(100)
    await kx.stop()
  })


  // ─── Multi-Agent Messaging ────────────────────────────────────────────

  test('agent A sends message to agent B via message_send tool', async () => {
    const agentBReceived: string[] = []
    let msgCallCount = 0

    const kx = createKeryx({
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

    await kx.agents.spawn('agent-a', makeAgent('Agent A'))
    await kx.agents.spawn('agent-b', makeAgent('Agent B'))
    kx.start()
    await kx.send({ to: 'agent-a', body: 'Start chain' })
    await wait(500)

    expect(agentBReceived.some(m => m.includes('Hello from A!'))).toBe(true)
    await kx.stop()
  })

  // ─── System Prompt Addendum ───────────────────────────────────────────

  test('system prompt contains agent registry', async () => {
    let capturedSystemPrompt = ''

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          capturedSystemPrompt = systemMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('manager', makeAgent('Manager'))
    await kx.agents.spawn('worker', makeAgent('Worker'))
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
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('test-agent', makeAgent('Test'))
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
      capabilities: {
        writes: ['message:received', 'activation:before', 'activation:after'],
      },
      onStart: (kx) => {
        kx.bus.on('message:received', () => { hookLog.push('first:message:received') }, 1)
        kx.bus.on('activation:before', () => { hookLog.push('first:activation:before') }, 1)
        kx.bus.on('activation:after', () => { hookLog.push('first:activation:after') }, 1)
      },
    }

    const daemon2: DaemonDefinition = {
      id: 'second',
      capabilities: {
        writes: ['message:received', 'activation:before', 'activation:after'],
      },
      onStart: (kx) => {
        kx.bus.on('message:received', () => { hookLog.push('second:message:received') }, 2)
        kx.bus.on('activation:before', () => { hookLog.push('second:activation:before') }, 2)
        kx.bus.on('activation:after', () => { hookLog.push('second:activation:after') }, 2)
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'ok' }),
      },
    })

    // Register deliberately out of order — listeners sorted by order arg
    await kx.daemons.register(daemon2)
    await kx.daemons.register(daemon1)

    await kx.agents.spawn('test', makeAgent('Test'))
    kx.start()
    await kx.send({ to: 'test', body: 'hello' })
    await wait(200)

    // Hooks should fire in order (1 before 2)
    expect(hookLog).toEqual([
      'first:message:received',
      'second:message:received',
      'first:activation:before',
      'second:activation:before',
      'first:activation:after',
      'second:activation:after',
    ])

    await kx.stop()
  })

  test('daemon can inject tools via activation:before', async () => {
    let capturedTools: any[] = []

    const daemon: DaemonDefinition = {
      id: 'tool-injector',
      capabilities: {
        writes: ['activation:before'],
      },
      onStart: (kx) => {
        kx.bus.on('activation:before', (ctx) => {
          ctx.addTools([
            createTool({
              id: 'custom_tool',
              description: 'A daemon-injected tool',
              execute: async () => 'custom result',
            }),
          ])
        })
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    await kx.daemons.register(daemon)

    await kx.agents.spawn('test', makeAgent('Test'))
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
      capabilities: {
        writes: ['activation:before'],
      },
      onStart: (kx) => {
        kx.bus.on('activation:before', (ctx) => {
          ctx.addPromptSegment('You have access to the Thesauros knowledge graph.')
        })
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedSystemPrompt = params.messages.find((m: any) => m.role === 'system').content
          return { content: 'ok' }
        },
      },
    })

    await kx.daemons.register(daemon)

    await kx.agents.spawn('test', makeAgent('Test'))
    kx.start()
    await kx.send({ to: 'test', body: 'test' })
    await wait(200)

    expect(capturedSystemPrompt).toContain('You have access to the Thesauros knowledge graph.')
    await kx.stop()
  })

  // ─── Runtime Daemon Management ────────────────────────────────────────

  test('daemons.register/deregister/list work at runtime', async () => {
    const kx = createKeryx({
      pollingInterval: 100,
      defaultProvider: {
        generate: async () => ({ content: 'ok' }),
      },
    })

    expect(kx.daemons.list()).toEqual([])

    await kx.daemons.register({ id: 'test-daemon', capabilities: {} })
    expect(kx.daemons.list()).toEqual([{ id: 'test-daemon', capabilities: {} }])

    await kx.daemons.register({ id: 'another', capabilities: {} })
    expect(kx.daemons.list()).toEqual([
      { id: 'test-daemon', capabilities: {} },
      { id: 'another', capabilities: {} },
    ])

    await kx.daemons.deregister('test-daemon')
    expect(kx.daemons.list()).toEqual([{ id: 'another', capabilities: {} }])
  })

  test('register() always calls onStart', async () => {
    const hookLog: string[] = []
    const kx = createKeryx({
      pollingInterval: 100,
      defaultProvider: { generate: async () => ({ content: 'ok' }) },
    })

    await kx.daemons.register({
      id: 'my-daemon',
      capabilities: {},
      onStart: () => { hookLog.push('started') },
      onStop: () => { hookLog.push('stopped') },
    })

    // onStart should have been called immediately on register
    expect(hookLog).toEqual(['started'])

    await kx.stop()
    // onStop should fire during stop()
    expect(hookLog).toEqual(['started', 'stopped'])
  })

  test('deregister() always calls onStop', async () => {
    const hookLog: string[] = []
    const kx = createKeryx({
      pollingInterval: 100,
      defaultProvider: { generate: async () => ({ content: 'ok' }) },
    })

    await kx.daemons.register({
      id: 'will-remove',
      capabilities: {},
      onStart: () => { hookLog.push('started') },
      onStop: () => { hookLog.push('stopped') },
    })

    expect(hookLog).toEqual(['started'])

    await kx.daemons.deregister('will-remove')
    expect(hookLog).toEqual(['started', 'stopped'])

    await kx.stop()
    // onStop should NOT fire again — daemon was already removed
    expect(hookLog).toEqual(['started', 'stopped'])
  })

  test('re-register (same ID) calls onStop on old, onStart on new', async () => {
    const hookLog: string[] = []
    const kx = createKeryx({
      pollingInterval: 100,
      defaultProvider: { generate: async () => ({ content: 'ok' }) },
    })

    await kx.daemons.register({
      id: 'hot-reload',
      capabilities: {},
      onStart: () => { hookLog.push('v1:started') },
      onStop: () => { hookLog.push('v1:stopped') },
    })

    expect(hookLog).toEqual(['v1:started'])

    // Re-register with same ID → hot-reload
    await kx.daemons.register({
      id: 'hot-reload',
      capabilities: {},
      onStart: () => { hookLog.push('v2:started') },
      onStop: () => { hookLog.push('v2:stopped') },
    })

    // Old onStop, then new onStart
    expect(hookLog).toEqual(['v1:started', 'v1:stopped', 'v2:started'])

    await kx.stop()
    expect(hookLog).toEqual(['v1:started', 'v1:stopped', 'v2:started', 'v2:stopped'])
  })



  // ─── Failure Notification ─────────────────────────────────────────────

  test('failure notification sent back to sender agent', async () => {
    const receivedByA: string[] = []

    const kx = createKeryx({
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

    await kx.agents.spawn('agent-a', makeAgent('Agent A'))
    await kx.agents.spawn('agent-b', makeAgent('Agent B'))
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

    await kx.agents.spawn('serial', makeAgent('Serial Agent'))
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

  test('activation:after receives response and steps', async () => {
    let capturedResponse = ''
    let capturedSteps = 0

    const daemon: DaemonDefinition = {
      id: 'spy',
      capabilities: {
        reads: ['activation:after'],
      },
      onStart: (kx) => {
        kx.bus.on('activation:after', (ctx) => {
          capturedResponse = ctx.response ?? ''
          capturedSteps = ctx.steps
        })
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'The response text', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }),
      },
    })

    await kx.daemons.register(daemon)

    await kx.agents.spawn('test', makeAgent('Test'))
    kx.start()
    await kx.send({ to: 'test', body: 'test' })
    await wait(200)

    expect(capturedResponse).toBe('The response text')
    expect(capturedSteps).toBe(1)

    await kx.stop()
  })

  test('activation:after receives error on failure', async () => {
    let capturedError: Error | null = null

    const daemon: DaemonDefinition = {
      id: 'spy',
      capabilities: {
        reads: ['activation:after'],
      },
      onStart: (kx) => {
        kx.bus.on('activation:after', (ctx) => {
          capturedError = ctx.error
        })
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => { throw new Error('Boom!') },
      },
    })

    await kx.daemons.register(daemon)

    await kx.agents.spawn('fail', makeAgent('Fail Agent'))
    kx.start()
    await kx.send({ to: 'fail', body: 'crash' })
    await wait(200)

    expect(capturedError).not.toBeNull()
    expect(capturedError!.message).toBe('Boom!')

    await kx.stop()
  })

  // ─── Agent Spawn/Destroy Lifecycle ────────────────────────────────────

  test('spawn returns AgentInstance with correct fields', async () => {
    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: { generate: async () => ({ content: 'ok' }) },
    })

    const def = makeAgent('My Agent')
    const instance = await kx.agents.spawn('my-agent', def)

    expect(instance.id).toBe('my-agent')
    expect(instance.name).toBe('My Agent')
    expect(instance.instruction).toBe('You are My Agent.')
    expect(instance.spawnTools).toEqual([])
    expect(instance.spawnPromptSegments).toEqual([])
  })

  test('spawn rejects duplicate ID', async () => {
    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: { generate: async () => ({ content: 'ok' }) },
    })

    await kx.agents.spawn('dup', makeAgent('First'))
    await expect(kx.agents.spawn('dup', makeAgent('Second'))).rejects.toThrow('already registered')
  })

  test('destroy removes agent from registry', async () => {
    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: { generate: async () => ({ content: 'ok' }) },
    })

    await kx.agents.spawn('doomed', makeAgent('Doomed'))
    kx.start()

    // Agent exists
    expect(kx.agents.getStatus('doomed')).toBeDefined()

    await kx.agents.destroy('doomed')
    await wait(200)

    // Agent no longer exists
    expect(kx.agents.getStatus('doomed')).toBeUndefined()
    await expect(kx.send({ to: 'doomed', body: 'hello' })).rejects.toThrow('Unknown agent')

    await kx.stop()
  })

  test('destroy flushes inbox', async () => {
    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => {
          await wait(200) // slow agent
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('busy', makeAgent('Busy Agent'))
    kx.start()

    // Send a message to make the agent busy, then queue more
    await kx.send({ to: 'busy', body: 'first' })
    await wait(20) // let it start processing
    await kx.send({ to: 'busy', body: 'second' })
    await kx.send({ to: 'busy', body: 'third' })

    // Destroy with force to interrupt active processing
    await kx.agents.destroy('busy', { force: true })
    await wait(200)

    // Check inbox is empty (agent is gone)
    expect(kx.agents.getInbox('busy')).toEqual([])

    await kx.stop()
  })

  test('agent:spawn hook fires and can inject tools', async () => {
    let spawnedId = ''
    let capturedTools: any[] = []

    const daemon: DaemonDefinition = {
      id: 'spawn-watcher',
      capabilities: {
        writes: ['agent:spawn'],
      },
      onStart: (kx) => {
        kx.bus.on('agent:spawn', (ctx) => {
          spawnedId = ctx.agentId
          ctx.addTools([
            createTool({
              id: 'spawn_tool',
              description: 'Injected at spawn time',
              execute: async () => 'spawn result',
            }),
          ])
        }, 1)
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    await kx.daemons.register(daemon)

    const instance = await kx.agents.spawn('spawned', makeAgent('Spawned'))
    expect(spawnedId).toBe('spawned')
    expect(instance.spawnTools.length).toBe(1)

    // Verify spawn-time tools appear in activation
    kx.start()
    await kx.send({ to: 'spawned', body: 'test' })
    await wait(200)

    const spawnTool = capturedTools.find((t: any) => t.name === 'spawn_tool')
    expect(spawnTool).toBeDefined()

    await kx.stop()
  })

  test('agent:destroy hook fires on destroy', async () => {
    let destroyedId = ''

    const daemon: DaemonDefinition = {
      id: 'destroy-watcher',
      capabilities: {
        reads: ['agent:destroy'],
      },
      onStart: (kx) => {
        kx.bus.on('agent:destroy', (ctx) => {
          destroyedId = ctx.agentId
        }, 1)
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: { generate: async () => ({ content: 'ok' }) },
    })

    await kx.daemons.register(daemon)

    await kx.agents.spawn('target', makeAgent('Target'))
    kx.start()

    await kx.agents.destroy('target')
    await wait(200)

    expect(destroyedId).toBe('target')

    await kx.stop()
  })

  test('spawn-time prompt segments persist across activations', async () => {
    const capturedPrompts: string[] = []

    const daemon: DaemonDefinition = {
      id: 'prompt-spawner',
      capabilities: {
        writes: ['agent:spawn'],
      },
      onStart: (kx) => {
        kx.bus.on('agent:spawn', (ctx) => {
          ctx.addPromptSegment('You have vault access.')
        }, 1)
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          capturedPrompts.push(systemMsg.content)
          return { content: 'ok' }
        },
      },
    })

    await kx.daemons.register(daemon)

    await kx.agents.spawn('vaulted', makeAgent('Vaulted'))
    kx.start()

    // First activation
    await kx.send({ to: 'vaulted', body: 'msg1' })
    await wait(200)
    // Second activation
    await kx.send({ to: 'vaulted', body: 'msg2' })
    await wait(200)

    // Both activations should have the spawn-time prompt segment
    expect(capturedPrompts.length).toBe(2)
    expect(capturedPrompts[0]).toContain('You have vault access.')
    expect(capturedPrompts[1]).toContain('You have vault access.')

    await kx.stop()
  })

  test('agents have spawn and destroy tools', async () => {
    let capturedTools: any[] = []

    const kx = createKeryx({
      pollingInterval: 10,
      definitions: { helper: makeAgent('Helper') },
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('orchestrator', makeAgent('Orchestrator'))
    kx.start()
    await kx.send({ to: 'orchestrator', body: 'test' })
    await wait(200)

    const spawnTool = capturedTools.find((t: any) => t.name === 'agent_spawn')
    const destroyTool = capturedTools.find((t: any) => t.name === 'agent_destroy')
    expect(spawnTool).toBeDefined()
    expect(destroyTool).toBeDefined()
    // spawn tool should list available definitions
    expect(spawnTool.description).toContain('helper')

    await kx.stop()
  })

  // ─── Attachment Metadata Assembly ──────────────────────────────────────

  test('image attachment assembles multipart content when provider supports it', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        supportedMedia: ['image/*'],
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('vision', makeAgent('Vision'))
    kx.start()
    await kx.send({
      to: 'vision',
      body: 'What is in this photo?',
      metadata: {
        attachments: [
          { url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' },
        ],
      },
    })
    await wait(200)

    expect(Array.isArray(capturedContent)).toBe(true)
    expect(capturedContent).toEqual([
      { type: 'text', text: 'What is in this photo?' },
      { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
    ])

    await kx.stop()
  })

  test('video attachment assembles multipart content when provider supports it', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        supportedMedia: ['video/*'],
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('vision', makeAgent('Vision'))
    kx.start()
    await kx.send({
      to: 'vision',
      body: 'Describe this clip',
      metadata: {
        attachments: [
          { url: 'https://example.com/clip.mp4', mimeType: 'video/mp4' },
        ],
      },
    })
    await wait(200)

    expect(Array.isArray(capturedContent)).toBe(true)
    expect(capturedContent).toEqual([
      { type: 'text', text: 'Describe this clip' },
      { type: 'video_url', video_url: { url: 'https://example.com/clip.mp4' } },
    ])

    await kx.stop()
  })

  test('mixed supported attachments assemble all native types', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        supportedMedia: ['image/*', 'video/*'],
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('multi', makeAgent('Multi'))
    kx.start()
    await kx.send({
      to: 'multi',
      body: 'Analyze these',
      metadata: {
        attachments: [
          { url: 'https://example.com/img.png', mimeType: 'image/png' },
          { url: 'https://example.com/vid.webm', mimeType: 'video/webm' },
        ],
      },
    })
    await wait(200)

    expect(Array.isArray(capturedContent)).toBe(true)
    expect(capturedContent).toHaveLength(3)
    expect(capturedContent[0]).toEqual({ type: 'text', text: 'Analyze these' })
    expect(capturedContent[1]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/img.png' } })
    expect(capturedContent[2]).toEqual({ type: 'video_url', video_url: { url: 'https://example.com/vid.webm' } })

    await kx.stop()
  })

  test('no attachments keeps plain string content', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('plain', makeAgent('Plain'))
    kx.start()
    await kx.send({ to: 'plain', body: 'Just text, no attachments' })
    await wait(200)

    expect(typeof capturedContent).toBe('string')
    expect(capturedContent).toBe('Just text, no attachments')

    await kx.stop()
  })

  test('unsupported mimeType injects notice into context', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        // No supportedMedia — text-only provider
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('doc', makeAgent('Doc'))
    kx.start()
    await kx.send({
      to: 'doc',
      body: 'Read this PDF',
      metadata: {
        attachments: [
          { url: 'https://example.com/report.pdf', mimeType: 'application/pdf', filename: 'report.pdf' },
        ],
      },
    })
    await wait(200)

    // Unsupported attachment → notice injected as text
    expect(typeof capturedContent).toBe('string')
    expect(capturedContent).toContain('Read this PDF')
    expect(capturedContent).toContain('[Unsupported attachment: report.pdf (application/pdf)]')

    await kx.stop()
  })

  test('empty body with supported attachment omits text part', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        supportedMedia: ['image/*'],
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('silent', makeAgent('Silent'))
    kx.start()
    await kx.send({
      to: 'silent',
      body: '',
      metadata: {
        attachments: [
          { url: 'data:image/png;base64,iVBOR...', mimeType: 'image/png' },
        ],
      },
    })
    await wait(200)

    expect(Array.isArray(capturedContent)).toBe(true)
    expect(capturedContent).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR...' } },
    ])

    await kx.stop()
  })

  test('PDF passes through as file ContentPart when provider supports it', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        supportedMedia: ['image/*', 'application/pdf'],
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('gemini', makeAgent('Gemini'))
    kx.start()
    await kx.send({
      to: 'gemini',
      body: 'Summarize this report',
      metadata: {
        attachments: [
          { url: 'https://example.com/report.pdf', mimeType: 'application/pdf', filename: 'report.pdf' },
        ],
      },
    })
    await wait(200)

    expect(Array.isArray(capturedContent)).toBe(true)
    expect(capturedContent).toEqual([
      { type: 'text', text: 'Summarize this report' },
      { type: 'file', file: { url: 'https://example.com/report.pdf', mime_type: 'application/pdf', name: 'report.pdf' } },
    ])

    await kx.stop()
  })

  test('image without supportedMedia is unsupported (text-only provider)', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        // No supportedMedia — text-only
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('text-only', makeAgent('TextOnly'))
    kx.start()
    await kx.send({
      to: 'text-only',
      body: 'Look at this',
      metadata: {
        attachments: [
          { url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg', filename: 'photo.jpg' },
        ],
      },
    })
    await wait(200)

    // No supportedMedia → image is unsupported, notice injected
    expect(typeof capturedContent).toBe('string')
    expect(capturedContent).toContain('Look at this')
    expect(capturedContent).toContain('[Unsupported attachment: photo.jpg (image/jpeg)]')

    await kx.stop()
  })

  test('mixed supported + unsupported attachments', async () => {
    let capturedContent: any = null

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        supportedMedia: ['image/*'],
        generate: async (params: any) => {
          const userMsg = params.messages.find((m: any) => m.role === 'user')
          capturedContent = userMsg.content
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('partial', makeAgent('Partial'))
    kx.start()
    await kx.send({
      to: 'partial',
      body: 'Process these files',
      metadata: {
        attachments: [
          { url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' },
          { url: 'https://example.com/data.csv', mimeType: 'text/csv', filename: 'data.csv' },
        ],
      },
    })
    await wait(200)

    // Image is supported → ContentPart, CSV is unsupported → notice in text
    expect(Array.isArray(capturedContent)).toBe(true)
    expect(capturedContent).toHaveLength(2)
    expect(capturedContent[0].type).toBe('text')
    expect(capturedContent[0].text).toContain('Process these files')
    expect(capturedContent[0].text).toContain('[Unsupported attachment: data.csv (text/csv)]')
    expect(capturedContent[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/photo.jpg' },
    })

    await kx.stop()
  })

  test('daemon can pre-process and remove attachments before assembly', async () => {
    let capturedContent: any = null

    const pdfDaemon: DaemonDefinition = {
      id: 'pdf-processor',
      capabilities: {
        writes: ['activation:before'],
      },
      onStart: (kx) => {
        kx.bus.on('activation:before', (ctx) => {
          const atts = (ctx.message.metadata?.attachments ?? []) as any[]
          const remaining: any[] = []
          for (const att of atts) {
            if (att.mimeType === 'application/pdf') {
              // Daemon handles PDF: extract text and push into context
              ctx.ctx.push({ role: 'user', content: `[Extracted from ${att.filename}]: Lorem ipsum dolor sit amet...` })
            } else {
              remaining.push(att)
            }
          }
          // Remove handled attachments so process-manager doesn't double-push
          if (ctx.message.metadata) {
            ctx.message.metadata.attachments = remaining
          }
        }, 10)
      },
    }

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        // No PDF support — daemon handles it
        supportedMedia: ['image/*'],
        generate: async (params: any) => {
          capturedContent = params.messages
            .filter((m: any) => m.role === 'user')
            .map((m: any) => m.content)
          return { content: 'ok' }
        },
      },
    })

    await kx.daemons.register(pdfDaemon)

    await kx.agents.spawn('agent', makeAgent('Agent'))
    kx.start()
    await kx.send({
      to: 'agent',
      body: 'Review this document',
      metadata: {
        attachments: [
          { url: 'https://example.com/report.pdf', mimeType: 'application/pdf', filename: 'report.pdf' },
        ],
      },
    })
    await wait(200)

    // Daemon should have pushed extracted text, process-manager pushes body (no unsupported notice)
    expect(capturedContent).toHaveLength(2)
    // First: daemon-pushed extracted text
    expect(capturedContent[0]).toContain('[Extracted from report.pdf]')
    // Second: the message body (PDF was removed, no unsupported notice)
    expect(capturedContent[1]).toBe('Review this document')

    await kx.stop()
  })

  // ─── Streaming RequestHandle ──────────────────────────────────────────

  test('RequestHandle.stream yields StreamEvent objects incrementally', async () => {
    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          // Simulate streaming: call stream.onContent with individual chunks
          const chunks = ['Hello', ' ', 'world', '!']
          for (const chunk of chunks) {
            params.stream?.onContent?.(chunk)
            await new Promise(r => setTimeout(r, 10))
          }
          return { content: 'Hello world!' }
        },
      },
    })

    await kx.agents.spawn('streamer', makeAgent('Streamer'))
    kx.start()

    const handle = kx.request({ to: 'streamer', body: 'Say hello' })

    // Collect events from the stream
    const receivedEvents: StreamEvent[] = []
    for await (const event of handle.stream) {
      receivedEvents.push(event)
    }

    // Verify events arrived as StreamEvent objects with type 'text'
    expect(receivedEvents.length).toBe(4)
    for (const event of receivedEvents) {
      expect(event.type).toBe('text')
      expect(event.agentId).toBe('streamer')
    }
    expect(receivedEvents.map(e => (e as { content: string }).content)).toEqual(['Hello', ' ', 'world', '!'])

    // Verify result matches
    const fullResult = await handle.result
    expect(fullResult.response).toBe('Hello world!')
    expect(fullResult.events).toEqual(receivedEvents)

    await kx.stop()
  })

  test('RequestHandle.abort() kills agent loop and rejects result', async () => {
    let agentAborted = false

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const signal = params.signal as AbortSignal | undefined
          // Simulate slow streaming
          for (let i = 0; i < 20; i++) {
            if (signal?.aborted) {
              agentAborted = true
              throw new Error('Agent was aborted')
            }
            params.stream?.onContent?.(`chunk${i} `)
            await new Promise(r => setTimeout(r, 20))
          }
          return { content: 'should not reach' }
        },
      },
    })

    await kx.agents.spawn('slow', makeAgent('Slow'))
    kx.start()

    const handle = kx.request({ to: 'slow', body: 'generate' })

    // Wait for some chunks to arrive, then abort
    await wait(80)
    handle.abort()

    // Result should reject
    await expect(handle.result).rejects.toThrow('Request aborted')
    // Agent's Nous loop should have been killed
    await wait(100)
    expect(agentAborted).toBe(true)

    await kx.stop()
  })

  test('RequestHandle.result resolves without consuming stream', async () => {
    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          params.stream?.onContent?.('chunk1')
          params.stream?.onContent?.('chunk2')
          return { content: 'full response' }
        },
      },
    })

    await kx.agents.spawn('lazy', makeAgent('Lazy'))
    kx.start()

    const handle = kx.request({ to: 'lazy', body: 'test' })

    // Only await result — never consume .stream
    const result = await handle.result
    expect(result.response).toBe('full response')
    expect(result.events.length).toBe(2)
    expect(result.events[0]!.type).toBe('text')

    await kx.stop()
  })

  test('RequestMessage.signal wires to abort (kills agent loop)', async () => {
    let agentAborted = false

    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const signal = params.signal as AbortSignal | undefined
          for (let i = 0; i < 20; i++) {
            if (signal?.aborted) {
              agentAborted = true
              throw new Error('Agent was aborted')
            }
            await new Promise(r => setTimeout(r, 20))
          }
          return { content: 'should not reach' }
        },
      },
    })

    await kx.agents.spawn('signal-test', makeAgent('SignalTest'))
    kx.start()

    const controller = new AbortController()
    const handle = kx.request({
      to: 'signal-test',
      body: 'test',
      signal: controller.signal,
    })

    await wait(80)
    controller.abort()

    await expect(handle.result).rejects.toThrow('Request aborted')
    await wait(100)
    expect(agentAborted).toBe(true)

    await kx.stop()
  })

  test('await kx.request() returns RequestResult (breaking change)', async () => {
    const kx = createKeryx({
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({ content: 'hello', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } }),
      },
    })

    await kx.agents.spawn('compat', makeAgent('Compat'))
    kx.start()

    // Using await directly on the handle returns RequestResult
    const result = await kx.request({ to: 'compat', body: 'test' })
    expect(typeof result).toBe('object')
    expect(result.response).toBe('hello')
    expect(result.events).toBeDefined()
    expect(result.usage.totalTokens).toBe(8)

    await kx.stop()
  })
})
