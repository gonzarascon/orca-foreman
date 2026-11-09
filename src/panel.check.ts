// `orca plugin check` renders the panel once per scenario. `requests` stands in for the
// worker so check never shells out to the real `orca` CLI or Linear.
import { defineCheck } from 'orca/testing'

const ticket = (id: string, priority: number, priorityLabel: string, title: string, state: string) => ({
  id,
  title,
  url: `https://linear.app/acme/issue/${id}`,
  state,
  priority,
  priorityLabel,
  assignee: null,
  updatedAt: '2026-01-01'
})

const yours = () => [
  ticket('ACME-21', 2, 'High', 'Speed up search', 'Todo'),
  ticket('ACME-22', 0, 'none', 'Update the onboarding email', 'Triage')
]
const nothing = { needsYou: [], working: [], waiting: [], fetchedAt: 0, error: null }

export default defineCheck({
  empty: {
    requests: { 'board.get': () => nothing, 'tickets.find': yours }
  },
  busy: {
    storage: { foreman: { workspaceId: 'w-1', terminalId: 't-1', startedAt: 0 } },
    requests: {
      'board.get': () => ({
        ...nothing,
        needsYou: [
          ticket('ACME-12', 1, 'Urgent', 'Checkout fails on Safari', 'In Review'),
          ticket('ACME-9', 3, 'Medium', 'Pick a chart library', 'In Review')
        ],
        working: [ticket('ACME-14', 2, 'High', 'Add CSV export', 'In Progress')],
        waiting: [ticket('ACME-15', 4, 'Low', 'Tidy settings copy', 'Todo')]
      }),
      'tickets.find': yours
    },
    events: [
      { event: 'agent.status.changed', payload: { workspaceId: 'w-1', paneKey: 'p', terminalId: 't-1', state: 'working', receivedAt: 0 } }
    ]
  },
  linearError: {
    requests: {
      'board.get': () => ({ ...nothing, error: 'Linear is not connected in Orca' }),
      'tickets.find': () => []
    }
  }
})
