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
| Daemons | External services that extend Keryx |

## Features

- **Message bus** — PostgreSQL-backed inbox per agent with priority queuing
- **Process manager** — spawn-on-demand, serial per-agent, concurrent across agents
- **Context persistence** — configurable per-agent stateful/stateless execution
- **Force interrupts** — abort running agents via `AbortSignal`
- **External channels** — fire-and-forget and request-reply patterns
- **Hooks** — observability without opinions (bring your own logging)
- **Tool agnostic** — inject any Nous `Tool` instances you want

## Quick Start

```typescript
import { createKeryx } from '@elfenlabs/keryx'

const kx = await createKeryx({
  db: 'postgres://localhost:5432/keryx',
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
      persistContext: true,
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

Daemons (δαίμων, *spirit*) are external services that extend Keryx. Unlike MCP servers which are pull-only, daemons are **bidirectional** — they can provide tools to agents AND push messages into agent inboxes.

```typescript
import cron from 'node-cron'

// crond — pushes messages on a schedule
cron.schedule('0 9 * * *', () => {
  kx.send({ to: 'manager', body: 'Good morning! Generate the daily digest.' })
})

// telegramd — pushes incoming messages AND provides a reply tool
telegramBot.on('message', (msg) => {
  kx.send({ to: 'manager', body: msg.text, metadata: { chatId: msg.chat.id } })
})
```

| Daemon | Provides Tools | Pushes Messages |
|---|---|---|
| **crond** | ✗ | ✓ |
| **thesauros** | ✓ | ✗ |
| **telegramd** | ✓ | ✓ |

Keryx is tool-agnostic. Inject any Nous `Tool` into any agent — Keryx doesn't care what the tools do.

## Requirements

- Node.js 22+
- PostgreSQL 15+

## License

MIT © [Elfenlabs](https://github.com/elfenlabs)
