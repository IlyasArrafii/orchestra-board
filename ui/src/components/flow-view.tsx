import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Maximize, Minus, Plus, RotateCcw } from 'lucide-react'
import type { BoardItem, BoardSnapshot } from '@protocol'
import { FLOW_DIMS, edgePath, layoutFlow, personaName, snap, type Point } from '@shared/model'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { BoardCard } from './board-card'
import { AgentAvatar } from './icons'

type View = { x: number; y: number; k: number }
const DRAG_THRESHOLD = 4

/**
 * One lane per agent, time left to right, arrows for dependencies. Drag a card to move it (snapped to
 * 8 px and saved), drag the background to pan, scroll to zoom.
 */
export function FlowView({
  items,
  snapshot,
  now,
  selectedKey,
  positions,
  onPositions,
  onOpen
}: {
  items: BoardItem[]
  snapshot: BoardSnapshot
  now: number
  selectedKey: string | null
  positions: Record<string, Point>
  onPositions: (positions: Record<string, Point>) => void
  onOpen: (key: string) => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View | null>(null)
  const [dragging, setDragging] = useState<{ key: string; x: number; y: number } | null>(null)
  const layout = useMemo(() => layoutFlow(items, snapshot.agents, positions), [items, snapshot.agents, positions])
  const nodePos = (key: string, x: number, y: number) => (dragging?.key === key ? { x: dragging.x, y: dragging.y } : { x, y })

  const fit = () => {
    const box = viewport.current
    if (!box) return
    const k = Math.max(0.3, Math.min(1, (box.clientWidth - 64) / layout.width, (box.clientHeight - 96) / layout.height))
    setView({ k, x: Math.max(24, (box.clientWidth - layout.width * k) / 2), y: Math.max(24, (box.clientHeight - layout.height * k) / 2) })
  }
  useLayoutEffect(() => {
    if (!view) fit()
    // Fit once on first draw; later layouts keep the person's pan and zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((current) => {
      if (!current) return current
      const k = Math.min(2, Math.max(0.3, current.k * factor))
      return { k, x: cx - (cx - current.x) * (k / current.k), y: cy - (cy - current.y) * (k / current.k) }
    })

  useEffect(() => {
    const box = viewport.current
    if (!box) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = box.getBoundingClientRect()
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [items.length > 0])

  const pan = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const drag = useRef<{ id: number; key: string; x: number; y: number; nx: number; ny: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  if (!items.length) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">No cards match the filters.</div>
  }

  return (
    <div
      ref={viewport}
      className={cn('relative h-full touch-none overflow-hidden', pan.current ? 'cursor-grabbing' : 'cursor-grab')}
      style={{ backgroundImage: 'radial-gradient(color-mix(in srgb, var(--foreground) 12%, transparent) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
      onPointerDown={(event) => {
        if (!view || (event.target as Element).closest('[data-node], [data-controls]')) return
        pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: view.x, oy: view.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = pan.current
        if (!current || event.pointerId !== current.id) return
        setView((value) => (value ? { ...value, x: current.ox + event.clientX - current.x, y: current.oy + event.clientY - current.y } : value))
      }}
      onPointerUp={() => (pan.current = null)}
      onPointerCancel={() => (pan.current = null)}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: layout.width, height: layout.height, transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.k})` : undefined }}
      >
        {layout.lanes.map((lane, index) => (
          <div
            key={lane.persona}
            className={cn('absolute left-0', index > 0 && 'border-t border-dashed border-border/70')}
            style={{ top: lane.y - FLOW_DIMS.laneGap / 2, height: FLOW_DIMS.nodeH + FLOW_DIMS.laneGap, width: layout.width }}
          >
            <div className="absolute top-1/2 left-4 flex -translate-y-1/2 items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
              <AgentAvatar persona={lane.persona} agents={snapshot.agents} className="size-4 text-[9px]" />
              {personaName(lane.persona, snapshot.agents)}
            </div>
          </div>
        ))}
        {layout.backlogX !== null && (
          <div className="absolute top-0 border-l border-dashed border-border" style={{ left: layout.backlogX + FLOW_DIMS.gapX / 2, height: layout.height }}>
            <span className="absolute top-1.5 left-2 text-[11px] whitespace-nowrap text-muted-foreground">Backlog · not in Orca yet</span>
          </div>
        )}
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible text-muted-foreground" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            {['arrow', 'arrow-active'].map((id) => (
              <marker key={id} id={id} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={id === 'arrow' ? 'currentColor' : 'var(--status-progress)'} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((edge) => {
            const active = selectedKey === edge.from.item.key || selectedKey === edge.to.item.key
            return (
              <path
                key={`${edge.from.item.key}>${edge.to.item.key}`}
                d={edgePath(nodePos(edge.from.item.key, edge.from.x, edge.from.y), nodePos(edge.to.item.key, edge.to.x, edge.to.y))}
                fill="none"
                stroke={active ? 'var(--status-progress)' : 'currentColor'}
                strokeWidth={active ? 2.2 : 1.6}
                opacity={active ? 1 : 0.75}
                markerEnd={`url(#${active ? 'arrow-active' : 'arrow'})`}
              />
            )
          })}
        </svg>
        {layout.nodes.map((node) => {
          const position = nodePos(node.item.key, node.x, node.y)
          return (
            <div
              key={node.item.key}
              data-node
              role="button"
              tabIndex={0}
              aria-label={`${node.item.title}, ${node.item.column}`}
              className={cn('absolute cursor-grab touch-none outline-none active:cursor-grabbing focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-ring', dragging?.key === node.item.key && 'z-10')}
              style={{ left: position.x, top: position.y, width: FLOW_DIMS.nodeW, height: FLOW_DIMS.nodeH }}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                drag.current = { id: event.pointerId, key: node.item.key, x: event.clientX, y: event.clientY, nx: node.x, ny: node.y, moved: false }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                const current = drag.current
                if (!current || event.pointerId !== current.id) return
                const k = view?.k ?? 1
                const dx = (event.clientX - current.x) / k
                const dy = (event.clientY - current.y) / k
                if (!current.moved && Math.hypot(dx, dy) * k < DRAG_THRESHOLD) return
                current.moved = true
                setDragging({ key: current.key, x: Math.max(0, current.nx + dx), y: Math.max(0, current.ny + dy) })
              }}
              onPointerUp={() => {
                const current = drag.current
                drag.current = null
                if (current?.moved && dragging) {
                  onPositions({ ...positions, [current.key]: { x: snap(dragging.x), y: snap(dragging.y) } })
                  suppressClick.current = true
                }
                setDragging(null)
              }}
              onPointerCancel={() => {
                drag.current = null
                setDragging(null)
              }}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false
                  return
                }
                onOpen(node.item.key)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen(node.item.key)
                }
              }}
            >
              <BoardCard
                item={node.item}
                agents={snapshot.agents}
                now={now}
                compact
                selected={selectedKey === node.item.key}
                dragging={dragging?.key === node.item.key}
                className="h-full gap-1 px-2.5 py-2"
              />
            </div>
          )
        })}
      </div>
      <p className="pointer-events-none absolute bottom-4 left-4 text-[11px] text-muted-foreground">
        Drag a card to move it · drag the background to pan · scroll to zoom · arrows show dependencies
      </p>
      <div data-controls className="absolute right-4 bottom-4 flex items-center gap-1 rounded-lg border bg-popover p-1 shadow-sm">
        {Object.keys(positions).length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => onPositions({})}>
            <RotateCcw /> Reset layout
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => viewport.current && zoomAt(1 / 1.2, viewport.current.clientWidth / 2, viewport.current.clientHeight / 2)}>
          <Minus />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => viewport.current && zoomAt(1.2, viewport.current.clientWidth / 2, viewport.current.clientHeight / 2)}>
          <Plus />
        </Button>
        <Button variant="ghost" size="sm" onClick={fit}>
          <Maximize /> Fit
        </Button>
      </div>
    </div>
  )
}
