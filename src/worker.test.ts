/// <reference types="node" />
// Runs src/worker.ts's activate(orca) over a mock host. Linear reads go through a fake `orca`
// CLI script, so the tests never touch a real Linear workspace.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'foreman-')))

/** A fake `orca` that prints `output` and logs its arguments to `<path>.log`. */
function fakeCli(output: object): string {
  const path = join(scratch(), 'orca')
  writeFileSync(path, `#!/bin/sh\necho "$*" >> "$0.log"\ncat <<'EOF'\n${JSON.stringify(output)}\nEOF\n`)
  chmodSync(path, 0o755)
  return path
}

const issue = {
  identifier: 'ENG-1',
  title: 'Fix login',
  url: 'https://linear.app/acme/issue/ENG-1',
  description: 'never sent to the panel',
  state: { name: 'In Progress', type: 'started' },
  priority: 2,
  priorityLabel: 'High',
  assignee: { displayName: 'Ada' },
  updatedAt: '2026-01-01T00:00:00Z'
}
const closed = { ...issue, identifier: 'ENG-2', state: { name: 'Done', type: 'completed' } }

/** A home folder whose tickets.json already lists `ids`. */
function homeWith(ids: string[]): string {
  const home = scratch()
  const list = ids.map((id) => ({ id, title: id, url: `https://linear.app/acme/issue/${id}`, sentAt: '2026-01-01' }))
  writeFileSync(join(home, 'tickets.json'), JSON.stringify(list))
  return home
}

const listed = (home: string) => JSON.parse(readFileSync(join(home, 'tickets.json'), 'utf8')).map((t: { id: string }) => t.id)

test('the board shows sent tickets by their Linear state', async () => {
  const home = homeWith(['ENG-1'])
  const cli = fakeCli({ ok: true, result: { issue } })
  const worker = await mountWorker(main, { host: mockHost({ settings: { home, orcaCli: cli } }) })
  const board = await worker.request('board.get')
  assert.equal(board.error, null)
  assert.deepEqual(board.working, [
    {
      id: 'ENG-1',
      title: 'Fix login',
      url: issue.url,
      state: 'In Progress',
      priority: 2,
      priorityLabel: 'High',
      assignee: 'Ada',
      updatedAt: issue.updatedAt
    }
  ])
  assert.deepEqual([board.needsYou, board.waiting], [[], []])
  assert.equal(readFileSync(`${cli}.log`, 'utf8').trim(), 'linear issue ENG-1 --json')
  await worker.deactivate()
})

test('closed tickets leave the list', async () => {
  const home = homeWith(['ENG-2'])
  const worker = await mountWorker(main, {
    host: mockHost({ settings: { home, orcaCli: fakeCli({ ok: true, result: { issue: closed } }) } })
  })
  const board = await worker.request('board.get')
  assert.deepEqual([board.needsYou, board.working, board.waiting], [[], [], []])
  assert.deepEqual(listed(home), [])
  await worker.deactivate()
})

test('an empty home folder is an empty board, not an error', async () => {
  const worker = await mountWorker(main, { host: mockHost({ settings: { home: join(scratch(), 'new') } }) })
  const board = await worker.request('board.get')
  assert.equal(board.error, null)
  assert.deepEqual(board.waiting, [])
  await worker.deactivate()
})

test('finds open tickets by search, or yours when the search is empty', async () => {
  const cli = fakeCli({ ok: true, result: { issues: [issue, closed] } })
  const worker = await mountWorker(main, { host: mockHost({ settings: { orcaCli: cli } }) })
  const found = await worker.request('tickets.find', { query: ' login ' })
  assert.deepEqual(found.map((t) => t.id), ['ENG-1'], 'skips closed tickets')
  await worker.request('tickets.find', { query: '' })
  const [search, mine] = readFileSync(`${cli}.log`, 'utf8').trim().split('\n')
  assert.match(search, /^linear search login /)
  assert.match(mine, /--assignee me /)
  await worker.deactivate()
})

