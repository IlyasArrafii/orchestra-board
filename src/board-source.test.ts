import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { childEnv, cleanError, countColumns, lightItem, parseSnapshot, resolveTeamFolder, statusBarView } from './board-source'
import type { BoardItem, BoardResult } from './protocol'

const items = (columns: BoardItem['column'][]) => columns.map((column, index) => ({ key: `k${index}`, column }) as BoardItem)

test('the team folder is the setting, or the folder the plugin sits in', () => {
  const root = process.platform === 'win32' ? 'C:\\repo\\.orca-team\\plugin' : '/repo/.orca-team/plugin'
  const parent = process.platform === 'win32' ? 'C:\\repo\\.orca-team' : '/repo/.orca-team'
  assert.equal(resolveTeamFolder('', root), parent)
  assert.equal(resolveTeamFolder('   ', root), parent)
  assert.equal(resolveTeamFolder(undefined, root), parent)
  assert.equal(resolveTeamFolder(parent, root), parent)
})

test('Windows children get APPDATA and LOCALAPPDATA back', () => {
  const env = childEnv({ PATH: 'x' }, 'win32', 'C:\\Users\\me')
  assert.equal(env.APPDATA, join('C:\\Users\\me', 'AppData', 'Roaming'))
  assert.equal(env.LOCALAPPDATA, join('C:\\Users\\me', 'AppData', 'Local'))
  assert.equal(childEnv({ APPDATA: 'kept' }, 'win32', 'C:\\Users\\me').APPDATA, 'kept')
  assert.equal(childEnv({}, 'linux', '/home/me').APPDATA, undefined)
})

test('board.ps1 output parses, with or without a BOM', () => {
  const json = JSON.stringify({ generatedAt: 'x', teamFolder: 'y', columns: [], items: [] })
  assert.equal(parseSnapshot(json).teamFolder, 'y')
  assert.equal(parseSnapshot(`\uFEFF${json}\n`).generatedAt, 'x')
  assert.throws(() => parseSnapshot('Write-Error: boom'))
  assert.throws(() => parseSnapshot('{"items": 3}'))
})

test('errors lose ANSI colours', () => {
  assert.equal(cleanError('\u001b[31;1mboom\u001b[0m\n'), 'boom')
})

test('counts and the status bar view', () => {
  const list = items(['Backlog', 'Under Review', 'Under Review', 'Done'])
  assert.deepEqual(countColumns(list), { Backlog: 1, 'In Progress': 0, 'Under Review': 2, Done: 1 })
  const ok: BoardResult = { ok: true, loadedAt: 1, snapshot: { generatedAt: '', teamFolder: '', columns: [], items: list, agents: [], teams: [], decisions: {} } }
  assert.deepEqual(statusBarView(ok).text, 'Orchestra 1 · 0 · 2')
  assert.equal(statusBarView(ok).tone, 'warning')
  const busy: BoardResult = { ...ok, snapshot: { ...ok.snapshot, items: items(['In Progress']) } }
  assert.equal(statusBarView(busy).tone, 'accent')
  const failed: BoardResult = { ok: false, error: 'pwsh hilang', teamFolder: null, loadedAt: 1 }
  assert.equal(statusBarView(failed).tone, 'danger')
})

test('board.load leaves out the brief and the report body', () => {
  const full = { key: 'k', brief: 'long brief', report: { outcome: 'succeeded', subject: 's', body: 'long body', filesModified: [] } } as unknown as BoardItem
  const light = lightItem(full)
  assert.equal(light.brief, undefined)
  assert.equal(light.report?.body, '')
  assert.equal(light.report?.subject, 's')
  assert.equal(full.report?.body, 'long body')
})
