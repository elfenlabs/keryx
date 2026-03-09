/**
 * Inbox (Priority Queue) — Unit Tests
 */

import { describe, test, expect } from 'bun:test'
import { Inbox } from '../inbox.js'
import type { Message } from '../types.js'

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    to: 'agent-a',
    from: null,
    body: 'test',
    priority: 0,
    force: false,
    replyTo: null,
    createdAt: new Date(),
    ...overrides,
  }
}

describe('Inbox', () => {
  test('dequeue returns undefined for empty inbox', () => {
    const inbox = new Inbox()
    expect(inbox.dequeue('agent-a')).toBeUndefined()
  })

  test('hasPending returns false for empty inbox', () => {
    const inbox = new Inbox()
    expect(inbox.hasPending('agent-a')).toBe(false)
  })

  test('enqueue and dequeue a single message', () => {
    const inbox = new Inbox()
    const msg = makeMsg({ body: 'hello' })
    inbox.enqueue(msg)

    expect(inbox.hasPending('agent-a')).toBe(true)
    const dequeued = inbox.dequeue('agent-a')
    expect(dequeued?.body).toBe('hello')
    expect(inbox.hasPending('agent-a')).toBe(false)
  })

  test('dequeue in FIFO order within same priority', () => {
    const inbox = new Inbox()
    const msg1 = makeMsg({ body: 'first', createdAt: new Date('2026-01-01T00:00:00Z') })
    const msg2 = makeMsg({ body: 'second', createdAt: new Date('2026-01-01T00:00:01Z') })
    const msg3 = makeMsg({ body: 'third', createdAt: new Date('2026-01-01T00:00:02Z') })

    inbox.enqueue(msg1)
    inbox.enqueue(msg2)
    inbox.enqueue(msg3)

    expect(inbox.dequeue('agent-a')?.body).toBe('first')
    expect(inbox.dequeue('agent-a')?.body).toBe('second')
    expect(inbox.dequeue('agent-a')?.body).toBe('third')
  })

  test('dequeue higher priority first', () => {
    const inbox = new Inbox()
    const low = makeMsg({ body: 'low', priority: 0, createdAt: new Date('2026-01-01T00:00:00Z') })
    const high = makeMsg({ body: 'high', priority: 10, createdAt: new Date('2026-01-01T00:00:01Z') })
    const mid = makeMsg({ body: 'mid', priority: 5, createdAt: new Date('2026-01-01T00:00:02Z') })

    inbox.enqueue(low)
    inbox.enqueue(high)
    inbox.enqueue(mid)

    expect(inbox.dequeue('agent-a')?.body).toBe('high')
    expect(inbox.dequeue('agent-a')?.body).toBe('mid')
    expect(inbox.dequeue('agent-a')?.body).toBe('low')
  })

  test('FIFO within same priority regardless of insertion order', () => {
    const inbox = new Inbox()
    const a = makeMsg({ body: 'a', priority: 5, createdAt: new Date('2026-01-01T00:00:00Z') })
    const b = makeMsg({ body: 'b', priority: 5, createdAt: new Date('2026-01-01T00:00:01Z') })

    // Insert b first, then a — but a has earlier timestamp
    inbox.enqueue(b)
    inbox.enqueue(a)

    expect(inbox.dequeue('agent-a')?.body).toBe('a')
    expect(inbox.dequeue('agent-a')?.body).toBe('b')
  })

  test('force message detection', () => {
    const inbox = new Inbox()
    const normal = makeMsg({ body: 'normal' })
    const force = makeMsg({ body: 'STOP', force: true })

    inbox.enqueue(normal)
    expect(inbox.hasForceMessage('agent-a')).toBe(false)

    inbox.enqueue(force)
    expect(inbox.hasForceMessage('agent-a')).toBe(true)
  })

  test('dequeueForce extracts force message specifically', () => {
    const inbox = new Inbox()
    const normal = makeMsg({ body: 'normal', createdAt: new Date('2026-01-01T00:00:00Z') })
    const force = makeMsg({ body: 'STOP', force: true, createdAt: new Date('2026-01-01T00:00:01Z') })

    inbox.enqueue(normal)
    inbox.enqueue(force)

    const dequeued = inbox.dequeueForce('agent-a')
    expect(dequeued?.body).toBe('STOP')
    expect(dequeued?.force).toBe(true)

    // Normal message still in queue
    expect(inbox.hasPending('agent-a')).toBe(true)
    expect(inbox.dequeue('agent-a')?.body).toBe('normal')
  })

  test('agentsWithPending returns correct agent IDs', () => {
    const inbox = new Inbox()
    inbox.enqueue(makeMsg({ to: 'agent-a' }))
    inbox.enqueue(makeMsg({ to: 'agent-b' }))

    const agents = inbox.agentsWithPending()
    expect(agents).toContain('agent-a')
    expect(agents).toContain('agent-b')
    expect(agents.length).toBe(2)
  })

  test('separate queues per agent', () => {
    const inbox = new Inbox()
    inbox.enqueue(makeMsg({ to: 'agent-a', body: 'for-a' }))
    inbox.enqueue(makeMsg({ to: 'agent-b', body: 'for-b' }))

    expect(inbox.dequeue('agent-a')?.body).toBe('for-a')
    expect(inbox.dequeue('agent-b')?.body).toBe('for-b')
    expect(inbox.dequeue('agent-a')).toBeUndefined()
  })
})
