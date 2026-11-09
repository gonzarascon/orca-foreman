import { assert, test } from 'orca/testing'
import { addSent, findArgs, foremanPrompt, sweepPrompt, takePrompt, toBoard, toConfig, toTickets } from './board'

const issue = (identifier: string, priority: number, updatedAt: string, state = 'Todo', type = 'unstarted') => ({
  identifier,
  title: `Title ${identifier}`,
  url: `https://linear.app/x/issue/${identifier}`,
  priority,
  priorityLabel: String(priority),
  assignee: null,
  updatedAt,
  state: { name: state, type }
})

test('sorts urgent first, no priority last, then most recently updated', () => {
  const ids = toTickets([
    issue('NONE', 0, '2026-01-03'),
    issue('LOW', 4, '2026-01-01'),
    issue('URGENT-OLD', 1, '2026-01-01'),
    issue('URGENT-NEW', 1, '2026-01-02')
  ]).map((t) => t.id)
  assert.deepEqual(ids, ['URGENT-NEW', 'URGENT-OLD', 'LOW', 'NONE'])
})

test('sorts sent tickets by state and drops closed ones', () => {
  const board = toBoard(
    [
      issue('REVIEW', 2, '2026-01-01', 'In Review', 'started'),
      issue('WORKING', 2, '2026-01-01', 'In Progress', 'started'),
      issue('TRIAGE', 2, '2026-01-01', 'Triage', 'triage'),
      issue('DONE', 2, '2026-01-01', 'Done', 'completed')
    ],
    toConfig({})
  )
  assert.deepEqual(
    [board.needsYou, board.working, board.waiting].map((column) => column.map((t) => t.id)),
    [['REVIEW'], ['WORKING'], ['TRIAGE']]
  )
})

test('sending a ticket again moves it to the end of the list', () => {
  const a = { id: 'A', title: 'a', url: 'u', sentAt: '1' }
  const b = { id: 'B', title: 'b', url: 'u', sentAt: '2' }
  assert.deepEqual(addSent([a, b], { ...a, sentAt: '3' }).map((t) => `${t.id}${t.sentAt}`), ['B2', 'A3'])
})

test('falls back to defaults for blank settings', () => {
  const c = toConfig({ reviewState: '  ', linearTeam: 'ENG' })
  assert.equal(c.reviewState, 'In Review')
  assert.equal(c.home, '~/.foreman')
  assert.ok(findArgs(c, '').join(' ').includes('--assignee me --team ENG'))
  assert.deepEqual(findArgs(c, 'ENG-7').slice(0, 3), ['linear', 'search', 'ENG-7'])
})

test('every prompt is one line and carries the briefing', () => {
  const c = toConfig({ reviewState: 'Needs Review' })
  const manual = '/plugins/foreman/AGENTS.md'
  for (const prompt of [
    foremanPrompt(manual, c),
    sweepPrompt(manual, c),
    takePrompt({ id: 'ENG-7', url: 'https://linear.app/x/issue/ENG-7' }, manual, c)
  ]) {
    assert.ok(!prompt.includes('\n'))
    assert.ok(prompt.includes('`/plugins/foreman/AGENTS.md`'))
    assert.ok(prompt.includes('`orca skills get orchestration`'))
    assert.ok(prompt.includes('reviewState="Needs Review"'))
  }
  assert.ok(takePrompt({ id: 'ENG-7', url: 'U' }, manual, c).startsWith('Foreman: take ENG-7 now (U).'))
})
