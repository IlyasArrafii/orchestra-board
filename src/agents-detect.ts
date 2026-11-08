// Agent CLIs as Orca knows them, without asking the CLI: Orca's model catalog
// (<userData>/agent-model-catalog.json: models and effort levels per agent), its disabled list and
// default agent (<userData>/profiles/<profile>/orca-data.json), and which agent binaries are on PATH,
// which is how Orca's Settings → Agents finds "installed" agents. Node only.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CatalogModel, DetectedAgent } from './protocol'

type Known = { id: string; label: string; bins: string[]; takes: DetectedAgent['takes'] }

/**
 * Orca's agent ids with their binaries. `takes` follows `orca orchestration worker-start --help`:
 * --model works for Claude, Codex, Cursor, Antigravity, Grok and Muse (with --effort), OMP takes both,
 * OpenCode takes a model but no effort, and other agents launch with their own config.
 */
export const KNOWN_AGENTS: Known[] = [
  { id: 'claude', label: 'Claude', bins: ['claude'], takes: 'model+effort' },
  { id: 'codex', label: 'Codex', bins: ['codex'], takes: 'model+effort' },
  { id: 'opencode2', label: 'OpenCode 2', bins: ['opencode2'], takes: 'model' },
  { id: 'opencode', label: 'OpenCode', bins: ['opencode'], takes: 'model' },
  { id: 'pi', label: 'Pi', bins: ['pi'], takes: 'none' },
  { id: 'omp', label: 'OMP', bins: ['omp'], takes: 'model+effort' },
  { id: 'antigravity', label: 'Antigravity', bins: ['agy'], takes: 'model+effort' },
  { id: 'droid', label: 'Droid', bins: ['droid'], takes: 'none' },
  { id: 'cursor', label: 'Cursor', bins: ['cursor-agent'], takes: 'model+effort' },
  { id: 'grok', label: 'Grok', bins: ['grok'], takes: 'model+effort' },
  { id: 'muse', label: 'Muse', bins: ['muse'], takes: 'model+effort' },
  { id: 'gemini', label: 'Gemini', bins: ['gemini'], takes: 'none' },
  { id: 'copilot', label: 'Copilot', bins: ['copilot'], takes: 'none' },
  { id: 'aider', label: 'Aider', bins: ['aider'], takes: 'none' },
  { id: 'amp', label: 'Amp', bins: ['amp'], takes: 'none' },
  { id: 'kimi', label: 'Kimi', bins: ['kimi'], takes: 'none' },
  { id: 'qwen', label: 'Qwen', bins: ['qwen'], takes: 'none' },
  { id: 'goose', label: 'Goose', bins: ['goose'], takes: 'none' },
  { id: 'crush', label: 'Crush', bins: ['crush'], takes: 'none' },
  { id: 'zcode', label: 'ZCode', bins: ['zcode'], takes: 'none' }
]

type RawModel = {
  id?: string
  label?: string
  resolvedModel?: string
  description?: string
  isDefault?: boolean
  defaultEffort?: string
  efforts?: Array<{ value?: string; label?: string }>
}
type RawEntry = { agent?: string; discovered?: { models?: RawModel[]; at?: number } }

export function userDataCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const list: string[] = []
  if (env.ORCA_USER_DATA_PATH) list.push(env.ORCA_USER_DATA_PATH)
  if (platform === 'win32') list.push(join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'orca'))
  else if (platform === 'darwin') list.push(join(home, 'Library', 'Application Support', 'orca'))
  else list.push(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orca'))
  return list
}

