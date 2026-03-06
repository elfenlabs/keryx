# Product Requirements Document (PRD): Keryx — Agent Orchestrator

## 1. Product Vision & Executive Summary

**Keryx** (Greek: κῆρυξ, *herald*) is a process manager and message bus for autonomous AI agents. Each agent is a [Nous](file:///home/yonder/projects/nous) instance — a system prompt, a tool set, and a provider config. Keryx gives agents the ability to **communicate** and **interrupt** each other through a shared message queue backed by PostgreSQL.

It is the missing middle layer between Nous (the agent runner) and Drakonyx (the product):

```
┌─────────────────────────────────────┐
│         DRAKONYX (product)          │
├──────────────────┬──────────────────┤
│   THESAUROS      │     KERYX        │
│  (optional/      │  (this project)  │
│   pluggable)     │                  │
├──────────────────┴──────────────────┤
│             NOUS (SDK)              │
└─────────────────────────────────────┘
```

Keryx is **not** an application framework — it's pure plumbing. It manages agent lifecycles, routes messages between inboxes, and injects the messaging tools that let agents talk to each other. Agents remain "dumb" Nous loops that don't know they're being orchestrated.

### 1.1. Keryx vs Nous: Scope Boundaries

Nous already supports synchronous multi-agent workflows through tool calls — a parent agent can invoke a sub-agent as a tool, passing context in and collapsing the result back. This works well for sequential, request-response chains within a single execution.

Keryx exists for everything Nous can't do alone:

| Concern | Owner |
|---|---|
| Synchronous sub-agent calls | **Nous** (tool call = sub-agent) |
| Asynchronous agent-to-agent messaging | **Keryx** |
| Parallel agent execution | **Keryx** |
| Scheduled/cron-triggered agents | **User-space** (`kx.send()` on a timer) |
| External system → agent communication | **Keryx** |
| Agent lifecycle management | **Keryx** |

## 2. Core Concepts

### 2.1. The Actor Model

Every agent is an **actor** with a **mailbox** (inbox). Message arrival is the *only* activation trigger. No messages = no computation.

```
                    ┌─────────┐
  External ──msg──▶ │  INBOX  │ ──dequeue──▶ [Nous Loop] ──msg──▶ Other Inbox
  Agent B ─msg───▶  │ (queue) │              (processing)
  Webhook ─msg───▶  │ sorted  │
                    │ by prio │
                    └─────────┘
```

### 2.2. Agent Definition

An agent is a static configuration registered with Keryx:

```typescript
type AgentDefinition = {
  id: string                       // unique identifier, e.g. "summarizer"
  name: string                     // human-readable name
  instruction: string              // system prompt (Nous's `instruction`)
  provider: ProviderConfig         // LLM backend config
  tools?: Tool[]                   // user-injected tools (Nous Tool instances)
  persistContext?: boolean         // default: false (stateless)

  // Keryx injects these automatically:
  //   - send_message tool
  //   - Agent registry awareness (via system prompt addendum)
}
```

### 2.3. Messages

Everything is a message. Agent-to-agent communication, external events, and "stop" commands are all messages routed to agent inboxes.

```typescript
type Message = {
  id: string                       // unique message ID
  to: string                       // target agent ID (or external channel ID)
  from: string | null              // sender agent ID (null = system/external)
  body: string                     // message content (natural language)
  priority: number                 // 0 = normal, higher = more urgent
  force: boolean                   // if true, abort current Nous loop
  replyTo: string | null           // where to send replies (agent ID or channel ID)
  metadata?: Record<string, any>   // arbitrary key-value pairs
  createdAt: Date                  // timestamp
}
```

### 2.4. Priority & Interruption

Messages are dequeued in **priority order** (highest first, FIFO within same priority).

- **Normal messages** (`force: false`): Queued. Processed when the agent is idle.
- **Force messages** (`force: true`): Immediately **abort** the current Nous loop via `AbortSignal`, discard its progress, and process the force message instead.

> Force messages are "fire alarms" — the user noticed the agent is doing something dangerous, or a critical system event requires immediate attention. The interrupted work is **discarded**, not re-queued.

## 3. System Architecture

### 3.1. Components

```
┌──────────────────────────────────────────────────────────────┐
│                          KERYX                               │
│                                                              │
│  ┌──────────────┐                                          │
│  │   REGISTRY   │                                          │
│  │              │                                          │
│  │  agent defs  │                                          │
│  │  (static)    │                                          │
│  └──────┬───────┘                                          │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              MESSAGE BUS (PostgreSQL)                 │    │
│  │                                                      │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │    │
│  │  │ inbox:A  │  │ inbox:B  │  │ inbox:C  │           │    │
│  │  │ (queue)  │  │ (queue)  │  │ (queue)  │           │    │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘           │    │
│  └───────┼──────────────┼──────────────┼────────────────┘    │
│          │              │              │                     │
│  ┌───────▼──────────────▼──────────────▼────────────────┐    │
│  │              PROCESS MANAGER                          │    │
│  │                                                      │    │
│  │  - Spawns Nous instances on demand                     │    │
│  │  - Injects messaging tools                            │    │
│  │  - Merges user-injected tools into agent tool set     │    │
│  │  - Manages AbortControllers per agent                 │    │
│  │  - Optionally persists/restores context per agent     │    │
│  │  - Serial: one Nous instance per agent at a time       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2. Agent Lifecycle (Spawn-on-Demand)

Agents do **not** run continuously. They are spawned when messages arrive and exit when the inbox is drained. Agents are **never blocked** — they process one message, respond, and exit.

```
1. Message arrives in inbox
2. Process Manager checks: is agent already running?
   ├─ YES + force=true  → abort current loop, discard, process force message
   ├─ YES + force=false → message sits in queue (processed after current work)
   └─ NO → spawn new Nous instance:
       a. Load agent definition from Registry
       b. If persistContext: restore serialized context; else: fresh context
       c. Inject tools (send_message, agent-specific tools)
       d. Inject system prompt addendum (identity, registry, current message metadata)
       e. Push inbox message as user message into context
       f. Run Nous loop: await runAgent({ ctx, provider, instruction, tools, signal })
       g. Log text output via hooks (not routed)
       h. If persistContext: serialize and store context
       i. Check inbox for more messages → repeat from (e) or exit
```

### 3.3. Context Persistence (Per-Agent)

Context persistence is **configurable per agent** via the `persistContext` flag.

- **`persistContext: false` (default):** Each activation starts with a fresh Nous context. The agent only sees the current message. Ideal for stateless workers (file processors, fetchers, converters).

- **`persistContext: true`:** Context is serialized after each activation and restored on the next. The agent accumulates conversation history across activations. Nous's eviction strategy keeps it bounded. Ideal for coordinators and user-facing agents that need situational awareness.

> [!NOTE]
> Context persistence is private to a single agent. For shared state across agents, inject your own coordination tools (ledgers, shared databases, etc.).

### 3.4. Text Output (Monologue)

When the Nous loop exits, it produces a text response (`AgentResult.response`). In Keryx, this text output is **not routed** anywhere — it is purely a monologue.

All inter-agent communication goes through the `send_message` tool explicitly. Text output is emitted via hooks for observability purposes only.

### 3.5. Injected Tools

Keryx injects the following tools into every agent's tool set:

#### `send_message`

```typescript
createTool({
  id: 'send_message',
  description: 'Send a message to another agent or reply to the sender.',
  schema: {
    to:       { type: 'string', description: 'Target agent ID (use the replyTo value from the current message to reply)' },
    body:     { type: 'string', description: 'Message content' },
    priority: { type: 'number', description: 'Priority (0=normal, higher=urgent)', required: false },
  },
  execute: async (args) => {
    // Keryx enqueues message to target's inbox
  },
})
```


> [!NOTE]
> There is no separate `reply` tool. To reply to the sender, the agent uses `send_message` with `to` set to the `replyTo` value shown in the system prompt addendum. This keeps the communication model to a single, explicit primitive.

### 3.6. System Prompt Addendum

Keryx prepends an addendum to each agent's `instruction` with:

- The agent's own identity (`You are agent "summarizer"`)
- The agent registry (available agents and their descriptions)
- Messaging conventions (how to use `send_message`, how to reply)
- The current message being processed (sender, replyTo, priority, metadata)

Example addendum:

```
You are agent "manager". You communicate with other agents using the send_message tool.

Available agents:
- video_editor: Extracts and converts audio/video formats
- image_manager: Organizes, filters, and selects images
- pdf_processor: Splits and converts PDF documents

Current message:
- From: video_editor
- Reply-to: ext-abc123
- Priority: 0
- Body: (provided as user message)

To reply to the original requester, use send_message with to="ext-abc123".
```

## 4. Memory Model

Keryx provides a single built-in layer of memory. Additional layers are user-injected.

| Layer | Scope | Persistence | Mutability | Owner |
|---|---|---|---|---|
| **Nous context** | Private to one agent | Per-agent (`persistContext`) | Mutable (eviction) | Single agent |
| **User-injected** | Depends on tool | Depends on tool | Depends on tool | User's choice |

## 5. External Channels

External channels bridge between the outside world and the agent messaging system. They allow programmatic callers to send messages to agents and optionally receive replies.

### 5.1. Fire-and-Forget

```typescript
await kx.send({ to: 'greeter', body: 'Good morning!' })
```

Enqueues a message to the agent's inbox with no expectation of a response.

### 5.2. Request-Reply

```typescript
const response = await kx.request({ to: 'summarizer', body: 'Summarize this article: ...' })
// response = "Here is the summary: ..."
```

Internally:
1. Creates an ephemeral external channel `ext-<uuid>` (an in-memory `Map<channelId, PromiseResolver>`)
2. Sends the message with `replyTo: 'ext-<uuid>'`
3. The agent sees `replyTo: ext-<uuid>` in its system prompt and calls `send_message(to: 'ext-<uuid>', ...)`
4. Keryx intercepts messages to `ext-*` — instead of queuing, it resolves the waiting Promise
5. Cleans up the channel entry from the map

The agent doesn't know it's talking to an external system. It just sees a `replyTo` address.

**Timeouts** are the caller's responsibility, using the standard `AbortSignal` API:

```typescript
const response = await kx.request({
  to: 'summarizer',
  body: 'Summarize this article: ...',
  signal: AbortSignal.timeout(30_000)  // give up after 30s
})
```

When aborted, the Promise rejects and the ephemeral channel is cleaned up. If the agent eventually replies to a cleaned-up channel, the reply is silently dropped.

> [!NOTE]
> Channels are one-shot: the first reply resolves the Promise. Streaming intermediate updates through external channels is out of scope for v1.

### 5.3. Force Messages

```typescript
await kx.send({ to: 'greeter', body: 'STOP', force: true })
```

Interrupts the agent's current Nous loop and processes the force message immediately.

## 6. Observability (Hooks)

Keryx does **not** store activation logs, traces, or token usage internally. Instead, it exposes hooks that let consumers build their own observability layer.

### 6.1. Hook Interface

```typescript
type KeryxHooks = {
  onThinking?:   (agentId: string, activationId: string, chunk: string) => void
  onOutput?:     (agentId: string, activationId: string, chunk: string) => void
  onToolCall?:   (agentId: string, activationId: string, tool: string, args: Record<string, unknown>) => void
  onToolResult?: (agentId: string, activationId: string, tool: string, args: Record<string, unknown>, result: unknown) => void
  onComplete?:   (agentId: string, activationId: string, response: string, usage: Usage) => void
  onError?:      (agentId: string, activationId: string, error: Error) => void
  onAbort?:      (agentId: string, activationId: string) => void
}
```

Every hook receives `agentId` and `activationId` (the ID of the triggering message) for correlation.

### 6.2. Default Terminal Logger

Keryx ships a built-in terminal logger for quick development feedback:

```typescript
import { createKeryx, terminalLogger } from '@elfenlabs/keryx'

const kx = await createKeryx({
  // ...
  hooks: terminalLogger()
})
```

Output:

```
[summarizer] ← "Summarize this article..." (from: ext-abc123)
[summarizer] 🔧 send_message({ to: "fetcher", body: "..." }) → "sent"
[summarizer] → "Here is the summary: ..."  (steps: 2, tokens: 3920)
```

## 7. Database Schema

All Keryx state lives in PostgreSQL. Three tables.

```sql
-- Agent registry (could also be file-based config loaded at startup)
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  instruction     TEXT NOT NULL,
  provider_config JSONB NOT NULL,
  persist_context BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Message queue (inbox per agent)
-- Status derived from nullable timestamps:
--   All null = PENDING | claimed_at = PROCESSING | completed_at = DONE
--   failed_at = FAILED | discarded_at = DISCARDED (aborted by force message)
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_agent        TEXT NOT NULL REFERENCES agents(id),
  from_agent      TEXT,
  body            TEXT NOT NULL,
  priority        INT NOT NULL DEFAULT 0,
  force           BOOLEAN NOT NULL DEFAULT FALSE,
  reply_to        TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ,          -- picked up for processing
  completed_at    TIMESTAMPTZ,          -- successfully processed
  failed_at       TIMESTAMPTZ,          -- runAgent() threw
  discarded_at    TIMESTAMPTZ           -- aborted by force message
);

