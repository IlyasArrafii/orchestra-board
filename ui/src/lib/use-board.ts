import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardItem, BoardSnapshot } from '@protocol'
import { messageOf, request } from './orca'

export type BoardState = {
  snapshot: BoardSnapshot | null
  error: string
  loading: boolean
  loadedAt: number
  load: (force?: boolean) => Promise<void>
}

/** The board from the worker; reloads when the worker posts board.changed. */
export function useBoard(): BoardState {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadedAt, setLoadedAt] = useState(0)
  const announced = useRef(false)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    try {
      const result = await request('board.load', { force })
      setLoadedAt(result.loadedAt)
      if (result.ok) {
        setSnapshot(result.snapshot)
        setError('')
      } else {
        setError(result.error)
      }
    } catch (failure) {
      setError(messageOf(failure))
      setLoadedAt(Date.now())
    } finally {
      setLoading(false)
      // The file's content is not used. Asking for it tells Orca the editor is up, so ask once the
      // board has drawn, and `orca plugin shot` captures the board rather than "Loading".
      if (!announced.current) {
        announced.current = true
        orca.document?.get().catch(() => undefined)
      }
    }
  }, [])

  useEffect(() => {
    void load(false)
    const subscription = orca.plugin.on('board.changed', () => void load(false))
    const fallback = setTimeout(() => {
      if (!announced.current) {
        announced.current = true
        orca.document?.get().catch(() => undefined)
      }
    }, 3000)
    return () => {
      subscription.dispose()
      clearTimeout(fallback)
    }
  }, [load])

  return { snapshot, error, loading, loadedAt, load }
}

/** One card with its brief and full report (board.load leaves those out). */
export function useCardDetail(key: string | null, version: number): BoardItem | null {
  const [item, setItem] = useState<BoardItem | null>(null)
  useEffect(() => {
    let live = true
    setItem((current) => (current?.key === key ? current : null))
    if (!key) return
    request('board.item', { key })
      .then((result) => {
        if (live) setItem(result.item)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key, version])
  return item
}

/** "5m ago" labels that stay current. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
