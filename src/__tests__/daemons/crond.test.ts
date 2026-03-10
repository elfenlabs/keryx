/**
 * crond — Tests
 *
 * Tests for the built-in cron daemon (scheduled messages).
 */

import { describe, test, expect } from 'bun:test'
import { createKeryx } from '../../keryx.js'
import { crond } from '../../daemons/crond.js'
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

describe('crond', () => {
  test('timer fires and delivers message to agent', async () => {
    const receivedBodies: string[] = []

    const kx = createKeryx({
      agents: [makeAgent('reporter', 'Reporter')],
      daemons: [
        crond({
          jobs: [{
            id: 'test-job',
            to: 'reporter',
            body: 'Generate report',
            intervalMs: 100,
          }],
        }),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const userMsgs = params.messages.filter((m: any) => m.role === 'user')
          const lastMsg = userMsgs[userMsgs.length - 1]?.content ?? ''
          receivedBodies.push(lastMsg)
          return { content: 'Report generated.' }
        },
      },
    })

    kx.start()
    // Wait for at least 2 timer fires
    await wait(350)

    expect(receivedBodies.length).toBeGreaterThanOrEqual(2)
    expect(receivedBodies[0]).toBe('Generate report')

    await kx.stop()
  })

  test('multiple jobs fire independently', async () => {
    const received: Map<string, number> = new Map()

    const kx = createKeryx({
      agents: [
        makeAgent('daily', 'Daily Agent'),
        makeAgent('hourly', 'Hourly Agent'),
      ],
      daemons: [
        crond({
          jobs: [
            { id: 'daily-job', to: 'daily', body: 'Daily task', intervalMs: 200 },
            { id: 'hourly-job', to: 'hourly', body: 'Hourly task', intervalMs: 100 },
          ],
        }),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "daily"')) {
            received.set('daily', (received.get('daily') ?? 0) + 1)
          } else if (systemMsg.content.includes('agent "hourly"')) {
            received.set('hourly', (received.get('hourly') ?? 0) + 1)
          }
          return { content: 'done' }
        },
      },
    })

    kx.start()
    await wait(450)

    // Hourly should fire more often than daily
    const dailyCount = received.get('daily') ?? 0
    const hourlyCount = received.get('hourly') ?? 0
    expect(hourlyCount).toBeGreaterThan(dailyCount)
    expect(dailyCount).toBeGreaterThanOrEqual(1)

    await kx.stop()
  })

  test('stop cleans up timers', async () => {
    let callCount = 0

    const kx = createKeryx({
      agents: [makeAgent('ticker', 'Ticker')],
      daemons: [
        crond({
          jobs: [{
            id: 'tick',
            to: 'ticker',
            body: 'tick',
            intervalMs: 50,
          }],
        }),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => {
          callCount++
          return { content: 'ticked' }
        },
      },
    })

    kx.start()
    await wait(200)

    await kx.stop()
    const countAfterStop = callCount

    // Wait more — no new calls should happen
    await wait(200)
    expect(callCount).toBe(countAfterStop)
  })

  test('cron messages include metadata with job ID', async () => {
    let capturedMetadata: Record<string, unknown> | undefined

    const kx = createKeryx({
      agents: [makeAgent('meta-test', 'Meta Test')],
      daemons: [
        crond({
          jobs: [{
            id: 'daily-report',
            to: 'meta-test',
            body: 'report',
            intervalMs: 50,
            metadata: { source: 'scheduler' },
          }],
        }),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          // Metadata is passed in the system prompt message context
          if (systemMsg.content.includes('cronJobId')) {
            capturedMetadata = JSON.parse(
              systemMsg.content.match(/Metadata: (.+)/)?.[1] ?? '{}'
            )
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await wait(200)

    expect(capturedMetadata).toBeDefined()
    expect(capturedMetadata!.cronJobId).toBe('daily-report')
    expect(capturedMetadata!.type).toBe('cron')
    expect(capturedMetadata!.source).toBe('scheduler')

    await kx.stop()
  })
})
