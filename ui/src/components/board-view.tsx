import { useRef, useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { BoardItem, BoardSnapshot, Column } from '@protocol'
import { DONE_SHOWN, groupColumns, planMove, type MovePlan } from '@shared/model'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { BoardCard } from './board-card'
import { ColumnDot } from './icons'

const DROP_HINT: Record<MovePlan['action'], string> = {
  start: 'Start the agent',
  unstart: 'Back to Backlog',
  verdict: 'Mark as done',
  changes: 'Send back with changes',
  refuse: ''
}

function DraggableCard({ item, snapshot, now, selected, onOpen }: { item: BoardItem; snapshot: BoardSnapshot; now: number; selected: boolean; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.key })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn('cursor-grab touch-none outline-none active:cursor-grabbing focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-ring', isDragging && 'opacity-30')}
      {...listeners}
      {...attributes}
      aria-label={`${item.title}, ${item.column}, ${item.label}. Press Enter to open, Space to drag.`}
      onClick={onOpen}
      onKeyDown={(event) => {
        listeners?.onKeyDown?.(event)
        if (event.key === 'Enter') onOpen()
      }}
    >
      <BoardCard item={item} agents={snapshot.agents} decision={snapshot.decisions[item.key]} now={now} selected={selected} />
    </div>
  )
}

function ColumnBox({
  column,
  total,
  hint,
  dimmed,
  children
}: {
  column: Column
  total: number
  hint: string | null
  dimmed: boolean
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column, disabled: dimmed })
  return (
    <section
      ref={setNodeRef}
      aria-label={column}
      className={cn(
        'flex min-h-0 min-w-[272px] flex-1 flex-col rounded-xl p-1.5 transition-colors',
        hint && 'bg-accent/40 ring-1 ring-border ring-dashed',
        hint && isOver && 'bg-accent ring-status-progress',
        dimmed && 'opacity-45'
      )}
    >
      <header className="flex items-center gap-2 px-1.5 pt-1 pb-2.5">
        <ColumnDot column={column} />
        <span className="text-[13px] font-semibold">{column}</span>
        <span className="text-xs text-muted-foreground">{total}</span>
        {hint && <span className="ml-auto truncate text-[11px] text-status-progress">{hint}</span>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-0.5 pb-2">{children}</div>
    </section>
  )
}

export function BoardView({
  items,
  snapshot,
  now,
  selectedKey,
  showAllDone,
  onShowAllDone,
  onOpen,
  onMove
}: {
  items: BoardItem[]
  snapshot: BoardSnapshot
  now: number
  selectedKey: string | null
  showAllDone: boolean
  onShowAllDone: (value: boolean) => void
  onOpen: (key: string) => void
  onMove: (item: BoardItem, to: Column) => void
}) {
  const [active, setActive] = useState<BoardItem | null>(null)
  // The click that ends a drag must not also open the card.
  const draggedAt = useRef(0)
  const open = (key: string) => {
    if (Date.now() - draggedAt.current > 250) onOpen(key)
  }
  // A press shorter than 6 px opens the card; a longer drag moves it.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor))
  const groups = groupColumns(items, showAllDone)

  const onDragStart = (event: DragStartEvent) => setActive(items.find((item) => item.key === event.active.id) ?? null)
  const onDragEnd = (event: DragEndEvent) => {
    const item = active
    setActive(null)
    draggedAt.current = Date.now()
    const to = event.over?.id as Column | undefined
    if (item && to && to !== item.column) onMove(item, to)
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => {
      setActive(null)
      draggedAt.current = Date.now()
    }}>
      <div className="flex h-full gap-3 overflow-x-auto px-4 pt-3 pb-4">
        {groups.map((group) => {
          const plan = active && active.column !== group.column ? planMove(active, group.column) : null
          const hint = plan && plan.action !== 'refuse' ? DROP_HINT[plan.action] : null
          return (
            <ColumnBox key={group.column} column={group.column} total={group.total} hint={hint} dimmed={Boolean(plan && plan.action === 'refuse')}>
              {group.items.length ? (
                group.items.map((item) => <DraggableCard key={item.key} item={item} snapshot={snapshot} now={now} selected={item.key === selectedKey} onOpen={() => open(item.key)} />)
              ) : (
                <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">No cards</div>
              )}
              {group.hidden > 0 && (
                <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => onShowAllDone(true)}>
                  Show {group.hidden} more
                </Button>
              )}
              {group.column === 'Done' && showAllDone && group.total > DONE_SHOWN && (
                <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => onShowAllDone(false)}>
                  Show fewer
                </Button>
              )}
            </ColumnBox>
          )
        })}
      </div>
      <DragOverlay dropAnimation={null}>{active ? <BoardCard item={active} agents={snapshot.agents} decision={snapshot.decisions[active.key]} now={now} dragging /> : null}</DragOverlay>
    </DndContext>
  )
}
