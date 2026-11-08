// The frame's `orca` global, typed by the plugin's protocol (declaration merging on 'orca').
import type {} from '@protocol'

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^[\w.-]+ answered [\w.]+ with \w+: /, '') : String(error)
}

const TIMEOUT_MS = 110_000

/** plugin.request with a long timeout: board.ps1 and Jev calls can take a few seconds. */
export const request: typeof orca.plugin.request = ((name: string, input?: unknown) =>
  orca.plugin.request(name as never, input as never, { timeoutMs: TIMEOUT_MS } as never)) as typeof orca.plugin.request

export async function readStorage<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await orca.storage.get(key)
    return value === null || value === undefined ? fallback : (value as T)
  } catch {
    return fallback
  }
}

export function writeStorage(key: string, value: unknown): void {
  orca.storage.set(key, value as never).catch(() => undefined)
}
