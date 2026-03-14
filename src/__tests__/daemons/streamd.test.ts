/**
 * streamd — Tests
 *
 * Tests for the built-in stream daemon (internal event bus).
 */

import { describe, test, expect } from 'bun:test'
import { createKeryx } from '../../keryx.js'
import { streamd } from '../../daemons/streamd.js'
import type { StreamEvent } from '../../daemons/streamd.js'
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

describe('streamd', () => {
  test('subscriber receives stream events from provider', async () => {
    const events: StreamEvent[] = []
    const stream = streamd()

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async (params) => {
          // Simulate streaming by calling the stream callbacks
          const streamCbs = params.stream
          if (streamCbs) {
            streamCbs.onContent?.('Hello')
            streamCbs.onContent?.(' world')
          }
          return { content: 'Hello world' }
        },
      },
    })

    await kx.daemons.register(stream.daemon)

    await kx.agents.spawn('writer', makeAgent('Writer Agent'))

    stream.subscribe((event) => {
      events.push(event)
    })

    kx.start()
    await kx.send({ to: 'writer', body: 'Write something' })
    await wait(200)

    // Should have output events (start, chunks, end)
    const outputEvents = events.filter(e => e.type === 'output')
    expect(outputEvents.length).toBeGreaterThanOrEqual(1)

    // All events should have correct agentId and timestamps
    for (const event of events) {
      expect(event.agentId).toBe('writer')
      expect(event.timestamp).toBeInstanceOf(Date)
    }

    await kx.stop()
  })

  test('multiple subscribers receive the same events', async () => {
    const events1: StreamEvent[] = []
    const events2: StreamEvent[] = []
    const stream = streamd()

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async (params) => {
          params.stream?.onContent?.('hi')
          return { content: 'hi' }
        },
      },
    })

    await kx.daemons.register(stream.daemon)

    await kx.agents.spawn('echo', makeAgent('Echo Agent'))

    stream.subscribe((e) => events1.push(e))
    stream.subscribe((e) => events2.push(e))

    kx.start()
    await kx.send({ to: 'echo', body: 'test' })
    await wait(200)

    // Both subscribers should receive the same number of events
    expect(events1.length).toBeGreaterThanOrEqual(1)
    expect(events1.length).toBe(events2.length)

    // Events should have matching content
    for (let i = 0; i < events1.length; i++) {
      expect(events1[i]!.agentId).toBe(events2[i]!.agentId)
      expect(events1[i]!.type).toBe(events2[i]!.type)
      expect(events1[i]!.phase).toBe(events2[i]!.phase)
      expect(events1[i]!.chunk).toBe(events2[i]!.chunk)
    }

    await kx.stop()
  })

  test('unsubscribe stops event delivery', async () => {
    const events: StreamEvent[] = []
    const stream = streamd()

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async (params) => {
          params.stream?.onContent?.('chunk')
          return { content: 'chunk' }
        },
      },
    })

    await kx.daemons.register(stream.daemon)

    await kx.agents.spawn('echo', makeAgent('Echo Agent'))

    const unsub = stream.subscribe((e) => events.push(e))

    kx.start()
    await kx.send({ to: 'echo', body: 'first' })
    await wait(200)

    const countAfterFirst = events.length
    expect(countAfterFirst).toBeGreaterThanOrEqual(1)

    // Unsubscribe
    unsub()

    // Send another message — should not produce more events
    await kx.send({ to: 'echo', body: 'second' })
    await wait(200)

    expect(events.length).toBe(countAfterFirst)

    await kx.stop()
  })

  test('events are tagged with correct agentId in multi-agent setup', async () => {
    const events: StreamEvent[] = []
    const stream = streamd()

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async (params) => {
          params.stream?.onContent?.('response')
          return { content: 'response' }
        },
      },
    })

    await kx.daemons.register(stream.daemon)

    await kx.agents.spawn('agent-a', makeAgent('Agent A'))
    await kx.agents.spawn('agent-b', makeAgent('Agent B'))

    stream.subscribe((e) => events.push(e))

    kx.start()
    await kx.send({ to: 'agent-a', body: 'hello A' })
    await kx.send({ to: 'agent-b', body: 'hello B' })
    await wait(300)

    const agentAEvents = events.filter(e => e.agentId === 'agent-a')
    const agentBEvents = events.filter(e => e.agentId === 'agent-b')

    expect(agentAEvents.length).toBeGreaterThanOrEqual(1)
    expect(agentBEvents.length).toBeGreaterThanOrEqual(1)

    await kx.stop()
  })

  test('subscriber receives tool call stream events', async () => {
    const events: StreamEvent[] = []
    const stream = streamd()
    let callCount = 0

    const kx = createKeryx({      pollingInterval: 10,
      defaultProvider: {
        generate: async (params) => {
          callCount++
          if (callCount === 1) {
            // Simulate tool call streaming
            params.stream?.onToolCallStart?.(0, 'call-1', 'read_file')
            params.stream?.onToolCallDelta?.(0, '{"path":')
            params.stream?.onToolCallDelta?.(0, '"/src/main.ts"}')
            return {
              toolCalls: [{
                id: 'call-1',
                name: 'read_file',
                arguments: { path: '/src/main.ts' },
              }],
            }
          }
          return { content: 'Done reading.' }
        },
      },
    })

    await kx.daemons.register(stream.daemon)

    await kx.agents.spawn('coder', makeAgent('Coder Agent'))

    stream.subscribe((e) => events.push(e))

    kx.start()
    await kx.send({ to: 'coder', body: 'Read the file' })
    await wait(300)

    // Should have tool_call start event with metadata
    const startEvents = events.filter(e => e.type === 'tool_call' && e.phase === 'start')
    expect(startEvents.length).toBe(1)
    expect(startEvents[0]!.toolIndex).toBe(0)
    expect(startEvents[0]!.toolCallId).toBe('call-1')
    expect(startEvents[0]!.toolName).toBe('read_file')

    // Should have tool_call chunk events with arg fragments
    const chunkEvents = events.filter(e => e.type === 'tool_call' && e.phase === 'chunk')
    expect(chunkEvents.length).toBe(2)
    expect(chunkEvents[0]!.chunk).toBe('{"path":')
    expect(chunkEvents[1]!.chunk).toBe('"/src/main.ts"}')
    expect(chunkEvents[0]!.toolIndex).toBe(0)

    await kx.stop()
  })
})
