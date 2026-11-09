import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Board } from './protocol'

const ticket = (id: string, state = 'Todo') => ({
  id,
  title: `Ticket ${id}`,
  url: `https://linear.app/acme/issue/${id}`,
  state,
  priority: 1,
  priorityLabel: 'Urgent',
  assignee: null,
  updatedAt: '2026-01-01'
})

const board: Board = {
  needsYou: [ticket('ENG-1', 'In Review')],
  working: [ticket('ENG-3', 'In Progress')],
  waiting: [],
  fetchedAt: 0,
  error: null
}
const empty: Board = { ...board, needsYou: [], working: [] }
const running = { foreman: { workspaceId: 'w-1', terminalId: 't-1', startedAt: 0 } }
const tree = (view: { tree(): unknown }) => JSON.stringify(view.tree())

test('shows the sent tickets and drives the Foreman', async () => {
  const sent: string[] = []
  const host = mockHost({
    capabilities: ['storage:own', 'agent:read'],
    requests: {
      'board.get': () => board,
      'tickets.find': () => [],
      'foreman.start': () => ({ workspaceId: 'w-1', terminalId: 't-1', startedAt: 0 }),
      'foreman.open': () => ({ opened: true }),
      'foreman.sweep': ({ terminalId }) => (sent.push(terminalId), { accepted: true })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(tree(view).includes('"title":"Needs you (1)"'))
  assert.ok(tree(view).includes('"title":"Working (1)"'))
  assert.ok(!tree(view).includes('"title":"Waiting'), 'empty groups are hidden')
  assert.ok(view.find({ text: 'Send back' }))
  assert.ok(view.find({ text: 'Not started' }))

  await view.press({ text: 'Start foreman' })
  assert.ok(view.find({ text: 'Started' }))
  assert.deepEqual(view.persisted.storage.foreman, running.foreman)

  // Events carry Orca's own terminal id, not the launch handle: the badge follows the workspace.
  await view.emit('agent.status.changed', { workspaceId: 'w-1', paneKey: 'p', terminalId: 'pane-9', state: 'blocked', receivedAt: 1 })
  assert.ok(view.find({ text: 'Blocked' }))

  await view.press({ text: 'Sweep' })
  assert.deepEqual(sent, ['t-1'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('Send tells the running Foreman and says so', async () => {
  const sends: { ticket: { id: string }; terminalId: string | null }[] = []
  const host = mockHost({
    storage: running,
    requests: {
      'board.get': () => empty,
      'tickets.find': () => [ticket('ENG-4')],
      'tickets.send': (input) => (sends.push(input), { told: true })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Send' })
  assert.deepEqual(sends.map((s) => [s.ticket.id, s.terminalId]), [['ENG-4', 't-1']])
  assert.ok(tree(view).includes('Sent ENG-4. The Foreman is starting a worker for it.'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Send starts the Foreman when there is none', async () => {
  const host = mockHost({
    requests: {
      'board.get': () => empty,
      'tickets.find': () => [ticket('ENG-4')],
      'tickets.send': () => ({ told: false }),
      'foreman.start': () => running.foreman
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Send' })
  assert.deepEqual(view.persisted.storage.foreman, running.foreman)
  assert.ok(tree(view).includes('started the Foreman'))
  await view.unmount()
})

test('searches Linear and hides tickets already sent', async () => {
  const queries: string[] = []
  const host = mockHost({
    requests: {
      'board.get': () => board,
      'tickets.find': ({ query }) => (queries.push(query), [ticket('ENG-3'), ticket('ENG-8')])
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'Search Linear' }, 'checkout', { submit: true })
  assert.deepEqual(queries, ['', 'checkout'])
  assert.ok(tree(view).includes('Open tickets matching \\"checkout\\"'))
  assert.equal(view.findAll({ text: 'Send' }).length, 1, 'ENG-3 is already on the board')
  await view.unmount()
})

test('a failed send stays on screen, and a closed Foreman is forgotten', async () => {
  const host = mockHost({
    storage: running,
    requests: {
      'board.get': () => empty,
      'tickets.find': () => [ticket('ENG-4')],
      'tickets.send': () => {
        throw new Error('Linear is down')
      },
      'foreman.sweep': () => ({ accepted: false })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Send' })
  assert.ok(view.summary().includes('Callout danger "Something failed"'))
  assert.ok(tree(view).includes('Linear is down'))

  await view.press({ text: 'Sweep' })
  assert.ok(tree(view).includes("The Foreman's terminal is closed"))
  assert.equal(view.persisted.storage.foreman, null)
  await view.unmount()
})

test('shows a Linear error from the worker', async () => {
  const host = mockHost({
    requests: {
      'board.get': () => ({ ...empty, error: 'Connect Linear first' }),
      'tickets.find': () => []
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.summary().includes('Callout warning "Couldn\'t read Linear"'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
