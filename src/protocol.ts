// The worker <-> editor contract, declared once: the worker and every editor module read it.
// BoardItem mirrors one item of `board.ps1 -Json`; the column rules live in board.ps1 (README bagian 3).

export type Column = 'Backlog' | 'In Progress' | 'Under Review' | 'Done'

/** board.ps1's stable state codes; `label` carries the English text for each. */
export type ItemState =
  | 'not-started'
  | 'start-requested'
  | 'queued-deps'
  | 'queued-ready'
  | 'working'
  | 'blocked'
  | 'cancelled'
  | 'failed'
  | 'failed-resolved'
  | 'inline-done'
  | 'approved'
  | 'merged'
  | 'closed'
  | 'changes-requested'
  | 'interim'
  | 'not-reviewed'
  | 'reviewing'
  | 'reviewed'
  | 'review-done'
  | 'unknown'

export type Priority = 'P1' | 'P2' | 'P3' | '-'

export type BoardReport = {
  outcome: string | null
  subject: string | null
  /** Empty in `board.load`; `board.item` sends it. */
  body: string
  filesModified: string[]
}

export type BoardReview = { verdict: string | null; lines: string[] }

/** One card: a spec file, a task started with an inline spec, or a spec joined to its task. */
export type BoardItem = {
  key: string
  column: Column
  state: ItemState
  label: string
  priority: Priority
  persona: string
  name: string
  title: string
  specFile: string | null
  specModified: string | null
  taskId: string | null
  olderTaskIds: string[]
  runId: string | null
  runObjective: string | null
  status: string | null
  deps: string[]
  createdAt: string | null
  completedAt: string | null
  time: string
  report: BoardReport | null
  review: BoardReview | null
  /** A `**Start requested:**` line written by version 0.3 (a request to the coordinator); later versions start workers themselves. */
  startRequested: string | null
  /** Review cards: the spec they review (`**Reviews:** tasks/x.md (round n)`). */
  reviews: string | null
  reviewRound: number | null
  /** Original cards: the review of their current round, when one exists. */
  reviewer: { key: string; persona: string; round: number; status: string | null } | null
  /** The task brief (the spec below its persona prompt). Only `board.item` sends it. */
  brief?: string
}

export type Agent = {
  id: string
  name: string
  role: string
  team: string | null
  /** Orca agent id for `worker-start --agent`; null for the lead, who is never a worker. */
  agent: string | null
  model: string | null
  effort: string | null
  active: boolean
  color: string
  note: string
}

export type Team = { id: string; name: string; description: string }

export type TeamConfig = { version: 1; roles: string[]; teams: Team[]; agents: Agent[] }

export type FitLevel = 'Poor fit' | 'Partial fit' | 'Good fit' | 'Strong fit'

/** Jev's judgments about one card. Probabilities and confidence are Jev's own numbers. */
export type Decision = {
  model: string
  assessedAt: number
  /** Best agent for the task; null when Jev picked "none of these agents fits". */
  suggested: { agent: string | null; probability: number; confidence: number; probabilities: Record<string, number> }
  /** Fit of every active worker for this task, by agent id. */
  fits: Record<string, FitScore>
  /** How well the assigned agent fits; null when the card has no assigned agent on the team. */
  fit: ({ agent: string } & FitScore) | null
  /** Who should review the work: never the implementer; null agent when none fits. */
  reviewer: { agent: string | null; probability: number; confidence: number } | null
  priority: { suggested: Exclude<Priority, '-'>; score: number; confidence: number }
}

export type FitScore = { level: FitLevel; score: number; confidence: number }

export type BoardSnapshot = {
  generatedAt: string
  teamFolder: string
  columns: Column[]
  items: BoardItem[]
  agents: Agent[]
  teams: Team[]
  /** Current Jev decisions by card key; stale ones (spec, brief or agents changed) are left out. */
  decisions: Record<string, Decision>
}

export type BoardCounts = Record<Column, number>

export type BoardResult =
  | { ok: true; snapshot: BoardSnapshot; loadedAt: number }
  | { ok: false; error: string; teamFolder: string | null; loadedAt: number }

