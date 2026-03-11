# secretd — Secrets Management Daemon

> Secure secret injection via symbolic handles and middleware-layer substitution.

## Overview

`secretd` is a Keryx daemon that provides secure access to secrets (API keys, tokens, credentials) without exposing their values to agents. Agents see symbolic handles like `${SECRET:OPENAI_API_KEY}` and use them in tool arguments. `secretd` substitutes the real values at the `onPreToolCall` middleware layer, scoped to allowed tools.

### Why

The naive approach — pasting API keys into agent instructions or inbox messages — leaks secrets into conversation context, logs, and persistence. `secretd` ensures:

1. **Secrets never enter the LLM context** — agents only see symbolic handles
2. **Blast radius is limited** — substitution only happens in allowed tools
3. **ACL-based access** — operators grant specific agents access to specific secrets
4. **Encrypted at rest** — default storage uses AES-256-GCM

### Design Principles

1. **Separation of control planes** — operators configure secrets via code, agents consume via `${SECRET:ID}` syntax
2. **No agent tools** — agents cannot list, set, or inspect secrets. Zero attack surface.
3. **Fail-loud** — unknown `${SECRET:ID}` references throw with available secret names for self-correction
4. **Namespaced syntax** — `${SECRET:ID}` avoids collision with shell `${ENV_VAR}` patterns

---

## Configuration

```ts
import { createKeryx, secretd, InMemorySecretStorage } from '@elfenlabs/keryx'

const kx = createKeryx({
  daemons: [
    secretd({
      storage: new InMemorySecretStorage({
        OPENAI_API_KEY: 'sk-abc123...',
        GITHUB_TOKEN: 'ghp_xyz...',
      }),
      secrets: {
        OPENAI_API_KEY: {
          grants: ['analyst', 'writer'],   // specific agents
          allowedTools: ['http_request'],   // substitution only here
        },
        GITHUB_TOKEN: {
          grants: ['*'],                   // all agents
          allowedTools: ['github_api', 'git_push'],
        },
      },
    }),
  ],
  agents: [
    {
      id: 'analyst',
      name: 'Analyst',
      instruction: 'You analyze data using external APIs.',
    },
  ],
})
```

### `SecretdOptions`

| Option    | Type                          | Description                         |
|-----------|-------------------------------|-------------------------------------|
| `storage` | `SecretStorage`               | Backend that holds secret values    |
| `secrets` | `Record<string, SecretConfig>` | Per-secret ACL and tool allowlists |

### `SecretConfig`

| Field          | Type       | Description                                              |
|----------------|------------|----------------------------------------------------------|
| `grants`       | `string[]` | Agent IDs that can use this secret. `'*'` = all agents.  |
| `allowedTools` | `string[]` | Tool IDs where substitution is applied. `'*'` = all tools. |

---

## Security Model

| Mechanism | Purpose |
|-----------|---------|
| **ACL grants** | Per-agent access — only granted agents trigger substitution |
| **Allowed tools** | Per-tool scoping — `${SECRET:ID}` in `send_message` is safe (no substitution) |
| **Namespaced syntax** | `${SECRET:ID}` won't collide with `${HOME}` or other `${...}` patterns |
| **Fail-loud** | Unknown `${SECRET:TYPO}` throws immediately with available secret names |
| **No agent tools** | Agents can't enumerate, read, or set secrets — zero surface area |
| **Memory-only runtime** | Secrets are decrypted into memory at startup, never written to context |

### What Agents See

The agent's system prompt includes:

```
[secretd] Available secrets (use in tool arguments, auto-resolved): ${SECRET:OPENAI_API_KEY}, ${SECRET:GITHUB_TOKEN}
```

The agent uses these handles in tool arguments:

```json
{
  "tool": "http_request",
  "args": {
    "url": "https://api.openai.com/v1/chat/completions",
    "headers": "Bearer ${SECRET:OPENAI_API_KEY}"
  }
}
```

`secretd` intercepts at `onPreToolCall`, verifies the ACL and tool allowlist, and substitutes `${SECRET:OPENAI_API_KEY}` → `sk-abc123...` before the tool executes.

### Error Handling

| Scenario | Behavior |
|----------|----------|
| `${SECRET:TYPO}` (unknown secret) | Throws: `Unknown secret "TYPO". Available secrets: OPENAI_API_KEY, GITHUB_TOKEN` |
| `${SECRET:OPENAI_API_KEY}` in non-allowed tool | Throws: `Secret "OPENAI_API_KEY" cannot be used in tool "send_message"` |
| Agent without grant uses `${SECRET:ID}` | Throws: `Agent "rogue" does not have access to secret "OPENAI_API_KEY"` |
| `${HOME}` (non-secret pattern) | Ignored — not a `${SECRET:...}` pattern, passed through literally |

