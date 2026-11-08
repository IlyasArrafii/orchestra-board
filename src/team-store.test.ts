import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import type { Agent } from './protocol'
import { deleteAgent, deleteTeam, idFromName, normalizePrompt, PRESET_ROLES, readTeamState, saveAgent, saveTeam, workerFlags } from './team-store'

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-team-'))
  mkdirSync(join(dir, 'agents'))
  mkdirSync(join(dir, 'tasks'))
  writeFileSync(join(dir, 'agents', 'bagas.md'), '# Bagas\n')
  writeFileSync(join(dir, 'tasks', 'bagas-old-task.md'), 'spec\n')
  return dir
}

const agent = (patch: Partial<Agent>): Agent => ({ id: 'dewi', name: 'Dewi', role: 'QA Engineer', team: null, agent: 'claude', model: 'claude-opus-5-5', effort: 'high', active: true, color: '#123456', note: '', ...patch })

async function withFolder(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = folder()
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('without team.json, agents come from agents/*.md', () =>
  withFolder(async (dir) => {
    const state = await readTeamState(dir)
    assert.deepEqual(state.config.agents.map((entry) => entry.id), ['bagas'])
    assert.equal(state.prompts.agents.bagas, '# Bagas\n')
    assert.equal(state.specCounts.bagas, 1)
  }))

test('teams and agents save to team.json and their prompt files', () =>
  withFolder(async (dir) => {
    await saveTeam(dir, { id: 'qa', name: 'QA', description: 'Testing' }, 'Write tests first.', true)
    const state = await saveAgent(dir, agent({ team: 'qa' }), '# Dewi — QA\n\nYou test things.', true)
    assert.deepEqual(state.config.agents.map((entry) => entry.id), ['bagas', 'dewi'])
    assert.equal(readFileSync(join(dir, 'agents', 'dewi.md'), 'utf8'), '# Dewi — QA\n\nYou test things.\n')
    assert.equal(readFileSync(join(dir, 'teams', 'qa.md'), 'utf8'), 'Write tests first.\n')
    const saved = JSON.parse(readFileSync(join(dir, 'team.json'), 'utf8'))
    assert.equal(saved.agents[1].effort, 'high')
    assert.equal(workerFlags(state.config.agents[1]), '--agent claude --model claude-opus-5-5 --effort high')
  }))

test('validation refuses bad ids, unknown teams, effort without a model, and bad agent ids', () =>
  withFolder(async (dir) => {
    await assert.rejects(() => saveAgent(dir, agent({ id: 'Bad Id' }), '', true), /ID must start/)
    await assert.rejects(() => saveAgent(dir, agent({ team: 'nope' }), '', true), /does not exist/)
    await assert.rejects(() => saveAgent(dir, agent({ model: null }), '', true), /Effort needs a model/)
    await assert.rejects(() => saveAgent(dir, agent({ agent: 'Not An Agent' }), '', true), /Orca agent id/)
    await assert.rejects(() => saveAgent(dir, agent({ id: 'bagas' }), '', true), /already exists/)
    await assert.rejects(() => saveAgent(dir, agent({ id: 'ghost' }), '', false), /no agent/)
  }))

test('a new agent gets its ID from its name, a palette colour, and its role joins the role list', () =>
  withFolder(async (dir) => {
    const state = await saveAgent(dir, agent({ id: '', name: 'Dewi Lestari', role: 'Release Manager', color: '' }), 'Line\n---\nmore', true)
    const dewi = state.config.agents.find((entry) => entry.name === 'Dewi Lestari')
    assert.equal(dewi?.id, 'dewi-lestari')
    assert.match(dewi?.color ?? '', /^#[0-9a-f]{6}$/)
    assert.ok(state.config.roles.includes('Release Manager'))
    assert.ok(PRESET_ROLES.every((role) => state.config.roles.includes(role)))
    assert.equal(readFileSync(join(dir, 'agents', 'dewi-lestari.md'), 'utf8'), 'Line\n***\nmore\n', 'a --- line becomes ***')
    assert.equal(idFromName('Dewi Lestari', ['dewi-lestari']), 'dewi-lestari-2')
    assert.equal(normalizePrompt('a\r\n---\r\nb'), 'a\n***\nb')
    const edited = await saveAgent(dir, { ...dewi, role: 'QA Lead' } as Agent, 'Line', false)
    assert.equal(edited.config.agents.find((entry) => entry.id === 'dewi-lestari')?.color, dewi?.color, 'editing keeps the colour')
  }))

test('an agent with specs cannot be deleted; one without goes, its prompt to .trash', () =>
  withFolder(async (dir) => {
    await assert.rejects(() => deleteAgent(dir, 'bagas'), /Deactivate the agent/)
    await saveAgent(dir, agent({}), '# Dewi\n', true)
    const state = await deleteAgent(dir, 'dewi')
    assert.deepEqual(state.config.agents.map((entry) => entry.id), ['bagas'])
    assert.ok(!existsSync(join(dir, 'agents', 'dewi.md')))
    assert.equal(readdirSync(join(dir, 'agents', '.trash')).length, 1)
  }))

test('a team with members cannot be deleted, and an empty team prompt leaves no file', () =>
  withFolder(async (dir) => {
    await saveTeam(dir, { id: 'qa', name: 'QA', description: '' }, '', true)
    assert.ok(!existsSync(join(dir, 'teams', 'qa.md')))
    await saveAgent(dir, agent({ team: 'qa' }), '# Dewi\n', true)
    await assert.rejects(() => deleteTeam(dir, 'qa'), /Move Dewi/)
  }))
