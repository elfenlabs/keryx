/**
 * Keryx — secretd (Secrets Management Daemon)
 *
 * Built-in daemon that provides secure secret injection via
 * ${SECRET:ID} substitution in tool call arguments.
 *
 * Secrets are never exposed to the agent — only symbolic handles
 * are shown. Substitution happens at the middleware layer during
 * tool:before, scoped to allowed tools per secret.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import type { DaemonDefinition, KeryxInstance } from '../types.js'

// ── Types ───────────────────────────────────────────────────────────────────

/** Configuration for a single secret */
export type SecretConfig = {
  /** Agent IDs that can use this secret. Use '*' to grant all agents. */
  grants: string[]
  /** Tool IDs where ${SECRET:ID} substitution is applied. */
  allowedTools: string[]
}

/** Options for creating the secretd daemon */
export type SecretdOptions = {
  /** Pluggable secret storage backend */
  storage: SecretStorage
  /** Secret configurations: maps secret ID → config */
  secrets: Record<string, SecretConfig>
}

// ── Storage Interface ───────────────────────────────────────────────────────

/** Pluggable backend for secret value storage */
export interface SecretStorage {
  /** Retrieve a secret value by ID. Returns undefined if not found. */
  get(id: string): string | undefined
  /** List all secret IDs (values are never exposed through this). */
  list(): string[]
}

// ── In-Memory Storage ───────────────────────────────────────────────────────

/** Simple in-memory secret storage for testing and lightweight use */
export class InMemorySecretStorage implements SecretStorage {
  private secrets: Map<string, string>

  constructor(secrets: Record<string, string>) {
    this.secrets = new Map(Object.entries(secrets))
  }

  get(id: string): string | undefined {
    return this.secrets.get(id)
  }

  list(): string[] {
    return [...this.secrets.keys()]
  }
}

// ── Encrypted File Storage ──────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const TAG_LENGTH = 16

/** AES-256-GCM encrypted JSON file storage */
export class EncryptedFileSecretStorage implements SecretStorage {
  private secrets: Map<string, string> = new Map()
  private readonly filePath: string
  private readonly encryptionKey: Buffer

  /**
   * @param filePath - Path to the encrypted secrets file
   * @param key - 32-byte encryption key (hex string or raw string)
   */
  constructor(filePath: string, key: string) {
    this.filePath = filePath
    // Accept hex-encoded 64-char key or derive from passphrase
    if (key.length === 64 && /^[0-9a-f]+$/i.test(key)) {
      this.encryptionKey = Buffer.from(key, 'hex')
    } else {
      // Derive a 32-byte key from passphrase using scrypt (deterministic)
      this.encryptionKey = crypto.scryptSync(key, 'keryx-secretd-salt', 32)
    }
  }

  /** Load and decrypt the secrets file */
  load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.secrets = new Map()
      return
    }

    const raw = fs.readFileSync(this.filePath)
    // Format: [IV (16 bytes)][Auth Tag (16 bytes)][Ciphertext]
    const iv = raw.subarray(0, IV_LENGTH)
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH)

    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv)
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const data = JSON.parse(decrypted.toString('utf-8')) as Record<string, string>
    this.secrets = new Map(Object.entries(data))
  }

  /** Encrypt and save secrets to file */
  save(): void {
    const data = Object.fromEntries(this.secrets)
    const json = JSON.stringify(data)

    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv)

    const encrypted = Buffer.concat([cipher.update(json, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()

    // Format: [IV][Tag][Ciphertext]
    fs.writeFileSync(this.filePath, Buffer.concat([iv, tag, encrypted]))
  }

  /** Set a secret (useful for initial population) */
  set(id: string, value: string): void {
    this.secrets.set(id, value)
  }

  get(id: string): string | undefined {
    return this.secrets.get(id)
  }

  list(): string[] {
    return [...this.secrets.keys()]
  }

  /** Clear all secrets from memory */
  clear(): void {
    this.secrets.clear()
  }
}

// ── Substitution Engine ─────────────────────────────────────────────────────

const SECRET_PATTERN = /\$\{SECRET:([^}]+)\}/g

