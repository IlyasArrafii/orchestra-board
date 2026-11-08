// Jev decisions per card: a cache keyed by the exact request, and a one-at-a-time queue.
// A decision counts only while its request is unchanged: editing the brief, an agent, a prompt or the
// model makes it stale, and the card is asked again. Dependencies are injected so tests can fake them.
import type { Agent, BoardItem, Decision, JevStatus } from './protocol'
import { askJev, buildRequest, JevError, listModels, parseDecision, requestHash, type JevRequest } from './jev'

type Storage = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<void> }
type FetchLike = Parameters<typeof askJev>[0]

export type DecisionDeps = {
  token(): Promise<string | null>
  model(): Promise<string>
  auto(): Promise<boolean>
  protection(): Promise<JevStatus['protection']>
  storage: Storage
  fetch: FetchLike
  log(message: string): void
  /** A decision was added or replaced. */
  changed(): void
  status(status: JevStatus): void
}

type Cached = { hash: string; decision: Decision }
const CACHE_KEY = 'decisions'
const RETRY_AFTER_MS = 10 * 60_000
const PAUSE_MS = 250
const COLUMN_ORDER = ['Backlog', 'In Progress', 'Under Review', 'Done']

export class DecisionEngine {
  private cache: Record<string, Cached> = {}
  private failures: Record<string, { hash: string; at: number }> = {}
  private items = new Map<string, BoardItem>()
  private agents: Agent[] = []
  private prompts: Record<string, string> = {}
  private modelName = 'jev-latest'
  private queue: string[] = []
  private running = false
  private lastError: string | null = null
  private lastAssessedAt: number | null = null
  private stopped = false

  constructor(private readonly deps: DecisionDeps) {}

  async init(): Promise<void> {
    const stored = await this.deps.storage.get(CACHE_KEY)
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) this.cache = stored as Record<string, Cached>
    this.modelName = await this.deps.model()
  }

  stop(): void {
    this.stopped = true
    this.queue = []
  }

  async setContext(items: BoardItem[], agents: Agent[], prompts: Record<string, string>): Promise<void> {
    this.items = new Map(items.map((item) => [item.key, item]))
    this.agents = agents
    this.prompts = prompts
    this.modelName = await this.deps.model()
  }

  private request(key: string): JevRequest | null {
    const item = this.items.get(key)
    return item ? buildRequest(item, this.agents, this.prompts, this.modelName) : null
  }

  /** Decisions whose request still matches the card as it is now. */
  current(): Record<string, Decision> {
    const out: Record<string, Decision> = {}
    for (const key of this.items.keys()) {
      const cached = this.cache[key]
      const request = cached ? this.request(key) : null
      if (cached && request && cached.hash === requestHash(request)) out[key] = cached.decision
    }
    return out
  }

  async status(): Promise<JevStatus> {
    const token = await this.deps.token()
    return {
      configured: Boolean(token),
      last4: token ? token.slice(-4) : null,
      protection: await this.deps.protection(),
      auto: await this.deps.auto(),
      model: this.modelName,
      pending: this.queue.length + (this.running ? 1 : 0),
      lastError: this.lastError,
      // From the stored cache too, so a worker restart does not read as "nothing assessed yet".
      lastAssessedAt: Math.max(this.lastAssessedAt ?? 0, ...Object.values(this.cache).map((entry) => entry.decision.assessedAt ?? 0)) || null
    }
  }

  private async publishStatus(): Promise<void> {
    this.deps.status(await this.status())
  }

  /** Queue cards with no current decision (or every card), Backlog first. */
  async enqueue(all = false, automatic = true): Promise<void> {
    if (this.stopped || !(await this.deps.token())) return
    if (automatic && !(await this.deps.auto())) return
    const now = Date.now()
    const keys = [...this.items.values()]
      .sort((a, b) => COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column))
      .map((item) => item.key)
    for (const key of keys) {
      const request = this.request(key)
      if (!request || this.queue.includes(key)) continue
      const hash = requestHash(request)
      if (!all && this.cache[key]?.hash === hash) continue
      const failure = this.failures[key]
      if (automatic && failure && failure.hash === hash && now - failure.at < RETRY_AFTER_MS) continue
      this.queue.push(key)
    }
    void this.publishStatus()
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && !this.stopped) {
        const key = this.queue.shift() as string
        const result = await this.assess(key)
        if (result.error && result.fatal) {
          this.queue = []
          break
        }
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
      }
    } finally {
      this.running = false
      void this.publishStatus()
    }
  }

  /** The current decision for a card, asking Jev now when there is none. */
  async decide(key: string): Promise<{ decision: Decision | null; error: string | null }> {
    const current = this.current()[key]
    if (current) return { decision: current, error: null }
    const { decision, error } = await this.assess(key)
    return { decision, error }
  }

  /** Ask Jev about one card now. `fatal` errors (a bad token) stop the queue. */
  async assess(key: string): Promise<{ decision: Decision | null; error: string | null; fatal?: boolean }> {
    const token = await this.deps.token()
    if (!token) return { decision: null, error: 'No TypeSafe API token. Add one in Settings → Jev.' }
    const request = this.request(key)
    if (!request) return { decision: null, error: 'Nothing to judge: the card has no brief, or the team has no active worker agent.' }
    const hash = requestHash(request)
    try {
      const decision = parseDecision(await askJev(this.deps.fetch, token, request), request)
      this.cache[key] = { hash, decision }
      delete this.failures[key]
      this.lastError = null
      this.lastAssessedAt = decision.assessedAt
      await this.deps.storage.set(CACHE_KEY, this.cache as never)
      this.deps.changed()
      void this.publishStatus()
      return { decision, error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failures[key] = { hash, at: Date.now() }
      this.lastError = message
      this.deps.log(`Jev failed for ${key}: ${message}`)
      void this.publishStatus()
      return { decision: null, error: message, fatal: error instanceof JevError && (error.status === 401 || error.status === 403) }
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const token = await this.deps.token()
    if (!token) return { ok: false, message: 'No token saved yet.' }
    try {
      const models = await listModels(this.deps.fetch, token)
      this.lastError = null
      void this.publishStatus()
      return { ok: true, message: models.length ? `Connected. Models: ${models.join(', ')}` : 'Connected.' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
