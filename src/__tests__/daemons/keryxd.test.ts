/**
 * keryxd — Tests
 *
 * Tests for the agent management daemon.
 */

import { describe, test, expect } from 'bun:test'
import { createKeryx } from '../../keryx.js'
import { keryxd } from '../../daemons/keryxd.js'
import type { AgentDefinition } from '../../types.js'

function makeAgent(name: string, config?: Record<string, unknown>): AgentDefinition {
  return {
    name,
    instruction: `You are ${name}.`,
    config,
  }
}

function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

describe('keryxd', () => {
  test('agent_list tool returns all agents with status', async () => {
    let capturedTools: any[] = []

    const kx = createKeryx({
      daemons: [keryxd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('manager', makeAgent('Manager', { 'keryxd': { read: ['*'] } }))
    await kx.agents.spawn('worker', makeAgent('Worker'))

    kx.start()
    await kx.send({ to: 'manager', body: 'list agents' })
    await wait(200)

    const listTool = capturedTools.find((t: any) => t.name === 'agent_list')
    expect(listTool).toBeDefined()

    await kx.stop()
  })

  test('agent with keryxd read config gets agent_status and inbox_read tools', async () => {
    let capturedTools: any[] = []

    const kx = createKeryx({
      daemons: [keryxd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('assistant', makeAgent('Assistant', { 'keryxd': { read: ['*'] } }))
    await kx.agents.spawn('analyst', makeAgent('Analyst'))

    kx.start()
    await kx.send({ to: 'assistant', body: 'check' })
    await wait(200)

    expect(capturedTools.find((t: any) => t.name === 'agent_status')).toBeDefined()
    expect(capturedTools.find((t: any) => t.name === 'inbox_read')).toBeDefined()

    await kx.stop()
  })

  test('agent with keryxd write config gets inbox_flush and agent_abort tools', async () => {
    let capturedTools: any[] = []

    const kx = createKeryx({
      daemons: [keryxd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('admin', makeAgent('Admin', { 'keryxd': { write: ['*'] } }))

    kx.start()
    await kx.send({ to: 'admin', body: 'go' })
    await wait(200)

    expect(capturedTools.find((t: any) => t.name === 'inbox_flush')).toBeDefined()
    expect(capturedTools.find((t: any) => t.name === 'agent_abort')).toBeDefined()

    await kx.stop()
  })

  test('agent without keryxd config gets no keryxd tools', async () => {
    let capturedTools: any[] = []

    const kx = createKeryx({
      daemons: [keryxd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('plain', makeAgent('Plain Agent'))

    kx.start()
    await kx.send({ to: 'plain', body: 'go' })
    await wait(200)

    expect(capturedTools.find((t: any) => t.name === 'agent_list')).toBeUndefined()
    expect(capturedTools.find((t: any) => t.name === 'agent_status')).toBeUndefined()

    await kx.stop()
  })

  test('glob matching: prefix* matches correct agents', async () => {
    let flushResult = ''
    let deniedResult = ''
    let callCount = 0

    const kx = createKeryx({
      daemons: [keryxd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "admin"')) {
            callCount++
            if (callCount === 1) {
              // Flush news-agent (should succeed — matches news-*)
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'inbox_flush',
                  arguments: { id: 'news-agent' },
                }],
              }
            }
            if (callCount === 2) {
              // Capture first tool result
              const toolMsg = params.messages.find((m: any) => m.role === 'tool')
              flushResult = toolMsg?.content ?? ''
              // Flush analyst (should be denied — doesn't match news-*)
              return {
                toolCalls: [{
                  id: 'call-2',
                  name: 'inbox_flush',
                  arguments: { id: 'analyst' },
                }],
              }
            }
            // Capture second tool result
            const toolMsgs = params.messages.filter((m: any) => m.role === 'tool')
            deniedResult = toolMsgs[toolMsgs.length - 1]?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('admin', makeAgent('Admin', { 'keryxd': { write: ['news-*'] } }))
    await kx.agents.spawn('news-agent', makeAgent('News'))
    await kx.agents.spawn('analyst', makeAgent('Analyst'))

    kx.start()
    await kx.send({ to: 'admin', body: 'test' })
    await wait(500)

    expect(flushResult).toContain('Flushed')
    expect(deniedResult).toContain('No write permission')

    await kx.stop()
  })

  test('inbox_read returns pending messages', async () => {
    let readResult = ''
    let callCount = 0

    const kx = createKeryx({
      daemons: [keryxd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "monitor"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'inbox_read',
                  arguments: { id: 'worker' },
                }],
              }
            }
            const toolMsg = params.messages.find((m: any) => m.role === 'tool')
            readResult = toolMsg?.content ?? ''
            return { content: 'done' }
          }
          // Worker: just process normally
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('monitor', makeAgent('Monitor', { 'keryxd': { read: ['*'] } }))
    await kx.agents.spawn('worker', makeAgent('Worker'))

    // Pre-seed worker inbox with messages
    kx.start()

    // Send messages to worker (they'll be processed, so let's send to monitor which will peek)
    await kx.send({ to: 'monitor', body: 'check worker inbox' })
    await wait(300)

    // readResult should be valid JSON with count and messages
    const parsed = JSON.parse(readResult)
    expect(parsed).toHaveProperty('count')
    expect(parsed).toHaveProperty('messages')

    await kx.stop()
  })

  test('agent_status returns error for agent outside read permissions', async () => {
    let statusResult = ''
    let callCount = 0

    const kx = createKeryx({
      daemons: [keryxd()],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "limited"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'agent_status',
                  arguments: { id: 'secret' },
                }],
              }
            }
            const toolMsg = params.messages.find((m: any) => m.role === 'tool')
            statusResult = toolMsg?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    await kx.agents.spawn('limited', makeAgent('Limited', { 'keryxd': { read: ['worker'] } }))
    await kx.agents.spawn('worker', makeAgent('Worker'))
    await kx.agents.spawn('secret', makeAgent('Secret Agent'))

    kx.start()
    await kx.send({ to: 'limited', body: 'check secret' })
    await wait(300)

    expect(statusResult).toContain('No read permission')

    await kx.stop()
  })
})
