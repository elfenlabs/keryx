# RFC: `delegate` — Scoped Agent Delegation

**Status:** Draft  
**Author:** yonder  
**Date:** 2026-03-16

## Summary

`delegate` is a built-in Keryx tool that allows a running agent to invoke an `AgentDefinition` from the catalog as an **ephemeral sub-agent**. The sub-agent runs in an isolated context with its own scoped tools, and only its final response enters the parent agent's context (as the tool result). Internal reasoning turns are discarded.

This is semantically equivalent to: **spawn → ask_agent → destroy**, composed into a single tool call.

### Programming Analogy

| Programming | Delegate |
|:------------|:---------|
| Function definition | `AgentDefinition` in catalog |
| Function call | `delegate` tool invocation |
| Stack frame | Sub-agent's isolated context |
| Parameters | `instruction` + optional `forkContext` |
| Return value | Aggregated response string |
| Local variables | Sub-agent's internal turns (discarded) |

## Motivation

Without `delegate`, agents must choose between:

1. **Having all tools available** — bloats context, confuses the LLM with irrelevant options
2. **Using `ask_agent`** to a pre-spawned specialist — heavy-weight, requires lifecycle management, persists on the bus

`delegate` fills the gap: a lightweight, scoped invocation that runs through the full daemon pipeline but is invisible as a bus entity.

## Design

### Tool Definition

```ts
delegate({
  to: string,           // Name of the target AgentDefinition in the catalog
  instruction: string,   // Task instruction for the sub-agent
})
```

**Returns:** The sub-agent's final response as a string.

### Agent Definition Extensions

```ts
type AgentDefinition = {
  // ...existing fields...

  /**
   * Allowlist of definition names this agent may delegate to.
   * If omitted or empty, the delegate tool is NOT injected.
   */
  delegates?: string[]
}
```

The `delegate` tool is **opt-in**: it is only injected into agents that declare a non-empty `delegates` array. The array also acts as a guard — the agent can only delegate to definitions in its allowlist.

### Activation Context Extension

```ts
type ActivationContext = {
  // ...existing fields...

  /**
   * Present when this activation was triggered by a delegation.
   * Allows daemons to differentiate delegated from top-level activations.
   */
  delegation?: {
    /** Agent ID of the immediate parent who delegated */
    parentAgentId: string
    /** Agent ID of the root (top-level) agent that started the delegation chain */
    rootAgentId: string
    /** Name of the definition being delegated to (catalog key) */
    definitionName: string
    /** Current delegation nesting depth (1 = first level) */
    depth: number
  }
}
```

The same field is added to `AfterActivationContext`.

### Depth Limit

A maximum delegation depth prevents infinite recursion. Configurable via `KeryxConfig`:

```ts
type KeryxConfig = {
  // ...existing fields...

  /** Maximum delegation nesting depth. Default: 5 */
  maxDelegationDepth?: number
}
```

When the limit is reached, the `delegate` tool returns an error result to the calling agent rather than throwing.

## Execution Flow

```
Parent Agent (activation)
  │
  ├─ LLM decides to call delegate({ to: "code_editor", instruction: "..." })
  │
  ├─ 1. Validate: "code_editor" is in parent's delegates[] allowlist
  ├─ 2. Validate: current depth < maxDelegationDepth
  ├─ 3. Spawn ephemeral instance: "parent-id::code_editor::abc123"
  │      └─ Full daemon pipeline: onAgentSpawn hooks fire
  ├─ 4. Send message via kx.request() (blocking)
  │      └─ Full daemon pipeline: onBeforeActivation, contextd, etc.
  │      └─ contextd sees delegation field → handles context per config
  │      └─ Sub-agent runs Nous loop with its own tools
  │      └─ onAfterActivation hooks fire
  ├─ 5. Destroy ephemeral instance
  │      └─ Full daemon pipeline: onAgentDestroy hooks fire
  │
  └─ Tool result = sub-agent's final response (string)
      └─ Parent context only sees this. Sub-agent internals discarded.
```

## Context Modes (contextd concern)

Context behavior for delegated activations is configured on the **target definition's** contextd config, not on Keryx core. contextd uses the `delegation` field on `ActivationContext` to determine behavior.

| contextd config | Behavior |
|:----------------|:---------|
| *absent* | Clean slate — empty context, no persistence |
| `{ context: 'fork' }` | contextd clones the parent agent's current context into the sub-agent |
| `{ context: 'persistent' }` | Normal contextd behavior — load/save from storage (most like `ask_agent`) |

