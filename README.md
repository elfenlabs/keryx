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

## Agents Talk via Tools

Keryx automatically injects **one tool** into every agent:

- **`send_message`** — send a message to another agent's inbox

That's it. All coordination, shared state, and external integrations are user-injected tools.

## Tool Injection

Keryx is tool-agnostic. Inject your own tools per agent:

```typescript
import { createTool } from '@elfenlabs/nous'

const readFile = createTool({
  id: 'read_file',
  description: 'Read a file from disk.',
  schema: { path: { type: 'string' } },
  execute: async (args) => fs.readFile(args.path, 'utf-8'),
})

const kx = await createKeryx({
  agents: [
    {
      id: 'swe',
      instruction: 'You implement code changes.',
      provider: { ... },
      tools: [readFile],  // ← your tools, Keryx doesn't care what they do
    },
  ],
})
```

## Requirements

- Node.js 22+
- PostgreSQL 15+

## License

MIT © [Elfenlabs](https://github.com/elfenlabs)
