import { assert, test } from 'orca/testing'
import type { Agent, BoardItem } from '../protocol'
import { briefBody, editableBeforeStart, planMove, slugify, edgePath, filterItems, formatDuration, groupColumns, layoutFlow, parseReviewLine, personaName, personasOf, relativeTime, stateTone, timelineSteps } from './model'

function item(patch: Partial<BoardItem> & { key: string }): BoardItem {
  return {
    column: 'Done',
    state: 'approved',
    label: 'Approved',
    priority: '-',
    persona: 'bagas',
    name: patch.key,
    title: patch.key,
    specFile: null,
    specModified: null,
    taskId: null,
    olderTaskIds: [],
    runId: null,
    runObjective: null,
    status: null,
    deps: [],
    createdAt: null,
    completedAt: null,
    time: '',
    report: null,
    review: null,
    startRequested: null,
    reviews: null,
    reviewRound: null,
    reviewer: null,
    ...patch
  }
}

const agent = (id: string, name: string): Agent => ({ id, name, role: 'Engineer', team: 'core', agent: 'claude', model: 'm', effort: null, active: true, color: '#000000', note: '' })

test('columns follow board.ps1 order: Done newest first, the rest by priority then age', () => {
  const groups = groupColumns(
    [
      item({ key: 'b-p3', column: 'Backlog', priority: 'P3', time: '2026-11-01T00:00:00' }),
      item({ key: 'b-p1', column: 'Backlog', priority: 'P1', time: '2026-11-05T00:00:00' }),
      item({ key: 'b-none', column: 'Backlog', priority: '-', time: '2026-10-01T00:00:00' }),
      ...Array.from({ length: 7 }, (_, index) => item({ key: `d${index}`, time: `2026-11-0${index + 1}T00:00:00` }))
    ],
    false
  )
  assert.deepEqual(groups[0].items.map((entry) => entry.key), ['b-p1', 'b-p3', 'b-none'])
  const done = groups[3]
  assert.equal(done.total, 7)
  assert.equal(done.hidden, 2)
  assert.deepEqual(done.items.map((entry) => entry.key), ['d6', 'd5', 'd4', 'd3', 'd2'])
})

test('filters by assignee, priority and text', () => {
  const items = [
    item({ key: 'a', persona: 'bagas', priority: 'P1', title: 'Endpoint login' }),
    item({ key: 'b', persona: 'rizki', priority: 'P2', title: 'Review', taskId: 'task_abc' })
  ]
  assert.deepEqual(filterItems(items, { persona: 'rizki', priority: 'all', query: '' }).map((entry) => entry.key), ['b'])
  assert.deepEqual(filterItems(items, { persona: 'all', priority: 'P1', query: '' }).map((entry) => entry.key), ['a'])
  assert.deepEqual(filterItems(items, { persona: 'all', priority: 'all', query: 'TASK_ABC' }).map((entry) => entry.key), ['b'])
})

test('agents come in team.json order, unknown ids after, unassigned last', () => {
  const agents = [agent('rizki', 'Rizki'), agent('bagas', 'Bagas')]
  const order = personasOf([item({ key: '1', persona: '-' }), item({ key: '2', persona: 'bagas' }), item({ key: '3', persona: 'zed' }), item({ key: '4', persona: 'rizki' })], agents)
  assert.deepEqual(order, ['rizki', 'bagas', 'zed', '-'])
  assert.equal(personaName('-', agents), 'Unassigned')
  assert.equal(personaName('zed', agents), 'Zed')
})

test('state tones', () => {
  assert.equal(stateTone('failed'), 'danger')
  assert.equal(stateTone('changes-requested'), 'warning')
  assert.equal(stateTone('queued-deps'), 'queue')
  assert.equal(stateTone('merged'), 'ok')
  assert.equal(stateTone('working'), '')
})

test('flow keeps time order, shares columns across lanes, puts dependents after their dependency, and keeps dragged cards', () => {
  const at = (minute: number) => `2026-11-07T10:${String(minute).padStart(2, '0')}:00Z`
  const items = [
    item({ key: 'audit', persona: 'rizki', taskId: 't1', createdAt: at(0) }),
    item({ key: 'fix', persona: 'bagas', taskId: 't2', createdAt: at(1) }),
    item({ key: 'engine', persona: 'bagas', taskId: 't3', createdAt: at(2) }),
    item({ key: 'review1', persona: 'rizki', taskId: 't4', createdAt: at(3) }),
    item({ key: 'review2', persona: 'rizki', taskId: 't5', createdAt: at(4), deps: ['t3'] }),
    item({ key: 'later', persona: 'bagas', specFile: 'tasks/bagas-later.md', priority: 'P1', column: 'Backlog' })
  ]
  const layout = layoutFlow(items, [agent('bagas', 'Bagas'), agent('rizki', 'Rizki')])
  const slot = (key: string) => layout.nodes.find((node) => node.item.key === key)?.slot
  assert.deepEqual(['audit', 'fix', 'engine', 'review1', 'review2', 'later'].map(slot), [0, 0, 1, 1, 2, 4])
  assert.deepEqual(layout.lanes.map((lane) => lane.persona), ['bagas', 'rizki'])
  assert.deepEqual(layout.edges.map((edge) => `${edge.from.item.key}->${edge.to.item.key}`), ['engine->review2'])

  const moved = layoutFlow(items, [], { review2: { x: 4000, y: 600 } })
  const node = moved.nodes.find((entry) => entry.item.key === 'review2')
  assert.deepEqual([node?.x, node?.y, node?.moved], [4000, 600, true])
  assert.ok(moved.width >= 4000 + 240)
  assert.ok(edgePath({ x: 0, y: 0 }, { x: 400, y: 100 }).startsWith('M 240 44 C'))
})

