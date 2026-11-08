// Pure logic for the board editor: filtering, column order, the Flow layout, the activity timeline and
// time labels. No DOM and no Orca calls, so model.test.ts runs it in Node.
import type { Agent, BoardItem, Column, Decision, FitScore, ItemState, Verdict } from '../protocol'

export const COLUMNS: Column[] = ['Backlog', 'In Progress', 'Under Review', 'Done']
export const DONE_SHOWN = 5
const PRIORITY_RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3 }
const SAME_MOMENT_MS = 2 * 60_000

export type Filters = { persona: string; priority: string; query: string }
export type ColumnGroup = { column: Column; items: BoardItem[]; total: number; hidden: number }
export type Tone = '' | 'danger' | 'warning' | 'queue' | 'ok'

export function parseUtc(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

const rank = (item: BoardItem) => PRIORITY_RANK[item.priority] ?? 9

export function stateTone(state: ItemState): Tone {
  if (state === 'failed') return 'danger'
  if (state === 'changes-requested' || state === 'interim') return 'warning'
  if (state === 'queued-deps' || state === 'queued-ready' || state === 'start-requested') return 'queue'
  if (state === 'approved' || state === 'merged' || state === 'closed') return 'ok'
  return ''
}

export function filterItems(items: BoardItem[], filters: Filters): BoardItem[] {
  const query = filters.query.trim().toLowerCase()
  return items.filter((item) => {
    if (filters.persona !== 'all' && item.persona !== filters.persona) return false
    if (filters.priority !== 'all' && item.priority !== filters.priority) return false
    if (!query) return true
    return [item.title, item.name, item.key, item.taskId, item.label, item.runObjective, item.report?.subject]
      .some((field) => typeof field === 'string' && field.toLowerCase().includes(query))
  })
}

/** Same order as board.ps1: Done newest first, the rest by priority then oldest first. */
export function groupColumns(items: BoardItem[], showAllDone: boolean): ColumnGroup[] {
  return COLUMNS.map((column) => {
    const inColumn = items.filter((item) => item.column === column)
    const sorted =
      column === 'Done'
        ? [...inColumn].sort((a, b) => b.time.localeCompare(a.time))
        : [...inColumn].sort((a, b) => rank(a) - rank(b) || a.time.localeCompare(b.time))
    const visible = column === 'Done' && !showAllDone ? sorted.slice(0, DONE_SHOWN) : sorted
    return { column, items: visible, total: sorted.length, hidden: sorted.length - visible.length }
  })
}

/** Agents on the board, in team.json order, then unknown ids, then unassigned ('-'). */
export function personasOf(items: BoardItem[], agents: Agent[] = []): string[] {
  const order = agents.map((agent) => agent.id)
  const seen = [...new Set(items.map((item) => item.persona))]
  const position = (persona: string) => (persona === '-' ? 1e6 : order.includes(persona) ? order.indexOf(persona) : 1e3)
  return seen.sort((a, b) => position(a) - position(b) || a.localeCompare(b))
}

export function personaName(persona: string, agents: Agent[] = []): string {
  if (persona === '-') return 'Unassigned'
  return agents.find((agent) => agent.id === persona)?.name ?? persona.charAt(0).toUpperCase() + persona.slice(1)
}

export function indexByTask(items: BoardItem[]): Map<string, BoardItem> {
  const map = new Map<string, BoardItem>()
  for (const item of items) {
    if (item.taskId) map.set(item.taskId, item)
  }
  return map
}

export function dependentsOf(item: BoardItem, items: BoardItem[]): BoardItem[] {
  if (!item.taskId) return []
  return items.filter((other) => other.deps.includes(item.taskId as string))
}

/** When the card last moved: finished, started, or (backlog) the spec was saved. */
export function activityTime(item: BoardItem): number | null {
  return parseUtc(item.completedAt) ?? parseUtc(item.createdAt) ?? parseUtc(item.specModified)
}

export function relativeTime(ms: number, now: number): string {
  const seconds = Math.round((now - ms) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.round(days / 30)}mo ago`
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days}d ${restHours}h` : `${days}d`
}

/** "Approved — 2026-11-08 (Lead). note" → head, date and the rest. */
export function parseReviewLine(line: string): { head: string; date: string | null; text: string } {
  const match = /^(.+?)\s+—\s+(\d{4}-\d{2}-\d{2})?\s*(.*)$/.exec(line)
  if (!match) return { head: '', date: null, text: line }
  return { head: match[1], date: match[2] ?? null, text: match[3] }
}

/**
 * What moving a card to another column does. The worker carries it out; it never stops a worker:
 * - Backlog → In Progress starts the assignee in Orca (Jev picks one when there is none).
 * - In Progress (a start request from an older board) → Backlog takes that request back.
 * - → Done writes a verdict: Merged, Approved (PR open) or Closed; a card nobody started can only be Closed.
 * - Under Review → In Progress writes "Changes requested" with a note and starts the same agent again.
 * Everything else moves by itself (an agent starting or reporting) and is refused here.
 */
export type MovePlan =
  | { action: 'start' }
  | { action: 'unstart' }
  | { action: 'verdict'; options: Verdict[] }
  | { action: 'changes' }
  | { action: 'refuse'; reason: string }

export function planMove(item: BoardItem, to: Column): MovePlan {
  const from = item.column
  if (from === to) return { action: 'refuse', reason: 'The card is already in this column.' }
  if (from === 'Done') return { action: 'refuse', reason: 'Done cards stay done. Write a new task to reopen the work.' }
  if (!item.specFile) return { action: 'refuse', reason: 'This task was started with an inline spec, so there is no spec file to update.' }
  if (to === 'Under Review') return { action: 'refuse', reason: "A card reaches Under Review when its worker reports. It can't be moved there by hand." }

  if (item.state === 'not-started') {
    if (to === 'In Progress') return { action: 'start' }
    if (to === 'Done') return { action: 'verdict', options: ['Closed'] }
  }
  if (item.state === 'start-requested') {
    if (to === 'Backlog') return { action: 'unstart' }
    if (to === 'Done') return { action: 'verdict', options: ['Closed'] }
    return { action: 'refuse', reason: 'An older board asked the coordinator to start this. Move it back to Backlog, then drag it to In Progress to start it now.' }
  }
  if (item.state === 'queued-deps' || item.state === 'queued-ready') {
    return { action: 'refuse', reason: 'The task is already queued in Orca. Its Run starts it when its dependencies finish.' }
  }
  if (from === 'In Progress') {
    return { action: 'refuse', reason: 'An agent is on this task. The card moves when the agent reports.' }
  }
  if (from === 'Under Review') {
    if (to === 'Done') return { action: 'verdict', options: ['Merged', 'Approved', 'Closed'] }
    if (to === 'In Progress') return { action: 'changes' }
    return { action: 'refuse', reason: 'A reviewed task cannot go back to Backlog. Request changes or close it instead.' }
  }
  return { action: 'refuse', reason: 'This move is not supported.' }
}

/** Assignee and priority can change only while the spec is not in Orca yet. */
export function editableBeforeStart(item: BoardItem): { ok: true } | { ok: false; reason: string } {
  if (!item.specFile) return { ok: false, reason: 'Inline task: there is no spec file.' }
  if (item.state === 'start-requested') return { ok: false, reason: 'An older board asked the coordinator to start it. Move it back to Backlog to change this.' }
  if (item.taskId || item.state !== 'not-started') return { ok: false, reason: 'The task is already in Orca, which keeps its own copy of the spec.' }
  return { ok: true }
}

/** File-name form of a title or name: lowercase letters, digits and dashes. */
export function slugify(text: string, max = 48): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return /^[a-z]/.test(slug) ? slug : slug ? `t-${slug}` : ''
}

