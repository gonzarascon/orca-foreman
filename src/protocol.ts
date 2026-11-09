// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type Ticket = {
  id: string
  title: string
  url: string
  /** Workflow state name, as Linear shows it. */
  state: string
  priority: number
  priorityLabel: string
  assignee: string | null
  updatedAt: string
}

/** The tickets you sent the Foreman, by where they stand in Linear. */
export type Board = {
  needsYou: Ticket[]
  working: Ticket[]
  waiting: Ticket[]
  fetchedAt: number
  error: string | null
}

export type Foreman = { workspaceId: string; terminalId: string; startedAt: number }

declare module 'orca' {
  interface PluginRequests {
    'board.get': { output: Board }
    /** Open tickets: a Linear search, or yours when `query` is empty. */
    'tickets.find': { input: { query: string }; output: Ticket[] }
    /**
     * Adds a ticket to the Foreman's list and tells the Foreman to take it. `told` is false when
     * there is no Foreman terminal to tell, so the panel starts one.
     */
    'tickets.send': {
      input: { ticket: { id: string; title: string; url: string }; terminalId: string | null }
      output: { told: boolean }
    }
    /** Launches the Foreman agent in its home folder, pointed at AGENTS.md. */
    'foreman.start': { output: Foreman }
    'foreman.open': { input: { workspaceId: string }; output: { opened: boolean } }
    /** Types the sweep prompt into the Foreman's chat; `accepted` is false when its terminal is gone. */
    'foreman.sweep': { input: { terminalId: string }; output: { accepted: boolean } }
  }
}
