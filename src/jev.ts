// Jev (TypeSafe System One) decisions for one card, all in one request as the TypeSafe docs advise for
// independent questions over the same state:
// - assignee (Choice): which active worker should do it, or none;
// - fit:<id> (Score, one per worker): how well each worker fits, so the board can rank them;
// - reviewer (Choice): who should review the work, never the implementer;
// - priority (Score): how urgent it is.
// Node only (uses crypto).
import { createHash } from 'node:crypto'
import type { Agent, BoardItem, Decision, FitLevel, FitScore, Priority } from './protocol'

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const MODELS_URL = 'https://api.typesafe.ai/v1/models'
export const DEFAULT_MODEL = 'jev-latest'
/** Bump when a question changes, so cached decisions are asked again. */
export const QUESTIONS_VERSION = 2
const BRIEF_LIMIT = 12_000
const PROMPT_SUMMARY_LIMIT = 900
const NONE = 'none'
const FIT_PREFIX = 'fit:'
export const FIT_LEVELS: FitLevel[] = ['Poor fit', 'Partial fit', 'Good fit', 'Strong fit']

const FIT_CRITERIA = [
  "Poor fit: the task is mostly outside the agent's role, or the agent's instructions forbid what the task needs (for example a read-only agent asked to change code).",
  'Partial fit: the agent can do part of the task, but another role would clearly do it better.',
  "Good fit: the task is within the agent's role.",
  "Strong fit: the task is squarely what the agent's role and instructions describe."
]
const PRIORITY_CRITERIA = [
  'Can wait: nice to have, and no other work depends on it soon.',
  'Normal: planned work with no special urgency.',
  'Urgent: something is broken or blocked, or other work is waiting on this task.'
]

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

export type JevRequest = { model: string; state: Record<string, unknown>; questions: Record<string, JevQuestion> }

export type JevAnswer = {
  type: string
  choice?: string
  score?: number
  confidence?: number | null
  probabilities?: Record<string, number>
}

export type JevResponse = { model: string; answers: Record<string, JevAnswer>; usage?: { input_tokens: number; output_tokens: number } }

/** Only active workers (agents Orca can start) can be assigned or review. */
export function candidateAgents(agents: Agent[]): Agent[] {
  return agents.filter((agent) => agent.active && agent.agent)
}

function summarize(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length > PROMPT_SUMMARY_LIMIT ? `${flat.slice(0, PROMPT_SUMMARY_LIMIT)}…` : flat
}

function choices(agents: Agent[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const agent of agents) criteria[agent.id] = `${agent.name}: ${agent.role}`
  criteria[NONE] = 'None of these agents fits.'
  return criteria
}

/** null when there is nothing to judge: no brief, or no active worker to choose from. */
export function buildRequest(item: BoardItem, agents: Agent[], prompts: Record<string, string>, model: string): JevRequest | null {
  const brief = (item.brief ?? '').trim()
  const candidates = candidateAgents(agents)
  if (!brief || !candidates.length) return null

  const implementer = candidates.find((agent) => agent.id === item.persona) ?? null
  const state: Record<string, unknown> = {
    task: { title: item.title, brief: brief.length > BRIEF_LIMIT ? `${brief.slice(0, BRIEF_LIMIT)}…` : brief },
    agents: candidates.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, prompt_summary: summarize(prompts[agent.id] ?? '') }))
  }
  if (implementer) state.implementer = { id: implementer.id, name: implementer.name, role: implementer.role }

  const questions: Record<string, JevQuestion> = {
    assignee: {
      type: 'choice',
      instructions:
        "Which agent in `agents` should do the task in `task`? Judge by each agent's role and `prompt_summary`, including what an agent must never do (for example, a read-only agent cannot edit files).",
      criteria: choices(candidates)
    },
    priority: { type: 'score', instructions: 'How urgent is the task in `task` for the team?', criteria: PRIORITY_CRITERIA }
  }
  for (const agent of candidates) {
    questions[`${FIT_PREFIX}${agent.id}`] = {
      type: 'score',
      instructions: `How well does the agent "${agent.name}" (id "${agent.id}" in \`agents\`) fit the task in \`task\`, given that agent's role and \`prompt_summary\`?`,
      criteria: FIT_CRITERIA
    }
  }
  const reviewers = candidates.filter((agent) => agent.id !== implementer?.id)
  if (reviewers.length) {
    questions.reviewer = {
      type: 'choice',
      instructions: implementer
        ? 'The task in `task` is done by the agent in `implementer`. Which other agent in `agents` should review that work before it is accepted? Prefer an agent whose role reviews, audits or tests work of this kind; a read-only reviewer is fine. Never pick the implementer.'
        : 'Which agent in `agents` should review the work for the task in `task` once it is done? Prefer an agent whose role reviews, audits or tests work of this kind; a read-only reviewer is fine.',
      criteria: choices(reviewers)
    }
  }
  return { model, state, questions }
}

