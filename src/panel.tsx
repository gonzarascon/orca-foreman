// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  Heading,
  IconButton,
  Input,
  Link,
  on,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  shell,
  Spinner,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { Board, Foreman, Ticket } from './protocol'

const board = atom<Board | null>(null)
const loading = atom(false)
const failure = atom<string | null>(null)
/** What the last Send did, so a press never looks like nothing happened. */
const notice = atom<string | null>(null)
/** The Foreman's last reported status; null until Orca reports one. */
const agentState = atom<string | null>(null)
/** "Send a ticket": the search, its results, and the ticket being sent. */
const query = atom('')
const found = atom<Ticket[]>([])
const searching = atom(false)
const sending = atom<string | null>(null)
/** Kept in the plugin's storage, so it survives restarts. */
const foreman = atom<Foreman | null>('foreman', null, { persist: 'storage' })

async function attempt(work: () => Promise<unknown>): Promise<void> {
  set(failure, null)
  try {
    await work()
  } catch (error) {
    set(failure, error instanceof Error ? error.message : String(error))
  }
}

async function loadBoard(): Promise<void> {
  set(loading, true)
  try {
    set(board, await plugin.request('board.get'))
  } finally {
    set(loading, false)
  }
}

const refresh = () => attempt(loadBoard)

const GONE = "The Foreman's terminal is closed. Press Start foreman, or send a ticket to start it."

const start = () =>
  attempt(async () => {
    set(foreman, await plugin.request('foreman.start'))
    set(agentState, null)
  })

const open = () =>
  attempt(() => plugin.request('foreman.open', { workspaceId: read(foreman)!.workspaceId }))

const sweep = () =>
  attempt(async () => {
    const { accepted } = await plugin.request('foreman.sweep', { terminalId: read(foreman)!.terminalId })
    if (accepted) return set(notice, 'Asked the Foreman to sweep.')
    set(foreman, null)
    throw new Error(GONE)
  })

const find = () =>
  attempt(async () => {
    set(searching, true)
    try {
      set(found, await plugin.request('tickets.find', { query: read(query) }))
    } finally {
      set(searching, false)
    }
  })

const send = (t: Ticket) =>
  attempt(async () => {
    set(notice, null)
    set(sending, t.id)
    try {
      const { told } = await plugin.request('tickets.send', {
        ticket: { id: t.id, title: t.title, url: t.url },
        terminalId: read(foreman)?.terminalId ?? null
      })
      if (told) return set(notice, `Sent ${t.id}. The Foreman is starting a worker for it.`)
      // No Foreman to tell: start one. It sweeps first, so it finds the ticket in its list.
      set(foreman, await plugin.request('foreman.start'))
      set(agentState, null)
      set(notice, `Sent ${t.id} and started the Foreman. It picks the ticket up first.`)
    } finally {
      set(sending, null)
      // Inside the attempt, so a failed send keeps its error on screen.
      await loadBoard()
    }
  })