The fail-loud approach with descriptive error messages enables **agent self-correction** — a typo like `${SECRET:OPENAI_KEY}` is corrected on retry because the error lists the correct name.

---

## Storage Backends

### `SecretStorage` Interface

```ts
interface SecretStorage {
  get(id: string): string | undefined
  list(): string[]
}
```

### `InMemorySecretStorage`

Simple in-memory storage for testing and lightweight deployments:

```ts
const storage = new InMemorySecretStorage({
  OPENAI_API_KEY: 'sk-abc123...',
  GITHUB_TOKEN: 'ghp_xyz...',
})
```

### `EncryptedFileSecretStorage`

AES-256-GCM encrypted JSON file. Secrets are encrypted at rest, decrypted into memory at startup:

```ts
import { EncryptedFileSecretStorage } from '@elfenlabs/keryx'

// Create and populate (one-time setup)
const storage = new EncryptedFileSecretStorage('./secrets.enc', 'my-passphrase')
storage.set('OPENAI_API_KEY', 'sk-abc123...')
storage.set('GITHUB_TOKEN', 'ghp_xyz...')
storage.save()

// Use in daemon (runtime)
const storage = new EncryptedFileSecretStorage('./secrets.enc', 'my-passphrase')
// .load() is called automatically by secretd.onStart
```

**Key formats:**

| Format | Example | Behavior |
|--------|---------|----------|
| 64-char hex | `'a1b2c3...f0'` | Used as raw AES-256 key |
| Any other string | `'my-passphrase'` | Derived via `scrypt` to 32 bytes |

**File format:** `[IV (16 bytes)][Auth Tag (16 bytes)][Ciphertext]` — binary, no human-readable content.

### Custom Storage

Implement `SecretStorage` to integrate with external secret managers:

```ts
class VaultSecretStorage implements SecretStorage {
  get(id: string): string | undefined {
    return vault.readSecret(`keryx/${id}`)
  }
  list(): string[] {
    return vault.listSecrets('keryx/')
  }
}
```

---

## Daemon Lifecycle

| Hook | Order | Behavior |
|------|-------|----------|
| `onStart` | 3 | Load/decrypt storage. Validate all configured secrets exist. |
| `onPreActivation` | 3 | Inject prompt segment listing granted `${SECRET:*}` handles |
| `onPreToolCall` | 3 | Deep-substitute `${SECRET:ID}` in args if tool is allowed |
| `onStop` | 3 | Clear secrets from memory |

### Substitution Engine

The substitution engine deep-walks all tool arguments:

- **Strings** — regex `/${SECRET:([^}]+)}/g` match and replace
- **Nested objects** — recursively walked
- **Arrays** — each element checked (strings replaced, objects recursed)
- **Non-strings** — skipped (numbers, booleans, null)

Example deep substitution:

```json
{
  "headers": {
    "Authorization": "Bearer ${SECRET:API_KEY}",
    "X-Custom": "plain"
  },
  "body": "{\"token\": \"${SECRET:TOKEN}\"}"
}
```

Both `${SECRET:API_KEY}` and `${SECRET:TOKEN}` are resolved, `"plain"` is untouched.

---

## Workflow Example

An analyst agent with access to the OpenAI API:

```
── Operator (setup code) ──────────────────────────────────────────────

1. Configure secretd with OPENAI_API_KEY granted to analyst,
   allowed in http_request tool

── Agent (analyst) ────────────────────────────────────────────────────

2. Receives message: "Summarize this article using GPT-4"

3. System prompt includes:
   [secretd] Available secrets: ${SECRET:OPENAI_API_KEY}

4. Agent calls:
   http_request({
     url: "https://api.openai.com/v1/chat/completions",
     headers: "Bearer ${SECRET:OPENAI_API_KEY}",
     body: "{...}"
   })

── secretd middleware (onPreToolCall) ──────────────────────────────────

5. Checks: analyst has grant ✓, http_request is allowed ✓
6. Substitutes: "Bearer ${SECRET:OPENAI_API_KEY}" → "Bearer sk-abc123..."
7. Tool executes with real credentials

── What stays safe ────────────────────────────────────────────────────

8. Nous context contains: "Bearer ${SECRET:OPENAI_API_KEY}" (not the real key)
9. contextd persists: "Bearer ${SECRET:OPENAI_API_KEY}" (safe to store)
10. Agent response: "I used the OpenAI API" (no secret leakage)
```

---

## Future Considerations (v2)

- **Secret rotation** — hot-swap values via `kx.secrets.update()` without restart
- **Audit trail** — log secret access events (agent, secret, tool, timestamp) without values
- **Scoped environment** — `${ENV:VAR}` syntax for non-secret environment variables
- **TTL / expiry** — auto-revoke grants after a time window
- **Rate limiting** — cap how many times a secret can be used per activation
