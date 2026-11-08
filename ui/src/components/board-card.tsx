import { CircleDot } from 'lucide-react'
import type { Agent, BoardItem, Decision } from '@protocol'
import { activityTime, relativeTime, stateTone } from '@shared/model'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { AgentAvatar, PriorityIcon, StatusIcon } from './icons'

export function identOf(item: BoardItem): string {
  return item.specFile ? item.name : item.taskId ?? item.key
}

const TONE_CLASS: Record<string, string> = {
  danger: 'border-destructive/40 text-destructive',
  warning: 'border-status-review/40 text-status-review',
  ok: 'border-status-done/40 text-status-done',
  queue: 'border-dashed text-muted-foreground',
  '': 'text-muted-foreground'
}

export function StateBadge({ item, className }: { item: BoardItem; className?: string }) {
  return (
    <Badge variant="outline" className={cn('h-5 max-w-full truncate rounded-full px-2 text-[11px] font-normal', TONE_CLASS[stateTone(item.state)], className)}>
      {item.label}
    </Badge>
  )
}

const FIT_CLASS: Record<string, string> = {
  'Strong fit': 'border-status-done/40 text-status-done',
  'Good fit': 'border-status-done/40 text-status-done',
  'Partial fit': 'border-status-review/40 text-status-review',
  'Poor fit': 'border-destructive/40 text-destructive'
}

export function FitPill({ level, confidence, short = false }: { level: string; confidence: number; short?: boolean }) {
  return (
    <Badge variant="outline" className={cn('h-5 shrink-0 rounded-full px-2 text-[11px] font-normal', FIT_CLASS[level])} title={`Jev · ${level} · confidence ${confidence.toFixed(2)}`}>
      {!short && <CircleDot />}
      {short ? level.replace(/ fit$/, '') : level}
    </Badge>
  )
}

export function FitBadge({ decision }: { decision: Decision | undefined }) {
  if (!decision?.fit) return null
  return <FitPill level={decision.fit.level} confidence={decision.fit.confidence} />
}

export function BoardCard({
  item,
  agents,
  decision,
  now,
  selected = false,
  compact = false,
  dragging = false,
  className
}: {
  item: BoardItem
  agents: Agent[]
  decision?: Decision
  now: number
  selected?: boolean
  compact?: boolean
  dragging?: boolean
  className?: string
}) {
  const time = activityTime(item)
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left text-card-foreground shadow-xs transition-[border-color,box-shadow] select-none',
        'hover:border-foreground/25',
        selected && 'border-status-progress ring-1 ring-status-progress',
        dragging && 'rotate-1 shadow-xl ring-1 ring-status-progress',
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusIcon column={item.column} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{identOf(item)}</span>
        {item.priority !== '-' && <PriorityIcon priority={item.priority} />}
      </div>
      <p className={cn('text-[13px] leading-snug font-medium', compact ? 'line-clamp-1' : 'line-clamp-2')}>{item.title}</p>
      <div className={cn('flex min-w-0 items-center gap-1.5', compact ? 'flex-nowrap' : 'flex-wrap')}>
        {!compact && <AgentAvatar persona={item.persona} agents={agents} />}
        <StateBadge item={item} className={compact ? 'min-w-0 shrink' : undefined} />
        {!compact && <FitBadge decision={decision} />}
        {time !== null && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{relativeTime(time, now)}</span>}
      </div>
    </div>
  )
}
