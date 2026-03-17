/**
 * Keryx — artifactd (Artifact Management Daemon)
 *
 * Built-in daemon that provides filesystem-backed artifact storage
 * with ownership enforcement and safe text manipulation guardrails.
 *
 * Artifacts are `.md` files with YAML frontmatter stored on disk.
 * Agents interact through 7 tools: read, search, list, create,
 * replace, append, delete.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTool } from '@elfenlabs/nous'
import type { DaemonDefinition, KeryxInstance } from '../types.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type ArtifactMeta = {
  owner: string
  createdAt: string
  updatedAt: string
}

export type ArtifactInfo = {
  id: string
  owner: string
  createdAt: string
  updatedAt: string
}

export type ArtifactdOptions = {
  /** Root directory for artifact storage. Default: './artifacts' */
  root?: string
}

// ── Frontmatter Parsing ─────────────────────────────────────────────────────

const FRONTMATTER_FENCE = '---'

/** Parse YAML frontmatter from raw file content. Returns meta + body. */
function parseFrontmatter(raw: string): { meta: ArtifactMeta; body: string } {
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    throw new Error('Invalid artifact: missing frontmatter')
  }

  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_FENCE) {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) {
    throw new Error('Invalid artifact: unclosed frontmatter')
  }

  // Simple YAML key: value parser (no nesting needed)
  const meta: Record<string, string> = {}
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i]!
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      meta[key] = value
    }
  }

  // Body starts after frontmatter fence + optional blank line
  let bodyStart = endIdx + 1
  if (lines[bodyStart] === '') bodyStart++

  const body = lines.slice(bodyStart).join('\n')

  return {
    meta: {
      owner: meta['owner'] ?? 'unknown',
      createdAt: meta['created_at'] ?? new Date().toISOString(),
      updatedAt: meta['updated_at'] ?? new Date().toISOString(),
    },
    body,
  }
}

/** Serialize meta + body into a full .md file with frontmatter */
function serializeFrontmatter(meta: ArtifactMeta, body: string): string {
  return [
    FRONTMATTER_FENCE,
    `owner: ${meta.owner}`,
    `created_at: ${meta.createdAt}`,
    `updated_at: ${meta.updatedAt}`,
    FRONTMATTER_FENCE,
    '',
    body,
  ].join('\n')
}

// ── Storage Adapter ─────────────────────────────────────────────────────────

export interface ArtifactStorage {
  read(id: string): { content: string; meta: ArtifactMeta } | undefined
  write(id: string, content: string, meta: ArtifactMeta): void
  create(id: string, content: string, owner: string): ArtifactMeta
  delete(id: string): boolean
  deleteDir(dirPath: string): number
  list(glob: string): ArtifactInfo[]
  exists(id: string): boolean
  existsDir(dirPath: string): boolean
  getFolderOwner(dirPath: string): string | undefined
  setFolderOwner(dirPath: string, owner: string): void
}

/** Default filesystem-backed storage */
export class FilesystemArtifactStorage implements ArtifactStorage {
  private readonly root: string
  private readonly metaDir: string
  private folderOwners: Record<string, string> = {}

