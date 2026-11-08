import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import type { TeamConfig } from './protocol'
import { appendReview, assignSpec, briefTemplate, createReviewSpec, createSpec, launchFlags, orcaCandidates, readBoardHome, readRuns, recordRun, setPriority, setStartRequested, splitSpec, workerStartArgs } from './task-actions'

const config: TeamConfig = {
  version: 1,
  roles: [],
  teams: [{ id: 'core', name: 'Core', description: '' }],
  agents: [
    { id: 'bagas', name: 'Bagas', role: 'Senior Software Engineer', team: 'core', agent: 'claude', model: 'm', effort: null, active: true, color: '#000000', note: '' },
    { id: 'rizki', name: 'Rizki', role: 'Principal', team: null, agent: 'claude', model: 'm', effort: null, active: true, color: '#000000', note: '' }
  ]
}

async function withFolder(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-tasks-'))
  for (const sub of ['tasks', 'agents', 'teams', 'templates']) mkdirSync(join(dir, sub))
  writeFileSync(join(dir, 'agents', 'bagas.md'), '# Bagas\nYou build.\n')
  writeFileSync(join(dir, 'agents', 'rizki.md'), '# Rizki\nYou review.\n')
  writeFileSync(join(dir, 'teams', 'core.md'), '# Core rules\n')
  writeFileSync(join(dir, 'templates', 'task-brief.md'), '# Task: <judul singkat>\n\n**Priority:** <P1|P2|P3>\n\n<!-- fill it in -->\n\n## Goal\n<goal>\n')
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the brief template drops its title, priority and comment', () =>
  withFolder(async (dir) => {
    assert.equal(await briefTemplate(dir), '## Goal\n<goal>')
  }))

test('a new task is team prompt + agent prompt + --- + brief, or starts at --- when unassigned', () =>
  withFolder(async (dir) => {
    const made = await createSpec(dir, config, { title: 'Add login endpoint!', priority: 'P1', agentId: 'bagas', brief: '## Goal\nShip it' })
    assert.equal(made.key, 'spec:bagas-add-login-endpoint')
    const text = readFileSync(join(dir, 'tasks', 'bagas-add-login-endpoint.md'), 'utf8')
    assert.ok(text.startsWith('# Core rules\n\n# Bagas\nYou build.\n\n---\n\n# Task: Add login endpoint!\n\n**Priority:** P1\n\n## Goal\nShip it'))
    const again = await createSpec(dir, config, { title: 'Add login endpoint', priority: 'P2', agentId: 'bagas', brief: '' })
    assert.equal(again.key, 'spec:bagas-add-login-endpoint-2')
    const open = await createSpec(dir, config, { title: 'Pick a worker', priority: 'P3', agentId: null, brief: 'x' })
    assert.equal(open.key, 'spec:unassigned-pick-a-worker')
    assert.ok(readFileSync(join(dir, 'tasks', 'unassigned-pick-a-worker.md'), 'utf8').startsWith('---\n\n# Task: Pick a worker'))
  }))

test('assigning swaps the prompts above --- and renames the file; the brief stays', () =>
  withFolder(async (dir) => {
    await createSpec(dir, config, { title: 'Pick a worker', priority: 'P3', agentId: null, brief: '## Goal\nKeep me' })
    const toRizki = await assignSpec(dir, config, 'spec:unassigned-pick-a-worker', 'rizki')
    assert.equal(toRizki.key, 'spec:rizki-pick-a-worker')
    const text = readFileSync(join(dir, 'tasks', 'rizki-pick-a-worker.md'), 'utf8')
    assert.equal(splitSpec(text).head, '# Rizki\nYou review.')
    assert.ok(splitSpec(text).body.includes('## Goal\nKeep me'))
    const back = await assignSpec(dir, config, toRizki.key, null)
    assert.equal(back.key, 'spec:unassigned-pick-a-worker')
    assert.deepEqual(readdirSync(join(dir, 'tasks')), ['unassigned-pick-a-worker.md'])
    await assert.rejects(() => assignSpec(dir, config, 'spec:unassigned-pick-a-worker', 'ghost'), /no agent/)
  }))

test('priority, start request and review lines', () =>
  withFolder(async (dir) => {
    const { key } = await createSpec(dir, config, { title: 'Ship', priority: 'P3', agentId: 'bagas', brief: '## Goal\nGo' })
    const file = join(dir, 'tasks', 'bagas-ship.md')
    await setPriority(dir, key, 'P1')
    await setStartRequested(dir, key, true, new Date('2026-11-08T13:05:00Z'))
    let text = readFileSync(file, 'utf8')
    assert.ok(text.includes('**Priority:** P1\n**Start requested:** 2026-11-08 13:05 UTC via Orchestra Board'))
    await setStartRequested(dir, key, false)
    text = readFileSync(file, 'utf8')
    assert.ok(!text.includes('Start requested'))
    const line = await appendReview(dir, key, 'Approved', 'PR #9 open', new Date('2026-11-08T14:00:00Z'))
    assert.equal(line, 'Approved — 2026-11-08 (user via Orchestra Board). PR #9 open')
    await appendReview(dir, key, 'Merged', '', new Date('2026-11-09T09:00:00Z'))
    text = readFileSync(file, 'utf8')
    assert.ok(text.trimEnd().endsWith('## Review\nApproved — 2026-11-08 (user via Orchestra Board). PR #9 open\nMerged — 2026-11-09 (user via Orchestra Board).'))
  }))

