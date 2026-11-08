import type { Agent, Column, Priority } from '@protocol'
import { personaName } from '@shared/model'
import { cn } from '@/lib/utils'

export const COLUMN_COLOR: Record<Column, string> = {
  Backlog: 'text-status-backlog',
  'In Progress': 'text-status-progress',
  'Under Review': 'text-status-review',
  Done: 'text-status-done'
}

export const COLUMN_BG: Record<Column, string> = {
  Backlog: 'bg-status-backlog',
  'In Progress': 'bg-status-progress',
  'Under Review': 'bg-status-review',
  Done: 'bg-status-done'
}

/** Linear-style status ring: dashed, half, three quarters, done. */
export function StatusIcon({ column, className }: { column: Column; className?: string }) {
  return (
    <svg viewBox="0 0 14 14" className={cn('size-3.5 shrink-0', COLUMN_COLOR[column], className)} aria-hidden="true">
      {column === 'Backlog' && <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" />}
      {(column === 'In Progress' || column === 'Under Review') && <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {column === 'In Progress' && <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" />}
      {column === 'Under Review' && <path d="M7 3.5 A3.5 3.5 0 1 1 3.5 7 L7 7 Z" fill="currentColor" />}
      {column === 'Done' && (
        <>
          <circle cx="7" cy="7" r="6.2" fill="currentColor" />
          <path d="M4.3 7.2 L6.2 9 L9.8 5.3" fill="none" stroke="var(--card)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  )
}

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const label = priority === '-' ? 'No priority' : `Priority ${priority}`
  const filled = { P1: 3, P2: 2, P3: 1, '-': 0 }[priority]
  const tone = priority === 'P1' ? 'text-orange-500' : priority === 'P2' ? 'text-foreground' : 'text-muted-foreground'
  return (
    <svg viewBox="0 0 16 16" className={cn('size-3.5 shrink-0', tone, className)} role="img" aria-label={label}>
      <title>{label}</title>
      {priority === '-'
        ? [1.5, 6.25, 11].map((x) => <rect key={x} x={x} y={7.2} width={3.2} height={1.6} rx={0.6} fill="currentColor" />)
        : [6, 9, 12].map((height, index) => (
            <rect key={height} x={1.5 + index * 4.75} y={14 - height} width={3.2} height={height} rx={0.8} fill="currentColor" opacity={index < filled ? 1 : 0.22} />
          ))}
    </svg>
  )
}

export function AgentAvatar({ persona, agents, className }: { persona: string; agents: Agent[]; className?: string }) {
  const agent = agents.find((entry) => entry.id === persona)
  const name = personaName(persona, agents)
  return (
    <span
      className={cn('inline-grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white', !agent && 'bg-muted-foreground/60', className)}
      style={agent ? { background: agent.color } : undefined}
      title={name}
      aria-hidden="true"
    >
      {persona === '-' ? '?' : name.charAt(0).toUpperCase()}
    </span>
  )
}

export function ColumnDot({ column, className }: { column: Column; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', COLUMN_BG[column], className)} aria-hidden="true" />
}
