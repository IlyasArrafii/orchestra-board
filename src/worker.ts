// Orchestra Board's worker: keeps the board fresh, answers the editor, edits team.json and the prompt files
// for Settings, runs Jev decisions, and drives the status bar item. It stays running while the plugin
// is enabled, because the plugin has a status bar item.
import { existsSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { detectAgents } from './agents-detect'
import { boardSignature, childEnv, countColumns, lightItem, resolveTeamFolder, runBoard, statusBarView } from './board-source'
import { DecisionEngine } from './decisions'
import { DEFAULT_MODEL } from './jev'
import type { BoardItem, BoardResult, BoardSnapshot, DetectedAgent, TeamState } from './protocol'
import { editableBeforeStart, planMove, rankedFits } from './shared/model'
import { appendReview, assignSpec, briefTemplate, createReviewSpec, createSpec, drainBoardInbox, ensureBoardHome, readBoardHome, readRuns, recordRun, setPriority, setStartRequested, specPathOf, startWorker, type BoardHome } from './task-actions'
import { deleteAgent, deleteTeam, readConfig, readTeamState, saveAgent, saveTeam } from './team-store'

const CACHE_MS = 5_000
const AGENT_EVENT_DELAY_MS = 5_000
const FILE_EVENT_DELAY_MS = 1_500
const DEFAULT_REFRESH_SECONDS = 60
const MIN_REFRESH_SECONDS = 15
const BOARD_FILE = 'board.orchestraboard'
const BOARD_FILE_TEXT = '{ "note": "Opened by the Orchestra Board plugin. The content of this file is not used." }\n'
const STATUS_ITEM = 'summary'
const TOKEN_SECRET = 'jevToken'
const SPEC_FILE = /^tasks\/[^/\\]+\.md$/
const WATCHED = ['tasks', 'agents', 'teams']
const DETECT_CACHE_MS = 10 * 60_000
/** Jev's pick is applied (new task, or a start with no assignee) only when it is this clear. */
const JEV_ASSIGN_PROBABILITY = 0.6
const JEV_ASSIGN_CONFIDENCE = 0.5

const disposers: Array<() => void> = []

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Team-store and validation errors reach the editor as `invalid_params` with their message. */
function asHostError(error: unknown): Error {
  const code = (error as { code?: unknown }).code
  return codedError(typeof code === 'string' ? code : 'action_failed', errorMessage(error))
}

function comparable(path: string): string {
  const forward = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? forward.toLowerCase() : forward
}

export default function activate(orca: OrcaWorkerApi): void {
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  let cache: BoardResult | null = null
  let fullItems = new Map<string, BoardItem>()
  let teamState: TeamState | null = null
  let inflight: Promise<BoardResult> | null = null
  let signature = ''
  let pending: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  const watchers: FSWatcher[] = []
  let watchedFolder = ''
  /** Orca task ids the board started (state/orchestra-runs.json); only these get an automatic review. */
  const boardTasks = new Set<string>()
  let boardTasksFolder = ''

  const engine = new DecisionEngine({
    token: async () => (await orca.secrets.get(TOKEN_SECRET)) || null,
    model: async () => {
      const value = await orca.settings.get('jevModel')
      return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_MODEL
    },
    auto: async () => (await orca.settings.get('jevAuto')) !== false,
    protection: async () => {
      try {
        return (await orca.host.call('secrets.protection')).status
      } catch {
        return 'unknown'
      }
    },
    storage: orca.storage as never,
    fetch: globalThis.fetch as never,
    log: (message) => orca.log(message),
    changed: () => void republish(),
    status: (status) => orca.panels.post('jev.changed', status)
  })
  const ready = engine.init().catch((error) => orca.log(`Jev cache could not be read: ${errorMessage(error)}`))

  disposers.push(() => {
    if (pending) clearTimeout(pending)
    if (interval) clearInterval(interval)
    for (const watcher of watchers) watcher.close()
    engine.stop()
  })

  async function teamFolder(): Promise<string> {
    return resolveTeamFolder(await orca.settings.get('teamFolder'), pluginRoot)
  }

  // Throttle, not debounce: agent status events can arrive every second, and a debounce would never fire.
  function schedule(delayMs: number): void {
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      void load(true)
    }, delayMs)
  }

  function watchFolder(folder: string): void {
    if (folder === watchedFolder) return
    for (const watcher of watchers.splice(0)) watcher.close()
    watchedFolder = folder
    for (const name of WATCHED) {
      const path = join(folder, name)
      if (!existsSync(path)) continue
      try {
        watchers.push(watch(path, () => schedule(FILE_EVENT_DELAY_MS)))
      } catch (error) {
        orca.log(`Cannot watch ${path}: ${errorMessage(error)}`)
      }
    }
  }

  async function updateStatusBar(result: BoardResult): Promise<void> {
    try {
      await orca.host.call('statusBar.update', { id: STATUS_ITEM, ...statusBarView(result) })
    } catch (error) {
      orca.log(`statusBar.update failed: ${errorMessage(error)}`)
    }
  }

  function snapshotFrom(base: Pick<BoardSnapshot, 'generatedAt' | 'teamFolder' | 'columns'>, state: TeamState): BoardSnapshot {
    return {
      ...base,
      items: [...fullItems.values()].map(lightItem),
      agents: state.config.agents,
      teams: state.config.teams,
      decisions: engine.current()
    }
  }

  function post(result: BoardResult): void {
    const next = result.ok ? `${boardSignature(result.snapshot.items)}\n${JSON.stringify(result.snapshot.decisions)}\n${JSON.stringify(result.snapshot.agents)}` : `error:${result.error}`
    if (next === signature) return
    signature = next
    orca.panels.post('board.changed', { loadedAt: result.loadedAt, counts: result.ok ? countColumns(result.snapshot.items) : null })
  }

  /** Rebuild the snapshot from memory (new decision, team edit) without running board.ps1. */
  async function republish(): Promise<void> {
    if (!cache?.ok || !teamState) return
    cache = { ok: true, snapshot: snapshotFrom(cache.snapshot, teamState), loadedAt: Date.now() }
    post(cache)
  }

  async function refresh(): Promise<BoardResult> {
    await ready
    const folder = await teamFolder()
    let result: BoardResult
    try {
      const [script, state] = await Promise.all([runBoard(folder, join(pluginRoot, 'scripts', 'board.ps1')), readTeamState(folder)])
      fullItems = new Map(script.items.map((item) => [item.key, item]))
      teamState = state
      await engine.setContext(script.items, state.config.agents, state.prompts.agents)
      if (boardTasksFolder !== folder) {
        boardTasksFolder = folder
        boardTasks.clear()
        for (const run of await readRuns(folder)) boardTasks.add(run.taskId)
      }
      result = { ok: true, snapshot: snapshotFrom(script, state), loadedAt: Date.now() }
      watchFolder(folder)
    } catch (error) {
      result = { ok: false, error: errorMessage(error), teamFolder: folder, loadedAt: Date.now() }
      orca.log(`Board refresh failed: ${result.error}`)
    }
    cache = result
    void updateStatusBar(result)
    post(result)
    if (result.ok) {
      void engine.enqueue()
      void autoReview()
      void drainInbox()
    }
    return result
  }

  function load(force: boolean): Promise<BoardResult> {
    if (!force && cache && Date.now() - cache.loadedAt < CACHE_MS) return Promise.resolve(cache)
    if (inflight) return inflight
    inflight = refresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function startInterval(): Promise<void> {
    const configured = Number(await orca.settings.get('refreshSeconds'))
    const seconds = Math.max(MIN_REFRESH_SECONDS, Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REFRESH_SECONDS)
    if (interval) clearInterval(interval)
    interval = setInterval(() => void load(true), seconds * 1000)
  }

  async function openInOrca(absolutePath: string): Promise<boolean> {
    const { workspaces } = await orca.host.call('workspace.list')
    const target = comparable(absolutePath)
    const owner = workspaces
      .filter((workspace) => target.startsWith(`${comparable(workspace.path)}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!owner) {
      throw codedError('action_failed', `No Orca workspace contains ${absolutePath}`)
    }
    const inside = relative(owner.path, absolutePath).replace(/\\/g, '/')
    try {
      await orca.host.call('editor.open', { workspaceId: owner.id, path: inside })
    } catch (first) {
      // Older hosts may want the absolute path; keep the first error if that fails too.
      try {
        await orca.host.call('editor.open', { workspaceId: owner.id, path: absolutePath })
      } catch {
        throw first
      }
    }
    return true
  }

  /** After a team edit: new agents, prompts and colours, and every decision they touch goes stale. */
  async function afterTeamChange(state: TeamState): Promise<TeamState> {
    teamState = state
    await engine.setContext([...fullItems.values()], state.config.agents, state.prompts.agents)
    await republish()
    void engine.enqueue()
    return state
  }

  async function teamCall(run: (folder: string) => Promise<TeamState>): Promise<TeamState> {
    try {
      return await afterTeamChange(await run(await teamFolder()))
    } catch (error) {
      throw asHostError(error)
    }
  }

  orca.panels.handle('board.load', (input) => load(Boolean(input?.force)))

  orca.panels.handle('board.item', async (input) => {
    if (!fullItems.size) await load(false)
    return { item: fullItems.get(String(input?.key ?? '')) ?? null }
  })

  orca.panels.handle('board.openSpec', async (input) => {
    const specFile = typeof input?.specFile === 'string' ? input.specFile : ''
    if (!SPEC_FILE.test(specFile)) {
      throw codedError('invalid_params', 'specFile must look like tasks/<name>.md')
    }
    return { opened: await openInOrca(join(await teamFolder(), specFile)) }
  })

  orca.panels.handle('team.load', async () => {
    try {
      return await readTeamState(await teamFolder())
    } catch (error) {
      throw asHostError(error)
    }
  })
  orca.panels.handle('team.saveAgent', (input) => teamCall((folder) => saveAgent(folder, input.agent, String(input.prompt ?? ''), Boolean(input.create))))
  orca.panels.handle('team.deleteAgent', (input) => teamCall((folder) => deleteAgent(folder, String(input.id))))
  orca.panels.handle('team.saveTeam', (input) => teamCall((folder) => saveTeam(folder, input.team, String(input.prompt ?? ''), Boolean(input.create))))
  orca.panels.handle('team.deleteTeam', (input) => teamCall((folder) => deleteTeam(folder, String(input.id))))

  orca.panels.handle('jev.status', () => engine.status())
  orca.panels.handle('jev.setToken', async (input) => {
    const token = String(input?.token ?? '').trim()
    if (!token || /\s/.test(token)) throw codedError('invalid_params', 'Paste the TypeSafe API key without spaces.')
    await orca.secrets.set(TOKEN_SECRET, token)
    void engine.enqueue()
    return engine.status()
  })
  orca.panels.handle('jev.clearToken', async () => {
    await orca.secrets.delete(TOKEN_SECRET)
    return engine.status()
  })
  orca.panels.handle('jev.test', () => engine.test())
  orca.panels.handle('jev.assess', async (input) => {
    if (!fullItems.size) await load(false)
    const { decision, error } = await engine.assess(String(input?.key ?? ''))
    return { decision, error }
  })
  orca.panels.handle('jev.assessAll', async (input) => {
    await engine.enqueue(Boolean(input?.all), false)
    return engine.status()
  })

  let detected: { at: number; agents: DetectedAgent[] } | null = null
  orca.panels.handle('agents.detect', async (input) => {
    try {
      if (!detected || input?.refresh || Date.now() - detected.at > DETECT_CACHE_MS) {
        detected = { at: Date.now(), agents: await detectAgents(childEnv(process.env)) }
      }
      return { agents: detected.agents, error: null }
    } catch (error) {
      return { agents: [], error: errorMessage(error) }
    }
  })

  orca.panels.handle('task.template', async () => ({ brief: await briefTemplate(await teamFolder()) }))

  /** The board's own terminal and Run (state/orchestra-board.json), one setup at a time. */
  let homeChain: Promise<unknown> = Promise.resolve()
  function boardHome(folder: string): Promise<BoardHome> {
    const next = homeChain.catch(() => undefined).then(() => ensureBoardHome(childEnv(process.env), { teamFolder: folder, repoRoot: dirname(folder), inboxScript: join(pluginRoot, 'inbox.ps1') }))
    homeChain = next
    return next
  }

  /** After each refresh: mark the board Run's messages read and answer questions (see drainBoardInbox). */
  let draining = false
  let lastDrainError = ''
  async function drainInbox(): Promise<void> {
    if (draining) return
    draining = true
    try {
      const home = await readBoardHome(await teamFolder())
      if (!home.terminal || !home.runId) return
      for (const message of await drainBoardInbox(childEnv(process.env), { terminal: home.terminal, runId: home.runId })) {
        if (message.type === 'question') orca.log(`Answered a question from task ${message.payload?.taskId ?? '?'}: ${message.subject ?? ''}`)
      }
      lastDrainError = ''
    } catch (error) {
      // A closed board terminal fails here until the next start opens a new one; say so once.
      const message = errorMessage(error)
      if (message !== lastDrainError) orca.log(`Board inbox not read: ${message}`)
      lastDrainError = message
    } finally {
      draining = false
    }
  }

  /** The card as the board last saw it; actions refuse cards that are gone or changed state. */
  async function currentItem(key: string): Promise<BoardItem> {
    const result = await load(true)
    const item = result.ok ? fullItems.get(key) : undefined
    if (!item) throw codedError('invalid_params', `The card ${key} is no longer on the board.`)
    return item
  }

  async function taskCall<T>(run: (folder: string) => Promise<T>): Promise<T> {
    try {
      const value = await run(await teamFolder())
      await load(true)
      return value
    } catch (error) {
      throw asHostError(error)
    }
  }

  /** Starts an agent on a spec, on the board's Run, and records the task for review automation. */
  async function launch(folder: string, agentId: string, key: string, kind: 'work' | 'review', title: string): Promise<{ name: string; taskId: string }> {
    const config = await readConfig(folder)
    const agent = config.agents.find((entry) => entry.id === agentId)
    if (!agent) throw codedError('invalid_params', `There is no agent "${agentId}".`)
    if (!agent.active) throw codedError('invalid_params', `${agent.name} is inactive. Activate the agent in Settings first.`)
    const home = await boardHome(folder)
    const started = await startWorker(childEnv(process.env), { agent, specPath: specPathOf(folder, key).file, title, repoRoot: dirname(folder), home })
    await recordRun(folder, { ...started, key, agent: agent.id, kind })
    boardTasks.add(started.taskId)
    return { name: agent.name, taskId: started.taskId }
  }

  /** Who does a card: its assignee, else Jev's pick when the pick is clear (or the best fit is Good or Strong). */
  async function pickAssignee(item: BoardItem): Promise<string> {
    if (item.persona !== '-') return item.persona
    const { decision, error } = await engine.decide(item.key)
    if (!decision) throw codedError('invalid_params', `Pick an assignee first. Jev could not decide: ${error ?? 'no decision'}`)
    const pick = decision.suggested
    if (pick.agent && pick.probability >= JEV_ASSIGN_PROBABILITY && pick.confidence >= JEV_ASSIGN_CONFIDENCE) return pick.agent
    const best = rankedFits(decision)[0]
    if (best && best.score >= 1.5) return best.agent
    throw codedError('invalid_params', 'Pick an assignee first: Jev found no clear fit for this task.')
  }

  /** Who reviews a card: the chosen reviewer, else Jev's pick, else the best fit; never the implementer. */
  async function pickReviewer(item: BoardItem, chosen?: string): Promise<string> {
    if (chosen) {
      if (chosen === item.persona) throw codedError('invalid_params', 'The implementer cannot review their own work.')
      return chosen
    }
    const { decision, error } = await engine.decide(item.key)
    const pick = decision?.reviewer?.agent
    if (pick && pick !== item.persona) return pick
    const fallback = rankedFits(decision ?? undefined).find((fit) => fit.agent !== item.persona)
    if (fallback) return fallback.agent
    throw codedError('invalid_params', error ? `Jev could not pick a reviewer: ${error}` : 'No other active agent can review this. Pick a reviewer.')
  }

  const reviewing = new Set<string>()
  const roundOf = (item: BoardItem) => (item.taskId ? item.olderTaskIds.length + 1 : 1)

  /** Writes a review spec for the card's current round and starts the reviewer on it. */
  async function requestReview(item: BoardItem, chosen?: string): Promise<string> {
    if (!item.specFile || item.reviews) throw codedError('invalid_params', 'Only a task card with a spec file can be reviewed.')
    if (item.column !== 'Under Review') throw codedError('invalid_params', 'Only cards in Under Review can be reviewed.')
    const round = roundOf(item)
    const guard = `${item.key}#${round}`
    if (!chosen && (reviewing.has(guard) || (item.reviewer && item.reviewer.round === round))) {
      throw codedError('invalid_params', 'This round already has a review. Pick a reviewer to ask for another one.')
    }
    reviewing.add(guard)
    try {
      const folder = await teamFolder()
      const reviewerId = await pickReviewer(item, chosen)
      const full = fullItems.get(item.key) ?? item
      const spec = await createReviewSpec(
        folder,
        await readConfig(folder),
        {
          name: item.specFile.replace(/^tasks\//, '').replace(/\.md$/, ''),
          specFile: item.specFile,
          title: item.title,
          priority: item.priority,
          persona: item.persona,
          taskId: item.taskId,
          round,
          report: full.report ? { subject: full.report.subject, body: full.report.body, filesModified: full.report.filesModified } : null
        },
        reviewerId
      )
      const started = await launch(folder, reviewerId, spec.key, 'review', spec.title)
      return `${started.name} is reviewing it (Orca task ${started.taskId}).`
    } catch (error) {
      reviewing.delete(guard)
      throw asHostError(error)
    }
  }

  /**
   * After each refresh: a card the board started that has just reported (Under Review, not reviewed)
   * gets a reviewer from Jev and starts at once. Older cards and cards started elsewhere are left alone;
   * "Request review" covers them.
   */
  let autoReviewRunning = false
  async function autoReview(): Promise<void> {
    if (autoReviewRunning) return
    if ((await orca.settings.get('autoReview')) === false || !(await orca.secrets.get(TOKEN_SECRET))) return
    autoReviewRunning = true
    let started = 0
    try {
      for (const item of [...fullItems.values()]) {
        if (item.column !== 'Under Review' || item.state !== 'not-reviewed' || item.status !== 'completed') continue
        if (!item.specFile || item.reviews || !item.taskId || !boardTasks.has(item.taskId)) continue
        if (reviewing.has(`${item.key}#${roundOf(item)}`)) continue
        try {
          orca.log(`Auto review ${item.key}: ${await requestReview(item)}`)
          started += 1
        } catch (error) {
          orca.log(`Auto review of ${item.key} failed: ${errorMessage(error)}`)
        }
      }
    } finally {
      autoReviewRunning = false
    }
    if (started) void load(true)
  }

  orca.panels.handle('task.create', (input) =>
    taskCall(async (folder) => {
      const config = await readConfig(folder)
      const assignee = String(input.assignee ?? '')
      const direct = assignee !== 'jev' && assignee !== 'later' ? assignee : null
      const created = await createSpec(folder, config, { title: String(input.title ?? ''), priority: input.priority, agentId: direct, brief: String(input.brief ?? '') })
      if (assignee !== 'jev') {
        return { key: created.key, assigned: direct, message: direct ? `Created ${created.specFile}.` : `Created ${created.specFile}. The agent is picked when it starts.` }
      }
      await load(true)
      const { decision, error } = await engine.assess(created.key)
      const pick = decision?.suggested
      if (pick?.agent && pick.probability >= JEV_ASSIGN_PROBABILITY && decision && decision.suggested.confidence >= JEV_ASSIGN_CONFIDENCE) {
        const moved = await assignSpec(folder, config, created.key, pick.agent)
        const fit = decision.fits?.[pick.agent]
        return { key: moved.key, assigned: pick.agent, message: `Jev picked ${config.agents.find((agent) => agent.id === pick.agent)?.name ?? pick.agent}${fit ? ` (${fit.level})` : ''}.` }
      }
      const why = error ?? (pick?.agent ? `Jev leaned to ${pick.agent} (${Math.round(pick.probability * 100)}%) but was not sure enough.` : 'Jev found no agent that fits.')
      return { key: created.key, assigned: null, message: `Created ${created.specFile} unassigned. ${why}` }
    })
  )

  orca.panels.handle('task.assign', async (input) => {
    const item = await currentItem(String(input.key))
    const editable = editableBeforeStart(item)
    if (!editable.ok) throw codedError('invalid_params', editable.reason)
    return taskCall(async (folder) => assignSpec(folder, await readConfig(folder), item.key, input.agent ? String(input.agent) : null))
  })

  orca.panels.handle('task.priority', async (input) => {
    const item = await currentItem(String(input.key))
    const editable = editableBeforeStart(item)
    if (!editable.ok) throw codedError('invalid_params', editable.reason)
    return taskCall(async (folder) => {
      await setPriority(folder, item.key, input.priority)
      return { key: item.key }
    })
  })

  orca.panels.handle('task.review', async (input) => {
    const item = await currentItem(String(input.key))
    const message = await requestReview(item, input.reviewer ? String(input.reviewer) : undefined)
    await load(true)
    return { message }
  })

  orca.panels.handle('task.move', async (input) => {
    const item = await currentItem(String(input.key))
    const plan = planMove(item, input.to)
    const note = String(input.note ?? '').trim()
    if (plan.action === 'refuse') throw codedError('invalid_params', plan.reason)
    return taskCall(async (folder) => {
      if (plan.action === 'start') {
        const agentId = await pickAssignee(item)
        const key = item.persona === agentId ? item.key : (await assignSpec(folder, await readConfig(folder), item.key, agentId)).key
        if (item.startRequested) await setStartRequested(folder, key, false)
        const started = await launch(folder, agentId, key, 'work', item.title)
        return { message: `${started.name} started on it (Orca task ${started.taskId}).`, started: true }
      }
      if (plan.action === 'unstart') {
        await setStartRequested(folder, item.key, false)
        return { message: 'Moved back to Backlog.', started: false }
      }
      if (plan.action === 'verdict') {
        const verdict = input.verdict
        if (!verdict || !plan.options.includes(verdict)) throw codedError('invalid_params', `Choose one of: ${plan.options.join(', ')}.`)
        const line = await appendReview(folder, item.key, verdict, note)
        return { message: `Wrote "${line}" in ${item.specFile}.`, started: false }
      }
      if (!note) throw codedError('invalid_params', 'Say what should change; the agent gets your note.')
      if (item.persona === '-') throw codedError('invalid_params', 'This card has no agent to send the changes to.')
      const config = await readConfig(folder)
      const name = config.agents.find((agent) => agent.id === item.persona)?.name ?? item.persona
      await appendReview(folder, item.key, 'Changes requested', note)
      await appendReview(folder, item.key, 'Rework', `${name} restarted with the changes above.`)
      const started = await launch(folder, item.persona, item.key, 'work', item.title)
      return { message: `${started.name} is reworking it with your note (Orca task ${started.taskId}).`, started: true }
    })
  })

  orca.commands.register('orchestra-board.open', async () => {
    const file = join(await teamFolder(), BOARD_FILE)
    if (!existsSync(file)) {
      writeFileSync(file, BOARD_FILE_TEXT, 'utf8')
    }
    await openInOrca(file)
    return 'Orchestra Board opened.'
  })

  orca.commands.register('orchestra-board.refresh', async () => {
    const result = await load(true)
    return result.ok ? statusBarView(result).tooltip : `Orchestra Board failed to load: ${result.error}`
  })

  orca.events.on('agent.status.changed', () => schedule(AGENT_EVENT_DELAY_MS))

  const settingsSubscription = orca.settings.onDidChange(({ key }) => {
    if (key === 'refreshSeconds') void startInterval()
    if (key === 'teamFolder') void load(true)
    if (key === 'jevModel' || key === 'jevAuto') {
      void (async () => {
        if (teamState) await engine.setContext([...fullItems.values()], teamState.config.agents, teamState.prompts.agents)
        await republish()
        void engine.enqueue()
        orca.panels.post('jev.changed', await engine.status())
      })()
    }
  })
  disposers.push(() => settingsSubscription.dispose())

  void startInterval()
  void load(true)
}

export function deactivate(): void {
  while (disposers.length) {
    disposers.pop()?.()
  }
}
