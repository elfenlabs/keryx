# streamd — Streaming Event Bus Daemon

> Internal event bus for real-time agent output, thinking, and tool call streaming.

## Overview

`streamd` is a Keryx daemon that provides a subscribe/unsubscribe API for consuming real-time streaming events from all agents. It acts as an internal event bus — it does **not** expose HTTP or WebSocket endpoints itself. User-space code subscribes to the event stream and decides how to deliver events (WebSocket, SSE, CLI dashboard, etc.).

### Why

Without `streamd`, observability is limited to batch events — you see when an agent starts and finishes, but nothing in between. `streamd` fills that gap:

1. **Token-level output** — see agent responses as they stream, not after completion
2. **Thinking visibility** — observe model reasoning (chain-of-thought) in real time
3. **Tool call streaming** — watch tool calls being constructed, including argument fragments
4. **Multi-agent dashboards** — each agent's stream is tagged with `agentId`, enabling per-agent windows

### Design Principles

1. **Internal event bus** — no network layer, no server. User-space integrations decide the transport.
2. **Synchronous broadcast** — streaming hooks never block the token flow. Daemons that need async work should buffer internally.
3. **Factory pattern** — `streamd()` returns both the daemon and a `subscribe()` handle, keeping the API ergonomic.
4. **Zero-config** — no options needed. Register the daemon and subscribe.

---

## Configuration

```ts
import { createKeryx, streamd } from '@elfenlabs/keryx'

const stream = streamd()

const kx = createKeryx({
  daemons: [stream.daemon],
  agents: [
    { id: 'writer', name: 'Writer', instruction: 'You write articles.' },
    { id: 'analyst', name: 'Analyst', instruction: 'You analyze data.' },
  ],
  defaultProvider: myProvider,
})

// Subscribe to all stream events
const unsub = stream.subscribe((event) => {
  console.log(`[${event.agentId}] ${event.type}:${event.phase}`, event.chunk ?? '')
})

kx.start()

// Later: stop receiving events
unsub()
```

---

## Stream Events

All events share the `StreamEvent` type:

```ts
type StreamEvent = {
  agentId: string
  type: 'thinking' | 'output' | 'tool_call'
  phase: 'start' | 'chunk' | 'end'
  chunk?: string
  toolIndex?: number
  toolCallId?: string
  toolName?: string
  timestamp: Date
}
```

### Event Types

| `type` | `phase` | Description | Extra fields |
|--------|---------|-------------|--------------|
| `thinking` | `start` | Model began reasoning | — |
| `thinking` | `chunk` | Reasoning fragment | `chunk` |
| `thinking` | `end` | Reasoning complete | — |
| `output` | `start` | Model began text response | — |
| `output` | `chunk` | Response text fragment | `chunk` |
| `output` | `end` | Response complete | — |
| `tool_call` | `start` | Model began a tool call | `toolIndex`, `toolCallId`, `toolName` |
| `tool_call` | `chunk` | Argument JSON fragment | `toolIndex`, `chunk` |

> **Note:** `tool_call` does not emit an `end` phase. The stream stops when arguments are complete, and the existing `onBeforeToolCall` / `onAfterToolCall` daemon hooks cover execution lifecycle.

### Event Timeline

A typical agent activation produces events in this order:

```
thinking:start → thinking:chunk × N → thinking:end
→ output:start → output:chunk × N → output:end

Or with tool calls:

thinking:start → thinking:chunk × N → thinking:end
→ tool_call:start → tool_call:chunk × N
→ (tool executes via onBeforeToolCall / onAfterToolCall)
→ thinking:start → ... → output:start → output:chunk × N → output:end
```

---

## Integration Examples

### WebSocket Server

```ts
import { WebSocketServer } from 'ws'

const wss = new WebSocketServer({ port: 8080 })
const stream = streamd()

stream.subscribe((event) => {
  const payload = JSON.stringify(event)
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload)
  }
})
```

### Server-Sent Events (SSE)

```ts
import { createServer } from 'http'

const stream = streamd()

createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const unsub = stream.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  })

  req.on('close', unsub)
}).listen(3000)
```

### Per-Agent Filtering

```ts
stream.subscribe((event) => {
  if (event.agentId === 'writer' && event.type === 'output') {
    process.stdout.write(event.chunk ?? '')
  }
})
```

---

## API Reference

### `streamd()`

Factory function. Returns a `StreamdHandle`:

```ts
type StreamdHandle = {
  daemon: DaemonDefinition    // register with createKeryx({ daemons: [...] })
  subscribe: (cb: StreamSubscriber) => () => void  // returns unsubscribe fn
}
```

### `StreamSubscriber`

```ts
type StreamSubscriber = (event: StreamEvent) => void
```

Subscribers are called **synchronously** during token streaming. If your subscriber does async work (e.g., writing to a database), buffer internally to avoid backpressure on the stream.

---

## Daemon Lifecycle

| Hook | Order | Behavior |
|------|-------|----------|
| `onAgentStream` | 0 | Broadcasts `AgentStreamContext` to all subscribers as `StreamEvent` |

`streamd` uses a single daemon hook (`onAgentStream`) with `order: 0` to ensure it runs early in the daemon chain.

---

## Exports

```ts
// Value export
export { streamd } from '@elfenlabs/keryx'

// Type exports
export type { StreamEvent, StreamSubscriber, StreamdHandle } from '@elfenlabs/keryx'
```