  constructor(root: string) {
    this.root = path.resolve(root)
    this.metaDir = path.join(this.root, '.artifactd')
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.root, { recursive: true })
    fs.mkdirSync(this.metaDir, { recursive: true })
    this.loadFolderOwners()
  }

  private resolvePath(id: string): string {
    return path.join(this.root, `${id}.md`)
  }

  private loadFolderOwners(): void {
    const ownersFile = path.join(this.metaDir, 'folders.json')
    if (fs.existsSync(ownersFile)) {
      try {
        this.folderOwners = JSON.parse(fs.readFileSync(ownersFile, 'utf-8'))
      } catch {
        this.folderOwners = {}
      }
    }
  }

  private saveFolderOwners(): void {
    fs.mkdirSync(this.metaDir, { recursive: true })
    fs.writeFileSync(
      path.join(this.metaDir, 'folders.json'),
      JSON.stringify(this.folderOwners, null, 2),
    )
  }

  /** Initialize on daemon start */
  init(): void {
    this.ensureDirs()
  }

  read(id: string): { content: string; meta: ArtifactMeta } | undefined {
    const filePath = this.resolvePath(id)
    if (!fs.existsSync(filePath)) return undefined

    const raw = fs.readFileSync(filePath, 'utf-8')
    const { meta, body } = parseFrontmatter(raw)
    return { content: body, meta }
  }

  write(id: string, content: string, meta: ArtifactMeta): void {
    const filePath = this.resolvePath(id)
    meta.updatedAt = new Date().toISOString()
    fs.writeFileSync(filePath, serializeFrontmatter(meta, content))
  }

  create(id: string, content: string, owner: string): ArtifactMeta {
    const filePath = this.resolvePath(id)
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })

    const now = new Date().toISOString()
    const meta: ArtifactMeta = { owner, createdAt: now, updatedAt: now }
    fs.writeFileSync(filePath, serializeFrontmatter(meta, content))

    // Track folder ownership: first creator owns the directory
    const relDir = path.relative(this.root, dir)
    if (relDir && relDir !== '.' && !this.folderOwners[relDir]) {
      this.folderOwners[relDir] = owner
      this.saveFolderOwners()
    }

    return meta
  }

  delete(id: string): boolean {
    const filePath = this.resolvePath(id)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    return true
  }

  deleteDir(dirPath: string): number {
    const fullPath = path.join(this.root, dirPath)
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) return 0

    let count = 0
    const entries = fs.readdirSync(fullPath, { recursive: true }) as string[]
    for (const entry of entries) {
      const entryPath = path.join(fullPath, entry)
      if (fs.existsSync(entryPath) && fs.statSync(entryPath).isFile() && entry.endsWith('.md')) {
        count++
      }
    }

    fs.rmSync(fullPath, { recursive: true, force: true })

    // Clean up folder ownership entries
    const keysToRemove = Object.keys(this.folderOwners).filter(
      k => k === dirPath || k.startsWith(`${dirPath}/`),
    )
    for (const key of keysToRemove) {
      delete this.folderOwners[key]
    }
    if (keysToRemove.length > 0) this.saveFolderOwners()

    return count
  }

  list(glob: string): ArtifactInfo[] {
    // Support simple glob: "path/*" matches direct children, "path/**" matches recursive
    // For v1, we just support "prefix*" pattern matching
    const results: ArtifactInfo[] = []

    if (!fs.existsSync(this.root)) return results

    const allFiles = this.walkDir(this.root)
    for (const filePath of allFiles) {
      if (!filePath.endsWith('.md')) continue
      const relPath = path.relative(this.root, filePath)
      // Skip .artifactd metadata
      if (relPath.startsWith('.artifactd')) continue

      const id = relPath.replace(/\.md$/, '')

      if (this.matchGlob(id, glob)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8')
          const { meta } = parseFrontmatter(raw)
          results.push({
            id,
            owner: meta.owner,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
          })
        } catch {
          // Skip malformed files
        }
      }
    }

    return results
  }

  exists(id: string): boolean {
    return fs.existsSync(this.resolvePath(id))
  }

  existsDir(dirPath: string): boolean {
    const fullPath = path.join(this.root, dirPath)
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()
  }

  getFolderOwner(dirPath: string): string | undefined {
    return this.folderOwners[dirPath]
  }

  setFolderOwner(dirPath: string, owner: string): void {
    this.folderOwners[dirPath] = owner
    this.saveFolderOwners()
  }

  /** Recursively walk a directory and return all file paths */
  private walkDir(dir: string): string[] {
    const results: string[] = []
    if (!fs.existsSync(dir)) return results

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.artifactd') continue
        results.push(...this.walkDir(full))
      } else {
        results.push(full)
      }
    }
    return results
  }

  /** Simple glob matching: supports *, prefix*, path/*, path/**, and exact match */
  private matchGlob(id: string, glob: string): boolean {
    if (glob === '*') return true

    // "path/*" — match direct children of path
    if (glob.endsWith('/*')) {
      const prefix = glob.slice(0, -2)
      const dir = path.dirname(id)
      return dir === prefix
    }

    // "path/**" — match all descendants
    if (glob.endsWith('/**')) {
      const prefix = glob.slice(0, -3)
      return id.startsWith(`${prefix}/`)
    }

    // "prefix*" — starts-with match
    if (glob.endsWith('*')) {
      const prefix = glob.slice(0, -1)
      return id.startsWith(prefix)
    }

    // Exact match
    return id === glob
  }
}

