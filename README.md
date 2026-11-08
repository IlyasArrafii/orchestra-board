# Orchestra Board

A Linear-style board for agent teams in [Orca](https://www.onorca.dev). Write a task, drag it to In Progress, and the board starts the agent you picked in Orca. When the agent reports, the board starts a reviewer, and you decide when the work is done.

- **Board:** Backlog, In Progress, Under Review and Done, with drag and drop.
- **Flow:** a canvas with one lane per agent, time from left to right, and dependency arrows.
- **Card details:** the brief, activity, the worker's report, the reviewer's report and the review verdicts, plus status, assignee, priority and reviewer controls.
- **Agents started from the board:** `orca orchestration worker-start` with each agent's CLI, model and effort.
- **Jev decisions (optional):** [TypeSafe](https://typesafe.ai)'s Jev picks the best agent for a task, rates how well every agent fits, and picks a reviewer who is not the implementer.
- **Settings:** agents (CLI, model and effort detected from Orca), roles, teams, prompts, the Jev key and automation switches.

Status: early (0.4.0). Built and tested on Windows with Orca 1.4.

## Requirements

- Orca 1.4.248 or newer, with plugins turned on.
- PowerShell 7 (`pwsh`) on the PATH. The columns are computed by `scripts/board.ps1`.
- At least one agent CLI that Orca can start (Claude Code, Codex, …).
- Optional: a TypeSafe API key for Jev.

## Install

```sh
orca plugin install IlyasArrafii/orchestra-board
```

The plugin runs a worker, so Orca asks for approval and lists the access it needs (see [Access](#access)). Then set **Team folder** in Orca → Settings → Plugins → Orchestra Board, and run **Orchestra Board: Open board** from the command palette. The status bar item **Orchestra n · n · n** opens it too.

## The team folder

The board works on a folder of plain files at the root of the repository your agents work in, for example `<repo>/.orca-team`:

```
.orca-team/
  team.json                 agents, roles and teams (Settings edits it)
  agents/<id>.md            each agent's prompt
  teams/<id>.md             a prompt shared by a team's members (optional)
  tasks/<agent>-<name>.md   task specs; the board writes these, you can too
  templates/task-brief.md   the brief New task starts from (optional)
  state/                    what the board remembers (written by the board)
  board.orchestraboard      the file the board opens in (created by the command)
```

A minimal `team.json`:

```json
{
  "version": 1,
  "roles": ["Senior Software Engineer", "Principal Software Engineer"],
  "teams": [{ "id": "core", "name": "Core team", "description": "" }],
  "agents": [
    { "id": "ana", "name": "Ana", "role": "Senior Software Engineer", "team": "core", "agent": "claude", "model": "claude-opus-5-5", "effort": "high", "active": true, "color": "#2563eb", "note": "" },
    { "id": "ben", "name": "Ben", "role": "Principal Software Engineer", "team": "core", "agent": "claude", "model": "claude-opus-5-5", "effort": null, "active": true, "color": "#16a34a", "note": "" }
  ]
}
```

An agent with `"agent": null` is a lead: it shows on the board but is never started as a worker.

**Specs.** A spec is the team prompt, the agent prompt, a line with only `---`, then the brief. A spec with no assignee yet is `tasks/unassigned-<name>.md` and starts with the `---` line. The brief starts with `# Task: <title>` and an optional `**Priority:** P1|P2|P3` line. Do not put a line with only `---` in a prompt; use `***`.

**Verdicts.** Reviews are lines under `## Review` at the end of a spec. The board reads the last line that starts with `Approved`, `Merged`, `Closed`, `Changes requested`, `Interim` or `Rework`.

## How cards move

| From → to | What happens |
|---|---|
| Backlog → In Progress | The board starts the assignee in Orca on that spec. With no assignee, Jev picks the agent that fits best; when no pick is clear, the board asks you to choose. |
| (the agent reports) | The task is completed and the card moves to Under Review. See [Reviews](#reviews). |
| Under Review → In Progress | Your note is written as `Changes requested`, followed by a `Rework` line, and the same agent starts again on the spec. When it reports, the next review round starts. |
| Under Review → Done | You pick the verdict: `Merged`, `Approved` (PR open) or `Closed`. Done is always your call. |
| Backlog → Done | `Closed`. |
| Anything else | Refused, with the reason. |

Leads and inactive agents are never started. The board never stops a worker, merges or pushes. Every agent works in the repository's main checkout, so run parallel implementers in their own worktrees yourself.

## Reviews

When a card the board started reaches Under Review, and **Start a review automatically** is on (the default) and a Jev key is saved, the board:

1. picks a reviewer: Jev's reviewer pick, never the implementer; without one, the best-fitting other agent;
2. writes a read-only review spec, `tasks/<reviewer>-review-<name>.md` (`-r2`, `-r3` for later rounds), with the reviewer's prompts, a `**Reviews:** tasks/<spec>.md (round N)` line, the worker's report and the review's acceptance criteria;
3. starts the reviewer.

The original card shows "In review: <name>", then "Reviewed by <name>", and the reviewer's report appears in its details. For other cards, or another reviewer, use **Review** in the card details.

## Jev (TypeSafe)

With a key saved in Settings → Jev, the worker asks Jev one request per card at `https://api.typesafe.ai/v1/systemone` (model `jev-latest` by default):

- `assignee`: which agent should do it (Choice);
- `fit:<id>`: how well each active agent fits (Score: Poor, Partial, Good or Strong);
- `reviewer`: which other agent should review it (Choice);
- `priority`: a P1–P3 suggestion (Score).

It sends the card's title and brief (up to 12,000 characters), and each active worker's name, role and the first 900 characters of its prompt. Answers are cached until the card, the agents, the prompts or the model change. The key is stored in Orca's encrypted plugin secrets and never reaches the editor page.

## The board's own terminal and Run

Every Orca orchestration Run needs a coordinator terminal, and a plugin worker has none. Without `--from`, Orca attributes the worker's orchestration calls to some live terminal, which can put the board's tasks into another session's Run, or bind a new Run to that session.

So the board opens one terminal tab of its own, **Orchestra Board**, which runs `inbox.ps1`. It binds a Run named "Orchestra Board" to that terminal and passes `--run` and `--from` on every start. Agent reports go to that Run and nowhere else. The board marks its messages read on each refresh and answers questions from agents, telling them to decide from the spec or to stop with a failed `worker_done` that says what they need. Closing the tab is fine: the next start opens a new one and moves the board's Run there. Both are recorded in `state/orchestra-board.json`; the tasks the board started are in `state/orchestra-runs.json`.

## Settings

| Setting | Default | |
|---|---|---|
| Team folder | the folder the plugin sits in | The team folder described above. |
| Auto refresh (seconds) | 60 | The board also refreshes when `tasks/`, `agents/` or `teams/` change and when an agent's status changes. |
| Assess cards with Jev automatically | on | Ask Jev about cards whose brief or agents changed. |
| Start a review automatically | on | See [Reviews](#reviews). |
| Jev model | `jev-latest` | |

## Access

The plugin is a `trusted-worker`: a Node process with your user's access. Capabilities: `workspace:read`, `workspace:write`, `agent:read`, `settings:own`, `storage:own` and `secrets:own`.

It writes only inside the team folder: specs and review specs in `tasks/`, `team.json`, `agents/`, `teams/`, `state/`, and `.trash/` for deleted prompts. It runs `pwsh scripts/board.ps1` and the `orca` CLI (`terminal create`, `terminal list`, and `orchestration run-create`, `run-use`, `run-list`, `task-list`, `worker-start`, `check` and `reply` for its own Run). It calls `api.typesafe.ai` only when a Jev key is saved.

## Development

```
orca-plugin.json   manifest
src/               the worker (loaded as TypeScript, no build) and logic shared with the UI
editor/            the built editor page; commit it after a UI change
ui/                the editor's source: React 19, shadcn/ui, Tailwind 4, dnd-kit, sonner
scripts/board.ps1  the column rules
inbox.ps1          what runs in the board's terminal
```

Orca counts every file in a development folder, including `node_modules`, so keep the UI's dependencies outside the plugin folder. A bun workspace one level up does that:

```sh
# in the folder that contains orchestra-board/
echo '{ "private": true, "workspaces": ["orchestra-board/ui"] }' > package.json
bun install --linker hoisted

cd orchestra-board
orca plugin types .        # writes .orca/types for type checking
orca plugin dev load .     # Orca asks for approval the first time

cd ui
bun run build              # writes ../editor/{index.html, main.js, main.css}
bun run typecheck

cd ..
orca plugin test .         # worker and shared-logic tests
orca plugin check .
orca plugin logs local.orchestra-board
```

Notes:

- `ui/bun.lock` is for a standalone `bun install` inside `ui/`, which works for building but puts `node_modules` in the plugin folder.
- Type checking `src/` needs Node's typings: extend `.orca/types/tsconfig.json` in a scratch tsconfig and add `node` to `types`.
- Orca reloads the plugin on every save in a development folder, so it can crash briefly while several files change. `orca plugin list` should show `running` when you are done.
- Never test drag moves on real specs: a start or a Changes requested move runs a real agent.
