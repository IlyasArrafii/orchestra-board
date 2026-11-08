// Runs `board.ps1 -Json` and shapes what the worker shows. Node only: never imported by the editor.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { BoardCounts, BoardItem, BoardResult, BoardSnapshot, Column } from './protocol'

/** What board.ps1 -Json prints; the worker adds agents, teams and decisions to make a BoardSnapshot. */
export type ScriptSnapshot = Pick<BoardSnapshot, 'generatedAt' | 'teamFolder' | 'columns' | 'items'>

export const COLUMNS: Column[] = ['Backlog', 'In Progress', 'Under Review', 'Done']
const BOARD_SCRIPT = 'board.ps1'
const RUN_TIMEOUT_MS = 90_000
const ERROR_LIMIT = 2_000

/** The team folder (team.json, agents/, teams/, tasks/): the setting when set, else the folder this plugin sits in. */
export function resolveTeamFolder(setting: unknown, pluginRoot: string): string {
  const configured = typeof setting === 'string' ? setting.trim() : ''
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(pluginRoot, configured)
  }
  return dirname(pluginRoot)
}

/** Orca can start plugin workers without APPDATA/LOCALAPPDATA, which the `orca` CLI needs to find its runtime. */
export function childEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): NodeJS.ProcessEnv {
  const next = { ...env }
  if (platform === 'win32') {
    next.APPDATA ||= join(home, 'AppData', 'Roaming')
    next.LOCALAPPDATA ||= join(home, 'AppData', 'Local')
  }
  return next
}

export function pwshCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const candidates = ['pwsh']
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files']) {
      if (base) {
        candidates.push(join(base, 'PowerShell', '7', 'pwsh.exe'))
      }
    }
  }
  return [...new Set(candidates)]
}

/** PowerShell's error view may carry ANSI colours; the board shows plain text. */
export function cleanError(text: string): string {
  const plain = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim()
  return plain.length > ERROR_LIMIT ? `${plain.slice(0, ERROR_LIMIT)}…` : plain
}

export function parseSnapshot(stdout: string): ScriptSnapshot {
  const text = stdout.replace(/^\uFEFF/, '').trim()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`board.ps1 did not print JSON: ${cleanError(text.slice(0, 300))}`)
  }
  const snapshot = value as ScriptSnapshot
  if (!snapshot || !Array.isArray(snapshot.items)) {
    throw new Error('board.ps1 printed JSON without an items list')
  }
  return snapshot
}

/** board.load answers at most 1 MiB, so it leaves out each card's brief and report body; board.item sends them. */
export function lightItem(item: BoardItem): BoardItem {
  const { brief: _brief, ...rest } = item
  return { ...rest, report: item.report ? { ...item.report, body: '' } : null }
}

type ExecError = Error & { code?: string | number }

function execText(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      { cwd, env, signal, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const failure: ExecError = new Error(cleanError(String(stderr ?? '')) || error.message)
          failure.code = (error as ExecError).code
          reject(failure)
          return
        }
        resolvePromise(stdout)
      }
    )
  })
}

/** Runs the plugin's own scripts/board.ps1 against a team folder. */
export async function runBoard(teamFolder: string, script: string, signal?: AbortSignal): Promise<ScriptSnapshot> {
  if (!existsSync(join(teamFolder, 'team.json')) && !existsSync(join(teamFolder, 'tasks'))) {
    throw new Error(`${teamFolder} is not a team folder (no team.json or tasks/). Set "Team folder" in Settings → Plugins → Orchestra Board.`)
  }
  if (!existsSync(script)) throw new Error(`The plugin's ${BOARD_SCRIPT} is missing: ${script}`)
  const env = childEnv(process.env)
  const args = ['-NoProfile', '-NonInteractive', '-File', script, '-TeamFolder', teamFolder, '-Json']
  let missing: unknown = null
  for (const pwsh of pwshCandidates(env, process.platform)) {
    try {
      return parseSnapshot(await execText(pwsh, args, dirname(teamFolder), env, signal))
    } catch (error) {
      if ((error as ExecError).code === 'ENOENT') {
        missing = error
        continue
      }
      throw error
    }
  }
  throw new Error(`PowerShell 7 (pwsh) was not found: ${(missing as Error | null)?.message ?? 'no candidate'}`)
}

export function countColumns(items: BoardItem[]): BoardCounts {
  const counts: BoardCounts = { Backlog: 0, 'In Progress': 0, 'Under Review': 0, Done: 0 }
  for (const item of items) {
    if (item.column in counts) {
      counts[item.column] += 1
    }
  }
  return counts
}

/** Changes here are what an open board needs to redraw for. */
export function boardSignature(items: BoardItem[]): string {
  return items
    .map((item) =>
      [item.key, item.column, item.state, item.status, item.priority, item.title, item.review?.lines.length ?? 0, item.report?.subject ?? ''].join('|')
    )
    .sort()
    .join('\n')
}

export type StatusBarView = { text: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip: string }

export function statusBarView(result: BoardResult): StatusBarView {
  if (!result.ok) {
    return { text: 'Orchestra: error', tone: 'danger', tooltip: `Orchestra Board failed to load: ${result.error}` }
  }
  const counts = countColumns(result.snapshot.items)
  const tooltip = `Orchestra Board — Backlog ${counts.Backlog} · In Progress ${counts['In Progress']} · Under Review ${counts['Under Review']} · Done ${counts.Done}`
  const text = `Orchestra ${counts.Backlog} · ${counts['In Progress']} · ${counts['Under Review']}`
  const tone = counts['Under Review'] > 0 ? 'warning' : counts['In Progress'] > 0 ? 'accent' : 'neutral'
  return { text, tone, tooltip }
}