> [!NOTE]
> The `fork` and `persistent` modes are contextd implementation details. Keryx core only provides the `delegation` field on the activation context. contextd (or any daemon) decides what to do with it.

### Persistent Context Identity

In nested delegation chains like `A → B → C → B`, the definition `B` is invoked twice with different ephemeral agent IDs. For persistent context, contextd must resolve a **stable context key** independent of the ephemeral ID.

The recommended scoping is **per root agent**: contextd keys persistent context on `{rootAgentId}::{definitionName}`. This way:

- Both invocations of `B` in `A → B → C → B` share the same context (key: `A::B`)
- A different root agent `X` delegating to `B` gets its own separate context (key: `X::B`)

All necessary information is available via the `delegation` field — `rootAgentId` and `definitionName` — so contextd can implement this without any Keryx core changes.

## Ephemeral Instance Naming

Ephemeral instances spawned by `delegate` use a deterministic naming scheme:

```
{parentAgentId}::delegate::{definitionName}::{shortUUID}
```

Example: `analyst-1::delegate::code_editor::a1b2c3d4`

This is for **internal identification only** — daemons should use the `delegation` field on activation context, not parse the agent ID.

## Examples

### Definition Catalog

```ts
const definitions = {
  analyst: {
    name: 'Analyst',
    instruction: 'You analyze data and produce reports.',
    tools: [chartTool, queryTool],
    delegates: ['code_editor', 'search'],  // ← can delegate to these
  },
  code_editor: {
    name: 'Code Editor',
    instruction: 'You edit code files precisely.',
    tools: [readFileTool, writeFileTool, grepTool],
    // No delegates → cannot delegate further (leaf node)
  },
  search: {
    name: 'Search Specialist',
    instruction: 'You search codebases and return relevant snippets.',
    tools: [grepTool, findFileTool],
    delegates: ['code_editor'],  // ← can delegate deeper
  },
}
```

### Agent Interaction (LLM perspective)

```
User → Analyst: "Fix the broken imports in main.ts"

Analyst thinks: "I need to edit code, let me delegate to code_editor."

Analyst calls: delegate({ to: "code_editor", instruction: "Fix the import statements in main.ts" })

  [code_editor sub-agent runs]
  [reads main.ts, identifies issues, writes fixes]
  [4 internal turns, all invisible to analyst]

Tool result: "Fixed 3 import statements in main.ts:
  - Removed unused import 'lodash'
  - Added missing import 'path'
  - Fixed relative path '../utils' → './utils'"

Analyst continues with this result in context. Never saw the internal tool calls.
```

### Nested Delegation

```
Analyst delegates to Search ("find all files importing lodash")
  └─ Search delegates to Code Editor ("read package.json for lodash version")
      └─ Code Editor runs (leaf, no further delegation)
      └─ Returns: "lodash@4.17.21"
  └─ Search returns: "Found 12 files importing lodash. Version: 4.17.21"
Analyst continues with search results.
```

Depth tracking: Analyst(0) → Search(1) → Code Editor(2). If `maxDelegationDepth` is 2, Code Editor could **not** delegate further even if it had `delegates[]` configured.

## Comparison with Existing Primitives

| | `send_message` | `ask_agent` | `delegate` |
|:--|:---------------|:------------|:-----------|
| Target | Spawned instance | Spawned instance | Definition (catalog) |
| Reply? | Fire-and-forget | Blocking reply | Blocking reply |
| Instance lifecycle | Pre-existing | Pre-existing | Ephemeral (auto spawn/destroy) |
| Context | Separate, persistent | Separate, persistent | Configurable (clean/fork/persistent) |
| Daemon hooks | N/A (just inbox) | Full pipeline | Full pipeline |
| Parent sees internals? | N/A | No (separate agent) | No (scoped isolation) |
| Tool scoping | N/A | Target's tools | Target's tools |

## Resolved Design Decisions

1. **Streaming bubble-up: Yes.** Sub-agent output chunks propagate through the parent's stream. Since `delegate` is often used as a "mode switch," the user should see the sub-agent's output in real-time. The sub-agent's stream events flow through the existing daemon `onAgentStream` hooks.

2. **Timeout: Parent's.** No per-call timeout on `delegate`. The parent's overall activation timeout governs the entire call chain including delegations.

3. **Error propagation: Tool-error-result.** Sub-agent failures surface as tool error results to the parent agent, consistent with Nous's error-as-feedback pattern. The parent can retry, adapt, or report the failure.
