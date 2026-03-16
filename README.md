# Keryx

**κῆρυξ** — *herald, messenger*

Agent orchestrator — process manager and message bus for autonomous AI agents built on [Nous](https://github.com/elfenlabs/nous).

## What is Keryx?

Keryx is the missing middle layer between **Nous** (the agent runtime) and your application. It manages agent lifecycles, routes messages between inboxes, and provides the primitives for agents to communicate and self-organize.

Think of it as an **OS for agents**:

| OS Concept | Keryx Equivalent |
|---|---|
| Kernel | Process Manager |
| Process | Agent (Nous instance) |
| Scheduler | Inbox poller + per-agent locking |
| IPC | `message_send` / `agent_ask` tools |
| fork / exec | `agent_spawn` / `agent_destroy` tools |
| Signals | Force messages + `AbortSignal` |
| Daemons | Middleware services that extend Keryx |

## Quick Start

```typescript
import { createKeryx, loggerd, contextd } from '@elfenlabs/keryx'
import { createProvider } from '@elfenlabs/nous'

// 1. Define agent templates
const definitions = {
  analyst: {
    name: 'Analyst',
    instruction: 'You coordinate research. Use agent_ask to query specialists.',
    config: { 'context': { persist: true } },
  },
  researcher: {
    name: 'Researcher',
    instruction: 'You research topics and return detailed findings.',
  },
}

// 2. Create the orchestrator
const kx = createKeryx({
  defaultProvider: createProvider({ url: 'https://api.openai.com/v1', model: 'gpt-4o' }),
  definitions,  // catalog for agent_spawn tool
})

// 3. Register daemons at runtime
await kx.daemons.register(loggerd())
await kx.daemons.register(contextd())

// 4. Spawn agent instances from definitions
await kx.agents.spawn('analyst-1', definitions.analyst)
await kx.agents.spawn('researcher-1', definitions.researcher)

// 5. Start the inbox poller
kx.start()

// 6. Fire-and-forget
await kx.send({ to: 'analyst-1', body: 'Analyze AAPL' })

// 7. Request-reply (simple await)
const { response } = await kx.request({ to: 'analyst-1', body: 'Status report?' })

// 8. Request-reply with streaming
const handle = kx.request({ to: 'analyst-1', body: 'Deep analysis of AAPL' })
for await (const event of handle.stream) {
  if (event.type === 'text') process.stdout.write(event.content)
}
```

## Core API

### `createKeryx(config)`

Creates a Keryx orchestrator instance.

```typescript
type KeryxConfig = {
  defaultProvider: Provider          // Nous provider for all agents (unless overridden)
  definitions?: Record<string, AgentDefinition>  // Named agent templates
  pollingInterval?: number           // Inbox poll interval in ms (default: 100)
}
```

### `kx.send(opts)`

Fire-and-forget message delivery. Enqueues a message and triggers processing.

```typescript
await kx.send({ to: 'analyst-1', body: 'Run report', priority: 1 })
```

### `kx.request(opts)` → `RequestHandle`

Request-reply with streaming support. Returns a `RequestHandle`:

| Property | Type | Description |
|---|---|---|
| `stream` | `AsyncGenerator<StreamEvent>` | Structured stream events (text, thinking, tool calls) |
| `result` | `Promise<RequestResult>` | Resolves to the full result with events and usage |
| `abort()` | `() => void` | Kills the agent's Nous loop |
| `then()` | thenable | Makes `await kx.request(...)` return `RequestResult` |

**`StreamEvent`** is a discriminated union:

```typescript
type StreamEvent =
  | { type: 'text',        activationId: string, agentId: string, content: string }
  | { type: 'thinking',    activationId: string, agentId: string, content: string }
  | { type: 'tool_call',   activationId: string, agentId: string, name: string, args: Record<string, unknown> }
  | { type: 'tool_result', activationId: string, agentId: string, name: string, result: string }
```

**`RequestResult`** contains the full run output:

```typescript
type RequestResult = {
  activationId: string    // root activation ID for the entire causal chain
  response: string        // final text output from the agent
  events: StreamEvent[]   // full ordered list of all events
  usage: Usage            // aggregated token usage
}
```

```typescript
// Simple await
const { response, usage } = await kx.request({ to: 'agent-1', body: 'Hello' })

// Streaming with event type filtering
const handle = kx.request({ to: 'agent-1', body: 'Hello' })
for await (const event of handle.stream) {
  switch (event.type) {
    case 'text':        process.stdout.write(event.content); break
    case 'thinking':    /* reasoning tokens */                break
    case 'tool_call':   /* tool invocation */                 break
    case 'tool_result': /* tool output */                     break
  }
}

// With abort
const handle = kx.request({ to: 'agent-1', body: 'Long task', signal: controller.signal })
setTimeout(() => handle.abort(), 30_000)
const result = await handle.result
```

### `kx.agents`

Runtime agent lifecycle management and observability.

| Method | Description |
|---|---|
| `spawn(id, definition, opts?)` | Create a new agent instance from a definition |
| `destroy(id, opts?)` | Tear down an agent (with optional force-interrupt) |
| `list()` | List all agents with `busy`/`idle` status |
| `getStatus(id)` | Detailed status including active tool calls and step count |
| `getInbox(id)` | Peek at an agent's pending messages |
| `flushInbox(id)` | Clear all pending messages, returns count flushed |
| `abort(id)` | Force-abort a running agent's Nous loop |

```typescript
// Spawn with per-instance overrides
const agent = await kx.agents.spawn('analyst-2', analystDef, {
  provider: customProvider,
  config: { 'context': { persist: true } },
})

// Observe
const agents = kx.agents.list()
// → [{ id: 'analyst-1', name: 'Analyst', status: 'busy', step: 3, ... }]

// Teardown
await kx.agents.destroy('analyst-2', { force: true })
```

### `kx.daemons`

Runtime daemon registration with hot-reload support.

| Method | Description |
|---|---|
| `register(daemon)` | Register (or replace) a daemon, triggers `onStart` |
| `deregister(id)` | Remove a daemon, triggers `onStop` |
| `list()` | List registered daemons with `{ id, order }` |

```typescript
await kx.daemons.register(loggerd())
await kx.daemons.deregister('loggerd')
```

## Agent Communication

Agents have four built-in tools, injected automatically at activation time:

| Tool | Pattern | Description |
|---|---|---|
| `message_send` | Fire-and-forget | Send a message to another agent's inbox |
| `agent_ask` | Blocking RPC | Ask another agent and wait for their reply (120s timeout) |
| `agent_spawn` | Lifecycle | Spawn a new agent instance from a named definition |
| `agent_destroy` | Lifecycle | Destroy another agent instance |

```typescript
// Inside an agent's activation, via tool calls:

// Fire-and-forget — delegate without waiting
message_send({ to: 'reporter', body: 'Compile the final report.' })

// Blocking RPC — ask and wait (supports parallel tool calls)
agent_ask({ to: 'news-agent', body: 'Get latest news for AAPL' })
agent_ask({ to: 'market-data', body: 'Get 30-day price history for AAPL' })
// Both resolve → agent gets both results in one step

// Dynamic scaling — spawn a specialist on demand
agent_spawn({ id: 'aapl-analyst', definition: 'analyst' })
message_send({ to: 'aapl-analyst', body: 'Deep dive on AAPL earnings' })

// Cleanup — tear down when done
agent_destroy({ id: 'aapl-analyst' })
```

> [!WARNING]
> **Deadlock risk**: If Agent A `agent_ask`s Agent B while Agent B `agent_ask`s Agent A, both will wait forever. Avoid circular request chains. Default timeout: 120 seconds.

## Activation ID

Every message in Keryx carries an **`activationId`** — a causal chain identifier that scopes all events triggered by a single root action. When `kx.send()` or `kx.request()` creates a message, it assigns a unique `activationId`. All downstream messages created via `agent_ask` or `message_send` inherit the same `activationId`.

```
[activationId: abc-123]
  → agent-a processes message
    → agent_ask to agent-b     (same activationId)
      → agent-b processes      (same activationId)
    → message_send to agent-c  (same activationId)
      → agent-c processes      (same activationId)
```

This enables:
- **Cost accounting**: Token usage per activation across all agents in the chain
- **Distributed tracing**: Full event traces scoped to a single user action
- **Scoped subscriptions**: Filter `streamd` events by `activationId`

## Daemons

Daemons (δαίμων, *spirit*) are middleware services that extend Keryx through **lifecycle hooks**. Unlike MCP servers (pull-only), daemons are **bidirectional** — they can provide tools, inject prompt segments, push messages into inboxes, and observe agent streams.

```typescript
import type { DaemonDefinition } from '@elfenlabs/keryx'

const myDaemon: DaemonDefinition = {
  id: 'my-daemon',
  order: 10,

  // System lifecycle
  onStart: (kx) => { /* start polling, connect websocket, etc. */ },
  onStop: () => { /* cleanup */ },

  // Agent lifecycle
  onAgentSpawn: (ctx) => { /* agent instance created */ },
  onAgentDestroy: (ctx) => { /* agent instance destroyed */ },

  // Per-activation hooks
  onBeforeActivation: (ctx) => {
    ctx.addTools([queryTool])
    ctx.addPromptSegment('You have access to the knowledge graph.')
  },
  onAfterActivation: (ctx) => { /* cleanup, metrics */ },

  // Tool interception
  onBeforeToolCall: (ctx) => { /* arg mutation, secret injection */ },
  onAfterToolCall: (ctx) => { /* logging, metrics */ },

  // Observation
  onMessageReceived: (ctx) => { /* logging, filtering */ },
  onAgentStream: (ctx) => { /* real-time output/thinking/tool call observation */ },
}

await kx.daemons.register(myDaemon)
```

### Lifecycle Hooks

| Hook | When | Use |
|---|---|---|
| `onStart(kx)` | Daemon is registered | Start background processes |
| `onStop()` | Daemon is deregistered | Cleanup background processes |
| `onAgentSpawn(ctx)` | Agent instance created | Inject spawn-time tools/prompts |
| `onAgentDestroy(ctx)` | Agent instance destroyed | Cleanup per-agent resources |
| `onMessageReceived(ctx)` | Message enters inbox | Logging, filtering |
| `onBeforeActivation(ctx)` | Before Nous starts | Tool provisioning, prompt injection |
| `onBeforeToolCall(ctx)` | Before a tool executes | Argument mutation, secret injection |
| `onAfterToolCall(ctx)` | After a tool completes | Logging, metrics |
| `onAfterActivation(ctx)` | After activation ends | Context persistence, cleanup |
| `onAgentStream(ctx)` | During agent streaming | Real-time output/thinking/tool call observation |

### Scoped Configuration

Agents declare per-daemon config via the `config` field. No config key = no tools injected, keeping the context window minimal.

```typescript
const agentDef: AgentDefinition = {
  name: 'Researcher',
  instruction: '...',
  config: {
    'context': { persist: true },              // contextd: enable memory
    'shelld':  { hosts: ['dev-box'] },         // shelld: shell access
    'keryxd':  { read: ['*'], write: ['*'] },  // keryxd: full management
  },
}
```

### Built-in Daemons

| Daemon | Purpose | Provides Tools | Pushes Messages |
|---|---|---|---|
| **loggerd** | Terminal logging for development observability | ✗ | ✗ |
| **contextd** | Persist and restore Nous context between activations | ✗ | ✗ |
| **crond** | Scheduled message delivery on intervals | ✗ | ✓ |
| **keryxd** | Agent management — status, inbox reads, abort, flush | ✓ | ✗ |
| **artifactd** | Shared artifact storage with ownership and read/write tools | ✓ | ✗ |
| **secretd** | Secure secret injection via symbolic handles | ✗ | ✗ |
| **streamd** | Real-time streaming event bus for agent output | ✗ | ✗ |
| **shelld** | Shell session broker — exec, output pagination, stdin | ✓ | ✗ |

See [docs/](docs/) for detailed daemon documentation.

## Attachments

Keryx's message bus is text-only, but supports multimodal content through the **attachment metadata convention**:

```typescript
await kx.send({
  to: 'vision-agent',
  body: 'What is in this image?',
  metadata: {
    attachments: [
      { url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' },
      { url: 'data:image/png;base64,...',      mimeType: 'image/png', filename: 'chart.png' },
    ],
  },
})
```

Attachments are assembled into Nous `ContentPart[]` at activation time — native types (images, video) are passed through directly, while other formats can be pre-processed by daemons.

```typescript
type Attachment = {
  url: string           // HTTPS URL or data: base64 URI
  mimeType: string      // e.g. 'image/jpeg', 'video/mp4'
  filename?: string     // Optional original filename
  sizeBytes?: number    // Optional byte size (for budget/quota decisions)
}
```

## Requirements

- Node.js 22+ or Bun 1.0+
- `@elfenlabs/nous` ^0.8.0 (peer dependency)

## License

MIT © [Elfenlabs](https://github.com/elfenlabs)