test('sending lists the ticket and tells the Foreman to take it', async () => {
  const home = homeWith(['ENG-1', 'ENG-5'])
  const cli = fakeCli({ ok: true, result: {} })
  const worker = await mountWorker(main, { host: mockHost({ settings: { home, orcaCli: cli } }) })
  const ticket = { id: 'ENG-1', title: 'Fix login', url: issue.url }

  assert.deepEqual(await worker.request('tickets.send', { ticket, terminalId: 'term_1' }), { told: true })
  assert.deepEqual(listed(home), ['ENG-5', 'ENG-1'], 'sent again: moved to the end')
  const typed = readFileSync(`${cli}.log`, 'utf8').trim()
  assert.ok(typed.startsWith(`terminal send --terminal term_1 --text Foreman: take ENG-1 now (${issue.url}).`))
  assert.ok(typed.endsWith(' --enter --json'))
  assert.ok(typed.includes(`home=\`${home}\``))
  assert.equal(typed.split('\n').length, 1, 'one line')

  const other = { id: 'ENG-9', title: 'New', url: 'https://linear.app/acme/issue/ENG-9' }
  assert.deepEqual(await worker.request('tickets.send', { ticket: other, terminalId: null }), { told: false })
  assert.deepEqual(listed(home), ['ENG-5', 'ENG-1', 'ENG-9'])
  await worker.deactivate()
})

test('a closed Foreman terminal reads as not told, so the panel starts a new one', async () => {
  const cli = fakeCli({ ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' } })
  const worker = await mountWorker(main, { host: mockHost({ settings: { home: scratch(), orcaCli: cli } }) })
  const ticket = { id: 'ENG-1', title: 'Fix login', url: issue.url }
  assert.deepEqual(await worker.request('tickets.send', { ticket, terminalId: 'term_gone' }), { told: false })
  assert.deepEqual(await worker.request('foreman.sweep', { terminalId: 'term_gone' }), { accepted: false })
  await worker.deactivate()
})

test('reports CLI errors on the board instead of throwing', async () => {
  const home = homeWith(['ENG-1'])
  const cli = fakeCli({ ok: false, error: { code: 'linear_not_connected', message: 'Connect Linear first' } })
  const worker = await mountWorker(main, { host: mockHost({ settings: { home, orcaCli: cli } }) })
  const board = await worker.request('board.get')
  assert.equal(board.error, 'Connect Linear first')
  assert.deepEqual(board.needsYou, [])
  await worker.deactivate()
})

test('launches the Foreman in its existing home folder, then opens and sweeps it', async () => {
  const home = scratch()
  const cli = fakeCli({ ok: true, result: {} })
  const host = mockHost({
    settings: { home, orcaCli: cli },
    results: {
      'workspace.list': {
        workspaces: [{ id: 'f-1', kind: 'folder', name: 'foreman', path: home, branch: null, hostId: null }],
        truncated: false
      },
      'agent.launch': { terminalId: 't-1' },
      'workspace.open': { opened: true }
    }
  })
  const worker = await mountWorker(main, { host })

  const started = await worker.request('foreman.start')
  assert.deepEqual([started.workspaceId, started.terminalId], ['f-1', 't-1'])
  const [launch] = host.callsOf('agent.launch') as { agent: string; prompt: string }[]
  assert.equal(launch.agent, 'claude')
  assert.match(launch.prompt, /AGENTS\.md`/)
  assert.ok(launch.prompt.includes(`home=\`${home}\``))
  assert.equal(existsSync(`${cli}.log`), false, 'no repo add when the folder is already in Orca')

  assert.deepEqual(await worker.request('foreman.open', { workspaceId: 'f-1' }), { opened: true })
  assert.deepEqual(await worker.request('foreman.sweep', { terminalId: 't-1' }), { accepted: true })
  assert.ok(readFileSync(`${cli}.log`, 'utf8').startsWith('terminal send --terminal t-1 --text Foreman: sweep now.'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('creates the home folder and adds it to Orca as a folder project', async () => {
  const home = join(scratch(), 'nested', 'foreman')
  const cli = fakeCli({ ok: true, result: {} })
  const host = mockHost({
    settings: { home, orcaCli: cli },
    results: { 'workspace.list': { workspaces: [], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  // The mock host never lists the new folder, so Start asks to be pressed again.
  await assert.rejects(worker.request('foreman.start'), /isn't listed as a workspace yet/)
  assert.ok(existsSync(home))
  assert.equal(readFileSync(`${cli}.log`, 'utf8').trim(), `repo add --path ${home} --kind folder --json`)
  await worker.deactivate()
})