export function setup(ctx: PanelContext): void {
  void refresh()
  void find()
  ctx.subscriptions.push(
    on('agent.status.changed', (event) => {
      const current = read(foreman)
      // ponytail: matched by workspace, since agent.launch's `term_…` handle isn't the id events
      // carry. The Foreman's home folder runs no other agent.
      if (!current || event.workspaceId !== current.workspaceId) return
      set(agentState, event.state)
      // The Foreman just finished a turn, so it may have moved tickets.
      if (event.state !== 'working') void refresh()
    })
  )
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning'

const STATUS: Record<string, [string, Tone]> = {
  working: ['Working', 'accent'],
  waiting: ['Waiting', 'success'],
  blocked: ['Blocked', 'warning'],
  done: ['Idle', 'neutral']
}

type Action = { label: string; tooltip: string; onPress: () => unknown }

/** One ticket: the id opens it in Linear; state and priority underneath; an optional button. */
function ticketRow(t: Ticket, action?: Action) {
  const details = [t.state, t.priorityLabel === 'none' ? null : t.priorityLabel].filter(Boolean).join(' · ')
  return (
    <Row key={t.id} gap="sm" align="center" justify="between">
      <Box direction="column" grow shrink>
        <Text truncate>
          <Link onPress={() => shell.openExternal(t.url)}>{t.id}</Link> {t.title}
        </Text>
        <Text muted size="xs">
          {details}
        </Text>
      </Box>
      {action ? (
        <Button
          size="sm"
          variant="outline"
          icon="next"
          tooltip={action.tooltip}
          disabled={read(sending) !== null}
          onPress={action.onPress}
        >
          {action.label}
        </Button>
      ) : null}
    </Row>
  )
}

const sendAction = (t: Ticket): Action => ({
  label: 'Send',
  tooltip: 'Give this ticket to the Foreman; it starts a worker right away',
  onPress: () => send(t)
})

const sendBackAction = (t: Ticket): Action => ({
  label: 'Send back',
  tooltip: 'Comment on the ticket first; the Foreman resumes its worker with your comments',
  onPress: () => send(t)
})

function sendSection(sentIds: Set<string>) {
  const q = read(query)
  const rows = read(found).filter((t) => !sentIds.has(t.id))
  // ponytail: your 8 most urgent; the search reaches the rest.
  const shown = q ? rows : rows.slice(0, 8)
  return (
    <Collapsible title="Send a ticket" description={q ? `Open tickets matching "${q}"` : 'Your open tickets, most urgent first'} defaultOpen>
      <Stack gap="sm">
        <Input
          type="search"
          label="Search Linear"
          labelHidden
          placeholder="Ticket id or words, then Enter"
          value={q}
          onChange={(value) => set(query, value)}
          onSubmit={(value) => (set(query, value), find())}
        />
        {read(searching) ? (
          <Spinner label="Searching Linear" />
        ) : shown.length ? (
          shown.map((t) => ticketRow(t, sendAction(t)))
        ) : (
          <Text muted size="sm">
            {q ? 'No open tickets match.' : 'Nothing open is assigned to you.'}
          </Text>
        )}
      </Stack>
    </Collapsible>
  )
}

function section(title: string, tickets: Ticket[], action?: (t: Ticket) => Action) {
  return tickets.length ? (
    <Collapsible title={`${title} (${tickets.length})`} defaultOpen>
      <Stack gap="sm">{tickets.map((t) => ticketRow(t, action?.(t)))}</Stack>
    </Collapsible>
  ) : null
}

export default function Panel() {
  const current = read(foreman)
  const b = read(board)
  const error = read(failure)
  const done = read(notice)
  const sent = b ? [...b.needsYou, ...b.working, ...b.waiting] : []
  const [statusText, statusTone]: [string, Tone] = current
    ? (STATUS[read(agentState) ?? ''] ?? ['Started', 'neutral'])
    : ['Not started', 'neutral']

  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Foreman</Heading>
        <Badge tone={statusTone}>{statusText}</Badge>
      </Row>
      <Row gap="xs" wrap>
        <Button
          icon="play"
          variant={current ? 'ghost' : 'solid'}
          tone="accent"
          tooltip={
            current
              ? 'Launches another Foreman; the current one keeps running'
              : 'Starts the Foreman in its own folder (Settings → Home folder)'
          }
          onPress={start}
        >
          {current ? 'Start new' : 'Start foreman'}
        </Button>
        {current ? (
          <Button icon="terminal" variant="outline" onPress={open}>
            Open
          </Button>
        ) : null}
        {current ? (
          <Button icon="zap" variant="outline" tooltip="Ask the Foreman to check on its tickets and start waiting ones" onPress={sweep}>
            Sweep
          </Button>
        ) : null}
        <IconButton icon="refresh" label="Refresh" variant="ghost" disabled={read(loading)} onPress={refresh} />
      </Row>
      {error ? <Callout tone="danger" title="Something failed">{error}</Callout> : null}
      {done ? <Callout tone="success">{done}</Callout> : null}
      {b?.error ? (
        <Callout tone="warning" title="Couldn't read Linear">
          {b.error}
        </Callout>
      ) : null}
      {sendSection(new Set(sent.map((t) => t.id)))}
      <Heading level={3}>Sent to the Foreman</Heading>
      {sent.length ? (
        <>
          {section('Needs you', b!.needsYou, sendBackAction)}
          {section('Working', b!.working)}
          {section('Waiting', b!.waiting)}
        </>
      ) : (
        <Text muted size="sm">
          Nothing yet. Send a ticket above and the Foreman starts a worker for it.
        </Text>
      )}
      {b ? (
        <Text muted size="xs">
          Updated <RelativeTime at={b.fetchedAt} />
        </Text>
      ) : null}
    </Stack>
  )
}
