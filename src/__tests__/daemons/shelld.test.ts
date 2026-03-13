/**
 * shelld — Tests
 *
 * Tests for the shell session broker daemon using a mock ShellDriver.
 */

import { describe, test, expect } from 'bun:test'
import { createKeryx } from '../../keryx.js'
import { shelld } from '../../daemons/shelld.js'
import type { ShellDriver, ShellProcess, ShellSession } from '../../daemons/shelld.js'
import type { AgentDefinition } from '../../types.js'

// ── Mock Driver ─────────────────────────────────────────────────────────────

type MockProcess = ShellProcess & {
  /** Simulate data arriving from the process */
  emitData(chunk: string): void
  /** Simulate the process exiting */
  emitExit(code: number): void
  /** All data written to stdin */
  stdinHistory: string[]
  killed: boolean
}

function createMockProcess(): MockProcess {
  const dataCallbacks: ((chunk: string) => void)[] = []
  const exitCallbacks: ((code: number) => void)[] = []
  const stdinHistory: string[] = []
  let killed = false

  return {
    stdinHistory,
    get killed() { return killed },
    write(data: string) {
      stdinHistory.push(data)
    },
    onData(cb) {
      dataCallbacks.push(cb)
    },
    onExit(cb) {
      exitCallbacks.push(cb)
    },
    kill() {
      killed = true
    },
    emitData(chunk: string) {
      for (const cb of dataCallbacks) cb(chunk)
    },
    emitExit(code: number) {
      for (const cb of exitCallbacks) cb(code)
    },
  }
}

type MockDriver = ShellDriver & {
  /** All spawned processes, keyed by commandId auto-incrementing */
  spawned: MockProcess[]
  connectedHosts: Set<string>
  disconnectedHosts: Set<string>
  /** Optional: configure auto-complete behavior per spawn */
  autoComplete?: { output: string; exitCode: number }
}

