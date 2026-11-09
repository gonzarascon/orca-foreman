/// <reference types="node" />
// The plugin's worker: reads Linear through the `orca` CLI (reusing Orca's own Linear
// connection, so no API key), keeps the list of tickets sent to the Foreman, and launches or
// messages the Foreman agent in its home folder.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  addSent,
  type Config,
  findArgs,
  foremanPrompt,
  isClosed,
  type RawIssue,
  type Sent,
  sweepPrompt,
  takePrompt,
  toBoard,
  toConfig,
  toOpen
} from './board'
import type { Board } from './protocol'

const MANUAL = fileURLToPath(new URL('../AGENTS.md', import.meta.url))
// ponytail: apps opened from the macOS Dock get a minimal PATH without `orca`; fall back to the
// CLI inside the app bundle. Other installs set the `orcaCli` setting.
const MAC_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

function exec(cli: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cli, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      // A failing `orca … --json` still prints its error as JSON on stdout: parse that instead.
      error && !stdout ? reject(error) : resolve(stdout)
    )
  )
}

async function orcaJson(cli: string, args: string[]): Promise<any> {
  let out: string
  try {
    out = await exec(cli, args)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || cli !== 'orca') throw error
    out = await exec(MAC_CLI, args)
  }
  const parsed = JSON.parse(out)
  if (!parsed.ok) {
    const error = new Error(parsed.error?.message ?? `orca ${args.slice(0, 2).join(' ')} failed`)
    throw Object.assign(error, { code: parsed.error?.code as string | undefined })
  }
  return parsed.result
}

/**
 * Types a one-line prompt into the Foreman's chat and submits it. `orca terminal send` takes the
 * `term_…` handle agent.launch returns and pastes into a running agent properly, which the
 * plugin API's terminal.sendText does not. False when that terminal is gone.
 */
async function tell(cli: string, terminalId: string, text: string): Promise<boolean> {
  try {
    await orcaJson(cli, ['terminal', 'send', '--terminal', terminalId, '--text', text, '--enter', '--json'])
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'terminal_handle_stale') return false
    throw error
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const expand = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : resolve(path))

/** `<home>/tickets.json`: every ticket you sent the Foreman. The Foreman reads it on each sweep. */
const listFile = (c: Config) => join(expand(c.home), 'tickets.json')

function readSent(c: Config): Sent[] {
  try {
    return JSON.parse(readFileSync(listFile(c), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function writeSent(c: Config, list: Sent[]): void {
  mkdirSync(expand(c.home), { recursive: true })
  writeFileSync(listFile(c), `${JSON.stringify(list, null, 2)}\n`)
}

/** Settings as the Foreman sees them: an absolute home folder. */
const brief = (c: Config): Config => ({ ...c, home: expand(c.home) })

/**
 * The Foreman's home: a plain folder (not a repo), created if missing and added to Orca as a
 * folder project the first time, so the Foreman needs no repo of its own.
 */
async function homeWorkspace(orca: OrcaWorkerApi, c: Config) {
  const home = expand(c.home)
  mkdirSync(home, { recursive: true })
  const path = realpathSync(home)
  // ponytail: matched by path in workspace.list; if Orca ever truncates that list before this
  // folder, `repo add` runs again. Store the workspace id if that shows up.
  const find = async () =>
    (await orca.host.call('workspace.list')).workspaces.find((w) => w.kind === 'folder' && w.path === path)
  let workspace = await find()
  if (!workspace) {
    await orcaJson(c.cli, ['repo', 'add', '--path', path, '--kind', 'folder', '--json'])
    workspace = await find()
  }
  if (!workspace) throw new Error(`Added ${path} to Orca, but it isn't listed as a workspace yet. Press Start again.`)
  return { id: workspace.id, path }
}

export default function activate(orca: OrcaWorkerApi): void {
  const config = async () => toConfig(await orca.settings.get())

  orca.panels.handle('board.get', async (): Promise<Board> => {
    const c = await config()
    try {
      const sent = readSent(c)
      // ponytail: one `orca linear issue` per sent ticket; batch it if the list grows past a few dozen.
      const issues: RawIssue[] = await Promise.all(
        sent.map(async (t) => (await orcaJson(c.cli, ['linear', 'issue', t.id, '--json'])).issue)
      )
      // Closed tickets leave the list, so the board and the Foreman only see open work.
      const open = sent.filter((_, i) => !isClosed(issues[i]))
      if (open.length !== sent.length) writeSent(c, open)
      return { ...toBoard(issues, c), fetchedAt: Date.now(), error: null }
    } catch (error) {
      return { needsYou: [], working: [], waiting: [], fetchedAt: Date.now(), error: message(error) }
    }
  })

  orca.panels.handle('tickets.find', async ({ query }) => {
    const c = await config()
    return toOpen((await orcaJson(c.cli, findArgs(c, query.trim()))).issues)
  })

  orca.panels.handle('tickets.send', async ({ ticket, terminalId }) => {
    const c = await config()
    writeSent(c, addSent(readSent(c), { ...ticket, sentAt: new Date().toISOString() }))
    return { told: terminalId ? await tell(c.cli, terminalId, takePrompt(ticket, MANUAL, brief(c))) : false }
  })

  orca.panels.handle('foreman.start', async () => {
    const c = await config()
    const home = await homeWorkspace(orca, c)
    const { terminalId } = await orca.host.call('agent.launch', {
      workspaceId: home.id,
      agent: c.agent,
      prompt: foremanPrompt(MANUAL, { ...c, home: home.path })
    })
    return { workspaceId: home.id, terminalId, startedAt: Date.now() }
  })

  orca.panels.handle('foreman.open', ({ workspaceId }) =>
    orca.host.call('workspace.open', { workspaceId })
  )

  orca.panels.handle('foreman.sweep', async ({ terminalId }) => {
    const c = await config()
    return { accepted: await tell(c.cli, terminalId, sweepPrompt(MANUAL, brief(c))) }
  })
}
