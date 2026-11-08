import { useEffect, useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import type { Agent, BoardItem, Column, Decision, Verdict } from '@protocol'
import { personaName, rankedFits, type MovePlan } from '@shared/model'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ColumnDot } from './icons'

export type PendingMove = { item: BoardItem; to: Column; plan: Exclude<MovePlan, { action: 'refuse' }> }

const VERDICT_TEXT: Record<Verdict, { title: string; detail: string }> = {
  Merged: { title: 'Merged', detail: 'The work is merged into the branch.' },
  Approved: { title: 'Approved (PR open)', detail: 'The work is accepted; a pull request is open.' },
  Closed: { title: 'Closed', detail: 'Not doing it, or done another way.' }
}

/** Confirms what a move writes to the spec, and which agent the board starts. */
export function MoveDialog({
  pending,
  agents,
  decision,
  onCancel,
  onConfirm
}: {
  pending: PendingMove | null
  agents: Agent[]
  decision?: Decision
  onCancel: () => void
  onConfirm: (input: { verdict?: Verdict; note: string }) => Promise<void>
}) {
  const [verdict, setVerdict] = useState<Verdict | undefined>()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setVerdict(pending?.plan.action === 'verdict' ? pending.plan.options[0] : undefined)
    setNote('')
    setBusy(false)
  }, [pending])

  if (!pending) return null
  const { item, to, plan } = pending
  const assignee = item.persona === '-' ? null : personaName(item.persona, agents)
  const best = decision?.suggested.agent ?? rankedFits(decision)[0]?.agent ?? null
  const jev = best ? personaName(best, agents) : null
  const copy =
    plan.action === 'start'
      ? {
          title: assignee ? `Start ${assignee} now?` : 'Start this task now?',
          body: assignee
            ? `The board starts ${assignee} in Orca on this spec right away. The card moves to Under Review when ${assignee} reports, and Jev picks a reviewer.`
            : `No one is assigned, so Jev picks the agent that fits best${jev ? ` (now ${jev})` : ''} and the board starts it. Pick an assignee first if you want someone else.`,
          notePlaceholder: '',
          action: assignee ? `Start ${assignee}` : 'Let Jev pick and start'
        }
      : plan.action === 'unstart'
        ? { title: 'Move back to Backlog?', body: 'The "Start requested" line an older board wrote is removed from the spec. Nothing is running for this card yet.', notePlaceholder: '', action: 'Move back' }
        : plan.action === 'changes'
          ? {
              title: 'Send back with changes',
              body: `Your note goes under "## Review" in the spec and ${assignee ?? 'the agent'} starts again on it with the note. When it reports, a new review round starts.`,
              notePlaceholder: 'What should change?',
              action: assignee ? `Send back to ${assignee}` : 'Send back'
            }
          : { title: 'Mark as done', body: 'A verdict line is added under "## Review" in the spec, which moves the card to Done.', notePlaceholder: 'Optional note, e.g. a PR link', action: 'Mark as done' }
  const needsNote = plan.action === 'changes'

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="sm:max-w-md [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
          <ColumnDot column={item.column} />
          <ArrowRight className="size-3 text-muted-foreground" />
          <ColumnDot column={to} />
          <span className="text-muted-foreground">{to}</span>
        </div>
        {plan.action === 'verdict' && (
          <div className="grid gap-2" role="radiogroup" aria-label="Verdict">
            {plan.options.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={verdict === option}
                onClick={() => setVerdict(option)}
                className={cn('rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/60', verdict === option && 'border-status-progress bg-accent/60')}
              >
                <div className="text-[13px] font-medium">{VERDICT_TEXT[option].title}</div>
                <div className="text-xs text-muted-foreground">{VERDICT_TEXT[option].detail}</div>
              </button>
            ))}
          </div>
        )}
        {copy.notePlaceholder && (
          <div className="grid gap-1.5">
            <Label htmlFor="move-note">{needsNote ? 'Changes' : 'Note'}</Label>
            <Textarea id="move-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder={copy.notePlaceholder} className="min-h-20" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || (needsNote && !note.trim()) || (plan.action === 'verdict' && !verdict)}
            onClick={async () => {
              setBusy(true)
              await onConfirm({ verdict, note })
              setBusy(false)
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            {copy.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
