# Foreman

A chief-of-staff agent for [Orca](https://github.com/stablyai/orca). Send it a Linear ticket
from the panel, and the Foreman starts a supervised Orca worker for it right away. It keeps the
workers moving and puts everything that needs you in **one prioritized queue**: tickets waiting
on your review.

You stop babysitting a dozen agent chats. You clear one queue, in batches, when you choose to.

## How it works

1. **You send a ticket.** Find it in the panel (your open tickets, or search by id or words) and
   press **Send**. No labels, no state changes needed.
2. **The Foreman starts a worker** in a fresh worktree of the right repo, links the worktree to
   the ticket and moves it to **In Progress**. With every slot busy, the ticket waits for the
   next free one.
3. **The worker hands back** a PR with evidence (screenshots for UI changes), or one clear
   question with options, and moves the ticket to **In Review**: your queue.
4. **You clear the queue.** Merge what's good. On anything else, comment on the ticket and press
   **Send back**; the worker picks up in the same worktree.

- **The Foreman** is an agent (Claude by default) that follows [`AGENTS.md`](AGENTS.md). It
  lives in its own folder (`~/.foreman`), not in any repo, and works across all of them. It
  answers the workers' technical questions and routes judgment calls to you.
- **Preferences:** when you send work back with a reusable rule ("no new dependencies"), the
  Foreman writes it to `~/.foreman/PREFERENCES.md`. Workers read that file before they start, so
  first drafts improve over time.
- **The panel** has **Send a ticket** at the top, and below it what you've sent, grouped as
  **Needs you**, **Working** and **Waiting**. Each ticket id opens the ticket in Linear.

## Requirements

- Orca **1.4.248** or newer, with plugins turned on (Settings → Plugins).
- Linear connected in Orca. Check with `orca linear team list`.

## Install

```sh
orca plugin install gonzarascon/orca-foreman
```

Orca lists the access Foreman asks for and asks you to approve it (see [Access](#access)).

## Set up

1. In Orca, go to **Settings → Plugins → Foreman** and check the working and review state
   names. They must match your Linear workflow exactly (defaults: `In Progress`, `In Review`).
2. Open the **Foreman** panel in the right sidebar and press **Start foreman** (or just send a
   ticket; that starts it too). The first time, it creates `~/.foreman` and adds it to Orca as a
   folder project (no Git, no repo).
3. Tell the Foreman which repo each team or project uses (it keeps the map in
   `~/.foreman/REPOS.md`). With only one repo in Orca, it uses that one.

## Daily use

- **Send work:** in **Send a ticket**, press **Send** on one of your tickets, or search by id
  (`ENG-123`) or words and press Enter first.
- **Clear your queue:** open **Needs you**. Merge what's good. On anything else, comment on the
  ticket, then press **Send back**.
- **Check on the Foreman:** the badge shows its status. **Open** jumps to its terminal.
  **Sweep** asks it to check on every ticket and start waiting ones.

## Settings

| Setting              | Default       | Notes                                                     |
| -------------------- | ------------- | --------------------------------------------------------- |
| Home folder          | `~/.foreman`  | The Foreman's own folder, outside any repo                |
| Linear team          | (every team)  | Limits "your open tickets" to one team, such as `ENG`     |
| Working state        | `In Progress` | Where a ticket goes when its worker starts                |
| Review state         | `In Review`   | Where workers put tickets that need you                   |
| Max parallel workers | `3`           |                                                           |
| Agent                | `claude`      | Any Orca agent id, used for the Foreman and workers       |
| Orca CLI             | `orca`        | Set an absolute path if Orca can't find the CLI           |

## Access

Foreman runs a small Node worker. It asks for:

| Capability                          | Used for                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| Run its own Node.js process         | Reading Linear and messaging the Foreman (**Send**, **Sweep**) through the `orca` CLI, with no API key; the files in its home folder |
| `agent:launch`                      | Starting the Foreman                                             |
| `agent:read`                        | The Foreman status badge                                         |
| `workspace:read`, `workspace:write` | Finding its home folder's workspace, and **Open**                |
| `settings:own`, `storage:own`       | Its settings, plus which terminal the Foreman runs in            |

The panel shows ticket ids, titles, states and priorities. It never stores ticket descriptions
or comments, and it never writes to Linear itself; the Foreman and its workers do, as
described in [`AGENTS.md`](AGENTS.md).

## Limits

- Linear only, for now.
- Nothing sweeps on a timer. A waiting ticket starts when a worker finishes, or when you press
  **Sweep**.
- The Foreman's home folder is on the machine running Orca's desktop app.

## Develop

```sh
npm install                    # TypeScript and Node typings, only for `tsc`
npx tsc -p .
orca plugin test .             # unit tests (fake CLI and host, no real Linear calls)
orca plugin check .            # renders the panel's check scenarios
orca plugin dev watch . --check
```

`src/worker.ts` reads Linear and drives the Foreman. `src/panel.tsx` is the sidebar UI.
`src/board.ts` holds the pure logic and every prompt, and `src/protocol.ts` is the contract
between them. [`AGENTS.md`](AGENTS.md) is the Foreman's operating manual, and it ships with the
plugin.
