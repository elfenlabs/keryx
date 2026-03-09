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
| Agent lifecycle management | **Keryx** |
| Scheduled/cron-triggered agents | **Keryx Daemons** (e.g. `crond`) |
| External system → agent communication | **Keryx Daemons** (e.g. `webhookd`, `telegramd`) |

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
  tools?: Tool[]                   // static user-injected tools (Nous Tool instances)
  config?: Record<string, unknown> // per-daemon scoped config, keyed by daemon ID

  // Keryx injects these automatically:
  //   - send_message tool
  //   - Agent registry awareness (via system prompt addendum)
  //   - Daemon-provisioned tools (via onPreActivation hooks)
}
```

### 2.3. Messages

Everything is a message. Agent-to-agent communication, external events, and "stop" commands are all messages routed to agent inboxes.

```typescript
type Message = {
  id: string                       // unique message ID
  to: string                       // target agent ID (or reply channel ID for kx.request)
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
│  │  - Runs daemon onPreActivation hooks (tool provisioning)│    │
│  │  - Merges static + daemon-injected + internal tools     │    │
│  │  - Routes tool calls to owning daemon or direct execute │    │
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
       b. Create fresh Nous context
       c. Run onPreActivation hooks (daemons inject tools + prompt segments, restore context)
       d. Merge: send_message + static agent tools + daemon-provisioned tools
       e. Inject system prompt addendum (identity, registry, daemon segments, current message)
       f. Push inbox message as user message into context
       g. Run Nous loop: await runAgent({ ctx, provider, instruction, tools, signal })
       h. Run onPostActivation hooks (persist context, cleanup)
       j. Check inbox for more messages → repeat from (c) or exit
```

### 3.3. Context Persistence (Daemon)

By default, each activation starts with a **fresh Nous context**. The agent only sees the current message.

For agents that need memory across activations, use the `contextd` daemon (§5.7). The daemon restores context during `onPreActivation` and persists it during `onPostActivation`.

```typescript
{
  id: 'manager',
  config: {
    'context': { persist: true },   // opt-in via daemon config
  },
}
```

Since context persistence is a daemon, the pipeline composes naturally — other daemons can intercept and transform the context before persistence (e.g., redacting sensitive data, stripping thinking tokens).

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
| **Nous context** | Private to one agent | Per-agent (via `contextd` daemon) | Mutable (eviction) | Single agent |
| **User-injected** | Depends on tool | Depends on tool | Depends on tool | User's choice |

## 5. Daemons

Daemons (Greek: δαίμων, *spirit*) are modular middleware services registered with Keryx that extend its functionality without bloating the core engine.

Daemons interact with Keryx through **lifecycle hooks** — they observe and modify the execution flow at well-defined points. A daemon can provide tools, inject system prompt segments, push messages into inboxes, or handle observability.

### 5.1. Daemon Definition

```typescript
type DaemonDefinition = {
  id: string                       // unique daemon identifier, e.g. "thesauros"
  order: number                    // execution order in the middleware chain (ascending)

  // Lifecycle hooks (all optional)
  onMessageReceived?: (ctx: MessageContext) => void | Promise<void>
  onPreActivation?:  (ctx: ActivationContext) => void | Promise<void>
  onToolCall?:       (ctx: ToolCallContext) => unknown | Promise<unknown>
  onPostActivation?: (ctx: PostActivationContext) => void | Promise<void>
}
```

### 5.2. Lifecycle Hooks

Daemons subscribe to lifecycle hooks that fire in `order` (ascending). All daemons receive the same hooks — they inspect their scoped config to decide whether to act.

| Hook | When | Typical Use |
|---|---|---|
| **`onMessageReceived`** | A message enters an inbox | Logging, persistence, filtering |
| **`onPreActivation`** | Before Nous starts | Tool provisioning, system prompt injection |
| **`onToolCall`** | Agent invokes a daemon-owned tool | Execute tool logic, return result to Nous |
| **`onPostActivation`** | After activation finishes | Cleanup, metrics, error handling |

#### `onPreActivation` (Tool Provisioning)

This is the most important hook. During pre-activation, daemons inspect their scoped config for the agent and dynamically provision tools and prompt segments:

```typescript
const thesaurosDaemon: DaemonDefinition = {
  id: 'thesauros',
  order: 10,

  onPreActivation: (ctx) => {
    const config = ctx.agentConfig['thesauros']
    if (!config) return

    if (config.mode === 'read-write') {
      ctx.addTools([queryTool, addEntityTool, addRelationTool])
    } else if (config.mode === 'read-only') {
      ctx.addTools([queryTool])
    }

    ctx.addPromptSegment('You have access to the Thesauros knowledge graph.')
  },

  onToolCall: (ctx) => {
    return thesaurosClient.execute(ctx.toolId, ctx.args)
  },
}
```

#### Reducer-Style Activation

The tool set and system prompt are **rebuilt from scratch on every activation**. No caching:

```
activation(agent, message) = daemons.reduce((ctx, daemon) => {
  daemon.onPreActivation(ctx)
  return ctx
}, initialContext(agent, message))
```

This makes the system stateless and predictable. If a daemon changes its behavior at runtime, the very next activation picks it up automatically.

### 5.3. Scoped Configuration

Each agent has per-daemon configuration, namespaced by daemon ID:

```typescript
{
  id: 'researcher',
  instruction: 'You research topics and store findings.',
  provider: { /* ... */ },
  config: {
    'thesauros': { mode: 'read-write' },
    'telegram':  { chatId: 12345 },
  },
}
```

- If an agent's config **does not include** a daemon's key, the daemon **injects nothing** — minimizing context window usage and preventing unauthorized tool calls.
- Each daemon defines its own config schema. Keryx just passes the config through.

### 5.4. Tool Routing

When Nous invokes a tool, Keryx routes the call to the correct daemon:

1. During `onPreActivation`, each daemon registers tool IDs via `ctx.addTools([...])`.
2. Keryx maintains a **tool-to-daemon mapping** for the current activation.
3. When Nous calls a tool:
   - If the tool belongs to a daemon → route to that daemon's `onToolCall` hook.
   - If the tool is Keryx-internal (`send_message`) → handle internally.
   - If the tool is a static user-injected tool (`AgentDefinition.tools`) → call its `execute` directly.

### 5.5. Daemon vs MCP Server

| | MCP Server | Keryx Daemon |
|---|---|---|
| **Direction** | Agent → Server (pull) | Agent ↔ Daemon (bidirectional) |
| **Agent calls service** | ✓ (tool calls) | ✓ (provisioned tools) |
| **Service calls agent** | ✗ | ✓ (`kx.send()`) |
| **Dynamic provisioning** | ✗ | ✓ (per-agent config) |
| **Lifecycle hooks** | ✗ | ✓ (middleware chain) |

### 5.6. Data Flow

```
1. TRIGGER:   A message hits an agent's inbox.
              → All daemons run onMessageReceived (in order).
2. SETUP:     Process Manager claims message, prepares activation.
              → All daemons run onPreActivation (in order).
              → Daemons inspect scoped config, inject tools and prompt segments.
3. EXECUTION: Nous runs. Tool calls are routed:
              → Daemon-owned tools → daemon's onToolCall
              → Keryx-internal tools → Keryx handles directly
              → Static user tools → direct execute
4. FINISH:    Nous completes (or errors).
              → All daemons run onPostActivation (in order).
              → Cleanup, metrics, error handling.
```

### 5.7. Common Daemons

Keryx ships common daemons in the package:

| Daemon | Description |
|---|---|
| **`loggerd`** | Terminal logger for development feedback |
| **`contextd`** | Persists and restores Nous context between activations |

```typescript
import { createKeryx, loggerd } from '@elfenlabs/keryx'

const kx = await createKeryx({
  daemons: [loggerd()],
  // ...
})
```

Output:
```
[summarizer] ← "Summarize this article..." (from: ext-abc123)
[summarizer] 🔧 send_message({ to: "fetcher", body: "..." }) → "sent"
[summarizer] → "Here is the summary: ..."  (steps: 2, tokens: 3920)
```

### 5.8. Runtime Registration

Daemons passed to `createKeryx({ daemons: [...] })` are registered at startup. Additional daemons can be registered or deregistered at runtime via the `kx.daemons` namespace:

```typescript
// Register at runtime — participates in the next activation
kx.daemons.register(telegramDaemon)

// Deregister — removed from the next activation
kx.daemons.deregister('telegram')

// List active daemons
kx.daemons.list()  // → [{ id: 'loggerd', order: 0 }, { id: 'thesauros', order: 10 }]
```

Since activation is reducer-style (rebuild from scratch every time), runtime changes take effect on the very next activation with zero coordination.

### 5.9. Examples

| Daemon | Provides Tools | Pushes Messages | Description |
|---|---|---|---|
| **loggerd** | ✗ | ✗ | Observability — logs activations, tool calls, errors |
| **crond** | ✗ | ✓ | Calls `kx.send()` on a timer/schedule |
| **thesauros** | ✓ | ✗ | Knowledge graph query + memory stream tools |
| **ledgerd** | ✓ | ✗ | Shared append-only log tools |
| **telegramd** | ✓ | ✓ | Chat tools + forwards incoming messages to inbox |
| **webhookd** | ✗ | ✓ | Listens for HTTP webhooks, pushes payloads as messages |


## 6. Database Schema

All Keryx state lives in PostgreSQL. Two tables.

```sql
-- Agent registry (could also be file-based config loaded at startup)
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  instruction     TEXT NOT NULL,
  provider_config JSONB NOT NULL,
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
```

## 7. Programmatic API

Keryx exposes a TypeScript API for embedding in other applications:

```typescript
import { createKeryx, loggerd } from '@elfenlabs/keryx'

const kx = await createKeryx({
  db: 'postgres://localhost:5432/orchestrator',
  daemons: [loggerd()],
  agents: [
    {
      id: 'manager',
      name: 'Manager',
      instruction: 'You coordinate tasks and communicate with the user.',
      provider: { url: 'http://localhost:11434', model: 'qwen3:8b' },
      config: {
        'context': { persist: true },
        'thesauros': { mode: 'read-write' },
      },
    },
    {
      id: 'pdf_processor',
      name: 'PDF Processor',
      instruction: 'You split PDFs into readable markdown chapters.',
      provider: { url: 'https://api.openai.com', model: 'gpt-4o', apiKey: '...' },
      // stateless worker — no context config needed
    },
  ],
})

// Fire-and-forget
await kx.send({ to: 'manager', body: 'Process this PDF...' })

// Request-reply
const summary = await kx.request({ to: 'manager', body: 'What tasks are running?' })

// Force interrupt
await kx.send({ to: 'manager', body: 'STOP', force: true })

// Runtime daemon registration
kx.daemons.register(telegramDaemon)
kx.daemons.list()  // → active daemons

// Start Keryx (begins polling inboxes)
await kx.start()

// Graceful shutdown
await kx.stop()
```

### 7.1. Request-Reply (`kx.request`)

`kx.request()` is a convenience for programmatic callers that want a synchronous response from an agent.

```typescript
const response = await kx.request({ to: 'summarizer', body: 'Summarize this article: ...' })
// response = "Here is the summary: ..."
```

Internally:
1. Creates an ephemeral reply channel `ext-<uuid>` (an in-memory `Map<channelId, PromiseResolver>`)
2. Sends the message with `replyTo: 'ext-<uuid>'`
3. The agent sees `replyTo: ext-<uuid>` in its system prompt and calls `send_message(to: 'ext-<uuid>', ...)`
4. Keryx intercepts messages to `ext-*` — instead of queuing, it resolves the waiting Promise
5. Cleans up the channel entry from the map

**Timeouts** are the caller's responsibility via `AbortSignal`:

```typescript
const response = await kx.request({
  to: 'summarizer',
  body: 'Summarize this article: ...',
  signal: AbortSignal.timeout(30_000)
})
```

When aborted, the Promise rejects and the channel is cleaned up. Stale replies are silently dropped.

> [!NOTE]
> For daemon-mediated interactions (Telegram, Discord, etc.), agents reply via **tool calls** to the daemon — not via `kx.request()`. The request-reply pattern is for programmatic callers embedding Keryx in their own code.

### 7.2. Tool Injection (Static)

Keryx is **tool-agnostic**. In addition to daemon-provisioned tools (§5), users can inject static Nous `Tool` instances directly:

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

Keryx merges static user tools, daemon-provisioned tools, and its own `send_message` tool into a flat tool set visible to the agent.

## 8. Process Manager

The Process Manager is the runtime core of Keryx. It polls agent inboxes, spawns Nous instances, and manages agent lifecycles.

### 8.1. Architecture

Keryx treats Nous as a **pure reducer**: `agent = reducer(context, instruction, tools) → result`. The Process Manager's job is to invoke this reducer with the right inputs and handle the outputs.

```
Process Manager
├── Inbox Poller        — watches for PENDING messages (polling interval)
├── Agent Locks         — Map<agentId, Promise> ensures serial-per-agent
├── Abort Controllers   — Map<agentId, AbortController> for force interrupts
└── Nous Runner          — prepares context + tools, calls runAgent()
```

### 8.2. Processing Loop

```
1. POLL:    Query all inboxes for unclaimed messages
            → Run onMessageReceived on all daemons (in order)
2. CHECK:   For each message, is the target agent already running?
            ├─ YES + force=true  → abort current loop, discard, process force message
            ├─ YES + force=false → skip (will be picked up after current work)
            └─ NO  → claim message (SET claimed_at = NOW())
3. PREPARE: Load agent definition from registry
            Create fresh context
            Run onPreActivation on all daemons (in order)
            (contextd restores saved context if configured)
            Build tool set: static agent tools + daemon tools + send_message
            Build tool-to-daemon routing map
            Create AbortController, store in map
4. RUN:     Push message body into context as user message
            Call runAgent({ ctx, provider, instruction, tools, signal })
            Tool calls routed via tool-to-daemon map
5. FINISH:  On success:
              - SET completed_at = NOW()
              - Run onPostActivation on all daemons
              (contextd saves context if configured)
            On abort (AgentAbortError):
              - SET discarded_at = NOW()
              - Run onPostActivation on all daemons
            On error (any other throw):
              - SET failed_at = NOW()
              - Run onPostActivation on all daemons
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

### 8.4. Force Message Handling

When a force message arrives for an agent that is currently running:

1. Look up the agent's `AbortController` in the map
2. Call `controller.abort()` — this causes `runAgent()` to throw `AgentAbortError`
3. The processing loop catches the abort, marks the interrupted message with `discarded_at`
4. The force message is next in the priority queue (force messages get highest dequeue priority)
5. Processing continues with the force message

### 8.5. Error Handling Policy

**Log and skip.** When `runAgent()` throws (provider error, `MaxStepsError`, `ContextBudgetError`, etc.):

1. Mark the message with `failed_at = NOW()`
2. Emit the `onError` hook with the error details
3. If the message has a `from` agent, enqueue a **failure notification** to the sender (see §9.6)
4. Move on to the next message in the inbox

No retries, no dead-letter queue. The hooks provide full visibility — consumers can build retry logic externally if needed.

> [!NOTE]
> Tool-level errors (e.g., `send_message` fails) are handled **inside** Nous — the error is returned as a tool result and the LLM can self-correct. Only unrecoverable errors that crash the entire `runAgent()` call reach the Process Manager.

### 8.6. Failure Notifications

When a message processing fails and the original message has a `from` agent, Keryx automatically enqueues a failure notification back to the sender:

```typescript
// Auto-enqueued by the Process Manager on failure
{
  to: originalMessage.from,        // back to the sender
  from: 'system',                  // not from the failed agent
  body: `Message to "${originalMessage.to}" failed: ${error.message}`,
  metadata: {
    type: 'delivery_failure',
    originalMessageId: originalMessage.id,
    targetAgent: originalMessage.to,
    error: error.constructor.name,
  },
}
```

This keeps failure handling within the actor model — the sender receives a message rather than needing to introspect the runtime. The sender agent can then reason about the failure and decide how to proceed (retry, skip, synthesize with partial data, etc.).

Messages from external sources (`from: null`) or system messages do not trigger failure notifications — only agent-to-agent messages do. Failure details are always available to daemons via the `onPostActivation` hook.

## 9. Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript (Node.js) |
| Agent runtime | Nous SDK (`@elfenlabs/nous`) |
| Package | `@elfenlabs/keryx` |
| Database | PostgreSQL |
| Process model | Single Node.js process, serial per-agent |

## 10. Out of Scope (v1)

- **Multi-node / distributed orchestration** — single process for now
- **HTTP API** — programmatic API only
- **Agent hot-reload** — restart to pick up config changes
- **Parallel per-agent execution** — serial inbox processing per agent
- **Built-in activation logging** — use `loggerd` daemon or custom daemons
- **Message routing rules** — direct addressing only (no pub/sub, no topics)
- **Built-in coordination tools** (ledgers, shared databases) — inject your own
- **Web UI / dashboard**
- **Authentication / multi-tenancy**