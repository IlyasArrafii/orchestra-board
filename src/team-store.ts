// team.json and the prompt files: agents/<agent>.md and teams/<team>.md. Node only.
// new-task.ps1 builds a spec as team prompt + persona prompt + "---" + brief, and board.ps1 finds the
// brief after the first `---` line, so a prompt line that is only `---` is saved as `***` (also a rule).
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Agent, Team, TeamConfig, TeamState } from './protocol'
import { slugify } from './shared/model'

export const TEAM_FILE = 'team.json'
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
/** Orca agent ids and effort values come from Orca (agents.detect); these only check the shape. */
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const EFFORT_PATTERN = /^[a-z]{2,16}$/
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i
const PALETTE = ['#5e6ad2', '#0d9488', '#db2777', '#d97706', '#16a34a', '#7c3aed', '#0284c7', '#dc2626', '#ca8a04', '#4f46e5', '#059669', '#e11d48']
/** Offered in the Role picker; roles typed there are added to team.json. */
export const PRESET_ROLES = [
  'UI/UX Designer',
  'Lead Software Engineer',
  'Senior Software Engineer',
  'Principal Software Engineer',
  'Senior Dev',
  'Project Manager',
  'Code Reviewer',
  'DevOps Engineer',
  'QA Lead',
  'Lead Designer',
  'Design System Lead'
]

export class TeamError extends Error {
  code = 'invalid_params'
}

const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const nullable = (value: unknown, max = 120): string | null => text(value, max) || null

export function normalizeAgent(input: Partial<Agent>, index = 0): Agent {
  const color = text(input.color, 7)
  return {
    id: text(input.id, 32).toLowerCase(),
    name: text(input.name, 60),
    role: text(input.role, 120),
    team: nullable(input.team, 32),
    agent: nullable(input.agent, 32),
    model: nullable(input.model, 120),
    effort: nullable(input.effort, 16),
    active: input.active !== false,
    color: COLOR_PATTERN.test(color) ? color.toLowerCase() : PALETTE[index % PALETTE.length],
    note: text(input.note, 300)
  }
}

export function normalizeTeam(input: Partial<Team>): Team {
  return { id: text(input.id, 32).toLowerCase(), name: text(input.name, 60), description: text(input.description, 300) }
}

export function validateAgent(agent: Agent, config: TeamConfig): string[] {
  const errors: string[] = []
  if (!ID_PATTERN.test(agent.id)) errors.push('ID must start with a letter and use only a-z, 0-9 and -, at most 32 characters.')
  if (!agent.name) errors.push('Name is required.')
  if (!agent.role) errors.push('Role is required.')
  if (agent.team && !config.teams.some((team) => team.id === agent.team)) errors.push(`Team "${agent.team}" does not exist.`)
  if (agent.agent && !AGENT_ID_PATTERN.test(agent.agent)) errors.push('Agent CLI must be an Orca agent id, such as claude or codex.')
  if (agent.effort && !EFFORT_PATTERN.test(agent.effort)) errors.push('Effort must be a level such as low, high or max.')
  if (agent.effort && !agent.model) errors.push('Effort needs a model (Orca refuses --effort without --model).')
  if (agent.model && !/^[A-Za-z0-9._:/@-]+$/.test(agent.model)) errors.push('Model may use only letters, digits and . _ : / @ -')
  return errors
}

export function validateTeam(team: Team): string[] {
  const errors: string[] = []
  if (!ID_PATTERN.test(team.id)) errors.push('ID must start with a letter and use only a-z, 0-9 and -, at most 32 characters.')
  if (!team.name) errors.push('Name is required.')
  return errors
}

/** Prompts have no length limit. A line that is only `---` would end the prompt early, so it becomes `***`. */
export function normalizePrompt(prompt: string): string {
  return prompt.replace(/\r\n/g, '\n').replace(/^---\s*$/gm, '***')
}