export type TeamState = {
  config: TeamConfig
  prompts: { agents: Record<string, string>; teams: Record<string, string> }
  /** Spec files per agent id, so the UI can say why an agent cannot be deleted. */
  specCounts: Record<string, number>
}

/** A model Orca discovered for an agent CLI (agent-model-catalog.json). `id` is what --model takes. */
export type CatalogModel = {
  id: string
  label: string
  description: string
  isDefault: boolean
  efforts: Array<{ value: string; label: string }>
  defaultEffort: string | null
}

/** An agent CLI Orca knows, and whether this machine has it. */
export type DetectedAgent = {
  id: string
  label: string
  installed: boolean
  enabled: boolean
  isDefault: boolean
  /** What worker-start accepts for it: a model and effort, a model only, or neither (the agent uses its own config). */
  takes: 'model+effort' | 'model' | 'none'
  models: CatalogModel[]
}

export type Verdict = 'Merged' | 'Approved' | 'Closed'

export type JevStatus = {
  configured: boolean
  last4: string | null
  protection: 'os-keyring' | 'unavailable' | 'unknown'
  auto: boolean
  model: string
  pending: number
  lastError: string | null
  lastAssessedAt: number | null
}

declare module 'orca' {
  interface PluginRequests {
    /** The latest board; `force` runs board.ps1 now instead of answering from the 5 s cache. */
    'board.load': { input: { force?: boolean }; output: BoardResult }
    /** One card with its brief and the full worker report. */
    'board.item': { input: { key: string }; output: { item: BoardItem | null } }
    /** Opens `tasks/<name>.md` of the team folder in an Orca editor tab. */
    'board.openSpec': { input: { specFile: string }; output: { opened: boolean } }
    'team.load': { output: TeamState }
    'team.saveAgent': { input: { agent: Agent; prompt: string; create: boolean }; output: TeamState }
    'team.deleteAgent': { input: { id: string }; output: TeamState }
    'team.saveTeam': { input: { team: Team; prompt: string; create: boolean }; output: TeamState }
    'team.deleteTeam': { input: { id: string }; output: TeamState }
    'jev.status': { output: JevStatus }
    'jev.setToken': { input: { token: string }; output: JevStatus }
    'jev.clearToken': { output: JevStatus }
    'jev.test': { output: { ok: boolean; message: string } }
    /** Assess one card now, ignoring the cache. */
    'jev.assess': { input: { key: string }; output: { decision: Decision | null; error: string | null } }
    /** Queue every card whose decision is missing or stale (`all`: every card). */
    'jev.assessAll': { input: { all?: boolean }; output: JevStatus }
    /** Agent CLIs from Orca: its model catalog, its disabled list, and which binaries this machine has. */
    'agents.detect': { input: { refresh?: boolean }; output: { agents: DetectedAgent[]; error: string | null } }
    /** The brief template for a new task, without its title and priority lines. */
    'task.template': { output: { brief: string } }
    /** A new spec in tasks/. `assignee`: an agent id, 'jev' (Jev picks the best fit now) or 'later' (decided at start). */
    'task.create': {
      input: { title: string; priority: Exclude<Priority, '-'>; assignee: string; brief: string }
      output: { key: string; assigned: string | null; message: string }
    }
    /** Reassign a spec that is not in Orca yet; null leaves it for Jev to pick at start. */
    'task.assign': { input: { key: string; agent: string | null }; output: { key: string } }
    'task.priority': { input: { key: string; priority: Exclude<Priority, '-'> }; output: { key: string } }
    /** Move a card to another column, as planMove allows. */
    'task.move': { input: { key: string; to: Column; verdict?: Verdict; note?: string }; output: { message: string; started: boolean } }
    /** Start a review of the card's current round now; `reviewer` overrides Jev's pick. */
    'task.review': { input: { key: string; reviewer?: string }; output: { message: string } }
  }
  interface PluginPanelEvents {
    /** Posted after a refresh or a new Jev decision changed the board; editors ask `board.load` again. */
    'board.changed': { loadedAt: number; counts: BoardCounts | null }
    'jev.changed': JevStatus
  }
}
