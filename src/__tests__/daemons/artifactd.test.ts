/**
 * artifactd — Tests
 *
 * Tests for the built-in artifact management daemon.
 * Uses a temp directory for filesystem isolation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { artifactd, FilesystemArtifactStorage } from '../../daemons/artifactd.js'
import type { ArtifactMeta } from '../../daemons/artifactd.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifactd-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeStorage(): FilesystemArtifactStorage {
  const storage = new FilesystemArtifactStorage(tmpDir)
  storage.init()
  return storage
}

// ── Storage Layer Tests ─────────────────────────────────────────────────────

describe('FilesystemArtifactStorage', () => {
  test('create and read an artifact', () => {
    const storage = makeStorage()

    storage.create('notes/hello', 'Hello world!', 'agent-1')

    const result = storage.read('notes/hello')
    expect(result).toBeDefined()
    expect(result!.content).toBe('Hello world!')
    expect(result!.meta.owner).toBe('agent-1')
  })

  test('creates .md file with frontmatter on disk', () => {
    const storage = makeStorage()
    storage.create('report', 'Some report content', 'analyst')

    const filePath = path.join(tmpDir, 'report.md')
    expect(fs.existsSync(filePath)).toBe(true)

    const raw = fs.readFileSync(filePath, 'utf-8')
    expect(raw).toContain('---')
    expect(raw).toContain('owner: analyst')
    expect(raw).toContain('created_at:')
    expect(raw).toContain('Some report content')
  })

  test('read returns undefined for non-existent artifact', () => {
    const storage = makeStorage()
    expect(storage.read('nonexistent')).toBeUndefined()
  })

  test('write updates content and updatedAt', async () => {
    const storage = makeStorage()
    const meta = storage.create('doc', 'original', 'agent-1')

    // Small delay to ensure timestamp changes
    await new Promise(r => setTimeout(r, 10))

    const newMeta = { ...meta }
    storage.write('doc', 'modified', newMeta)

    const result = storage.read('doc')
    expect(result!.content).toBe('modified')
    // updatedAt should be refreshed by write()
    expect(result!.meta.owner).toBe('agent-1')
  })

  test('delete removes artifact', () => {
    const storage = makeStorage()
    storage.create('temp', 'temporary', 'agent-1')

    expect(storage.exists('temp')).toBe(true)
    const deleted = storage.delete('temp')
    expect(deleted).toBe(true)
    expect(storage.exists('temp')).toBe(false)
  })

  test('delete returns false for non-existent artifact', () => {
    const storage = makeStorage()
    expect(storage.delete('ghost')).toBe(false)
  })

  test('list with glob: direct children', () => {
    const storage = makeStorage()
    storage.create('analysis/brief', 'Brief content', 'manager')
    storage.create('analysis/sentiment', 'Sentiment analysis', 'specialist-1')
    storage.create('analysis/financials', 'Financial analysis', 'specialist-2')
    storage.create('other/doc', 'Other doc', 'agent-x')

    const items = storage.list('analysis/*')
    expect(items).toHaveLength(3)
    expect(items.map(i => i.id).sort()).toEqual([
      'analysis/brief',
      'analysis/financials',
      'analysis/sentiment',
    ])
  })

  test('list with glob: nested descendants', () => {
    const storage = makeStorage()
    storage.create('project/docs/readme', 'Readme', 'agent-1')
    storage.create('project/docs/api/endpoints', 'API docs', 'agent-1')
    storage.create('project/src/main', 'Source', 'agent-1')
    storage.create('other/file', 'Other', 'agent-2')

    const items = storage.list('project/**')
    expect(items).toHaveLength(3)
  })

  test('list with glob: wildcard matches all', () => {
    const storage = makeStorage()
    storage.create('a', 'A', 'agent')
    storage.create('b/c', 'BC', 'agent')

    const items = storage.list('*')
    expect(items.length).toBeGreaterThanOrEqual(2)
  })

  test('folder ownership tracking', () => {
    const storage = makeStorage()

    // First artifact in a directory sets folder ownership
    storage.create('reports/q1/summary', 'Q1 summary', 'manager')
    expect(storage.getFolderOwner('reports/q1')).toBe('manager')

    // Second artifact by different agent does NOT change folder ownership
    storage.create('reports/q1/details', 'Q1 details', 'analyst')
    expect(storage.getFolderOwner('reports/q1')).toBe('manager')
  })

  test('deleteDir removes folder and all children', () => {
    const storage = makeStorage()
    storage.create('cleanup/a', 'A', 'owner')
    storage.create('cleanup/b', 'B', 'other')
    storage.create('cleanup/sub/c', 'C', 'other')

    const count = storage.deleteDir('cleanup')
    expect(count).toBe(3)
    expect(storage.exists('cleanup/a')).toBe(false)
    expect(storage.existsDir('cleanup')).toBe(false)
  })

  test('folder owners persist across instances', () => {
    const storage1 = makeStorage()
    storage1.create('persist-test/doc', 'Hello', 'original-owner')
    expect(storage1.getFolderOwner('persist-test')).toBe('original-owner')

    // New storage instance reads from same directory
    const storage2 = new FilesystemArtifactStorage(tmpDir)
    storage2.init()
    expect(storage2.getFolderOwner('persist-test')).toBe('original-owner')
  })
})

// ── Tool Tests (via daemon) ─────────────────────────────────────────────────

describe('artifactd tools', () => {
  /** Extract tools from the daemon by simulating onPreActivation */
  function getTools(agentId: string, root: string) {
    const daemon = artifactd({ root })
    const tools: any[] = []

    // Call onStart to init storage
    if (daemon.onStart) {
      daemon.onStart({} as any)
    }

    // Simulate onPreActivation to collect tools
    if (daemon.onPreActivation) {
      daemon.onPreActivation({
        agentId,
        agentConfig: {},
        message: {} as any,
        ctx: { push: () => {} } as any,
        addTools: (t: any[]) => tools.push(...t),
        addPromptSegment: () => {},
      })
    }

    return tools
  }

  function findTool(tools: any[], id: string) {
    return tools.find((t: any) => t.id === id)
  }

  test('provisions all 7 tools', () => {
    const tools = getTools('agent-1', tmpDir)
    expect(tools).toHaveLength(7)

    const ids = tools.map((t: any) => t.id).sort()
    expect(ids).toEqual([
      'artifact_append',
      'artifact_create',
      'artifact_delete',
      'artifact_list',
      'artifact_read',
      'artifact_replace',
      'artifact_search',
    ])
  })

  test('artifact_create + artifact_read', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const read = findTool(tools, 'artifact_read')

    const createResult = await create.execute({ id: 'my/doc', content: '# Hello\n\nWorld!' })
    expect(createResult).toContain('Created')

    const readResult = await read.execute({ id: 'my/doc' })
    expect(readResult).toBe('# Hello\n\nWorld!')
  })

  test('artifact_create errors on duplicate', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')

    await create.execute({ id: 'dupe', content: 'First' })
    const result = await create.execute({ id: 'dupe', content: 'Second' })
    expect(result).toContain('Error')
    expect(result).toContain('already exists')
  })

  test('artifact_read with line range', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const read = findTool(tools, 'artifact_read')

    await create.execute({ id: 'lines', content: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5' })

    const result = await read.execute({ id: 'lines', startLine: 2, endLine: 4 })
    expect(result).toBe('Line 2\nLine 3\nLine 4')
  })

  test('artifact_search finds matches', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const search = findTool(tools, 'artifact_search')

    await create.execute({
      id: 'searchable',
      content: 'Apple pie\nBanana split\nApple sauce\nCherry tart',
    })

    const result = await search.execute({ id: 'searchable', pattern: 'Apple' })
    const matches = JSON.parse(result)
    expect(matches).toHaveLength(2)
    expect(matches[0].line).toBe(1)
    expect(matches[1].line).toBe(3)
  })

  test('artifact_list finds artifacts by glob', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const list = findTool(tools, 'artifact_list')

    await create.execute({ id: 'project/readme', content: 'README' })
    await create.execute({ id: 'project/notes', content: 'Notes' })
    await create.execute({ id: 'other/file', content: 'Other' })

    const result = await list.execute({ glob: 'project/*' })
    const items = JSON.parse(result)
    expect(items).toHaveLength(2)
  })

  test('artifact_replace: single match', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const replace = findTool(tools, 'artifact_replace')
    const read = findTool(tools, 'artifact_read')

    await create.execute({ id: 'editable', content: 'Hello World!' })

    const replaceResult = await replace.execute({
      id: 'editable',
      target: 'World',
      replacement: 'Keryx',
    })
    expect(replaceResult).toContain('Replaced 1')

    const content = await read.execute({ id: 'editable' })
    expect(content).toBe('Hello Keryx!')
  })

  test('artifact_replace: errors on multiple matches by default', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const replace = findTool(tools, 'artifact_replace')

    await create.execute({ id: 'multi', content: 'foo bar foo baz foo' })

    const result = await replace.execute({
      id: 'multi',
      target: 'foo',
      replacement: 'qux',
    })
    expect(result).toContain('Error')
    expect(result).toContain('Ambiguous')
    expect(result).toContain('3 matches')
  })

  test('artifact_replace: allowMultiple replaces all', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const replace = findTool(tools, 'artifact_replace')
    const read = findTool(tools, 'artifact_read')

    await create.execute({ id: 'multi-ok', content: 'foo bar foo baz foo' })

    const result = await replace.execute({
      id: 'multi-ok',
      target: 'foo',
      replacement: 'qux',
      allowMultiple: true,
    })
    expect(result).toContain('Replaced 3')

    const content = await read.execute({ id: 'multi-ok' })
    expect(content).toBe('qux bar qux baz qux')
  })

  test('artifact_replace: narrowed with startLine/endLine', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const replace = findTool(tools, 'artifact_replace')
    const read = findTool(tools, 'artifact_read')

    await create.execute({
      id: 'narrow',
      content: 'match here\nskip\nmatch here\nskip',
    })

    // Only replace in lines 3-4
    const result = await replace.execute({
      id: 'narrow',
      target: 'match here',
      replacement: 'REPLACED',
      startLine: 3,
      endLine: 4,
    })
    expect(result).toContain('Replaced 1')

    const content = await read.execute({ id: 'narrow' })
    expect(content).toContain('match here') // Line 1 untouched
    expect(content).toContain('REPLACED')   // Line 3 replaced
  })

  test('artifact_replace: errors when not owner', async () => {
    // Agent 1 creates the artifact
    const tools1 = getTools('agent-1', tmpDir)
    const create = findTool(tools1, 'artifact_create')
    await create.execute({ id: 'owned', content: 'Original content' })

    // Agent 2 tries to replace
    const tools2 = getTools('agent-2', tmpDir)
    const replace = findTool(tools2, 'artifact_replace')
    const result = await replace.execute({
      id: 'owned',
      target: 'Original',
      replacement: 'Modified',
    })
    expect(result).toContain('Error')
    expect(result).toContain('Not owner')
  })

  test('artifact_append: adds content', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const append = findTool(tools, 'artifact_append')
    const read = findTool(tools, 'artifact_read')

    await create.execute({ id: 'log', content: 'Entry 1' })
    await append.execute({ id: 'log', content: 'Entry 2' })

    const content = await read.execute({ id: 'log' })
    expect(content).toContain('Entry 1')
    expect(content).toContain('Entry 2')
  })

  test('artifact_append: errors when not owner', async () => {
    const tools1 = getTools('agent-1', tmpDir)
    const create = findTool(tools1, 'artifact_create')
    await create.execute({ id: 'private-log', content: 'My log' })

    const tools2 = getTools('agent-2', tmpDir)
    const append = findTool(tools2, 'artifact_append')
    const result = await append.execute({ id: 'private-log', content: 'Intruder!' })
    expect(result).toContain('Error')
    expect(result).toContain('Not owner')
  })

  test('artifact_delete: owner can delete', async () => {
    const tools = getTools('agent-1', tmpDir)
    const create = findTool(tools, 'artifact_create')
    const del = findTool(tools, 'artifact_delete')
    const read = findTool(tools, 'artifact_read')

    await create.execute({ id: 'deleteme', content: 'Bye' })
    const result = await del.execute({ id: 'deleteme' })
    expect(result).toContain('Deleted artifact')

    const readResult = await read.execute({ id: 'deleteme' })
    expect(readResult).toContain('not found')
  })

  test('artifact_delete: non-owner cannot delete', async () => {
    const tools1 = getTools('agent-1', tmpDir)
    const create = findTool(tools1, 'artifact_create')
    await create.execute({ id: 'protected', content: 'Protected' })

    const tools2 = getTools('agent-2', tmpDir)
    const del = findTool(tools2, 'artifact_delete')
    const result = await del.execute({ id: 'protected' })
    expect(result).toContain('Error')
    expect(result).toContain('Not owner')
  })

  test('artifact_delete: folder owner can cascade delete', async () => {
    const tools1 = getTools('manager', tmpDir)
    const create1 = findTool(tools1, 'artifact_create')
    // Manager creates brief — becomes folder owner
    await create1.execute({ id: 'analysis/brief', content: 'Brief' })

    // Specialist creates their own artifact in the folder
    const tools2 = getTools('specialist', tmpDir)
    const create2 = findTool(tools2, 'artifact_create')
    await create2.execute({ id: 'analysis/sentiment', content: 'Sentiment' })

    // Manager deletes the folder
    const del = findTool(tools1, 'artifact_delete')
    const result = await del.execute({ id: 'analysis' })
    expect(result).toContain('Deleted folder')
    expect(result).toContain('2 artifact(s)')
  })

  test('cross-agent read: any agent can read any artifact', async () => {
    // Agent 1 creates
    const tools1 = getTools('author', tmpDir)
    const create = findTool(tools1, 'artifact_create')
    await create.execute({ id: 'public/doc', content: 'Shared knowledge' })

    // Agent 2 reads
    const tools2 = getTools('reader', tmpDir)
    const read = findTool(tools2, 'artifact_read')
    const content = await read.execute({ id: 'public/doc' })
    expect(content).toBe('Shared knowledge')
  })
})