function createMockDriver(): MockDriver {
  const spawned: MockProcess[] = []
  const connectedHosts = new Set<string>()
  const disconnectedHosts = new Set<string>()
  let autoComplete: { output: string; exitCode: number } | undefined

  return {
    spawned,
    connectedHosts,
    disconnectedHosts,
    get autoComplete() { return autoComplete },
    set autoComplete(v) { autoComplete = v },

    async connect(hostId: string) {
      connectedHosts.add(hostId)
    },
    async spawn(_hostId: string, _command: string) {
      const proc = createMockProcess()
      spawned.push(proc)

      // If auto-complete is set, emit data and exit after handlers are registered
      if (autoComplete) {
        const { output, exitCode } = autoComplete
        setTimeout(() => {
          proc.emitData(output)
          proc.emitExit(exitCode)
        }, 0)
      }

      return proc
    },
    async disconnect(hostId: string) {
      disconnectedHosts.add(hostId)
      connectedHosts.delete(hostId)
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(id: string, name: string, config?: Record<string, unknown>): AgentDefinition {
  return {
    id,
    name,
    instruction: `You are ${name}.`,
    config,
  }
}

function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('shelld', () => {
  test('agent with shelld config receives shell_exec, shell_output, shell_input tools', async () => {
    let capturedTools: any[] = []
    const driver = createMockDriver()

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('coder', 'Coder', { 'shelld': { hosts: ['dev-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'coder', body: 'go' })
    await wait(200)

    expect(capturedTools.find((t: any) => t.name === 'shell_exec')).toBeDefined()
    expect(capturedTools.find((t: any) => t.name === 'shell_output')).toBeDefined()
    expect(capturedTools.find((t: any) => t.name === 'shell_input')).toBeDefined()

    await kx.stop()
  })

  test('agent without shelld config gets no shelld tools', async () => {
    let capturedTools: any[] = []
    const driver = createMockDriver()

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('plain', 'Plain Agent'),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          capturedTools = params.tools ?? []
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'plain', body: 'go' })
    await wait(200)

    expect(capturedTools.find((t: any) => t.name === 'shell_exec')).toBeUndefined()
    expect(capturedTools.find((t: any) => t.name === 'shell_output')).toBeUndefined()
    expect(capturedTools.find((t: any) => t.name === 'shell_input')).toBeUndefined()

    await kx.stop()
  })

  test('shell_exec returns full content for short output', async () => {
    let execResult = ''
    let callCount = 0
    const driver = createMockDriver()
    driver.autoComplete = { output: 'hello world\n', exitCode: 0 }

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('coder', 'Coder', { 'shelld': { hosts: ['dev-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "coder"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'dev-box', command: 'echo hello world' },
                }],
              }
            }
            const toolMsg = params.messages.find((m: any) => m.role === 'tool')
            execResult = toolMsg?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'coder', body: 'run echo' })
    await wait(300)

    const parsed = JSON.parse(execResult)
    expect(parsed.commandId).toBeDefined()
    expect(parsed.status).toBe('done')
    expect(parsed.exitCode).toBe(0)
    // Short output — should have 'content', not 'head'/'tail'
    expect(parsed.output.content).toBe('hello world\n')
    expect(parsed.output.head).toBeUndefined()
    expect(parsed.output.tail).toBeUndefined()

    await kx.stop()
  })

  test('shell_exec returns head/tail for large output', async () => {
    let execResult = ''
    let callCount = 0
    const driver = createMockDriver()
    // Generate output larger than headChars + tailChars (default 500+500=1000)
    const largeOutput = 'X'.repeat(2000)
    driver.autoComplete = { output: largeOutput, exitCode: 0 }

    const shell = shelld({ driver, headChars: 100, tailChars: 100 })
    const kx = createKeryx({
      agents: [
        makeAgent('coder', 'Coder', { 'shelld': { hosts: ['dev-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "coder"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'dev-box', command: 'cat huge.log' },
                }],
              }
            }
            const toolMsg = params.messages.find((m: any) => m.role === 'tool')
            execResult = toolMsg?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'coder', body: 'cat' })
    await wait(300)

    const parsed = JSON.parse(execResult)
    expect(parsed.output.head).toHaveLength(100)
    expect(parsed.output.tail).toHaveLength(100)
    expect(parsed.output.totalBytes).toBe(2000)
    expect(parsed.output.content).toBeUndefined()

    await kx.stop()
  })

  test('shell_exec with timeout returns running status for slow commands', async () => {
    let execResult = ''
    let callCount = 0
    const driver = createMockDriver()
    // No autoComplete — process stays running

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('coder', 'Coder', { 'shelld': { hosts: ['dev-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "coder"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'dev-box', command: 'npm run dev', timeout: 100 },
                }],
              }
            }
            const toolMsg = params.messages.find((m: any) => m.role === 'tool')
            execResult = toolMsg?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'coder', body: 'start server' })
    await wait(500)

    const parsed = JSON.parse(execResult)
    expect(parsed.commandId).toBeDefined()
    expect(parsed.status).toBe('running')
    expect(parsed.exitCode).toBeNull()

    await kx.stop()
  })

  test('shell_output paginates output buffer', async () => {
    let outputResult = ''
    let commandId = ''
    let callCount = 0
    const driver = createMockDriver()
    const output = 'ABCDEFGHIJ' // 10 chars
    driver.autoComplete = { output, exitCode: 0 }

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('coder', 'Coder', { 'shelld': { hosts: ['dev-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "coder"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'dev-box', command: 'echo ABCDEFGHIJ' },
                }],
              }
            }
            if (callCount === 2) {
              // Extract commandId from exec result
              const toolMsg = params.messages.find((m: any) => m.role === 'tool')
              const execParsed = JSON.parse(toolMsg?.content ?? '{}')
              commandId = execParsed.commandId
              return {
                toolCalls: [{
                  id: 'call-2',
                  name: 'shell_output',
                  arguments: { commandId, offset: 3, length: 4 },
                }],
              }
            }
            const toolMsgs = params.messages.filter((m: any) => m.role === 'tool')
            outputResult = toolMsgs[toolMsgs.length - 1]?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'coder', body: 'paginate' })
    await wait(500)

    const parsed = JSON.parse(outputResult)
    expect(parsed.content).toBe('DEFG')
    expect(parsed.offset).toBe(3)
    expect(parsed.length).toBe(4)
    expect(parsed.totalBytes).toBe(10)

    await kx.stop()
  })

  test('shell_input writes to stdin of running process', async () => {
    let inputResult = ''
    let commandId = ''
    let callCount = 0
    const driver = createMockDriver()
    // No autoComplete — process stays running for stdin

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('coder', 'Coder', { 'shelld': { hosts: ['dev-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "coder"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'dev-box', command: 'bash', timeout: 100 },
                }],
              }
            }
            if (callCount === 2) {
              const toolMsg = params.messages.find((m: any) => m.role === 'tool')
              const execParsed = JSON.parse(toolMsg?.content ?? '{}')
              commandId = execParsed.commandId
              return {
                toolCalls: [{
                  id: 'call-2',
                  name: 'shell_input',
                  arguments: { commandId, input: 'ls -la\n' },
                }],
              }
            }
            const toolMsgs = params.messages.filter((m: any) => m.role === 'tool')
            inputResult = toolMsgs[toolMsgs.length - 1]?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'coder', body: 'interactive' })
    await wait(500)

    const parsed = JSON.parse(inputResult)
    expect(parsed.ok).toBe(true)
    // Verify the mock process received the stdin
    expect(driver.spawned[0]!.stdinHistory).toContain('ls -la\n')

    await kx.stop()
  })

  test('host access control denies unauthorized hosts', async () => {
    let execResult = ''
    let callCount = 0
    const driver = createMockDriver()

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('coder', 'Coder', { 'shelld': { hosts: ['dev-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "coder"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'production-db', command: 'rm -rf /' },
                }],
              }
            }
            const toolMsg = params.messages.find((m: any) => m.role === 'tool')
            execResult = toolMsg?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'coder', body: 'hack' })
    await wait(300)

    expect(execResult).toContain('No access to host')
    expect(execResult).toContain('production-db')

    await kx.stop()
  })

  test('session access control denies output read for unauthorized host', async () => {
    let outputResult = ''
    let adminCallCount = 0
    let spyCallCount = 0
    const driver = createMockDriver()
    driver.autoComplete = { output: 'secret data', exitCode: 0 }

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('admin', 'Admin', { 'shelld': { hosts: ['secure-box'] } }),
        makeAgent('spy', 'Spy', { 'shelld': { hosts: ['public-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "admin"')) {
            adminCallCount++
            if (adminCallCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'secure-box', command: 'cat secrets.txt' },
                }],
              }
            }
            return { content: 'done' }
          }
          if (systemMsg.content.includes('agent "spy"')) {
            spyCallCount++
            if (spyCallCount === 1) {
              // Spy tries to read admin's session
              const sessions = [...shell.sessions.values()]
              const stolenId = sessions[0]!.commandId
              return {
                toolCalls: [{
                  id: 'call-spy',
                  name: 'shell_output',
                  arguments: { commandId: stolenId },
                }],
              }
            }
            // Capture tool result
            const toolMsgs = params.messages.filter((m: any) => m.role === 'tool')
            outputResult = toolMsgs[toolMsgs.length - 1]?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    // Admin creates a session
    await kx.send({ to: 'admin', body: 'read secrets' })
    await wait(300)
    // Spy tries to access it
    await kx.send({ to: 'spy', body: 'steal data' })
    await wait(300)

    expect(outputResult).toContain('No access to host')

    await kx.stop()
  })

  test('shared sessions: two agents on same host can share a session', async () => {
    let outputResult = ''
    let devACallCount = 0
    let devBCallCount = 0
    const driver = createMockDriver()
    driver.autoComplete = { output: 'shared output\n', exitCode: 0 }

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('dev-a', 'Dev A', { 'shelld': { hosts: ['shared-box'] } }),
        makeAgent('dev-b', 'Dev B', { 'shelld': { hosts: ['shared-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "dev-a"')) {
            devACallCount++
            if (devACallCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'shared-box', command: 'echo shared data' },
                }],
              }
            }
            return { content: 'done' }
          }
          if (systemMsg.content.includes('agent "dev-b"')) {
            devBCallCount++
            if (devBCallCount === 1) {
              // dev-b reads the session created by dev-a
              const sessions = [...shell.sessions.values()]
              const sharedId = sessions[0]!.commandId
              return {
                toolCalls: [{
                  id: 'call-b',
                  name: 'shell_output',
                  arguments: { commandId: sharedId },
                }],
              }
            }
            // Capture tool result
            const toolMsgs = params.messages.filter((m: any) => m.role === 'tool')
            outputResult = toolMsgs[toolMsgs.length - 1]?.content ?? ''
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'dev-a', body: 'start shared task' })
    await wait(300)
    await kx.send({ to: 'dev-b', body: 'read output' })
    await wait(300)

    const parsed = JSON.parse(outputResult)
    expect(parsed.content).toBe('shared output\n')

    await kx.stop()
  })

  test('cleanup on stop: kills sessions and disconnects hosts', async () => {
    const driver = createMockDriver()
    // No autoComplete — process stays running
    let callCount = 0

    const shell = shelld({ driver })
    const kx = createKeryx({
      agents: [
        makeAgent('coder', 'Coder', { 'shelld': { hosts: ['dev-box'] } }),
      ],
      daemons: [shell.daemon],
      pollingInterval: 10,
      defaultProvider: {
        generate: async (params: any) => {
          const systemMsg = params.messages.find((m: any) => m.role === 'system')
          if (systemMsg.content.includes('agent "coder"')) {
            callCount++
            if (callCount === 1) {
              return {
                toolCalls: [{
                  id: 'call-1',
                  name: 'shell_exec',
                  arguments: { hostId: 'dev-box', command: 'npm run dev', timeout: 100 },
                }],
              }
            }
            return { content: 'done' }
          }
          return { content: 'ok' }
        },
      },
    })

    kx.start()
    await kx.send({ to: 'coder', body: 'start server' })
    await wait(300)

    // Verify session exists and process is running
    expect(driver.spawned.length).toBe(1)
    expect(driver.connectedHosts.has('dev-box')).toBe(true)

    await kx.stop()

    // After stop: process killed, host disconnected, sessions cleared
    expect(driver.spawned[0]!.killed).toBe(true)
    expect(driver.disconnectedHosts.has('dev-box')).toBe(true)
    expect(shell.sessions.size).toBe(0)
  })
})