test('timeline merges a spec saved with its task, and lists a later save after the reviews', () => {
  const steps = timelineSteps(
    item({
      key: 'x',
      specFile: 'tasks/x.md',
      specModified: '2026-11-07T10:00:30Z',
      createdAt: '2026-11-07T10:00:00Z',
      completedAt: '2026-11-07T10:56:00Z',
      review: { verdict: 'Approved', lines: ['Rizki — 2026-11-08 (ctx): APPROVE', 'Approved — 2026-11-08 (Krisna). ok'] }
    })
  )
  assert.deepEqual(steps.map((step) => step.title), ['Spec written and task started', 'Worker reported done', 'Rizki', 'Approved'])
  assert.equal(steps[1].detail, 'Took 56m')
  assert.deepEqual(steps.map((step) => step.tone), ['progress', 'review', 'note', 'done'])

  const later = timelineSteps(item({ key: 'y', specModified: '2026-11-08T02:20:00Z', createdAt: '2026-11-07T16:41:40Z' }))
  assert.deepEqual(later.map((step) => step.title), ['Task started in Orca', 'Spec updated'])
  const backlog = timelineSteps(item({ key: 'z', column: 'Backlog', specModified: '2026-11-08T02:20:00Z' }))
  assert.deepEqual(backlog.map((step) => step.title), ['Spec written'])
})

test('time labels', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  assert.equal(relativeTime(now - 10_000, now), 'just now')
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago')
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago')
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2d ago')
  assert.equal(formatDuration(16 * 60_000), '16m')
  assert.equal(formatDuration(93 * 60_000), '1h 33m')
  assert.equal(formatDuration(27 * 3_600_000), '1d 3h')
})

test('review lines split into verdict, date and note', () => {
  assert.deepEqual(parseReviewLine('Approved — 2026-11-08 (Krisna). Merged.'), { head: 'Approved', date: '2026-11-08', text: '(Krisna). Merged.' })
  assert.deepEqual(parseReviewLine('free note'), { head: '', date: null, text: 'free note' })
})

test('the brief drops its "# Task:" heading, which the dialog shows as the title', () => {
  assert.equal(briefBody('# Task: Login\n\n## Goal\nShip it'), '## Goal\nShip it')
  assert.equal(briefBody('## Goal\nShip it'), '## Goal\nShip it')
})

test('moves follow the team workflow: start, take back, request changes, verdicts; the rest is refused', () => {
  const spec = { specFile: 'tasks/x.md' }
  const backlog = item({ key: 'a', column: 'Backlog', state: 'not-started', ...spec })
  assert.deepEqual(planMove(backlog, 'In Progress'), { action: 'start' })
  assert.deepEqual(planMove(backlog, 'Done'), { action: 'verdict', options: ['Closed'] })
  assert.equal(planMove(backlog, 'Under Review').action, 'refuse')

  const waiting = item({ key: 'b', column: 'In Progress', state: 'start-requested', ...spec })
  assert.deepEqual(planMove(waiting, 'Backlog'), { action: 'unstart' })
  assert.equal(planMove(waiting, 'Under Review').action, 'refuse')

  const working = item({ key: 'c', column: 'In Progress', state: 'working', taskId: 't', ...spec })
  assert.equal(planMove(working, 'Done').action, 'refuse')

  const review = item({ key: 'd', column: 'Under Review', state: 'not-reviewed', taskId: 't', ...spec })
  assert.deepEqual(planMove(review, 'Done'), { action: 'verdict', options: ['Merged', 'Approved', 'Closed'] })
  assert.deepEqual(planMove(review, 'In Progress'), { action: 'changes' })
  assert.equal(planMove(review, 'Backlog').action, 'refuse')

  assert.equal(planMove(item({ key: 'e', column: 'Done', state: 'approved', ...spec }), 'Under Review').action, 'refuse')
  assert.equal(planMove(item({ key: 'f', column: 'Under Review', state: 'not-reviewed' }), 'Done').action, 'refuse', 'inline tasks have no spec')
  assert.equal(planMove(item({ key: 'g', column: 'Backlog', state: 'queued-ready', taskId: 't', ...spec }), 'In Progress').action, 'refuse')
})

test('assignee and priority change only before the task is in Orca', () => {
  assert.deepEqual(editableBeforeStart(item({ key: 'a', column: 'Backlog', state: 'not-started', specFile: 'tasks/a.md' })), { ok: true })
  assert.equal(editableBeforeStart(item({ key: 'b', column: 'In Progress', state: 'start-requested', specFile: 'tasks/b.md' })).ok, false)
  assert.equal(editableBeforeStart(item({ key: 'c', column: 'Under Review', state: 'not-reviewed', specFile: 'tasks/c.md', taskId: 't' })).ok, false)
})

test('titles become file names', () => {
  assert.equal(slugify('Add login endpoint (v2)!'), 'add-login-endpoint-v2')
  assert.equal(slugify('Ünïcode café'), 'unicode-cafe')
  assert.equal(slugify('2026 plan'), 't-2026-plan')
  assert.equal(slugify('!!!'), '')
})
