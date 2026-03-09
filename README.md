# Keryx

**κῆρυξ** — *herald, messenger*

Agent orchestrator — process manager and message bus for autonomous AI agents built on [Nous](https://github.com/elfenlabs/nous).

```
┌─────────────────────────────────────┐
│         DRAKONYX (product)          │
├──────────────────┬──────────────────┤
│   THESAUROS      │     KERYX        │
│  (knowledge)     │  (orchestration) │
├──────────────────┴──────────────────┤
│             NOUS (runtime)          │
└─────────────────────────────────────┘
```

## What is Keryx?

Keryx is the missing middle layer between **Nous** (the agent runtime) and your application. It manages agent lifecycles, routes messages between inboxes, and provides the primitives for agents to communicate.

Think of it as an **OS for agents**:

| OS Concept | Keryx Equivalent |
|---|---|
| Kernel | Process Manager |
| Process | Agent (Nous instance) |
| Scheduler | Inbox poller + per-agent locking |
| IPC | `send_message` tool |
| Signals | Force messages |
| Daemons | Middleware services that extend Keryx |

## Features

- **Message bus** — PostgreSQL-backed inbox per agent with priority queuing
- **Process manager** — spawn-on-demand, serial per-agent, concurrent across agents
- **Daemon middleware** — lifecycle hooks for tool provisioning, observability, and more
- **Context persistence** — configurable per-agent stateful/stateless execution
- **Force interrupts** — abort running agents via `AbortSignal`
- **Tool agnostic** — static tools + daemon-provisioned tools per agent

## Quick Start

```typescript
import { createKeryx, loggerd } from '@elfenlabs/keryx'

const kx = await createKeryx({
  db: 'postgres://localhost:5432/keryx',
  daemons: [loggerd()],
  agents: [
    {
      id: 'greeter',
      name: 'Greeter',
      instruction: 'You are a friendly greeter. Reply to every message warmly.',
      provider: { model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY },
    },
    {
      id: 'manager',
      name: 'Manager',
      instruction: 'You coordinate the team. Delegate tasks to other agents.',
      provider: { model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY },
      config: {
        'context': { persist: true },
        'thesauros': { mode: 'read-write' },
      },
    },
  ],
})

// Fire-and-forget
await kx.send({ to: 'greeter', body: 'Hello!' })

// Request-reply
const response = await kx.request({ to: 'manager', body: 'Status report?' })

// Start processing
await kx.start()
```

## Daemons

Daemons (δαίμων, *spirit*) are middleware services that extend Keryx through **lifecycle hooks**. Unlike MCP servers (pull-only), daemons are **bidirectional** — they provide tools AND push messages into agent inboxes.

```typescript
const thesaurosDaemon: DaemonDefinition = {
  id: 'thesauros',
  order: 10,

  onPreActivation: (ctx) => {
    const config = ctx.agentConfig['thesauros']
    if (!config) return  // no config → inject nothing

    ctx.addTools([queryTool, addEntityTool])
    ctx.addPromptSegment('You have access to the Thesauros knowledge graph.')
  },

  onToolCall: (ctx) => {
    return thesaurosClient.execute(ctx.toolId, ctx.args)
  },
}
```

### Lifecycle Hooks

| Hook | When | Use |
|---|---|---|
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
    'thesauros': { mode: 'read-write' },  // gets CRUD tools
    'telegram':  { chatId: 12345 },        // gets send_telegram tool
  },
}
```

No config key = no tools injected. This minimizes context window usage.

### Common Daemons

| Daemon | Provides Tools | Pushes Messages |
|---|---|---|
| **loggerd** | ✗ | ✗ |
| **crond** | ✗ | ✓ |
| **thesauros** | ✓ | ✗ |
| **telegramd** | ✓ | ✓ |

## Requirements

- Node.js 22+
- PostgreSQL 15+

## License

MIT © [Elfenlabs](https://github.com/elfenlabs)