/** The brief opens with "# Task: <title>", which the dialog already shows as its heading. */
export function briefBody(brief: string): string {
  return brief.replace(/^\s*#\s+Task:[^\n]*\n?/, '').trimStart()
}

export type StepTone = 'backlog' | 'progress' | 'review' | 'done' | 'danger' | 'note'
export type Step = { title: string; when: number | null; date: string | null; detail: string; tone: StepTone }

function reviewTone(head: string): StepTone {
  if (/^(Approved|Merged|Closed)/.test(head)) return 'done'
  if (/^Changes requested/.test(head)) return 'danger'
  if (/^Interim/.test(head)) return 'review'
  return 'note'
}

/**
 * The card's history, oldest first. A spec saved within two minutes of its task starting is one step;
 * a spec saved later (usually to append a review) comes after the reviews as "Spec updated".
 */
export function timelineSteps(item: BoardItem): Step[] {
  const steps: Step[] = []
  const specSaved = parseUtc(item.specModified)
  const created = parseUtc(item.createdAt)
  const finished = parseUtc(item.completedAt)
  const together = specSaved !== null && created !== null && Math.abs(specSaved - created) <= SAME_MOMENT_MS
  const specLater = specSaved !== null && created !== null && !together && specSaved > created

  if (specSaved !== null && created === null) steps.push({ title: 'Spec written', when: specSaved, date: null, detail: '', tone: 'backlog' })
  if (specSaved !== null && created !== null && !together && !specLater) {
    steps.push({ title: 'Spec written', when: specSaved, date: null, detail: '', tone: 'backlog' })
  }
  if (item.startRequested) {
    steps.push({ title: 'Start requested', when: null, date: item.startRequested.slice(0, 10), detail: 'Asked by an older version of the board; nothing runs until it is started', tone: 'progress' })
  }
  if (item.olderTaskIds.length) {
    steps.push({ title: `Started ${item.olderTaskIds.length + 1} times`, when: null, date: null, detail: `Earlier tasks: ${item.olderTaskIds.join(', ')}`, tone: 'note' })
  }
  if (created !== null) {
    steps.push({ title: together ? 'Spec written and task started' : 'Task started in Orca', when: created, date: null, detail: '', tone: 'progress' })
  }
  if (finished !== null) {
    const failed = item.status === 'failed'
    steps.push({
      title: failed ? 'Worker reported failure' : 'Worker reported done',
      when: finished,
      date: null,
      detail: created !== null ? `Took ${formatDuration(finished - created)}` : '',
      tone: failed ? 'danger' : 'review'
    })
  }
  for (const line of item.review?.lines ?? []) {
    const parsed = parseReviewLine(line)
    if (!parsed.head) continue
    steps.push({ title: parsed.head, when: null, date: parsed.date, detail: parsed.text, tone: reviewTone(parsed.head) })
  }
  if (specLater) steps.push({ title: 'Spec updated', when: specSaved, date: null, detail: '', tone: 'note' })
  return steps
}

export type FlowDims = { nodeW: number; nodeH: number; gapX: number; laneGap: number; gutter: number; pad: number }
export type Point = { x: number; y: number }
export type FlowNode = { item: BoardItem; lane: number; slot: number; x: number; y: number; moved: boolean }
export type FlowLane = { persona: string; y: number }
export type FlowLayout = {
  lanes: FlowLane[]
  nodes: FlowNode[]
  edges: Array<{ from: FlowNode; to: FlowNode }>
  backlogX: number | null
  width: number
  height: number
}

export const FLOW_DIMS: FlowDims = { nodeW: 240, nodeH: 88, gapX: 56, laneGap: 32, gutter: 132, pad: 28 }

/**
 * One lane per persona, time running left to right. A task never sits left of the task started
 * before it, nor left of (or level with) a task it depends on; tasks in different lanes may share
 * a column, which is how parallel work shows. Specs not yet in Orca follow after a gap, by priority.
 * `positions` are cards the person dragged; they keep that spot until the layout is reset.
 */
export function layoutFlow(items: BoardItem[], agents: Agent[] = [], positions: Record<string, Point> = {}, dims: FlowDims = FLOW_DIMS): FlowLayout {
  const started = items
    .filter((item) => parseUtc(item.createdAt) !== null)
    .sort((a, b) => (parseUtc(a.createdAt) as number) - (parseUtc(b.createdAt) as number) || a.key.localeCompare(b.key))
  const backlog = items
    .filter((item) => parseUtc(item.createdAt) === null)
    .sort((a, b) => rank(a) - rank(b) || a.time.localeCompare(b.time))

  const lanePersonas = personasOf([...started, ...backlog], agents)
  const laneOf = new Map(lanePersonas.map((persona, index) => [persona, index]))
  const laneLast = new Map<number, number>()
  const slotOfTask = new Map<string, number>()
  const placed: Array<{ item: BoardItem; lane: number; slot: number }> = []

  let previousSlot = 0
  for (const item of started) {
    const lane = laneOf.get(item.persona) as number
    let slot = Math.max(previousSlot, (laneLast.get(lane) ?? -1) + 1)
    for (const dep of item.deps) {
      const depSlot = slotOfTask.get(dep)
      if (depSlot !== undefined) slot = Math.max(slot, depSlot + 1)
    }
    laneLast.set(lane, slot)
    if (item.taskId) slotOfTask.set(item.taskId, slot)
    previousSlot = slot
    placed.push({ item, lane, slot })
  }

  const backlogStart = started.length ? previousSlot + 2 : 0
  const backlogLast = new Map<number, number>()
  for (const item of backlog) {
    const lane = laneOf.get(item.persona) as number
    const slot = (backlogLast.get(lane) ?? backlogStart - 1) + 1
    backlogLast.set(lane, slot)
    placed.push({ item, lane, slot })
  }

  const laneHeight = dims.nodeH + dims.laneGap
  const xOf = (slot: number) => dims.gutter + dims.pad + slot * (dims.nodeW + dims.gapX)
  const yOf = (lane: number) => dims.pad + lane * laneHeight
  const nodes: FlowNode[] = placed.map(({ item, lane, slot }) => {
    const moved = positions[item.key]
    return { item, lane, slot, x: moved?.x ?? xOf(slot), y: moved?.y ?? yOf(lane), moved: Boolean(moved) }
  })
  const nodeOfTask = new Map(nodes.filter((node) => node.item.taskId).map((node) => [node.item.taskId as string, node]))
  const edges = nodes.flatMap((to) =>
    to.item.deps.flatMap((dep) => {
      const from = nodeOfTask.get(dep)
      return from ? [{ from, to }] : []
    })
  )
  const maxSlot = placed.reduce((max, entry) => Math.max(max, entry.slot), 0)
  const baseWidth = xOf(maxSlot) + dims.nodeW + dims.pad
  const baseHeight = dims.pad * 2 + Math.max(1, lanePersonas.length) * laneHeight - dims.laneGap
  return {
    lanes: lanePersonas.map((persona, index) => ({ persona, y: yOf(index) })),
    nodes,
    edges,
    backlogX: backlog.length && started.length ? xOf(backlogStart) - dims.gapX : null,
    width: Math.max(baseWidth, ...nodes.map((node) => node.x + dims.nodeW + dims.pad)),
    height: Math.max(baseHeight, ...nodes.map((node) => node.y + dims.nodeH + dims.pad))
  }
}

/** A curve from the right edge of `from` to the left edge of `to`, bending back when `to` sits left. */
export function edgePath(from: Point, to: Point, dims: FlowDims = FLOW_DIMS): string {
  const x1 = from.x + dims.nodeW
  const y1 = from.y + dims.nodeH / 2
  const x2 = to.x - 2
  const y2 = to.y + dims.nodeH / 2
  const dx = Math.max(48, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export const snap = (value: number, grid = 8) => Math.round(value / grid) * grid

/** Workers ranked by Jev's fit score for a card, best first. */
export function rankedFits(decision: Decision | undefined): Array<{ agent: string } & FitScore> {
  if (!decision?.fits) return []
  return Object.entries(decision.fits)
    .map(([agent, fit]) => ({ agent, ...fit }))
    .sort((a, b) => b.score - a.score)
}
