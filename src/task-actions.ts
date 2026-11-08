// Changes a board card makes to its spec in tasks/, and the orca calls that start an agent on one.
// A spec is "team prompt + agent prompt + --- + brief", as new-task.ps1 writes it; a spec with no
// assignee yet is tasks/unassigned-<name>.md and starts with the `---` line. Node only.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Agent, Priority, TeamConfig } from './protocol'
import { slugify } from './shared/model'

export const UNASSIGNED = 'unassigned'
const SPEC_KEY = /^spec:([a-z0-9][a-z0-9-]*)$/
const SEPARATOR = /^---\s*$/m

export class TaskError extends Error {
  code = 'invalid_params'
}

const fail = (message: string): never => {
  throw new TaskError(message)
}

export function specPathOf(teamFolder: string, key: string): { name: string; file: string } {
  const match = SPEC_KEY.exec(key)
  if (!match) fail(`Not a spec card: ${key}`)
  const name = (match as RegExpExecArray)[1]
  return { name, file: join(teamFolder, 'tasks', `${name}.md`) }
}

/** Splits a spec at its first `---` line: the prompts above, the brief below (with any review). */
export function splitSpec(text: string): { head: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  const match = SEPARATOR.exec(normalized)
  if (!match) return { head: '', body: normalized }
  return { head: normalized.slice(0, match.index).trimEnd(), body: normalized.slice(match.index + match[0].length).replace(/^\n+/, '') }
}

export function joinSpec(head: string, body: string): string {
  return `${head ? `${head}\n\n` : ''}---\n\n${body.trimStart()}`
}

async function readPromptFile(file: string): Promise<string> {
  return existsSync(file) ? (await readFile(file, 'utf8')).replace(/\r\n/g, '\n').trim() : ''
}

/** Team prompt + agent prompt for an agent, as new-task.ps1 composes them. */
export async function promptHead(teamFolder: string, agent: Agent): Promise<string> {
  const own = await readPromptFile(join(teamFolder, 'agents', `${agent.id}.md`))
  if (!own) fail(`${agent.name} has no prompt yet (agents/${agent.id}.md). Add one in Settings → Agents.`)
  const team = agent.team ? await readPromptFile(join(teamFolder, 'teams', `${agent.team}.md`)) : ''
  return team ? `${team}\n\n${own}` : own
}