/** The newest catalog entry per agent; `id` is what --model takes (the resolved id when Orca has one). */
export function parseCatalog(raw: unknown): Map<string, CatalogModel[]> {
  const entries = ((raw as { entries?: RawEntry[] } | null)?.entries ?? []).filter((entry) => entry.agent && entry.discovered?.models)
  const newest = new Map<string, RawEntry>()
  for (const entry of entries) {
    const current = newest.get(entry.agent as string)
    if (!current || (entry.discovered?.at ?? 0) > (current.discovered?.at ?? 0)) newest.set(entry.agent as string, entry)
  }
  const out = new Map<string, CatalogModel[]>()
  for (const [agent, entry] of newest) {
    const seen = new Set<string>()
    const models: CatalogModel[] = []
    for (const model of entry.discovered?.models ?? []) {
      const id = model.resolvedModel || model.id
      if (!id || seen.has(id)) continue
      seen.add(id)
      models.push({
        id,
        label: model.label || id,
        description: model.description ?? '',
        isDefault: model.isDefault === true,
        efforts: (model.efforts ?? []).filter((effort) => effort.value).map((effort) => ({ value: effort.value as string, label: effort.label || (effort.value as string) })),
        defaultEffort: model.defaultEffort ?? null
      })
    }
    out.set(agent, models)
  }
  return out
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

type AgentSettings = { disabled: string[]; defaultAgent: string | null }

function settingsFrom(raw: unknown): AgentSettings | null {
  const settings = raw as { disabledTuiAgents?: unknown; defaultTuiAgent?: unknown } | null
  if (!settings || typeof settings !== 'object' || !('defaultTuiAgent' in settings || 'disabledTuiAgents' in settings)) return null
  const disabled = Array.isArray(settings.disabledTuiAgents) ? settings.disabledTuiAgents.filter((id): id is string => typeof id === 'string') : []
  return { disabled, defaultAgent: typeof settings.defaultTuiAgent === 'string' ? settings.defaultTuiAgent : null }
}

/**
 * Orca keeps current settings in <profile>/profile-state.db (the `settings` document); orca-data.json
 * is an older export. Read the database read-only when this Node has node:sqlite, else the JSON.
 */
async function readSettings(userData: string): Promise<AgentSettings> {
  const profiles = join(userData, 'profiles')
  const names = existsSync(profiles) ? ['local-default', ...readdirSync(profiles).filter((name) => name !== 'local-default')] : []
  for (const name of names) {
    const database = join(profiles, name, 'profile-state.db')
    if (existsSync(database)) {
      try {
        const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void } }
        const db = new DatabaseSync(database, { readOnly: true })
        try {
          const row = db.prepare("select payload from profile_state_documents where domain = 'settings'").get() as { payload?: unknown } | undefined
          const parsed = settingsFrom(typeof row?.payload === 'string' ? JSON.parse(row.payload) : null)
          if (parsed) return parsed
        } finally {
          db.close()
        }
      } catch {
        // No node:sqlite here, or the schema changed: fall back to the JSON export.
      }
    }
    const parsed = settingsFrom((readJson(join(profiles, name, 'orca-data.json')) as { settings?: unknown } | null)?.settings ?? null)
    if (parsed) return parsed
  }
  return { disabled: [], defaultAgent: null }
}

function onPath(bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(platform === 'win32' ? 'where.exe' : 'which', [bin], { env, timeout: 4000, windowsHide: true }, (error) => resolve(!error))
  })
}

export async function detectAgents(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): Promise<DetectedAgent[]> {
  const userData = userDataCandidates(env, platform, home).find((dir) => existsSync(dir)) ?? null
  const catalog = userData ? parseCatalog(readJson(join(userData, 'agent-model-catalog.json'))) : new Map<string, CatalogModel[]>()
  const settings = userData ? await readSettings(userData) : { disabled: [], defaultAgent: null }
  const installed = await Promise.all(KNOWN_AGENTS.map(async (known) => catalog.has(known.id) || (await Promise.all(known.bins.map((bin) => onPath(bin, env, platform)))).some(Boolean)))
  return KNOWN_AGENTS.map((known, index) => ({
    id: known.id,
    label: known.label,
    installed: installed[index],
    enabled: !settings.disabled.includes(known.id),
    isDefault: settings.defaultAgent === known.id,
    takes: known.takes,
    models: known.takes === 'none' ? [] : catalog.get(known.id) ?? []
  })).sort((a, b) => Number(b.installed && b.enabled) - Number(a.installed && a.enabled))
}
