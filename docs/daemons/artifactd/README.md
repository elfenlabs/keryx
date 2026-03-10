# artifactd — Artifact Management Daemon

> Filesystem-backed document store with ownership and agent-scoped tools.

## Overview

`artifactd` is a Keryx daemon that gives agents the ability to create, read, search, and modify **artifacts** — persistent text documents stored on the real filesystem. It provides a virtual-filesystem-like API with path-based IDs, ownership enforcement, and safe text manipulation guardrails.

### Why

Agents need a structured way to produce, consume, and collaborate on documents (analysis reports, plans, scratchpads, research notes). Raw filesystem access is dangerous and hard to audit. `artifactd` sits in between: the artifacts are plain `.md` files humans can browse and edit directly, but agent access is mediated through ownership rules and safety guardrails.

### Design Principles

1. **Real filesystem** — artifacts are `.md` files on disk. Humans can `ls`, `cat`, `vim`, and `git diff` them.
2. **Ownership, not ACLs** — creator owns the artifact. Owner writes, everyone reads. Simple.
3. **Fail-loud guardrails** — ambiguous operations (e.g., multi-match replacements) error by default.
4. **Filesystem metaphor** — path-based IDs with `/` separators, glob-based listing, folder ownership.

---

## Configuration

```ts
import { artifactd } from '@elfenlabs/keryx'

const kx = createKeryx({
  daemons: [
    artifactd({
      root: './artifacts',  // where artifacts are stored, default: './artifacts'
    }),
  ],
  agents: [
    {
      id: 'analyst',
      name: 'Analyst',
      instruction: 'You analyze data and produce reports.',
      // No per-agent config needed — all agents get artifact tools by default
    },
  ],
})
```

### `ArtifactdOptions`

| Option | Type     | Default          | Description                        |
|--------|----------|------------------|------------------------------------|
| `root` | `string` | `'./artifacts'`  | Root directory for artifact storage |

---

## File Format

Artifacts are stored as `.md` files with YAML frontmatter for metadata:

```markdown
---
owner: social-sentiment-agent
created_at: 2026-03-02T14:30:00.000Z
updated_at: 2026-03-02T15:12:33.000Z
---

# Social Media Sentiment: META Q4

Twitter sentiment was overwhelmingly positive following the earnings beat...
```

### Frontmatter Rules

- **Managed by `artifactd`** — agents never see or touch frontmatter. It is stripped on read and injected on write.
- **`owner`** — the agent ID that created the artifact. Immutable after creation.
- **`created_at`** — ISO 8601 timestamp. Set once at creation.
- **`updated_at`** — ISO 8601 timestamp. Updated on every write operation.
- **Line numbers** — when agents use `startLine`/`endLine` in operations, line 1 refers to the first line of content *after* the frontmatter, not the raw file.

---

## Ownership Model

| Rule | Behavior |
|------|----------|
| Creator owns the artifact | The agent that calls `artifact_create` becomes the owner |
| Owner can write | Only the owner can `artifact_replace`, `artifact_append`, or `artifact_delete` |
| Everyone can read | Any agent can `artifact_read`, `artifact_search`, or `artifact_list` |
| Folder ownership | The agent that first creates an artifact under a path "owns" that directory |
| Folder deletion | Only the folder owner can delete the folder (cascading delete of all children) |
| Any agent can create anywhere | No path-based write gates for creation (v1) |
| Deleted artifact errors | Writing to a deleted artifact returns an error |

### Human Override

Humans can edit artifacts directly on the filesystem, bypassing ownership. This is intentional — the human is the superuser. `artifactd` does not enforce ownership for out-of-band filesystem modifications.

---

## Tools

`artifactd` provisions 7 tools to agents via `onPreActivation`. All agents get all tools by default.

### Read Operations (unrestricted)

#### `artifact_read`

Read the content of an artifact.

```
artifact_read(id, startLine?, endLine?)
```

| Param       | Type     | Required | Description                          |
|-------------|----------|----------|--------------------------------------|
| `id`        | `string` | ✓        | Artifact path (e.g., `analysis/sentiment`) |
| `startLine` | `number` |          | Start line (1-indexed, content-only) |
| `endLine`   | `number` |          | End line (inclusive)                  |

