# Keryx

**κῆρυξ** — *herald, messenger*

Agent orchestrator — process manager and message bus for autonomous AI agents built on [Nous](https://github.com/elfenlabs/nous).

## What is Keryx?

Keryx is the missing middle layer between **Nous** (the agent runtime) and your application. It manages agent lifecycles, routes messages between inboxes, and provides the primitives for agents to communicate.

Think of it as an **OS for agents**:

| OS Concept | Keryx Equivalent |
|---|---|
| Kernel | Process Manager |
| Process | Agent (Nous instance) |
| Scheduler | Inbox poller + per-agent locking |
| IPC | `send_message` / `ask_agent` tools |
| Signals | Force messages |
| Daemons | Middleware services that extend Keryx |

## Features

- **Message bus** — in-memory inbox per agent with priority queuing
- **Process manager** — spawn-on-demand, serial per-agent, concurrent across agents
- **Blocking RPC** — `ask_agent` tool for fan-out and request-reply between agents
- **Daemon middleware** — lifecycle hooks for tool provisioning, observability, and more
- **Context persistence** — configurable per-agent stateful/stateless execution via `contextd`
- **Scheduled tasks** — `crond` daemon for timed message injection
- **Force interrupts** — abort running agents via `AbortSignal`
- **Tool agnostic** — static tools + daemon-provisioned tools per agent

## Quick Start

```typescript
import { createKeryx, loggerd, contextd, crond } from '@elfenlabs/keryx'
import { createProvider } from '@elfenlabs/nous'

const kx = createKeryx({
  defaultProvider: createProvider({ url: 'https://api.openai.com/v1', model: 'gpt-4o' }),
  daemons: [
    loggerd(),
    contextd(),
    crond({
      jobs: [
        { id: 'daily-report', to: 'analyst', body: 'Generate daily report', intervalMs: 86_400_000 },
      ],
    }),
  ],
  agents: [
    {
      id: 'analyst',
      name: 'Analyst',
      instruction: 'You coordinate research. Use agent_ask to query specialists.',
      config: {
        'context': { persist: true },
      },
    },
    {
      id: 'researcher',
      name: 'Researcher',
      instruction: 'You research topics and return detailed findings.',
    },
  ],
})

// Fire-and-forget
await kx.send({ to: 'analyst', body: 'Analyze AAPL' })

// Request-reply (from external code)
const response = await kx.request({ to: 'analyst', body: 'Status report?' })

// Start background polling + daemon lifecycle
kx.start()
```

## Agent Communication

Agents have two communication primitives, injected automatically:

| Tool | Pattern | Use |
|---|---|---|
| `message_send` | Fire-and-forget | Notifications, delegation without waiting |
| `agent_ask` | Blocking RPC | Fan-out queries, request-reply between agents |

```typescript
// Inside an agent's activation, via tool calls:

// Fire-and-forget — send a task, don't wait
message_send({ to: 'reporter', body: 'Compile the final report.' })

// Blocking RPC — ask and wait for response (supports parallel tool calls)
agent_ask({ to: 'news-agent', body: 'Get latest news for AAPL' })
agent_ask({ to: 'market-data', body: 'Get 30-day price history for AAPL' })
// Both resolve → agent gets both results in one step
```

> [!WARNING]
> **Deadlock risk**: If Agent A `agent_ask`s Agent B while Agent B `agent_ask`s Agent A, both will wait forever. Avoid circular request chains. Default timeout: 120 seconds.

## Daemons

Daemons (δαίμων, *spirit*) are middleware services that extend Keryx through **lifecycle hooks**. Unlike MCP servers (pull-only), daemons are **bidirectional** — they provide tools AND push messages into agent inboxes.

```typescript
const myDaemon: DaemonDefinition = {
  id: 'my-daemon',
  order: 10,

  // Background process lifecycle
  onStart: (kx) => { /* start polling, connect websocket, etc. */ },
  onStop: () => { /* cleanup */ },

  // Per-activation hooks
  onPreActivation: (ctx) => {
    ctx.addTools([queryTool])
    ctx.addPromptSegment('You have access to the knowledge graph.')
  },
  onToolCall: (ctx) => myService.execute(ctx.toolId, ctx.args),
  onPostActivation: (ctx) => { /* cleanup, metrics */ },
}
```

### Lifecycle Hooks

| Hook | When | Use |
|---|---|---|
| `onStart(kx)` | `kx.start()` is called | Start background processes |
| `onStop()` | `kx.stop()` is called | Cleanup background processes |
| `onMessageReceived` | Message enters inbox | Logging, filtering |
| `onPreActivation` | Before Nous starts | Tool provisioning, prompt injection |
| `onToolCall` | Agent calls a daemon tool | Execute tool logic |
| `onPostActivation` | After activation ends | Cleanup, metrics |

### Scoped Configuration

Agents declare per-daemon capabilities via `config`:

```typescript
{
  id: 'researcher',
  config: {
    'context': { persist: true },         // contextd: enable memory
    'thesauros': { mode: 'read-write' },  // gets CRUD tools
    'telegram':  { chatId: 12345 },       // gets send_telegram tool
  },
}
```

No config key = no tools injected. This minimizes context window usage.

### Built-in Daemons

| Daemon | Purpose | Provides Tools | Pushes Messages |
|---|---|---|---|
| **loggerd** | Terminal logging for development observability | ✗ | ✗ |
| **contextd** | Persist and restore Nous context between activations | ✗ | ✗ |
| **crond** | Scheduled message delivery on intervals | ✗ | ✓ |
| **keryxd** | Agent management — status, inbox reads, abort, flush | ✓ | ✗ |

### keryxd — Agent Management

The `keryxd` daemon gives agents visibility into the system. Useful for assistant agents that need to monitor background work.

```typescript
{
  id: 'assistant',
  config: {
    'keryxd': {
      read: ['*'],                    // can inspect any agent
      write: ['analyst', 'news-*'],   // can flush/abort these agents
    },
  },
}
```

Tools provisioned based on permissions:

| Tool | Permission | Description |
|---|---|---|
| `agent_list` | always | List all agents with busy/idle status |
| `agent_status` | `read` | Detailed status with active tool calls |
| `inbox_read` | `read` | Peek at pending messages |
| `inbox_flush` | `write` | Clear pending messages |
| `agent_abort` | `write` | Force-abort running agent |

## Requirements

- Node.js 22+ or Bun 1.0+
- `@elfenlabs/nous` (peer dependency)

## License

MIT © [Elfenlabs](https://github.com/elfenlabs)