test('the orca CLI next to the app comes first, never the app itself', () => {
  const app = join(mkdtempSync(join(tmpdir(), 'orchestra-app-')), 'Orca.exe')
  const bin = join(app, '..', 'resources', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'orca.exe'), '')
  assert.deepEqual(orcaCandidates(app, 'win32'), [join(bin, 'orca.exe'), 'orca'])
  assert.deepEqual(orcaCandidates(join(tmpdir(), 'nowhere', 'Orca.exe'), 'win32'), ['orca'])
  rmSync(join(app, '..'), { recursive: true, force: true })
})

test('a review spec carries the reviewer prompts, links back to the card and quotes the report read-only', () =>
  withFolder(async (dir) => {
    const target = {
      name: 'bagas-add-login',
      specFile: 'tasks/bagas-add-login.md',
      title: 'Add login',
      priority: 'P1' as const,
      persona: 'bagas',
      taskId: 'task_1',
      round: 2,
      report: { subject: 'Login added', body: 'Done.\n---\nTests pass.', filesModified: ['apps/api/src/login.ts'] }
    }
    const spec = await createReviewSpec(dir, config, target, 'rizki')
    assert.equal(spec.key, 'spec:rizki-review-add-login-r2')
    const { head, body } = splitSpec(readFileSync(spec.specPath, 'utf8'))
    assert.ok(head.includes('You review.') && head.includes('# Core rules') === false, 'the reviewer prompt, not the implementer prompt')
    assert.ok(body.includes('**Reviews:** tasks/bagas-add-login.md (round 2)'))
    assert.ok(body.includes('Implementer: Bagas (Senior Software Engineer); Orca task task_1.'))
    assert.ok(body.includes('> ***'), 'a --- line in the report cannot split the spec')
    assert.ok(body.includes('**Read-only:**'))
    assert.ok(body.includes('`apps/api/src/login.ts`'))
    const again = await createReviewSpec(dir, config, target, 'rizki')
    assert.notEqual(again.key, spec.key, 'a second review of the same round gets its own file')
    await assert.rejects(() => createReviewSpec(dir, config, target, 'ghost'), /no agent/)
  }))

test('launch flags come from team.json, and the lead is never started', () => {
  const [bagas] = config.agents
  assert.deepEqual(launchFlags(bagas), ['--agent', 'claude', '--model', 'm'])
  assert.deepEqual(launchFlags({ ...bagas, effort: 'xhigh' }), ['--agent', 'claude', '--model', 'm', '--effort', 'xhigh'])
  assert.deepEqual(launchFlags({ ...bagas, model: null, effort: 'xhigh' }), ['--agent', 'claude'])
  assert.throws(() => launchFlags({ ...bagas, name: 'Krisna', agent: null }), /lead/)
})

test('runs the board started are kept in state/orchestra-runs.json', () =>
  withFolder(async (dir) => {
    assert.deepEqual(await readRuns(dir), [])
    await recordRun(dir, { runId: 'run_1', taskId: 'task_1', dispatchId: 'd_1', key: 'spec:bagas-x', agent: 'bagas', kind: 'work' }, new Date('2026-11-08T00:00:00Z'))
    await recordRun(dir, { runId: 'run_2', taskId: 'task_2', dispatchId: 'd_2', key: 'spec:rizki-review-x', agent: 'rizki', kind: 'review' })
    const runs = await readRuns(dir)
    assert.deepEqual(runs.map((run) => run.taskId), ['task_1', 'task_2'])
    assert.equal(runs[0].startedAt, '2026-11-08T00:00:00.000Z')
    writeFileSync(join(dir, 'state', 'orchestra-runs.json'), 'not json')
    assert.deepEqual(await readRuns(dir), [])
  }))

test('a start goes to the board Run as the board terminal, never to whichever session is current', () => {
  const [bagas] = config.agents
  const args = workerStartArgs({ agent: { ...bagas, effort: 'xhigh' }, specPath: 'C:\\team\\tasks\\bagas-x.md', title: 'Add login', repoRoot: 'C:\\repo', home: { terminal: 'term_board', runId: 'run_board' } })
  const flag = (name: string) => args[args.indexOf(name) + 1]
  assert.deepEqual(args.slice(0, 2), ['orchestration', 'worker-start'])
  assert.equal(flag('--run'), 'run_board')
  assert.equal(flag('--from'), 'term_board')
  assert.equal(flag('--worktree'), 'path:C:/repo')
  assert.equal(flag('--task-title'), 'Bagas: Add login')
  assert.equal(flag('--effort'), 'xhigh')
  assert.ok(Number(flag('--timeout-ms')) < 110_000, 'the start fits in the editor request timeout')
})

test('the board home reads as empty until the board has opened one', () =>
  withFolder(async (dir) => {
    assert.deepEqual(await readBoardHome(dir), {})
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(join(dir, 'state', 'orchestra-board.json'), JSON.stringify({ terminal: 'term_1', runId: 'run_1' }))
    assert.deepEqual(await readBoardHome(dir), { terminal: 'term_1', runId: 'run_1' })
  }))
