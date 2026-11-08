import { assert, test } from 'orca/testing'
import { parseCatalog, userDataCandidates } from './agents-detect'

test("Orca's catalog: newest entry per agent, resolved model ids, efforts, duplicates dropped", () => {
  const catalog = parseCatalog({
    version: 3,
    entries: [
      { agent: 'claude', discovered: { at: 1, models: [{ id: 'old', label: 'Old' }] } },
      {
        agent: 'claude',
        discovered: {
          at: 2,
          models: [
            { id: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', isDefault: true, efforts: [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }] },
            { id: 'claude-opus-5-5', label: 'duplicate' },
            { id: 'sonnet', label: 'Sonnet' }
          ]
        }
      },
      { agent: 'codex', discovered: { at: 5, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', defaultEffort: 'low', efforts: [{ value: 'low' }] }] } },
      { agent: 'broken' }
    ]
  })
  assert.deepEqual([...catalog.keys()], ['claude', 'codex'])
  const claude = catalog.get('claude') ?? []
  assert.deepEqual(claude.map((model) => model.id), ['claude-opus-5-5', 'sonnet'])
  assert.deepEqual(claude[0].efforts.map((effort) => effort.value), ['high', 'max'])
  assert.equal(claude[0].isDefault, true)
  assert.equal(catalog.get('codex')?.[0].defaultEffort, 'low')
  assert.deepEqual(catalog.get('codex')?.[0].efforts, [{ value: 'low', label: 'low' }])
  assert.equal(parseCatalog(null).size, 0)
})

test('the user-data folder follows Orca: APPDATA on Windows, then the platform default', () => {
  assert.deepEqual(userDataCandidates({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me').length, 1)
  assert.ok(userDataCandidates({ ORCA_USER_DATA_PATH: '/custom' }, 'linux', '/home/me')[0] === '/custom')
})