// ── Daemon Factory ──────────────────────────────────────────────────────────

/**
 * Create an artifact management daemon.
 *
 * @example
 * ```ts
 * await kx.daemons.register(artifactd({ root: './artifacts' }))
 * ```
 */
export function artifactd(opts?: ArtifactdOptions): DaemonDefinition {
  const storage = new FilesystemArtifactStorage(opts?.root ?? './artifacts')

  return {
    id: 'artifactd',
    capabilities: {
      writes: ['activation:before'],
      description: 'Provides shared artifact management tools to agents',
    },

    onStart: (kx: KeryxInstance) => {
      storage.init()

      kx.bus.on('activation:before', (ctx) => {
        const agentId = ctx.agentId

        ctx.addTools([
          // ── Read operations (unrestricted) ──────────────────────────────

          createTool({
            id: 'artifact_read',
            description:
              'Read the content of an artifact. Returns the text body. Use startLine/endLine to read a specific range.',
            schema: {
              id: { type: 'string', description: 'Artifact path (e.g., "analysis/sentiment")' },
              startLine: { type: 'number', description: 'Start line (1-indexed)', required: false },
              endLine: { type: 'number', description: 'End line (inclusive)', required: false },
            },
            execute: async (args: { id: string; startLine?: number; endLine?: number }) => {
              const result = storage.read(args.id)
              if (!result) return `Error: Artifact "${args.id}" not found.`

              let content = result.content
              if (args.startLine || args.endLine) {
                const lines = content.split('\n')
                const start = (args.startLine ?? 1) - 1
                const end = args.endLine ?? lines.length
                content = lines.slice(start, end).join('\n')
              }

              return content
            },
          }),

          createTool({
            id: 'artifact_search',
            description:
              'Search for a text pattern within an artifact. Returns matching lines with line numbers. Capped at 50 results.',
            schema: {
              id: { type: 'string', description: 'Artifact path' },
              pattern: { type: 'string', description: 'Text pattern to search for' },
            },
            execute: async (args: { id: string; pattern: string }) => {
              const result = storage.read(args.id)
              if (!result) return `Error: Artifact "${args.id}" not found.`

              const lines = result.content.split('\n')
              const matches: { line: number; content: string }[] = []

              for (let i = 0; i < lines.length && matches.length < 50; i++) {
                if (lines[i]!.includes(args.pattern)) {
                  matches.push({ line: i + 1, content: lines[i]! })
                }
              }

              if (matches.length === 0) {
                return `No matches found for "${args.pattern}" in "${args.id}".`
              }

              return JSON.stringify(matches)
            },
          }),

          createTool({
            id: 'artifact_list',
            description:
              'List artifacts matching a glob pattern. Use "path/*" for direct children or "path/**" for all descendants.',
            schema: {
              glob: {
                type: 'string',
                description: 'Glob pattern (e.g., "analysis/*", "agents/me/**")',
              },
            },
            execute: async (args: { glob: string }) => {
              const items = storage.list(args.glob)
              if (items.length === 0) {
                return `No artifacts found matching "${args.glob}".`
              }
              return JSON.stringify(items)
            },
          }),

          // ── Write operations (ownership-enforced) ───────────────────────

          createTool({
            id: 'artifact_create',
            description:
              'Create a new artifact. You become the owner. Parent directories are created automatically.',
            schema: {
              id: { type: 'string', description: 'Artifact path (e.g., "analysis/sentiment")' },
              content: { type: 'string', description: 'Initial content' },
            },
            execute: async (args: { id: string; content: string }) => {
              if (storage.exists(args.id)) {
                return `Error: Artifact "${args.id}" already exists.`
              }
              storage.create(args.id, args.content, agentId)
              return `Created artifact "${args.id}".`
            },
          }),

          createTool({
            id: 'artifact_replace',
            description:
              'Find and replace exact text within an artifact you own. Errors if multiple matches found (use allowMultiple to override). Use startLine/endLine to narrow the search.',
            schema: {
              id: { type: 'string', description: 'Artifact path' },
              target: { type: 'string', description: 'Exact text to find' },
              replacement: { type: 'string', description: 'Text to replace with' },
              startLine: { type: 'number', description: 'Narrow search start (1-indexed)', required: false },
              endLine: { type: 'number', description: 'Narrow search end (inclusive)', required: false },
              allowMultiple: { type: 'boolean', description: 'If true, replace all matches', required: false },
            },
            execute: async (args: {
              id: string
              target: string
              replacement: string
              startLine?: number
              endLine?: number
              allowMultiple?: boolean
            }) => {
              const result = storage.read(args.id)
              if (!result) return `Error: Artifact "${args.id}" not found.`
              if (result.meta.owner !== agentId) {
                return `Error: Not owner of "${args.id}" (owner: ${result.meta.owner}).`
              }

              const lines = result.content.split('\n')
              const searchStart = (args.startLine ?? 1) - 1
              const searchEnd = args.endLine ?? lines.length

              // Find all occurrences within the search range
              const matchLines: number[] = []
              const searchRegion = lines.slice(searchStart, searchEnd).join('\n')
              let idx = 0
              while (idx < searchRegion.length) {
                const found = searchRegion.indexOf(args.target, idx)
                if (found === -1) break

                // Calculate line number of this match
                const linesBeforeMatch = searchRegion.slice(0, found).split('\n').length
                matchLines.push(searchStart + linesBeforeMatch)
                idx = found + args.target.length
              }

              if (matchLines.length === 0) {
                return `Error: Target not found in artifact "${args.id}".`
              }

              if (matchLines.length > 1 && !args.allowMultiple) {
                return `Error: Ambiguous: found ${matchLines.length} matches at lines [${matchLines.join(', ')}]. Use allowMultiple or narrow with startLine/endLine.`
              }

              // Perform replacement on the search region
              const before = lines.slice(0, searchStart).join('\n')
              const region = lines.slice(searchStart, searchEnd).join('\n')
              const after = lines.slice(searchEnd).join('\n')

              const replaced = args.allowMultiple
                ? region.replaceAll(args.target, args.replacement)
                : region.replace(args.target, args.replacement)

              const parts = [before, replaced, after].filter(p => p !== '')
              const newContent = parts.join('\n')

              storage.write(args.id, newContent, result.meta)
              const count = args.allowMultiple ? matchLines.length : 1
              return `Replaced ${count} occurrence(s) in "${args.id}".`
            },
          }),

          createTool({
            id: 'artifact_append',
            description: 'Append content to the end of an artifact you own.',
            schema: {
              id: { type: 'string', description: 'Artifact path' },
              content: { type: 'string', description: 'Content to append' },
            },
            execute: async (args: { id: string; content: string }) => {
              const result = storage.read(args.id)
              if (!result) return `Error: Artifact "${args.id}" not found.`
              if (result.meta.owner !== agentId) {
                return `Error: Not owner of "${args.id}" (owner: ${result.meta.owner}).`
              }

              const newContent = result.content.endsWith('\n')
                ? result.content + args.content
                : result.content + '\n' + args.content

              storage.write(args.id, newContent, result.meta)
              return `Appended to "${args.id}".`
            },
          }),

          createTool({
            id: 'artifact_delete',
            description:
              'Delete an artifact or folder you own. Folder deletion is cascading (removes all children).',
            schema: {
              id: { type: 'string', description: 'Artifact or folder path' },
            },
            execute: async (args: { id: string }) => {
              // Try as artifact first
              if (storage.exists(args.id)) {
                const result = storage.read(args.id)
                if (!result) return `Error: Artifact "${args.id}" not found.`
                if (result.meta.owner !== agentId) {
                  return `Error: Not owner of "${args.id}" (owner: ${result.meta.owner}).`
                }
                storage.delete(args.id)
                return `Deleted artifact "${args.id}".`
              }

              // Try as directory
              if (storage.existsDir(args.id)) {
                const folderOwner = storage.getFolderOwner(args.id)
                if (folderOwner && folderOwner !== agentId) {
                  return `Error: Not owner of folder "${args.id}" (owner: ${folderOwner}).`
                }
                const count = storage.deleteDir(args.id)
                return `Deleted folder "${args.id}" (${count} artifact(s) removed).`
              }

              return `Error: Artifact or folder "${args.id}" not found.`
            },
          }),
        ])
      }, 10)
    },
  }
}
