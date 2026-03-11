/**
 * secretd — Tests
 *
 * Tests for the built-in secrets management daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createKeryx } from '../../keryx.js'
import {
  secretd,
  InMemorySecretStorage,
  EncryptedFileSecretStorage,
  substituteSecrets,
} from '../../daemons/secretd.js'
import type { AgentDefinition } from '../../types.js'
import { createTool } from '@elfenlabs/nous'

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── substituteSecrets unit tests ────────────────────────────────────────────

describe('substituteSecrets', () => {
  const resolve = (id: string): string => {
    const secrets: Record<string, string> = {
      API_KEY: 'sk-abc123',
      TOKEN: 'tok-xyz',
    }
    const val = secrets[id]
    if (!val) throw new Error(`Unknown secret "${id}"`)
    return val
  }

  test('substitutes simple string value', () => {
    const args: Record<string, unknown> = { key: '${SECRET:API_KEY}' }
    substituteSecrets(args, resolve)
    expect(args['key']).toBe('sk-abc123')
  })

  test('substitutes within a larger string', () => {
    const args: Record<string, unknown> = { header: 'Bearer ${SECRET:API_KEY}' }
    substituteSecrets(args, resolve)
    expect(args['header']).toBe('Bearer sk-abc123')
  })

  test('substitutes multiple secrets in one string', () => {
    const args: Record<string, unknown> = { combined: '${SECRET:API_KEY}:${SECRET:TOKEN}' }
    substituteSecrets(args, resolve)
    expect(args['combined']).toBe('sk-abc123:tok-xyz')
  })

  test('deep-walks nested objects', () => {
    const args: Record<string, unknown> = {
      headers: {
        Authorization: 'Bearer ${SECRET:API_KEY}',
        Other: 'plain',
      },
    }
    substituteSecrets(args, resolve)
    expect((args['headers'] as any).Authorization).toBe('Bearer sk-abc123')
    expect((args['headers'] as any).Other).toBe('plain')
  })

  test('handles arrays with strings', () => {
    const args: Record<string, unknown> = {
      tokens: ['${SECRET:API_KEY}', 'literal', '${SECRET:TOKEN}'],
    }
    substituteSecrets(args, resolve)
    expect((args['tokens'] as string[])[0]).toBe('sk-abc123')
    expect((args['tokens'] as string[])[1]).toBe('literal')
    expect((args['tokens'] as string[])[2]).toBe('tok-xyz')
  })

  test('handles arrays with nested objects', () => {
    const args: Record<string, unknown> = {
      items: [{ key: '${SECRET:API_KEY}' }, { key: 'plain' }],
    }
    substituteSecrets(args, resolve)
    expect((args['items'] as any[])[0].key).toBe('sk-abc123')
    expect((args['items'] as any[])[1].key).toBe('plain')
  })

  test('leaves non-secret ${} patterns alone', () => {
    const args: Record<string, unknown> = { path: '${HOME}/data' }
    substituteSecrets(args, resolve)
    expect(args['path']).toBe('${HOME}/data')
  })

  test('throws on unknown secret', () => {
    const args: Record<string, unknown> = { key: '${SECRET:NONEXISTENT}' }
    expect(() => substituteSecrets(args, resolve)).toThrow('Unknown secret "NONEXISTENT"')
  })
})

// ── EncryptedFileSecretStorage tests ────────────────────────────────────────

describe('EncryptedFileSecretStorage', () => {
  let tmpDir: string
  let filePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretd-test-'))
    filePath = path.join(tmpDir, 'secrets.enc')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('round-trip: save and load secrets', () => {
    const key = 'my-test-passphrase-for-keryx'

    const writer = new EncryptedFileSecretStorage(filePath, key)
    writer.set('API_KEY', 'sk-abc123')
    writer.set('TOKEN', 'tok-xyz')
    writer.save()

    // New instance, same key — should decrypt
    const reader = new EncryptedFileSecretStorage(filePath, key)
    reader.load()

    expect(reader.get('API_KEY')).toBe('sk-abc123')
    expect(reader.get('TOKEN')).toBe('tok-xyz')
    expect(reader.list()).toContain('API_KEY')
    expect(reader.list()).toContain('TOKEN')
  })

  test('load with wrong key fails', () => {
    const writer = new EncryptedFileSecretStorage(filePath, 'correct-key')
    writer.set('API_KEY', 'secret')
    writer.save()

    const reader = new EncryptedFileSecretStorage(filePath, 'wrong-key')
    expect(() => reader.load()).toThrow()
  })

  test('load from nonexistent file gives empty storage', () => {
    const reader = new EncryptedFileSecretStorage('/tmp/nonexistent-file.enc', 'key')
    reader.load()
    expect(reader.list()).toEqual([])
    expect(reader.get('anything')).toBeUndefined()
  })

  test('clear removes all secrets from memory', () => {
    const storage = new EncryptedFileSecretStorage(filePath, 'key')
    storage.set('API_KEY', 'secret')
    expect(storage.get('API_KEY')).toBe('secret')

    storage.clear()
    expect(storage.get('API_KEY')).toBeUndefined()
    expect(storage.list()).toEqual([])
  })

  test('accepts 64-char hex key', () => {
    const hexKey = 'a'.repeat(64)

    const writer = new EncryptedFileSecretStorage(filePath, hexKey)
    writer.set('KEY', 'value')
    writer.save()

    const reader = new EncryptedFileSecretStorage(filePath, hexKey)
    reader.load()
    expect(reader.get('KEY')).toBe('value')
  })
})

// ── Daemon integration tests ────────────────────────────────────────────────

describe('secretd daemon', () => {
  test('injects prompt segment listing granted secrets', async () => {
    const calls: { instruction: string }[] = []

    const kx = createKeryx({
      agents: [makeAgent('analyst', 'Analyst')],
      daemons: [
        secretd({
          storage: new InMemorySecretStorage({ OPENAI_KEY: 'sk-123' }),
          secrets: {
            OPENAI_KEY: { grants: ['analyst'], allowedTools: ['http_request'] },
          },
        }),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async ({ messages }) => {
          // Capture the system instruction to verify prompt injection
          const system = messages?.find((m: any) => m.role === 'system')
          if (system) calls.push({ instruction: String(system.content) })
          return { content: 'done' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'analyst', body: 'test' })
    await wait(300)
    await kx.stop()

    expect(calls.length).toBeGreaterThan(0)
    const instruction = calls[0]!.instruction
    expect(instruction).toContain('${SECRET:OPENAI_KEY}')
    expect(instruction).toContain('[secretd]')
  })

  test('does NOT inject prompt for agent without grants', async () => {
    const calls: { instruction: string }[] = []

    const kx = createKeryx({
      agents: [makeAgent('rogue', 'Rogue')],
      daemons: [
        secretd({
          storage: new InMemorySecretStorage({ OPENAI_KEY: 'sk-123' }),
          secrets: {
            OPENAI_KEY: { grants: ['analyst'], allowedTools: ['http_request'] },
          },
        }),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async ({ messages }) => {
          const system = messages?.find((m: any) => m.role === 'system')
          if (system) calls.push({ instruction: String(system.content) })
          return { content: 'done' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'rogue', body: 'test' })
    await wait(300)
    await kx.stop()

    expect(calls.length).toBeGreaterThan(0)
    const instruction = calls[0]!.instruction
    expect(instruction).not.toContain('SECRET:OPENAI_KEY')
  })

  test('substitutes ${SECRET:ID} in allowed tool args', async () => {
    let capturedArgs: Record<string, unknown> = {}

    const httpTool = createTool({
      id: 'http_request',
      description: 'Make HTTP request',
      schema: {
        url: { type: 'string', description: 'URL' },
        headers: { type: 'string', description: 'Headers as JSON string' },
      },
      execute: async (args: { url: string; headers: string }) => {
        capturedArgs = args
        return 'ok'
      },
    })

    const kx = createKeryx({
      agents: [{ ...makeAgent('analyst', 'Analyst'), tools: [httpTool] }],
      daemons: [
        secretd({
          storage: new InMemorySecretStorage({ OPENAI_KEY: 'sk-real-value' }),
          secrets: {
            OPENAI_KEY: { grants: ['analyst'], allowedTools: ['http_request'] },
          },
        }),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({
          content: null,
          toolCalls: [
            {
              id: 'call-1',
              name: 'http_request',
              arguments: {
                url: 'https://api.openai.com/v1/chat',
                headers: 'Bearer ${SECRET:OPENAI_KEY}',
              },
            },
          ],
        }),
      },
    })

    kx.start()
    await kx.send({ to: 'analyst', body: 'test' })
    await wait(300)
    await kx.stop()

    // The tool should have received the substituted value
    expect(capturedArgs['headers']).toBe('Bearer sk-real-value')
  })

  test('wildcard grant (*) gives all agents access', async () => {
    let capturedArgs: Record<string, unknown> = {}

    const apiTool = createTool({
      id: 'api_call',
      description: 'Call API',
      schema: { token: { type: 'string', description: 'Token' } },
      execute: async (args: { token: string }) => {
        capturedArgs = args
        return 'ok'
      },
    })

    const kx = createKeryx({
      agents: [{ ...makeAgent('any-agent', 'Any Agent'), tools: [apiTool] }],
      daemons: [
        secretd({
          storage: new InMemorySecretStorage({ TOKEN: 'my-token' }),
          secrets: {
            TOKEN: { grants: ['*'], allowedTools: ['api_call'] },
          },
        }),
      ],
      pollingInterval: 10,
      defaultProvider: {
        generate: async () => ({
          content: null,
          toolCalls: [
            {
              id: 'call-1',
              name: 'api_call',
              arguments: { token: '${SECRET:TOKEN}' },
            },
          ],
        }),
      },
    })

    kx.start()
    await kx.send({ to: 'any-agent', body: 'test' })
    await wait(300)
    await kx.stop()

    expect(capturedArgs['token']).toBe('my-token')
  })

  test('onStart throws if configured secret is missing from storage', () => {
    const kx = createKeryx({
      agents: [makeAgent('test', 'Test')],
      daemons: [
        secretd({
          storage: new InMemorySecretStorage({}),
          secrets: {
            MISSING_KEY: { grants: ['test'], allowedTools: ['http'] },
          },
        }),
      ],
      pollingInterval: 10,
      defaultProvider: { generate: async () => ({ content: 'ok' }) },
    })

    expect(() => kx.start()).toThrow('Secret "MISSING_KEY" is configured but not found in storage')
  })
})
