import { assert, test } from 'orca/testing'
import type { Agent, BoardItem } from './protocol'
import { askJev, buildRequest, listModels, parseDecision, requestHash, SYSTEM_ONE_URL, type JevResponse } from './jev'
import { DecisionEngine } from './decisions'

const agent = (patch: Partial<Agent>): Agent => ({ id: 'bagas', name: 'Bagas', role: 'Senior Software Engineer', team: 'core', agent: 'claude', model: 'm', effort: null, active: true, color: '#000000', note: '', ...patch })
const agents = [agent({}), agent({ id: 'rizki', name: 'Rizki', role: 'Principal (read-only)' }), agent({ id: 'krisna', name: 'Krisna', role: 'Lead', agent: null }), agent({ id: 'agus', name: 'Agus', active: false })]
const prompts = { bagas: 'You implement.', rizki: 'You never edit files.' }

const card = (patch: Partial<BoardItem> = {}): BoardItem =>
  ({ key: 'spec:bagas-x', column: 'Backlog', state: 'not-started', label: '', priority: '-', persona: 'bagas', name: 'x', title: 'Add login', brief: '## Goal\nAdd a login endpoint.', deps: [], olderTaskIds: [], ...patch }) as BoardItem

test('the request asks for an assignee, a priority, a fit per active worker and a reviewer who is not the implementer', () => {
  const request = buildRequest(card(), agents, prompts, 'jev-latest')
  assert.ok(request)
  if (!request) return
  assert.deepEqual(Object.keys(request.questions).sort(), ['assignee', 'fit:bagas', 'fit:rizki', 'priority', 'reviewer'])
  const assignee = request.questions.assignee
  assert.ok(assignee.type === 'choice')
  if (assignee.type === 'choice') assert.deepEqual(Object.keys(assignee.criteria), ['bagas', 'rizki', 'none'])
  const reviewer = request.questions.reviewer
  if (reviewer.type === 'choice') assert.deepEqual(Object.keys(reviewer.criteria), ['rizki', 'none'], 'the implementer never reviews')
  assert.deepEqual((request.state.implementer as { id: string }).id, 'bagas')
  const unassigned = buildRequest(card({ persona: '-' }), agents, prompts, 'jev-latest')
  assert.equal(unassigned?.state.implementer, undefined)
  const open = unassigned?.questions.reviewer
  if (open?.type === 'choice') assert.deepEqual(Object.keys(open.criteria), ['bagas', 'rizki', 'none'])
  assert.equal(buildRequest(card({ brief: '' }), agents, prompts, 'jev-latest'), null)
  assert.equal(buildRequest(card(), [agent({ active: false })], prompts, 'jev-latest'), null)
  const other = buildRequest(card({ brief: 'changed' }), agents, prompts, 'jev-latest')
  assert.ok(other && requestHash(request) !== requestHash(other))
})

const reply: JevResponse = {
  model: 'jev-1.14.0',
  answers: {
    assignee: { type: 'choice', choice: 'bagas', confidence: 0.8, probabilities: { bagas: 0.9, rizki: 0.08, none: 0.02 } },
    priority: { type: 'score', score: 1.6, confidence: 0.6 },
    'fit:bagas': { type: 'score', score: 2.7, confidence: 0.7 },
    'fit:rizki': { type: 'score', score: 0.8, confidence: 0.6 },
    reviewer: { type: 'choice', choice: 'rizki', confidence: 0.7, probabilities: { rizki: 0.85, none: 0.15 } }
  },
  usage: { input_tokens: 900, output_tokens: 20 }
}

test('answers become a decision', () => {
  const request = buildRequest(card(), agents, prompts, 'jev-latest')
  if (!request) throw new Error('no request')
  const decision = parseDecision(reply, request, 42)
  assert.deepEqual(decision.suggested.agent, 'bagas')
  assert.equal(decision.suggested.probability, 0.9)
  assert.deepEqual(decision.fit, { agent: 'bagas', level: 'Strong fit', score: 2.7, confidence: 0.7 })
  assert.deepEqual(decision.fits.rizki, { level: 'Partial fit', score: 0.8, confidence: 0.6 })
  assert.deepEqual(decision.reviewer, { agent: 'rizki', probability: 0.85, confidence: 0.7 })
  assert.deepEqual(decision.priority, { suggested: 'P1', score: 1.6, confidence: 0.6 })
  const none = parseDecision({ ...reply, answers: { ...reply.answers, assignee: { type: 'choice', choice: 'none', confidence: 0.5, probabilities: { none: 0.6 } } } }, request)
  assert.equal(none.suggested.agent, null)
  assert.throws(() => parseDecision({ model: 'x', answers: {} }, request))
})

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = []
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, init })
    const next = responses.shift() ?? { status: 500, body: 'no more' }
    return { ok: next.status < 300, status: next.status, text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)) }
  }
  return { fetch, calls }
}

test('the HTTP call sends the bearer token, retries 429, and explains a 401', async () => {
  const request = buildRequest(card(), agents, prompts, 'jev-latest')
  if (!request) throw new Error('no request')
  const ok = fakeFetch([{ status: 429, body: 'slow down' }, { status: 200, body: reply }])
  const answer = await askJev(ok.fetch, 'tok_123', request)
  assert.equal(answer.model, 'jev-1.14.0')
  assert.equal(ok.calls.length, 2)
  assert.equal(ok.calls[0].url, SYSTEM_ONE_URL)
  assert.equal(ok.calls[0].init.headers.Authorization, 'Bearer tok_123')
  assert.equal(JSON.parse(ok.calls[0].init.body ?? '{}').model, 'jev-latest')

  const denied = fakeFetch([{ status: 401, body: { detail: 'bad key' } }])
  await assert.rejects(() => askJev(denied.fetch, 'bad', request), /refused the API key/)
  const models = fakeFetch([{ status: 200, body: { models: [{ name: 'jev-latest' }, { name: 'jev-1.14.0' }] } }])
  assert.deepEqual(await listModels(models.fetch, 'tok'), ['jev-latest', 'jev-1.14.0'])
})

test('the engine caches by request, skips current cards, and stops on a bad token', async () => {
  const store: Record<string, unknown> = {}
  let changed = 0
  const responses: Array<{ status: number; body: unknown }> = [{ status: 200, body: reply }]
  const { fetch, calls } = fakeFetch(responses)
  const engine = new DecisionEngine({
    token: async () => 'tok',
    model: async () => 'jev-latest',
    auto: async () => true,
    protection: async () => 'os-keyring',
    storage: { get: async (key) => store[key] ?? null, set: async (key, value) => void (store[key] = value) },
    fetch,
    log: () => undefined,
    changed: () => void changed++,
    status: () => undefined
  })
  await engine.init()
  await engine.setContext([card()], agents, prompts)
  const result = await engine.assess('spec:bagas-x')
  assert.equal(result.error, null)
  assert.equal(changed, 1)
  assert.ok(engine.current()['spec:bagas-x'])
  assert.ok(store.decisions)
  await engine.setContext([card({ brief: 'different brief' })], agents, prompts)
  assert.deepEqual(engine.current(), {}, 'a changed brief makes the decision stale')
  responses.push({ status: 401, body: 'nope' })
  const denied = await engine.assess('spec:bagas-x')
  assert.ok(denied.fatal)
  assert.equal(calls.length, 2)
  assert.match((await engine.status()).lastError ?? '', /refused the API key/)
})
