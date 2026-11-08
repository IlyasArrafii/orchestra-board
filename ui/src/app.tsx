import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Search, Settings, SquareKanban } from 'lucide-react'
import { toast } from 'sonner'
import type { BoardItem, Column, JevStatus } from '@protocol'
import { filterItems, personaName, personasOf, planMove, relativeTime, type Point } from '@shared/model'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { BoardView } from '@/components/board-view'
import { DetailDialog } from '@/components/detail-dialog'
import { FlowView } from '@/components/flow-view'
import { AgentAvatar, PriorityIcon } from '@/components/icons'
import { MoveDialog, type PendingMove } from '@/components/move-dialog'
import { NewTaskDialog } from '@/components/new-task-dialog'
import { SettingsView, type SettingsTab } from '@/components/settings/settings-view'
import { messageOf, readStorage, request, writeStorage } from '@/lib/orca'
import { useBoard, useCardDetail, useNow } from '@/lib/use-board'
import { cn } from '@/lib/utils'

type View = 'board' | 'flow' | 'settings'
type Prefs = { view: View; persona: string; priority: string; showAllDone: boolean; settingsTab: SettingsTab }
const DEFAULT_PREFS: Prefs = { view: 'board', persona: 'all', priority: 'all', showAllDone: false, settingsTab: 'agents' }

function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void, boolean] {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    readStorage<Partial<Prefs>>('ui', {}).then((saved) => {
      setPrefs({ ...DEFAULT_PREFS, ...saved, view: saved.view === 'flow' || saved.view === 'settings' ? saved.view : 'board' })
      setReady(true)
    })
  }, [])
  const update = (patch: Partial<Prefs>) =>
    setPrefs((current) => {
      const next = { ...current, ...patch }
      writeStorage('ui', next)
      return next
    })
  return [prefs, update, ready]
}