CREATE INDEX idx_messages_inbox ON messages(
  to_agent, priority DESC, created_at ASC
) WHERE claimed_at IS NULL AND failed_at IS NULL AND discarded_at IS NULL;

-- Persisted context (only for agents with persist_context = true)
CREATE TABLE agent_contexts (
  agent_id        TEXT PRIMARY KEY REFERENCES agents(id),
  context_data    JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## 8. Programmatic API

Keryx exposes a TypeScript API for embedding in other applications:

```typescript
import { createKeryx, terminalLogger } from '@elfenlabs/keryx'

const kx = await createKeryx({
  db: 'postgres://localhost:5432/orchestrator',
  agents: [
    {
      id: 'manager',
      name: 'Manager',
      instruction: 'You coordinate tasks and communicate with the user.',
      provider: { url: 'http://localhost:11434', model: 'qwen3:8b' },
      persistContext: true,
    },
    {
      id: 'pdf_processor',
      name: 'PDF Processor',
      instruction: 'You split PDFs into readable markdown chapters.',
      provider: { url: 'https://api.openai.com', model: 'gpt-4o', apiKey: '...' },
      // persistContext defaults to false (stateless worker)
    },
  ],
  hooks: terminalLogger(),
})

// Fire-and-forget
await kx.send({ to: 'manager', body: 'Process this PDF...' })

// Request-reply (via external channel)
const summary = await kx.request({ to: 'manager', body: 'What tasks are running?' })

// Force interrupt
await kx.send({ to: 'manager', body: 'STOP', force: true })

// Start Keryx (begins polling inboxes)
await kx.start()

// Graceful shutdown
await kx.stop()
```

### 8.1. Tool Injection

Keryx is **tool-agnostic**. Users inject any Nous `Tool` instances they want — Keryx doesn't know or care what they do. This is how external integrations like Thesauros, file systems, APIs, etc. are wired in:

```typescript
import { createTool } from '@elfenlabs/nous'

// User creates their own tools
const databankQuery = createTool({
  id: 'databank_query',
  description: 'Query the knowledge base.',
  schema: {
    query: { type: 'string', description: 'GraphQL query' },
  },
  execute: async (args) => {
    return await fetch('http://localhost:4000/graphql', { ... })
  },
})

const readFile = createTool({
  id: 'read_file',
  description: 'Read a file from disk.',
  schema: { path: { type: 'string' } },
  execute: async (args) => fs.readFile(args.path, 'utf-8'),
})

// Inject into agents at registration
const kx = await createKeryx({
  agents: [
    {
      id: 'swe',
      instruction: 'You implement code.',
      provider: { ... },
      tools: [readFile, databankQuery],  // ← user's choice
    },
  ],
})
```

Keryx merges the user-provided tools with its own injected tool (`send_message`). The agent sees all of them as a flat tool set.

## 9. Process Manager

The Process Manager is the runtime core of Keryx. It polls agent inboxes, spawns Nous instances, and manages agent lifecycles.

### 9.1. Architecture

Keryx treats Nous as a **pure reducer**: `agent = reducer(context, instruction, tools) → result`. The Process Manager's job is to invoke this reducer with the right inputs and handle the outputs.

```
Process Manager
├── Inbox Poller        — watches for PENDING messages (polling interval)
├── Agent Locks         — Map<agentId, Promise> ensures serial-per-agent
├── Abort Controllers   — Map<agentId, AbortController> for force interrupts
└── Nous Runner          — prepares context + tools, calls runAgent()
```

### 9.2. Processing Loop

```
1. POLL:    Query all inboxes for unclaimed messages
2. CHECK:   For each message, is the target agent already running?
            ├─ YES + force=true  → abort current loop, discard, process force message
            ├─ YES + force=false → skip (will be picked up after current work)
            └─ NO  → claim message (SET claimed_at = NOW())
3. PREPARE: Load agent definition from registry
            If persistContext: restore context from agent_contexts
            Else: create fresh context
            Build tool set: agent tools + send_message
            Create AbortController, store in map
4. RUN:     Push message body into context as user message
            Call runAgent({ ctx, provider, instruction, tools, signal })
5. FINISH:  On success:
              - SET completed_at = NOW()
              - If persistContext: serialize and save context
              - Emit onComplete hook
            On abort (AgentAbortError):
              - SET discarded_at = NOW()
              - Emit onAbort hook
            On error (any other throw):
              - SET failed_at = NOW()
              - Emit onError hook
              - Log and skip (no retry)
6. CLEANUP: Remove AbortController from map
            Remove agent lock
            Check inbox for next message → repeat from step 3, or exit
```

### 9.3. Serial-Per-Agent Execution

Each agent processes messages **one at a time**. Multiple agents can run concurrently (Node.js async), but a single agent never has two overlapping Nous loops.

This is enforced via an in-memory lock map:

```typescript
const activeLocks = new Map<string, Promise<void>>()

async function processInbox(agentId: string) {
  if (activeLocks.has(agentId)) return  // already running
  
  const lock = (async () => {
    while (true) {
      const msg = await claimNext(agentId)  // SET claimed_at = NOW()
      if (!msg) break  // inbox empty
      await runActivation(agentId, msg)
    }
  })()
  
  activeLocks.set(agentId, lock)
  await lock
  activeLocks.delete(agentId)
}
```

### 9.4. Force Message Handling

When a force message arrives for an agent that is currently running:

1. Look up the agent's `AbortController` in the map
2. Call `controller.abort()` — this causes `runAgent()` to throw `AgentAbortError`
3. The processing loop catches the abort, marks the interrupted message with `discarded_at`
4. The force message is next in the priority queue (force messages get highest dequeue priority)
5. Processing continues with the force message

### 9.5. Error Handling Policy

**Log and skip.** When `runAgent()` throws (provider error, `MaxStepsError`, `ContextBudgetError`, etc.):

1. Mark the message with `failed_at = NOW()`
2. Emit the `onError` hook with the error details
3. Move on to the next message in the inbox

No retries, no dead-letter queue. The hooks provide full visibility — consumers can build retry logic externally if needed.

> [!NOTE]
> Tool-level errors (e.g., `send_message` fails) are handled **inside** Nous — the error is returned as a tool result and the LLM can self-correct. Only unrecoverable errors that crash the entire `runAgent()` call reach the Process Manager.

## 10. Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript (Node.js) |
| Agent runtime | Nous SDK (`@elfenlabs/nous`) |
| Package | `@elfenlabs/keryx` |
| Database | PostgreSQL |
| Process model | Single Node.js process, serial per-agent |

## 11. Out of Scope (v1)

- **Multi-node / distributed orchestration** — single process for now
- **HTTP API** — programmatic API only
- **Agent hot-reload** — restart to pick up config changes
- **Parallel per-agent execution** — serial inbox processing per agent
- **Built-in activation logging** — use hooks for custom observability
- **Message routing rules** — direct addressing only (no pub/sub, no topics)
- **Built-in coordination tools** (ledgers, shared databases) — inject your own
- **Web UI / dashboard**
- **Authentication / multi-tenancy**