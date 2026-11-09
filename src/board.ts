// Pure logic shared by the worker and its tests: settings, ticket shaping, prompts.
import type { Board, Ticket } from './protocol'

export type Config = {
  team: string
  workingState: string
  reviewState: string
  maxWorkers: number
  agent: string
  cli: string
  /** The Foreman's own folder; `~` expands to the home directory. */
  home: string
}

const str = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback

export function toConfig(settings: Record<string, unknown>): Config {
  return {
    team: str(settings.linearTeam, ''),
    workingState: str(settings.workingState, 'In Progress'),
    reviewState: str(settings.reviewState, 'In Review'),
    maxWorkers: typeof settings.maxWorkers === 'number' ? settings.maxWorkers : 3,
    agent: str(settings.agent, 'claude'),
    cli: str(settings.orcaCli, 'orca'),
    home: str(settings.home, '~/.foreman')
  }
}

/** One entry of `<home>/tickets.json`: a ticket the human sent the Foreman. */
export type Sent = { id: string; title: string; url: string; sentAt: string }

/** Adds a ticket to the list, or moves it to the end when it is sent again. */
export const addSent = (list: Sent[], ticket: Sent): Sent[] => [...list.filter((t) => t.id !== ticket.id), ticket]

export type RawIssue = {
  identifier: string
  title: string
  url: string
  priority: number
  priorityLabel: string
  assignee?: { displayName: string } | null
  updatedAt: string
  state?: { name: string; type: string }
}

// Linear priority: 1 urgent … 4 low, 0 none (last).
const rank = (priority: number) => (priority === 0 ? 5 : priority)

/** Keeps only what the panel shows (no descriptions), most urgent first, then most recent. */
export function toTickets(issues: RawIssue[]): Ticket[] {
  return issues
    .map((issue) => ({
      id: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state?.name ?? '',
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      assignee: issue.assignee?.displayName ?? null,
      updatedAt: issue.updatedAt
    }))
    .sort((a, b) => rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt))
}

export const isClosed = (issue: RawIssue) => ['completed', 'canceled', 'duplicate'].includes(issue.state?.type ?? '')

export const toOpen = (issues: RawIssue[]) => toTickets(issues.filter((issue) => !isClosed(issue)))

/** Sent tickets by their Linear state: review is the human's turn, working is a worker's. */
export function toBoard(issues: RawIssue[], config: Config): Omit<Board, 'fetchedAt' | 'error'> {
  const open = toOpen(issues)
  return {
    needsYou: open.filter((t) => t.state === config.reviewState),
    working: open.filter((t) => t.state === config.workingState),
    waiting: open.filter((t) => t.state !== config.reviewState && t.state !== config.workingState)
  }
}

/**
 * A Linear search, or your most recently updated tickets when `query` is empty.
 * `linear search` matches ids (ENG-123) as well as words, which `list-issues --query` doesn't.
 * ponytail: one page each, closed tickets filtered after; page with --cursor if they crowd out
 * open ones.
 */
export function findArgs(config: Config, query: string): string[] {
  if (query) return ['linear', 'search', query, '--limit', '50', '--json']
  const team = config.team ? ['--team', config.team] : []
  return ['linear', 'list-issues', '--assignee', 'me', ...team, '--order-by', 'updatedAt', '--limit', '100', '--json']
}

// ponytail: every prompt is one line on purpose; agent CLIs can treat a newline as submit.
function briefing(manualPath: string, config: Config): string {
  const settings = [
    `home=\`${config.home}\``,
    `workingState="${config.workingState}"`,
    `reviewState="${config.reviewState}"`,
    `maxWorkers=${config.maxWorkers}`,
    `workerAgent=${config.agent}`
  ].join('; ')
  return `run \`orca skills get orchestration\` and \`orca skills get orca-linear\` and keep their rules, then read your operating manual at \`${manualPath}\` and follow it for this whole session. Config: ${settings}.`
}

/** A launch prompt can get lost (a folder-trust question on first launch), so every message re-briefs. */
const unlessBriefed = (manualPath: string, config: Config) =>
  `(If you haven't been briefed in this session: you are the Foreman; first ${briefing(manualPath, config)})`

export const foremanPrompt = (manualPath: string, config: Config) =>
  `You are the Foreman. First ${briefing(manualPath, config)} Begin with a sweep.`

export const sweepPrompt = (manualPath: string, config: Config) =>
  `Foreman: sweep now. ${unlessBriefed(manualPath, config)}`

export const takePrompt = (ticket: { id: string; url: string }, manualPath: string, config: Config) =>
  `Foreman: take ${ticket.id} now (${ticket.url}). ${unlessBriefed(manualPath, config)}`
