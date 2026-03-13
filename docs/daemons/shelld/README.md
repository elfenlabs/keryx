# shelld — Shell Session Broker

Bridges agents to pre-provisioned shell hosts. Agents execute arbitrary commands, paginate output, and interact with running processes via stdin.

The actual runtime (Docker, local subprocess, remote API) is injected via a `ShellDriver` adapter — **no hard dependencies on container runtimes**.

## Quick Start

```ts
import { createKeryx, shelld } from '@elfenlabs/keryx'

const shell = shelld({ driver: myDockerDriver })

const kx = createKeryx({
  agents: [
    {
      id: 'coder',
      name: 'Coder',
      instruction: 'You are a coding agent.',
      config: {
        'shelld': { hosts: ['dev-box'] },
      },
    },
  ],
  daemons: [shell.daemon],
  defaultProvider: myProvider,
})
```

## Config

Agents declare which hosts they can access via the `shelld` config key:

```ts
config: {
  'shelld': {
    hosts: ['dev-box', 'staging-*']  // exact match or prefix* glob
  }
}
```

- **Isolation**: assign a unique host ID to one agent
- **Shared workspace**: assign the same host ID to multiple agents

## Driver Interface

Consumers implement `ShellDriver` for their runtime:

```ts
type ShellDriver = {
  connect(hostId: string): Promise<void>
  spawn(hostId: string, command: string): Promise<ShellProcess>
  disconnect(hostId: string): Promise<void>
}

type ShellProcess = {
  write(data: string): void
  onData(cb: (chunk: string) => void): void
  onExit(cb: (exitCode: number) => void): void
  kill(): void
}
```

All sessions **must be allocated with a PTY** to support interactive features (Ctrl+C via `\x03`).

## Tools

### `shell_exec`

Execute a command on a host.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `hostId` | string | ✅ | Target host ID |
| `command` | string | ✅ | Shell command to execute |
| `timeout` | number | ❌ | Max ms to wait (default: 5000) |

**Returns**: `{ commandId, status, exitCode, output }`

- **Short output** (≤ headChars + tailChars): `output = { content, totalBytes }`
- **Large output**: `output = { head, tail, totalBytes }`

If the command exceeds the timeout, `status` is `'running'` and the agent can poll with `shell_output`.

### `shell_output`

Paginate the output buffer of a command.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commandId` | string | ✅ | Command ID from `shell_exec` |
| `offset` | number | ❌ | Character offset (default: 0) |
| `length` | number | ❌ | Characters to read (default: 4000) |

**Returns**: `{ content, offset, length, totalBytes, status, exitCode }`

### `shell_input`

Write to stdin of a running command.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commandId` | string | ✅ | Command ID from `shell_exec` |
| `input` | string | ✅ | String to write (use `\x03` for Ctrl+C) |

**Returns**: `{ ok: true }` or error if the process has exited.

## Sessions

- **Long-lived**: sessions persist across tool calls until the process exits
- **Shared**: any agent with access to the same host can read/write sessions on that host
- **Growing buffer**: output accumulates in an append-only buffer, paginated via `shell_output`

## Options

```ts
shelld({
  driver: myDriver,      // Required — ShellDriver implementation
  headChars: 500,        // Truncation head size (default: 500)
  tailChars: 500,        // Truncation tail size (default: 500)
})
```

## Observability

The `ShelldHandle` exposes a read-only `sessions` map for external inspection:

```ts
const shell = shelld({ driver })
// After some activity...
for (const [id, session] of shell.sessions) {
  console.log(id, session.status, session.totalBytes)
}
```