**Returns:** The artifact content (frontmatter stripped). If `startLine`/`endLine` are provided, returns only that range.

**Errors:**
- Artifact not found

---

#### `artifact_search`

Search for a pattern within an artifact's content.

```
artifact_search(id, pattern)
```

| Param     | Type     | Required | Description                      |
|-----------|----------|----------|----------------------------------|
| `id`      | `string` | ✓        | Artifact path                    |
| `pattern` | `string` | ✓        | Text pattern to search for       |

**Returns:** Array of matches with line numbers and line content. Capped at 50 results.

**Errors:**
- Artifact not found

---

#### `artifact_list`

List artifacts matching a glob pattern.

```
artifact_list(glob)
```

| Param  | Type     | Required | Description                                    |
|--------|----------|----------|------------------------------------------------|
| `glob` | `string` | ✓        | Glob pattern (e.g., `analysis/*`, `agents/me/*`) |

**Returns:** Array of artifact info objects:

```json
[
  {
    "id": "analysis/2026-03-02-meta-earnings/sentiment",
    "owner": "social-sentiment-agent",
    "createdAt": "2026-03-02T14:30:00.000Z",
    "updatedAt": "2026-03-02T15:12:33.000Z"
  }
]
```

---

### Write Operations (ownership-enforced)

#### `artifact_create`

Create a new artifact. Caller becomes the owner.

```
artifact_create(id, content)
```

| Param     | Type     | Required | Description               |
|-----------|----------|----------|---------------------------|
| `id`      | `string` | ✓        | Artifact path             |
| `content` | `string` | ✓        | Initial content (body)    |

**Behavior:**
- Creates `{root}/{id}.md` with YAML frontmatter prepended
- Creates parent directories as needed
- First agent to create under a directory "owns" that directory

**Errors:**
- Artifact already exists at that path

---

#### `artifact_replace`

Find and replace exact text within an artifact. Owner only.

```
artifact_replace(id, target, replacement, startLine?, endLine?, allowMultiple?)
```

| Param           | Type      | Required | Default | Description                               |
|-----------------|-----------|----------|---------|-------------------------------------------|
| `id`            | `string`  | ✓        |         | Artifact path                             |
| `target`        | `string`  | ✓        |         | Exact text to find                        |
| `replacement`   | `string`  | ✓        |         | Text to replace with                      |
| `startLine`     | `number`  |          |         | Narrow search to start at this line       |
| `endLine`       | `number`  |          |         | Narrow search to end at this line         |
| `allowMultiple` | `boolean` |          | `false` | If true, replace all matches              |

**Behavior:**
- **0 matches** → error: `"Target not found in artifact"`
- **1 match** → replace it
- **>1 matches, `allowMultiple: false`** → error: `"Ambiguous: found N matches at lines [X, Y, Z]. Use allowMultiple or narrow with startLine/endLine."`
- **>1 matches, `allowMultiple: true`** → replace all occurrences

**Errors:**
- Not owner
- Artifact not found
- Target not found
- Ambiguous match (when `allowMultiple` is false)

---

#### `artifact_append`

Append content to the end of an artifact. Owner only.

```
artifact_append(id, content)
```

| Param     | Type     | Required | Description          |
|-----------|----------|----------|----------------------|
| `id`      | `string` | ✓        | Artifact path        |
| `content` | `string` | ✓        | Content to append    |

**Errors:**
- Not owner
- Artifact not found

---

#### `artifact_delete`

Delete an artifact or folder. Owner only (or parent folder owner).

```
artifact_delete(id)
```

| Param | Type     | Required | Description            |
|-------|----------|----------|------------------------|
| `id`  | `string` | ✓        | Artifact or folder path |

**Behavior:**
- If `id` points to an artifact: delete it (owner only)
- If `id` points to a folder: cascading delete of all children (folder owner only)

**Errors:**
- Not owner (and not parent folder owner)
- Artifact/folder not found

---

## Workflow Example