/** An unused ID from a name: "Dewi Lestari" → "dewi-lestari", then "-2", "-3" if taken. */
export function idFromName(name: string, taken: string[]): string {
  const base = slugify(name, 28) || 'agent'
  let id = base
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`
  return id
}

function randomColor(used: string[]): string {
  const free = PALETTE.filter((color) => !used.includes(color))
  const pool = free.length ? free : PALETTE
  return pool[Math.floor(Math.random() * pool.length)]
}

/** Orca flags for `worker-start`, as new-task.ps1 prints them. */
export function workerFlags(agent: Agent): string | null {
  if (!agent.agent) return null
  return [`--agent ${agent.agent}`, agent.model ? `--model ${agent.model}` : '', agent.model && agent.effort ? `--effort ${agent.effort}` : '']
    .filter(Boolean)
    .join(' ')
}

function parseConfig(raw: unknown): TeamConfig {
  const value = raw && typeof raw === 'object' ? (raw as Partial<TeamConfig>) : {}
  const roles = Array.isArray(value.roles) ? value.roles.map((role) => text(role, 120)).filter(Boolean) : []
  return {
    version: 1,
    roles: [...new Set([...PRESET_ROLES, ...roles])],
    teams: Array.isArray(value.teams) ? value.teams.map((team) => normalizeTeam(team)) : [],
    agents: Array.isArray(value.agents) ? value.agents.map((agent, index) => normalizeAgent(agent, index)) : []
  }
}

/** team.json, or (before it exists) one agent per agents/*.md with default settings. */
export async function readConfig(teamFolder: string): Promise<TeamConfig> {
  const file = join(teamFolder, TEAM_FILE)
  if (existsSync(file)) {
    return parseConfig(JSON.parse(await readFile(file, 'utf8')))
  }
  const promptFiles = existsSync(join(teamFolder, 'agents')) ? await readdir(join(teamFolder, 'agents')) : []
  return parseConfig({
    teams: [],
    agents: promptFiles
      .filter((name) => name.endsWith('.md'))
      .map((name) => {
        const id = name.slice(0, -3)
        return { id, name: id.charAt(0).toUpperCase() + id.slice(1), role: 'Agent', agent: 'claude' }
      })
  })
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, file)
}

export async function writeConfig(teamFolder: string, config: TeamConfig): Promise<void> {
  await writeAtomic(join(teamFolder, TEAM_FILE), `${JSON.stringify(config, null, 2)}\n`)
}

const promptFile = (teamFolder: string, kind: 'agents' | 'teams', id: string) =>
  join(teamFolder, kind === 'agents' ? 'agents' : 'teams', `${id}.md`)

async function readPrompt(teamFolder: string, kind: 'agents' | 'teams', id: string): Promise<string> {
  const file = promptFile(teamFolder, kind, id)
  return existsSync(file) ? (await readFile(file, 'utf8')).replace(/\r\n/g, '\n') : ''
}

/** A team prompt that is empty has no file, so new-task.ps1 adds nothing for it. */
async function writePrompt(teamFolder: string, kind: 'agents' | 'teams', id: string, prompt: string): Promise<void> {
  const file = promptFile(teamFolder, kind, id)
  const body = normalizePrompt(prompt).trim()
  if (!body && kind === 'teams') {
    if (existsSync(file)) await moveToTrash(file, id)
    return
  }
  await writeAtomic(file, `${body}\n`)
}

async function moveToTrash(file: string, id: string): Promise<void> {
  const trash = join(dirname(file), '.trash')
  await mkdir(trash, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await rename(file, join(trash, `${id}-${stamp}.md`))
}

export async function specCounts(teamFolder: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const tasks = join(teamFolder, 'tasks')
  if (!existsSync(tasks)) return counts
  for (const name of await readdir(tasks)) {
    if (!name.endsWith('.md')) continue
    const persona = name.split('-')[0]
    counts[persona] = (counts[persona] ?? 0) + 1
  }
  return counts
}

export async function readTeamState(teamFolder: string): Promise<TeamState> {
  const config = await readConfig(teamFolder)
  const agents: Record<string, string> = {}
  const teams: Record<string, string> = {}
  for (const agent of config.agents) agents[agent.id] = await readPrompt(teamFolder, 'agents', agent.id)
  for (const team of config.teams) teams[team.id] = await readPrompt(teamFolder, 'teams', team.id)
  return { config, prompts: { agents, teams }, specCounts: await specCounts(teamFolder) }
}

function fail(errors: string[]): never {
  throw new TeamError(errors.join(' '))
}

/**
 * A new agent gets its ID from its name and a random colour from the palette; an existing one keeps
 * both (the ID names its files). A role typed in the Role picker is added to team.json's roles.
 */
export async function saveAgent(teamFolder: string, input: Partial<Agent>, prompt: string, create: boolean): Promise<TeamState> {
  const config = await readConfig(teamFolder)
  const taken = config.agents.map((agent) => agent.id)
  const requested = text(input.id, 32).toLowerCase()
  const id = create ? requested || idFromName(text(input.name, 60), taken) : requested
  const index = config.agents.findIndex((agent) => agent.id === id)
  if (create && index !== -1) fail([`An agent with ID "${id}" already exists.`])
  if (!create && index === -1) fail([`There is no agent with ID "${id}".`])
  const previous = index === -1 ? null : config.agents[index]
  const color = create ? randomColor(config.agents.map((agent) => agent.color)) : (input.color ?? previous?.color)
  const agent = normalizeAgent({ ...previous, ...input, id, color, note: input.note ?? previous?.note }, index === -1 ? config.agents.length : index)
  const errors = validateAgent(agent, config)
  if (errors.length) fail(errors)
  if (index === -1) config.agents.push(agent)
  else config.agents[index] = agent
  if (agent.role && !config.roles.includes(agent.role)) config.roles.push(agent.role)
  await writePrompt(teamFolder, 'agents', agent.id, prompt)
  await writeConfig(teamFolder, config)
  return readTeamState(teamFolder)
}

/** Refused while specs in tasks/ name the agent: they are its history, so deactivate it instead. */
export async function deleteAgent(teamFolder: string, id: string): Promise<TeamState> {
  const config = await readConfig(teamFolder)
  if (!config.agents.some((agent) => agent.id === id)) fail([`There is no agent with ID "${id}".`])
  const count = (await specCounts(teamFolder))[id] ?? 0
  if (count) fail([`${id} has ${count} spec file(s) in tasks/. Deactivate the agent instead of deleting it.`])
  config.agents = config.agents.filter((agent) => agent.id !== id)
  const file = promptFile(teamFolder, 'agents', id)
  if (existsSync(file)) await moveToTrash(file, id)
  await writeConfig(teamFolder, config)
  return readTeamState(teamFolder)
}

export async function saveTeam(teamFolder: string, input: Partial<Team>, prompt: string, create: boolean): Promise<TeamState> {
  const config = await readConfig(teamFolder)
  const requested = text(input.id, 32).toLowerCase()
  const id = create && !requested ? idFromName(text(input.name, 60), config.teams.map((entry) => entry.id)) : requested
  const team = normalizeTeam({ ...input, id })
  const index = config.teams.findIndex((entry) => entry.id === team.id)
  if (create && index !== -1) fail([`A team with ID "${team.id}" already exists.`])
  if (!create && index === -1) fail([`There is no team with ID "${team.id}".`])
  const errors = validateTeam(team)
  if (errors.length) fail(errors)
  if (index === -1) config.teams.push(team)
  else config.teams[index] = team
  await writePrompt(teamFolder, 'teams', team.id, prompt)
  await writeConfig(teamFolder, config)
  return readTeamState(teamFolder)
}

export async function deleteTeam(teamFolder: string, id: string): Promise<TeamState> {
  const config = await readConfig(teamFolder)
  if (!config.teams.some((team) => team.id === id)) fail([`There is no team with ID "${id}".`])
  const members = config.agents.filter((agent) => agent.team === id).map((agent) => agent.name)
  if (members.length) fail([`Move ${members.join(', ')} to another team first.`])
  config.teams = config.teams.filter((team) => team.id !== id)
  const file = promptFile(teamFolder, 'teams', id)
  if (existsSync(file)) await moveToTrash(file, id)
  await writeConfig(teamFolder, config)
  return readTeamState(teamFolder)
}