export function App() {
  const board = useBoard()
  const now = useNow()
  const [prefs, setPrefs] = usePrefs()
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailVersion, setDetailVersion] = useState(0)
  const [pending, setPending] = useState<PendingMove | null>(null)
  const [creating, setCreating] = useState(false)
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [jev, setJev] = useState<JevStatus | null>(null)
  const detail = useCardDetail(selectedKey, detailVersion)
  const snapshot = board.snapshot

  useEffect(() => {
    readStorage<Record<string, Point>>('flowPositions', {}).then(setPositions)
    request('jev.status').then(setJev).catch(() => undefined)
    const subscription = orca.plugin.on('jev.changed', (status) => setJev(status))
    return () => subscription.dispose()
  }, [])

  const savePositions = (next: Record<string, Point>) => {
    setPositions(next)
    writeStorage('flowPositions', next)
  }

  const items = useMemo(() => (snapshot ? filterItems(snapshot.items, { persona: prefs.persona, priority: prefs.priority, query }) : []), [snapshot, prefs.persona, prefs.priority, query])
  const personas = snapshot ? personasOf(snapshot.items, snapshot.agents) : []
  const selected = snapshot?.items.find((item) => item.key === selectedKey) ?? null

  useEffect(() => {
    if (selectedKey && snapshot && !selected) setSelectedKey(null)
  }, [selectedKey, snapshot, selected])

  const requestMove = (item: BoardItem, to: Column) => {
    const plan = planMove(item, to)
    if (plan.action === 'refuse') {
      toast.error(plan.reason)
      return
    }
    setPending({ item, to, plan })
  }

  const confirmMove = async ({ verdict, note }: { verdict?: 'Merged' | 'Approved' | 'Closed'; note: string }) => {
    if (!pending) return
    try {
      const result = await request('task.move', { key: pending.item.key, to: pending.to, verdict, note })
      toast.success(result.message)
      setPending(null)
      setDetailVersion((value) => value + 1)
      await board.load(false)
    } catch (error) {
      toast.error(messageOf(error))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="mr-1 flex items-center gap-2">
          <SquareKanban className="size-4 text-status-progress" />
          <span className="text-[13px] font-semibold">Orchestra Board</span>
          {snapshot && (
            <span className="hidden text-xs text-muted-foreground lg:inline" title={snapshot.teamFolder}>
              {snapshot.teamFolder.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
            </span>
          )}
        </div>
        <div className="flex rounded-md border p-0.5" role="tablist" aria-label="View">
          {(['board', 'flow'] as const).map((view) => (
            <Button key={view} role="tab" aria-selected={prefs.view === view} variant={prefs.view === view ? 'secondary' : 'ghost'} size="xs" className="h-7 px-3 capitalize" onClick={() => setPrefs({ view })}>
              {view}
            </Button>
          ))}
        </div>
        {prefs.view !== 'settings' && (
          <>
            <Select value={prefs.persona} onValueChange={(persona) => setPrefs({ persona })}>
              <SelectTrigger size="sm" className="w-40" aria-label="Filter by assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All assignees</SelectItem>
                {personas.map((persona) => (
                  <SelectItem key={persona} value={persona}>
                    <AgentAvatar persona={persona} agents={snapshot?.agents ?? []} className="size-4 text-[9px]" />
                    {personaName(persona, snapshot?.agents ?? [])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={prefs.priority} onValueChange={(priority) => setPrefs({ priority })}>
              <SelectTrigger size="sm" className="w-36" aria-label="Filter by priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                {(['P1', 'P2', 'P3', '-'] as const).map((priority) => (
                  <SelectItem key={priority} value={priority}>
                    <PriorityIcon priority={priority} /> {priority === '-' ? 'No priority' : priority}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, task ID, run…" className="h-8 w-56 pl-8 text-xs" aria-label="Search cards" />
            </div>
          </>
        )}
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {board.loading ? 'Refreshing…' : board.loadedAt ? `Updated ${relativeTime(board.loadedAt, now)}` : ''}
        </span>
        <Button size="sm" onClick={() => setCreating(true)} disabled={!snapshot}>
          <Plus /> New task
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="Refresh" onClick={() => board.load(true)} disabled={board.loading}>
              <RefreshCw className={cn(board.loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh now</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant={prefs.view === 'settings' ? 'secondary' : 'outline'} size="icon-sm" aria-label="Settings" onClick={() => setPrefs({ view: prefs.view === 'settings' ? 'board' : 'settings' })}>
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </header>
      {board.error && (
        <div role="alert" className="mx-4 mt-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm whitespace-pre-wrap">
          The board failed to load: {board.error}
          {snapshot ? '\nShowing the last board that loaded.' : ''}
        </div>
      )}
      <main className="relative min-h-0 flex-1">
        {prefs.view === 'settings' ? (
          <SettingsView tab={prefs.settingsTab} onTab={(settingsTab) => setPrefs({ settingsTab })} folder={snapshot?.teamFolder ?? ''} onTeamChanged={() => board.load(true)} onResetLayout={() => savePositions({})} />
        ) : !snapshot ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">{board.error ? 'No board yet.' : 'Loading the board…'}</div>
        ) : prefs.view === 'flow' ? (
          <FlowView items={items} snapshot={snapshot} now={now} selectedKey={selectedKey} positions={positions} onPositions={savePositions} onOpen={setSelectedKey} />
        ) : (
          <BoardView items={items} snapshot={snapshot} now={now} selectedKey={selectedKey} showAllDone={prefs.showAllDone} onShowAllDone={(showAllDone) => setPrefs({ showAllDone })} onOpen={setSelectedKey} onMove={requestMove} />
        )}
      </main>
      {snapshot && selected && (
        <DetailDialog
          key={selected.key}
          item={selected}
          detail={detail?.key === selected.key ? detail : null}
          snapshot={snapshot}
          now={now}
          onClose={() => setSelectedKey(null)}
          onOpen={setSelectedKey}
          onMove={requestMove}
          onChanged={async (nextKey) => {
            await board.load(true)
            if (nextKey) setSelectedKey(nextKey)
            setDetailVersion((value) => value + 1)
          }}
        />
      )}
      <MoveDialog pending={pending} agents={snapshot?.agents ?? []} decision={pending ? snapshot?.decisions[pending.item.key] : undefined} onCancel={() => setPending(null)} onConfirm={confirmMove} />
      <NewTaskDialog
        open={creating}
        agents={snapshot?.agents ?? []}
        jevReady={Boolean(jev?.configured)}
        onClose={() => setCreating(false)}
        onCreated={async (key) => {
          setCreating(false)
          await board.load(true)
          setSelectedKey(key)
        }}
      />
    </div>
  )
}