A manager agent coordinates multiple specialists to produce a collaborative analysis:

```
── Manager (analyst-manager) ──────────────────────────────────────────

1. artifact_create("analysis/2026-03-02-meta-earnings/brief",
     "# META Q4 Earnings Brief\n\nAnalyze sentiment and financials...")
   → manager owns the folder and the brief

2. agent_ask("social-sentiment-agent",
     "Analyze social media sentiment. Write to: analysis/2026-03-02-meta-earnings/")

3. agent_ask("financial-agent",
     "Analyze financial data. Write to: analysis/2026-03-02-meta-earnings/")

── Specialist (social-sentiment-agent) ────────────────────────────────

4. artifact_read("analysis/2026-03-02-meta-earnings/brief")
   → reads the manager's brief for context

5. artifact_create("analysis/2026-03-02-meta-earnings/social-media-sentiment",
     "# Social Media Sentiment\n\nTwitter: bullish 78%...")
   → specialist owns this artifact

── Specialist (financial-agent) ───────────────────────────────────────

6. artifact_read("analysis/2026-03-02-meta-earnings/brief")
7. artifact_create("analysis/2026-03-02-meta-earnings/financial-analysis",
     "# Financial Analysis\n\nRevenue beat: $40.1B vs $39.2B expected...")

── Manager (analyst-manager) — after specialists reply ────────────────

8. artifact_list("analysis/2026-03-02-meta-earnings/*")
   → ["brief", "social-media-sentiment", "financial-analysis"]

9. artifact_read("analysis/2026-03-02-meta-earnings/social-media-sentiment")
10. artifact_read("analysis/2026-03-02-meta-earnings/financial-analysis")

11. artifact_create("analysis/2026-03-02-meta-earnings/final-report",
      "# Final Report\n\n## Summary\n\nBased on specialist analyses...")

── Cleanup ────────────────────────────────────────────────────────────

12. artifact_delete("analysis/2026-03-02-meta-earnings")
    → manager owns the folder, cascading delete removes everything
```

### Key Properties

- **No shared mutation** — each agent creates and owns their own artifacts
- **Natural discoverability** — `artifact_list` with a glob finds contributions
- **The brief is the contract** — manager's brief communicates expectations
- **Folder lifecycle** — manager controls cleanup via folder ownership

---

## Implementation Notes

### Storage Layer

`artifactd` uses a **storage adapter** pattern, similar to `contextd`:

```ts
export interface ArtifactStorage {
  read(id: string): { content: string; meta: ArtifactMeta } | undefined
  write(id: string, content: string, meta: ArtifactMeta): void
  delete(id: string): boolean
  list(glob: string): ArtifactInfo[]
  exists(id: string): boolean
}
```

The default implementation is `FilesystemArtifactStorage`, which reads/writes `.md` files with YAML frontmatter. Alternative adapters (e.g., in-memory for tests) can be injected via options.

### Frontmatter Parsing

Use the `gray-matter` npm package (or a minimal inline parser) to parse/serialize YAML frontmatter. The frontmatter boundary is `---` on its own line.

### Folder Ownership Tracking

Folder ownership is tracked in a sidecar file at `{root}/.artifactd/folders.json`:

```json
{
  "analysis/2026-03-02-meta-earnings": "analyst-manager"
}
```

This file is managed by `artifactd` and transparent to agents.

### Daemon Lifecycle

| Hook | Behavior |
|------|----------|
| `onStart` | Ensure root directory exists. Load folder ownership metadata. |
| `onPreActivation` | Inject all 7 artifact tools into the agent's toolset via `ctx.addTools()` |
| `onToolCall` | Route to the appropriate operation, enforce ownership |
| `onStop` | Flush any pending metadata |

---

## Future Considerations (v2)

- **Scoped creation** — restrict which paths an agent can create artifacts under (passed via message metadata or agent config)
- **Extensible frontmatter** — allow daemons to stash namespaced metadata in the frontmatter (e.g., `contextd` adding a summary field)
- **Artifact versioning** — track edit history via content hashing or git integration
- **Size limits** — configurable max artifact size and max line count for reads