export function requestHash(request: JevRequest): string {
  return createHash('sha256').update(JSON.stringify({ v: QUESTIONS_VERSION, request })).digest('hex')
}

const clamp01 = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

function priorityFrom(score: number): Exclude<Priority, '-'> {
  if (score >= 1.5) return 'P1'
  if (score >= 0.5) return 'P2'
  return 'P3'
}

function fitFrom(answer: JevAnswer | undefined): FitScore | null {
  if (!answer || typeof answer.score !== 'number') return null
  return { level: FIT_LEVELS[Math.min(FIT_LEVELS.length - 1, Math.max(0, Math.round(answer.score)))], score: answer.score, confidence: clamp01(answer.confidence) }
}

export function parseDecision(response: JevResponse, request: JevRequest, now = Date.now()): Decision {
  const answers = response.answers ?? {}
  const assignee = answers.assignee
  const priority = answers.priority
  if (!assignee || typeof assignee.choice !== 'string' || !priority || typeof priority.score !== 'number') {
    throw new Error('Jev answered without the assignee or priority answer')
  }
  const probabilities = assignee.probabilities ?? {}
  const chosen = assignee.choice
  const fits: Record<string, FitScore> = {}
  for (const [id, answer] of Object.entries(answers)) {
    if (!id.startsWith(FIT_PREFIX)) continue
    const fit = fitFrom(answer)
    if (fit) fits[id.slice(FIT_PREFIX.length)] = fit
  }
  const implementer = (request.state.implementer as { id?: string } | undefined)?.id
  const reviewer = answers.reviewer
  return {
    model: response.model,
    assessedAt: now,
    suggested: {
      agent: chosen === NONE ? null : chosen,
      probability: clamp01(probabilities[chosen]),
      confidence: clamp01(assignee.confidence),
      probabilities: Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [key, clamp01(value)]))
    },
    fits,
    fit: implementer && fits[implementer] ? { agent: implementer, ...fits[implementer] } : null,
    reviewer:
      reviewer && typeof reviewer.choice === 'string'
        ? { agent: reviewer.choice === NONE ? null : reviewer.choice, probability: clamp01(reviewer.probabilities?.[reviewer.choice]), confidence: clamp01(reviewer.confidence) }
        : null,
    priority: { suggested: priorityFrom(priority.score), score: priority.score, confidence: clamp01(priority.confidence) }
  }
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

const RETRY_STATUSES = new Set([429, 529])
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function describe(status: number, body: string): string {
  if (status === 401) return 'TypeSafe refused the API key (401). Check the token in Settings → Jev.'
  if (status === 429) return 'TypeSafe rate limit reached (429). Try again later.'
  if (status === 529) return 'TypeSafe is overloaded (529). Try again later.'
  let detail = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    if (parsed.detail) detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail).slice(0, 300)
  } catch {
    // keep the raw text
  }
  return `TypeSafe answered ${status}: ${detail}`
}

async function call(fetchImpl: FetchLike, url: string, token: string, body: unknown, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    })
    const text = await response.text()
    if (response.ok) return text
    if (RETRY_STATUSES.has(response.status) && attempt < 2) {
      await sleep(1000 * 2 ** attempt)
      continue
    }
    throw new JevError(describe(response.status, text), response.status)
  }
}

export async function askJev(fetchImpl: FetchLike, token: string, request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
  return JSON.parse(await call(fetchImpl, SYSTEM_ONE_URL, token, request, signal)) as JevResponse
}

/** GET /v1/models answers `{ models: [{ name, description, release_date }] }`; a cheap call that proves the token works. */
export async function listModels(fetchImpl: FetchLike, token: string, signal?: AbortSignal): Promise<string[]> {
  const parsed = JSON.parse(await call(fetchImpl, MODELS_URL, token, undefined, signal)) as { models?: Array<{ name?: string }> }
  return (parsed.models ?? []).map((entry) => entry.name ?? '').filter(Boolean)
}