/** Deep-walk an object and substitute ${SECRET:ID} in all string values */
export function substituteSecrets(
  obj: Record<string, unknown>,
  resolve: (id: string) => string,
): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (typeof value === 'string' && SECRET_PATTERN.test(value)) {
      // Reset lastIndex since we used .test()
      SECRET_PATTERN.lastIndex = 0
      obj[key] = value.replace(SECRET_PATTERN, (_match, secretId: string) => {
        return resolve(secretId)
      })
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string' && SECRET_PATTERN.test(value[i])) {
          SECRET_PATTERN.lastIndex = 0
          value[i] = value[i].replace(SECRET_PATTERN, (_match: string, secretId: string) => {
            return resolve(secretId)
          })
        } else if (typeof value[i] === 'object' && value[i] !== null) {
          substituteSecrets(value[i] as Record<string, unknown>, resolve)
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      substituteSecrets(value as Record<string, unknown>, resolve)
    }
  }
}

// ── Daemon Factory ──────────────────────────────────────────────────────────

/**
 * Create a secrets management daemon.
 *
 * @example
 * ```ts
 * await kx.daemons.register(secretd({
 *   storage: new InMemorySecretStorage({
 *     OPENAI_API_KEY: 'sk-abc123...',
 *     GITHUB_TOKEN: 'ghp_xyz...',
 *   }),
 *   secrets: {
 *     OPENAI_API_KEY: {
 *       grants: ['analyst', 'writer'],
 *       allowedTools: ['http_request'],
 *     },
 *     GITHUB_TOKEN: {
 *       grants: ['*'],
 *       allowedTools: ['github_api'],
 *     },
 *   },
 * }))
 * ```
 */
export function secretd(opts: SecretdOptions): DaemonDefinition {
  const { storage, secrets: secretConfigs } = opts

  /** Check if an agent has access to a secret */
  function hasGrant(secretId: string, agentId: string): boolean {
    const config = secretConfigs[secretId]
    if (!config) return false
    return config.grants.includes('*') || config.grants.includes(agentId)
  }

  /** Check if a tool is allowed for substitution of a given secret */
  function isToolAllowed(secretId: string, toolId: string): boolean {
    const config = secretConfigs[secretId]
    if (!config) return false
    return config.allowedTools.includes('*') || config.allowedTools.includes(toolId)
  }

  /** Get all secret IDs an agent has access to */
  function getGrantedSecrets(agentId: string): string[] {
    return Object.keys(secretConfigs).filter(id => hasGrant(id, agentId))
  }

  return {
    id: 'secretd',

    onStart: (kx: KeryxInstance) => {
      // If storage supports initialization (e.g., EncryptedFileSecretStorage.load)
      if ('load' in storage && typeof (storage as any).load === 'function') {
        (storage as any).load()
      }

      // Validate that all configured secrets exist in storage
      for (const secretId of Object.keys(secretConfigs)) {
        if (storage.get(secretId) === undefined) {
          throw new Error(`secretd: Secret "${secretId}" is configured but not found in storage`)
        }
      }

      kx.bus.on('activation:before', (ctx) => {
        const granted = getGrantedSecrets(ctx.agentId)
        if (granted.length === 0) return

        const secretList = granted.map(id => `\${SECRET:${id}}`).join(', ')
        ctx.addPromptSegment(
          `[secretd] Available secrets (use in tool arguments, auto-resolved): ${secretList}`,
        )
      }, 3)

      kx.bus.on('tool:before', (ctx) => {
        const agentId = ctx.agentId
        const toolId = ctx.toolId

        // Resolve function: checks ACL + tool allowlist, fails loud on unknown
        const resolve = (secretId: string): string => {
          // Check if secret exists in storage
          const value = storage.get(secretId)
          if (value === undefined) {
            const available = getGrantedSecrets(agentId)
            throw new Error(
              `secretd: Unknown secret "${secretId}". Available secrets: ${available.join(', ') || '(none)'}`,
            )
          }

          // Check ACL
          if (!hasGrant(secretId, agentId)) {
            throw new Error(`secretd: Agent "${agentId}" does not have access to secret "${secretId}"`)
          }

          // Check tool allowlist
          if (!isToolAllowed(secretId, toolId)) {
            throw new Error(
              `secretd: Secret "${secretId}" cannot be used in tool "${toolId}". Allowed tools: ${secretConfigs[secretId]!.allowedTools.join(', ')}`,
            )
          }

          return value
        }

        // Deep-substitute all ${SECRET:*} patterns in args
        substituteSecrets(ctx.args, resolve)
      }, 3)
    },

    onStop: () => {
      // Clear secrets from memory if storage supports it
      if ('clear' in storage && typeof (storage as any).clear === 'function') {
        (storage as any).clear()
      }
    },
  }
}