/** templates/task-brief.md without its title, priority and instruction-comment lines. */
export async function briefTemplate(teamFolder: string): Promise<string> {
  const text = await readPromptFile(join(teamFolder, 'templates', 'task-brief.md'))
  return text
    .replace(/^# Task:.*\n?/m, '')
    .replace(/^\*\*Priority:\*\*.*\n?/m, '')
    .replace(/^<!--[\s\S]*?-->\n?/m, '')
    .replace(/^\n+/, '')
}

function uniqueName(teamFolder: string, prefix: string, slug: string): string {
  let name = `${prefix}-${slug}`
  for (let n = 2; existsSync(join(teamFolder, 'tasks', `${name}.md`)); n += 1) name = `${prefix}-${slug}-${n}`
  return name
}

export async function createSpec(
  teamFolder: string,
  config: TeamConfig,
  input: { title: string; priority: Exclude<Priority, '-'>; agentId: string | null; brief: string }
): Promise<{ key: string; specFile: string }> {
  const title = input.title.trim().replace(/\s+/g, ' ')
  if (!title) fail('Title is required.')
  const slug = slugify(title)
  if (!slug) fail('The title needs at least one letter or digit.')
  const agent = input.agentId ? config.agents.find((entry) => entry.id === input.agentId) : null
  if (input.agentId && !agent) fail(`There is no agent "${input.agentId}".`)
  const head = agent ? await promptHead(teamFolder, agent) : ''
  const name = uniqueName(teamFolder, agent ? agent.id : UNASSIGNED, slug)
  const body = `# Task: ${title}\n\n**Priority:** ${input.priority}\n\n${input.brief.replace(/\r\n/g, '\n').trim()}\n`
  await writeFile(join(teamFolder, 'tasks', `${name}.md`), joinSpec(head, body), 'utf8')
  return { key: `spec:${name}`, specFile: `tasks/${name}.md` }
}

/** Puts the new agent's prompts above the brief and renames the file to its new prefix. */
export async function assignSpec(teamFolder: string, config: TeamConfig, key: string, agentId: string | null): Promise<{ key: string }> {
  const { name, file } = specPathOf(teamFolder, key)
  if (!existsSync(file)) fail(`Spec not found: tasks/${name}.md`)
  const agent = agentId ? config.agents.find((entry) => entry.id === agentId) : null
  if (agentId && !agent) fail(`There is no agent "${agentId}".`)
  const prefix = name.split('-')[0]
  const rest = config.agents.some((entry) => entry.id === prefix) || prefix === UNASSIGNED ? name.slice(prefix.length + 1) : name
  const { body } = splitSpec(await readFile(file, 'utf8'))
  const head = agent ? await promptHead(teamFolder, agent) : ''
  const nextName = agent?.id === prefix || (!agent && prefix === UNASSIGNED) ? name : uniqueName(teamFolder, agent ? agent.id : UNASSIGNED, rest)
  const nextFile = join(teamFolder, 'tasks', `${nextName}.md`)
  await writeFile(file, joinSpec(head, body), 'utf8')
  if (nextFile !== file) await rename(file, nextFile)
  return { key: `spec:${nextName}` }
}

/** Rewrites (or adds) the `**Priority:**` line under the task title. */
export async function setPriority(teamFolder: string, key: string, priority: Exclude<Priority, '-'>): Promise<void> {
  const { file } = specPathOf(teamFolder, key)
  const { head, body } = splitSpec(await readFile(file, 'utf8'))
  const next = /^\*\*Priority:\*\*.*$/m.test(body)
    ? body.replace(/^\*\*Priority:\*\*.*$/m, `**Priority:** ${priority}`)
    : body.replace(/^(# Task:.*)$/m, `$1\n\n**Priority:** ${priority}`)
  await writeFile(file, joinSpec(head, next), 'utf8')
}

/** The start request an older board wrote; removing it is all that is left of that flow. */
export async function setStartRequested(teamFolder: string, key: string, requested: boolean, now = new Date()): Promise<void> {
  const { file } = specPathOf(teamFolder, key)
  const { head, body } = splitSpec(await readFile(file, 'utf8'))
  const cleared = body.replace(/^\*\*Start requested:\*\*.*\n?/m, '')
  const line = `**Start requested:** ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC via Orchestra Board`
  const next = !requested
    ? cleared
    : /^\*\*Priority:\*\*.*$/m.test(cleared)
      ? cleared.replace(/^(\*\*Priority:\*\*.*)$/m, `$1\n${line}`)
      : cleared.replace(/^(# Task:.*)$/m, `$1\n\n${line}`)
  await writeFile(file, joinSpec(head, next), 'utf8')
}

/** Appends a verdict under `## Review` (adding the heading when missing), in the README's format. */
export async function appendReview(teamFolder: string, key: string, verdict: string, note: string, now = new Date()): Promise<string> {
  const { file } = specPathOf(teamFolder, key)
  const text = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n').trimEnd()
  const line = `${verdict} — ${now.toISOString().slice(0, 10)} (user via Orchestra Board).${note.trim() ? ` ${note.trim().replace(/\s+/g, ' ')}` : ''}`
  const next = /^## Review\s*$/m.test(text) ? `${text}\n${line}\n` : `${text}\n\n## Review\n${line}\n`
  await writeFile(file, next, 'utf8')
  return line
}

/**
 * The orca CLI, not the app. The worker runs inside Orca with ELECTRON_RUN_AS_NODE set, and on Windows
 * a bare `orca` also matches Orca.exe in the working directory, which would then run as plain Node.
 * So call resources/bin/orca(.exe) next to the app first, from a neutral directory, without that flag.
 */
export function orcaCandidates(execPath = process.execPath, platform: NodeJS.Platform = process.platform): string[] {
  const bundled = join(dirname(execPath), 'resources', 'bin', platform === 'win32' ? 'orca.exe' : 'orca')
  return existsSync(bundled) ? [bundled, 'orca'] : ['orca']
}

export function runOrca(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<unknown> {
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const tryNext = (candidates: string[]) => {
      const [bin, ...rest] = candidates
      if (!bin) return reject(new Error('The orca CLI was not found.'))
      execFile(bin, [...args, '--json'], { env: childEnv, cwd: tmpdir(), timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return tryNext(rest)
        let parsed: { ok?: boolean; result?: unknown; error?: { message?: string } } | null = null
        try {
          parsed = JSON.parse(String(stdout))
        } catch {
          // fall through to the error below
        }
        if (parsed?.ok) return resolve(parsed.result)
        reject(new Error(parsed?.error?.message || String(stderr).trim() || (error as Error | null)?.message || 'orca failed'))
      })
    }
    tryNext(orcaCandidates())
  })
}

/** The Orca flags for an agent, from team.json, as new-task.ps1 prints them. */
export function launchFlags(agent: Agent): string[] {
  if (!agent.agent) fail(`${agent.name} is the lead and is never started as a worker. Pick another agent.`)
  return ['--agent', agent.agent as string, ...(agent.model ? ['--model', agent.model] : []), ...(agent.model && agent.effort ? ['--effort', agent.effort] : [])]
}

export type StartedWorker = { runId: string; taskId: string; dispatchId: string }

/** How long worker-start may wait for the agent: under the editor's 110 s request timeout, with room for Jev. */
const START_TIMEOUT_MS = 80_000

/**
 * The board's own Orca terminal and the Run bound to it. Orca needs a coordinator terminal for every
 * Run, and the plugin process has none: without `--from`, Orca attributes the call to some live terminal
 * (in a test, the session that made the request) and binds or joins that terminal's Run, which could be
 * another coordinator's. So the board opens a terminal of its own, binds its Run to it, and passes both on every start.
 */
export type BoardHome = { terminal: string; runId: string }

const homeFile = (teamFolder: string) => join(teamFolder, 'state', 'orchestra-board.json')

export async function readBoardHome(teamFolder: string): Promise<Partial<BoardHome>> {
  try {
    const parsed = JSON.parse(await readFile(homeFile(teamFolder), 'utf8')) as Partial<BoardHome>
    return { terminal: typeof parsed.terminal === 'string' ? parsed.terminal : undefined, runId: typeof parsed.runId === 'string' ? parsed.runId : undefined }
  } catch {
    return {}
  }
}

async function writeBoardHome(teamFolder: string, home: BoardHome): Promise<void> {
  await mkdir(dirname(homeFile(teamFolder)), { recursive: true })
  await writeFile(homeFile(teamFolder), `${JSON.stringify({ ...home, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
}

type TerminalRow = { handle?: string; connected?: boolean; orphaned?: boolean }
type RunRow = { id?: string; coordinator_handle?: string | null }

/**
 * The board's terminal and Run, reusing them while the terminal is alive. A closed terminal gets a new
 * one, and the board's Run is moved to it with `run-use --from`; that Run belongs to the board, so this
 * never takes a Run from anyone else.
 */
export async function ensureBoardHome(env: NodeJS.ProcessEnv, input: { teamFolder: string; repoRoot: string; inboxScript: string }): Promise<BoardHome> {
  const saved = await readBoardHome(input.teamFolder)
  const terminals = ((await runOrca(['terminal', 'list'], env)) as { terminals?: TerminalRow[] }).terminals ?? []
  let terminal = saved.terminal && terminals.some((row) => row.handle === saved.terminal && row.connected && !row.orphaned) ? saved.terminal : undefined
  if (!terminal) {
    const created = (await runOrca(
      ['terminal', 'create', '--worktree', `path:${input.repoRoot.replace(/\\/g, '/')}`, '--title', 'Orchestra Board', '--command', `pwsh -NoLogo -NoProfile -File "${input.inboxScript}"`],
      env
    )) as { terminal?: { handle?: string } }
    terminal = created.terminal?.handle
    if (!terminal) throw new Error('Orca did not open a terminal for the board.')
  }
  const runs = ((await runOrca(['orchestration', 'run-list', '--full'], env)) as { runs?: RunRow[] }).runs ?? []
  const run = saved.runId ? runs.find((row) => row.id === saved.runId) : undefined
  let runId: string
  if (run) {
    if (run.coordinator_handle !== terminal) await runOrca(['orchestration', 'run-use', '--id', run.id as string, '--from', terminal], env)
    runId = run.id as string
  } else {
    const created = (await runOrca(['orchestration', 'run-create', '--objective', 'Orchestra Board', '--from', terminal], env)) as { runId?: string }
    if (!created.runId) throw new Error('Orca did not create a Run for the board.')
    runId = created.runId
  }
  const home = { terminal, runId }
  if (home.terminal !== saved.terminal || home.runId !== saved.runId) await writeBoardHome(input.teamFolder, home)
  return home
}

/** The worker-start arguments for an agent on a spec, on the board's Run, as the board's terminal. */
export function workerStartArgs(input: { agent: Agent; specPath: string; title: string; repoRoot: string; home: BoardHome }): string[] {
  return [
    'orchestration',
    'worker-start',
    ...launchFlags(input.agent),
    '--worktree',
    `path:${input.repoRoot.replace(/\\/g, '/')}`,
    '--task-title',
    `${input.agent.name}: ${input.title}`.slice(0, 120),
    '--spec-file',
    input.specPath,
    '--run',
    input.home.runId,
    '--from',
    input.home.terminal,
    '--timeout-ms',
    String(START_TIMEOUT_MS)
  ]
}

/** Starts the agent on a spec in the repo's main workspace; its report sets the task status, which moves the card. */
export async function startWorker(env: NodeJS.ProcessEnv, input: { agent: Agent; specPath: string; title: string; repoRoot: string; home: BoardHome }): Promise<StartedWorker> {
  const result = (await runOrca(workerStartArgs(input), env, START_TIMEOUT_MS + 10_000)) as Partial<StartedWorker>
  if (!result?.taskId) throw new Error('Orca started no task.')
  return { runId: String(result.runId ?? input.home.runId), taskId: String(result.taskId), dispatchId: String(result.dispatchId ?? '') }
}

export type InboxMessage = { id: string; type: string; subject?: string; body?: string; payload?: { taskId?: string; outcome?: string } }

/** The reply a worker gets when it asks the board a question: nobody watches this inbox. */
export const NO_COORDINATOR_REPLY =
  'No one is watching this inbox: Orchestra Board started you and only reads task status. Decide from the spec and your prompt. If you cannot go on without a person, stop and finish with worker_done, outcome failed, saying exactly what you need; the user sees it on the board.'

/**
 * Reads the board Run's unread messages (marking them read) and answers questions, so a worker that
 * asks never waits for a coordinator that does not exist. Reports need nothing: the task status moves the card.
 */
export async function drainBoardInbox(env: NodeJS.ProcessEnv, home: BoardHome): Promise<InboxMessage[]> {
  const result = (await runOrca(['orchestration', 'check', '--run', home.runId, '--terminal', home.terminal], env)) as { messages?: InboxMessage[] }
  const messages = Array.isArray(result?.messages) ? result.messages : []
  for (const message of messages) {
    if (message.type === 'question') await runOrca(['orchestration', 'reply', '--id', message.id, '--body', NO_COORDINATOR_REPLY, '--run', home.runId, '--from', home.terminal], env)
  }
  return messages
}

export type RecordedRun = StartedWorker & { key: string; agent: string; kind: 'work' | 'review'; startedAt: string }

const runsFile = (teamFolder: string) => join(teamFolder, 'state', 'orchestra-runs.json')

/** Runs the board started (state/orchestra-runs.json); a missing or broken file reads as none. */
export async function readRuns(teamFolder: string): Promise<RecordedRun[]> {
  try {
    const parsed = JSON.parse(await readFile(runsFile(teamFolder), 'utf8')) as { runs?: unknown }
    return Array.isArray(parsed.runs) ? (parsed.runs as RecordedRun[]).filter((run) => typeof run?.taskId === 'string') : []
  } catch {
    return []
  }
}

/** Records a task the board started, for review automation and for coordinator tooling that should leave it alone. */
export async function recordRun(teamFolder: string, entry: Omit<RecordedRun, 'startedAt'>, now = new Date()): Promise<void> {
  const file = runsFile(teamFolder)
  const runs = await readRuns(teamFolder)
  runs.push({ ...entry, startedAt: now.toISOString() })
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ runs: runs.slice(-500) }, null, 2)}\n`, 'utf8')
}

export type ReviewTarget = {
  name: string
  specFile: string
  title: string
  priority: Priority
  persona: string
  taskId: string | null
  round: number
  report: { subject: string | null; body: string; filesModified: string[] } | null
}

const REPORT_EXCERPT = 4000

/**
 * A read-only review spec for one round of a card: the reviewer's prompts, then a brief that points
 * at the original spec and quotes the worker's report. `**Reviews:**` links it back to the card.
 */
export async function createReviewSpec(teamFolder: string, config: TeamConfig, target: ReviewTarget, reviewerId: string): Promise<{ key: string; specPath: string; title: string }> {
  const reviewer = config.agents.find((agent) => agent.id === reviewerId)
  if (!reviewer) fail(`There is no agent "${reviewerId}".`)
  const implementer = config.agents.find((agent) => agent.id === target.persona)
  const head = await promptHead(teamFolder, reviewer as Agent)
  const base = target.name.startsWith(`${target.persona}-`) ? target.name.slice(target.persona.length + 1) : target.name
  const name = uniqueName(teamFolder, (reviewer as Agent).id, `review-${base}${target.round > 1 ? `-r${target.round}` : ''}`)
  const title = `Review — ${target.title}`
  const report = target.report
  const body = report?.body ? report.body.slice(0, REPORT_EXCERPT) + (report.body.length > REPORT_EXCERPT ? '\n…' : '') : ''
  const lines = [
    `# Task: ${title}`,
    '',
    `**Priority:** ${target.priority === '-' ? 'P2' : target.priority}`,
    `**Reviews:** ${target.specFile} (round ${target.round})`,
    '',
    '## Goal',
    `Review the work done for \`${basename(teamFolder)}/${target.specFile}\` and give a verdict: approve, approve with changes, or request changes.`,
    '',
    '## Context',
    `- The task spec, with its acceptance criteria: \`${basename(teamFolder)}/${target.specFile}\`. Review against those criteria.`,
    `- Implementer: ${implementer ? `${implementer.name} (${implementer.role})` : 'unknown'}${target.taskId ? `; Orca task ${target.taskId}` : ''}.`,
    report?.subject ? `- The worker's report: **${report.subject}**` : '- The worker left no report subject.',
    ...(body ? ['', ...body.replace(/^---\s*$/gm, '***').split('\n').map((line) => `> ${line}`), ''] : []),
    ...(report?.filesModified.length ? [`- Files changed: ${report.filesModified.map((file) => `\`${file}\``).join(', ')}`] : []),
    '',
    '## Scope',
    '- **Read-only:** do not edit files, run commands that change anything, commit or push. Reading, diffs and read-only commands are fine.',
    '',
    '## Deliverables',
    '- A verdict first (approve, approve with changes, or request changes), then findings sorted by severity, each with a file, a line and a concrete failure scenario.',
    '',
    '## Acceptance criteria',
    '- [ ] Every acceptance criterion in the task spec is checked against the actual change, not against the report.',
    '- [ ] Each finding names a file and line.',
    '',
    '## Evidence & reporting',
    '- Finish with worker_done, outcome succeeded once the review is done, whatever the verdict; put the verdict in the subject.',
    ''
  ]
  await writeFile(join(teamFolder, 'tasks', `${name}.md`), joinSpec(head, lines.join('\n')), 'utf8')
  return { key: `spec:${name}`, specPath: join(teamFolder, 'tasks', `${name}.md`), title }
}
