import { useState, type ReactNode } from 'react'
import { ChevronRight, CircleDot, ExternalLink, Eye, Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { BoardItem, BoardSnapshot, Column, Priority } from '@protocol'
import {
  COLUMNS,
  briefBody,
  dependentsOf,
  editableBeforeStart,
  formatDuration,
  indexByTask,
  parseUtc,
  personaName,
  planMove,
  rankedFits,
  relativeTime,
  timelineSteps,
  type StepTone
} from '@shared/model'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { messageOf, request } from '@/lib/orca'
import { useCardDetail } from '@/lib/use-board'
import { cn } from '@/lib/utils'
import { FitPill, StateBadge, identOf } from './board-card'
import { AgentAvatar, ColumnDot, PriorityIcon, StatusIcon } from './icons'
import { Markdown } from './markdown'

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const ACTIVITY_SHOWN = 4
const LONG = 1400
const UNASSIGNED = '__unassigned'

const STEP_DOT: Record<StepTone, string> = {
  backlog: 'bg-status-backlog',
  progress: 'bg-status-progress',
  review: 'bg-status-review',
  done: 'bg-status-done',
  danger: 'bg-destructive',
  note: 'border-2 border-muted-foreground bg-transparent'
}

function Section({ title, count, extra, defaultOpen = true, children }: { title: string; count?: number; extra?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-t first:border-t-0">
      <button type="button" className="flex w-full items-center gap-2 py-3 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="text-[13px] font-semibold">{title}</span>
        {count !== undefined && <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{count}</span>}
        {extra && <span className="ml-auto">{extra}</span>}
      </button>
      {open && <div className="pb-4 pl-5">{children}</div>}
    </section>
  )
}

function Clamped({ text }: { text: string }) {
  const [full, setFull] = useState(false)
  const long = text.length > LONG
  return (
    <div>
      <div className={cn(long && !full && 'clamp-fade')}>
        <Markdown source={text} />
      </div>
      {long && (
        <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground" onClick={() => setFull(!full)}>
          {full ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  )
}

function Activity({ item, now }: { item: BoardItem; now: number }) {
  const steps = timelineSteps(item)
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const hidden = all ? 0 : Math.max(0, steps.length - ACTIVITY_SHOWN)
  return (
    <Section title="Activity" count={steps.length}>
      {hidden > 0 && (
        <Button variant="link" size="sm" className="mb-2 h-auto px-0 text-muted-foreground" onClick={() => setAll(true)}>
          Show {hidden} earlier
        </Button>
      )}
      <ol className="space-y-0">
        {steps.slice(hidden).map((step, offset) => {
          const index = hidden + offset
          const long = step.detail.length > 200
          const expanded = open.has(index)
          return (
            <li key={index} className="relative grid grid-cols-[18px_1fr] gap-2.5 pb-3.5 last:pb-0">
              {offset < steps.length - hidden - 1 && <span className="absolute top-4 bottom-0 left-[8px] w-0.5 bg-border" aria-hidden="true" />}
              <span className={cn('relative mt-1.5 ml-1 size-2.5 rounded-full ring-4 ring-popover', STEP_DOT[step.tone])} aria-hidden="true" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-medium">{step.title}</span>
                  <span className="text-xs text-muted-foreground">{step.when !== null ? relativeTime(step.when, now) : step.date}</span>
                </div>
                {step.detail && (
                  <p
                    className={cn('mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]', long && 'cursor-pointer hover:text-foreground', long && !expanded && 'line-clamp-3')}
                    onClick={() => long && setOpen((current) => new Set(current.has(index) ? [...current].filter((n) => n !== index) : [...current, index]))}
                  >
                    {step.detail}
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </Section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 text-[13px]">{children}</div>
    </div>
  )
}

function LinkCard({ item, onOpen }: { item: BoardItem; onOpen: (key: string) => void }) {
  return (
    <button type="button" className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent" onClick={() => onOpen(item.key)} title={item.title}>
      <StatusIcon column={item.column} />
      <span className="truncate">{item.title}</span>
    </button>
  )
}

/** The linked review card's report, shown on the card it reviews. */
function ReviewerReport({ review, agents, now }: { review: BoardItem; agents: BoardSnapshot['agents']; now: number }) {
  const detail = useCardDetail(review.key, parseUtc(review.completedAt) ?? 0)
  const report = review.report
  const name = personaName(review.persona, agents)
  const startedAt = parseUtc(review.createdAt)
  return (
    <Section title={`Review by ${name}`} extra={<StateBadge item={review} />}>
      {!report ? (
        <p className="text-sm text-muted-foreground">
          {review.status === 'failed' ? `${name} stopped without a report.` : `${name} is reviewing${startedAt !== null ? `, started ${relativeTime(startedAt, now)}` : ''}.`}
        </p>
      ) : (
        <>
          {report.subject && <p className="mb-2 text-[13px] font-semibold">{report.subject}</p>}
          {detail?.report?.body ? <Clamped text={detail.report.body} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
        </>
      )}
    </Section>
  )
}

export function DetailDialog({
  item,
  detail,
  snapshot,
  now,
  onClose,
  onOpen,
  onMove,
  onChanged
}: {
  item: BoardItem | null
  detail: BoardItem | null
  snapshot: BoardSnapshot
  now: number
  onClose: () => void
  onOpen: (key: string) => void
  onMove: (item: BoardItem, to: Column) => void
  onChanged: (nextKey?: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [reviewerChoice, setReviewerChoice] = useState<string | undefined>()
  if (!item) return null
  const agents = snapshot.agents
  const decision = snapshot.decisions[item.key]
  const agent = agents.find((entry) => entry.id === item.persona)
  const team = agent?.team ? snapshot.teams.find((entry) => entry.id === agent.team) : undefined
  const editable = editableBeforeStart(item)
  const byTask = indexByTask(snapshot.items)
  const blockedBy = item.deps.map((id) => byTask.get(id)).filter((entry): entry is BoardItem => Boolean(entry))
  const blocking = dependentsOf(item, snapshot.items)
  const started = parseUtc(item.createdAt)
  const finished = parseUtc(item.completedAt)
  const brief = briefBody(detail?.brief ?? '')
  const report = item.report
  const workers = agents.filter((entry) => entry.agent && entry.active)
  const fits = rankedFits(decision)
  const fitOf = (id: string) => decision?.fits?.[id]
  const isReview = Boolean(item.reviews)
  const reviewed = isReview ? snapshot.items.find((entry) => entry.specFile === item.reviews) : undefined
  const reviewCard = item.reviewer ? snapshot.items.find((entry) => entry.key === item.reviewer?.key) : undefined
  const reviewers = workers.filter((entry) => entry.id !== item.persona)
  const jevReviewer = decision?.reviewer?.agent && decision.reviewer.agent !== item.persona ? decision.reviewer.agent : null
  const canReview = !isReview && Boolean(item.specFile) && item.column === 'Under Review'
  const chosenReviewer = reviewerChoice ?? jevReviewer ?? reviewers[0]?.id
  const reviewerState = (status: string | null) => (status === 'completed' ? 'reported' : status === 'failed' ? 'stopped' : 'reviewing')

  const run = async (label: string, call: () => Promise<{ key?: string } | unknown>, done: string | ((result: { key?: string; message?: string }) => string)) => {
    setBusy(label)
    try {
      const result = (await call()) as { key?: string; message?: string }
      toast.success(typeof done === 'string' ? done : done(result))
      onChanged(result?.key)
    } catch (error) {
      toast.error(messageOf(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="flex h-[min(880px,92vh)] w-[min(1120px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogDescription className="sr-only">Card details</DialogDescription>
        <header className="flex items-center gap-2.5 border-b px-4 py-3">
          <StatusIcon column={item.column} className="size-4" />
          <Badge variant="outline" className="max-w-[50%] truncate rounded-md font-mono text-[11px] font-normal text-muted-foreground">
            {identOf(item)}
          </Badge>
          <span className="flex-1" />
          {item.specFile && (
            <Button variant="outline" size="sm" onClick={() => request('board.openSpec', { specFile: item.specFile as string }).catch((error) => toast.error(messageOf(error)))}>
              <ExternalLink /> Open spec
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            ✕
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-h-0 overflow-y-auto px-6 pt-5 pb-8">
            <DialogTitle className="mb-3 text-lg leading-snug font-semibold [overflow-wrap:anywhere]">{item.title}</DialogTitle>
            <Section title="Description">{brief ? <Clamped text={brief} /> : <p className="text-sm text-muted-foreground">{detail ? 'No brief.' : 'Loading…'}</p>}</Section>
            <Activity item={item} now={now} />
            {report && (
              <Section
                title="Worker report"
                extra={
                  <Badge variant="outline" className={cn('rounded-full text-[11px] font-normal', report.outcome === 'succeeded' ? 'border-status-done/40 text-status-done' : 'border-destructive/40 text-destructive')}>
                    {report.outcome ?? 'no outcome'}
                  </Badge>
                }
              >
                {report.subject && <p className="mb-2 text-[13px] font-semibold">{report.subject}</p>}
                {report.filesModified.length > 0 && (
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{report.filesModified.length} files changed</span>
                    {report.filesModified.slice(0, 12).map((file) => (
                      <code key={file} className="rounded bg-muted px-1.5 font-mono text-[11px]">
                        {file}
                      </code>
                    ))}
                  </div>
                )}
                {detail?.report?.body ? <Clamped text={detail.report.body} /> : !detail && <p className="text-sm text-muted-foreground">Loading…</p>}
              </Section>
            )}
            {reviewCard && <ReviewerReport review={reviewCard} agents={agents} now={now} />}
            {(item.review || (item.specFile && item.column === 'Under Review')) && (
              <Section title="Review" count={item.review?.lines.length}>
                {item.review ? (
                  <div className="space-y-2">
                    {item.review.lines.map((line, index) => (
                      <p key={index} className="text-[13px] [overflow-wrap:anywhere]">
                        {line}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No verdict yet. Drag the card to Done when you accept it, or to In Progress to send it back with changes.</p>
                )}
              </Section>
            )}
          </div>

          <aside className="min-h-0 overflow-y-auto border-t bg-muted/20 px-4 py-4 md:border-t-0 md:border-l" aria-label="Properties">
            <div className="space-y-1">
              <Row label="Status">
                <Select value={item.column} onValueChange={(value) => onMove(item, value as Column)}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COLUMNS.map((column) => {
                      const plan = column === item.column ? null : planMove(item, column)
                      return (
                        <SelectItem key={column} value={column} disabled={Boolean(plan && plan.action === 'refuse')}>
                          <ColumnDot column={column} /> {column}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Assignee">
                <Select
                  value={item.persona === '-' ? UNASSIGNED : item.persona}
                  disabled={!editable.ok || busy !== null}
                  onValueChange={(value) => run('assign', () => request('task.assign', { key: item.key, agent: value === UNASSIGNED ? null : value }), value === UNASSIGNED ? 'Unassigned: Jev picks when it starts.' : `Assigned to ${personaName(value, agents)}.`)}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>
                      <AgentAvatar persona="-" agents={agents} className="size-4 text-[9px]" /> Jev picks at start
                    </SelectItem>
                    {(item.persona === '-' || workers.some((entry) => entry.id === item.persona) ? workers : [...workers, ...agents.filter((entry) => entry.id === item.persona)]).map((entry) => {
                      const fit = fitOf(entry.id)
                      return (
                        <SelectItem key={entry.id} value={entry.id}>
                          <AgentAvatar persona={entry.id} agents={agents} className="size-4 text-[9px]" /> {entry.name}
                          {fit && <FitPill level={fit.level} confidence={fit.confidence} short />}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Priority">
                <Select
                  value={item.priority === '-' ? undefined : item.priority}
                  disabled={!editable.ok || busy !== null}
                  onValueChange={(value) => run('priority', () => request('task.priority', { key: item.key, priority: value as Exclude<Priority, '-'> }), `Priority set to ${value}.`)}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue placeholder={<span className="flex items-center gap-2"><PriorityIcon priority="-" /> No priority</span>} />
                  </SelectTrigger>
                  <SelectContent>
                    {(['P1', 'P2', 'P3'] as const).map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        <PriorityIcon priority={priority} /> {priority} · {priority === 'P1' ? 'Urgent' : priority === 'P2' ? 'Normal' : 'Can wait'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              {!editable.ok && <p className="pl-[96px] text-[11px] leading-snug text-muted-foreground">{editable.reason}</p>}
              {agent && (
                <p className="pl-[96px] text-[11px] text-muted-foreground">
                  {agent.role}
                  {team ? ` · ${team.name}` : ''}
                </p>
              )}
              {reviewed && (
                <Row label="Reviews">
                  <LinkCard item={reviewed} onOpen={onOpen} />
                </Row>
              )}
              {!isReview && item.specFile && (
                <Row label="Reviewer">
                  <div className="space-y-1.5">
                    {item.reviewer ? (
                      <button type="button" className="flex max-w-full items-center gap-1.5 text-xs hover:underline" onClick={() => onOpen(item.reviewer?.key as string)}>
                        <AgentAvatar persona={item.reviewer.persona} agents={agents} className="size-4 text-[9px]" />
                        <span className="truncate">{personaName(item.reviewer.persona, agents)}</span>
                        <span className="shrink-0 text-muted-foreground">
                          · {reviewerState(item.reviewer.status)}
                          {item.reviewer.round > 1 ? ` · round ${item.reviewer.round}` : ''}
                        </span>
                      </button>
                    ) : canReview && reviewers.length > 0 ? null : jevReviewer ? (
                      <span className="flex items-center gap-1.5 text-xs">
                        <AgentAvatar persona={jevReviewer} agents={agents} className="size-4 text-[9px]" />
                        {personaName(jevReviewer, agents)}
                        <span className="text-muted-foreground">· Jev's pick</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Jev picks one when the work is reported</span>
                    )}
                    {canReview && reviewers.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <Select value={chosenReviewer} onValueChange={setReviewerChoice} disabled={busy !== null}>
                          <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs" aria-label="Reviewer">
                            <SelectValue placeholder="Reviewer" />
                          </SelectTrigger>
                          <SelectContent>
                            {reviewers.map((entry) => (
                              <SelectItem key={entry.id} value={entry.id}>
                                <AgentAvatar persona={entry.id} agents={agents} className="size-4 text-[9px]" /> {entry.name}
                                {entry.id === jevReviewer && <Sparkles className="size-3 text-status-progress" aria-label="Jev's pick" />}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          size="xs"
                          className="h-7"
                          title={item.reviewer ? 'Start another review with this agent' : 'Start the review now'}
                          disabled={busy !== null || !chosenReviewer}
                          onClick={() =>
                            run(
                              'review',
                              () => request('task.review', { key: item.key, reviewer: reviewerChoice ?? (item.reviewer ? chosenReviewer : undefined) }),
                              (result) => result.message ?? 'Review started.'
                            )
                          }
                        >
                          {busy === 'review' ? <Loader2 className="animate-spin" /> : <Eye />}
                          Review
                        </Button>
                      </div>
                    )}
                  </div>
                </Row>
              )}
            </div>

            <Separator className="my-3" />
            <div className="space-y-1">
              <Row label="State">
                <StateBadge item={item} />
              </Row>
              <Row label="Jev">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">{decision ? `Assessed ${relativeTime(decision.assessedAt, now)}` : 'Not assessed'}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy !== null}
                    onClick={() =>
                      run(
                        'jev',
                        async () => {
                          const result = await request('jev.assess', { key: item.key })
                          if (result.error) throw new Error(result.error)
                          return result
                        },
                        'Jev assessed the card.'
                      )
                    }
                  >
                    {busy === 'jev' ? <Loader2 className="animate-spin" /> : <Sparkles />}
                    {decision ? 'Re-assess' : 'Assess'}
                  </Button>
                </div>
              </Row>
              {decision && (
                <Row label="Best pick">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    {decision.suggested.agent ? (
                      <>
                        <AgentAvatar persona={decision.suggested.agent} agents={agents} className="size-4 text-[9px]" />
                        {personaName(decision.suggested.agent, agents)}
                        <span className="text-muted-foreground">{Math.round(decision.suggested.probability * 100)}%</span>
                        {editable.ok && decision.suggested.agent !== item.persona && (
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={busy !== null}
                            onClick={() => run('assign', () => request('task.assign', { key: item.key, agent: decision.suggested.agent }), `Assigned to ${personaName(decision.suggested.agent as string, agents)}.`)}
                          >
                            Assign
                          </Button>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">No agent fits</span>
                    )}
                    {item.priority === '-' && <span className="text-muted-foreground">· suggests {decision.priority.suggested}</span>}
                  </div>
                </Row>
              )}
              {fits.length > 0 && (
                <Row label="Agent fit">
                  <ul className="space-y-1">
                    {fits.map((fit) => (
                      <li key={fit.agent} className="flex items-center gap-1.5 text-xs">
                        <AgentAvatar persona={fit.agent} agents={agents} className="size-4 text-[9px]" />
                        <span className="min-w-0 flex-1 truncate">
                          {personaName(fit.agent, agents)}
                          {fit.agent === item.persona && <span className="text-muted-foreground"> · assignee</span>}
                          {fit.agent === jevReviewer && <span className="text-muted-foreground"> · reviewer</span>}
                        </span>
                        <FitPill level={fit.level} confidence={fit.confidence} short />
                      </li>
                    ))}
                  </ul>
                </Row>
              )}
            </div>

            {(blockedBy.length > 0 || blocking.length > 0) && (
              <>
                <Separator className="my-3" />
                <div className="space-y-2">
                  {blockedBy.length > 0 && (
                    <Row label="Blocked by">
                      <div className="space-y-1">
                        {blockedBy.map((entry) => (
                          <LinkCard key={entry.key} item={entry} onOpen={onOpen} />
                        ))}
                      </div>
                    </Row>
                  )}
                  {blocking.length > 0 && (
                    <Row label="Blocking">
                      <div className="space-y-1">
                        {blocking.map((entry) => (
                          <LinkCard key={entry.key} item={entry} onOpen={onOpen} />
                        ))}
                      </div>
                    </Row>
                  )}
                </div>
              </>
            )}

            <Separator className="my-3" />
            <div className="space-y-1 text-xs">
              {item.runObjective && (
                <Row label="Run">
                  <span className="text-xs" title={item.runId ?? ''}>
                    {item.runObjective}
                  </span>
                </Row>
              )}
              {item.taskId && (
                <Row label="Task">
                  <code className="font-mono text-[11px]">{item.taskId}</code>
                </Row>
              )}
              {started !== null && (
                <Row label="Started">
                  <span className="text-xs" title={relativeTime(started, now)}>
                    {dateFormat.format(started)}
                  </span>
                </Row>
              )}
              {finished !== null && (
                <Row label="Finished">
                  <span className="text-xs">
                    {dateFormat.format(finished)}
                    {started !== null && <span className="text-muted-foreground"> · took {formatDuration(finished - started)}</span>}
                  </span>
                </Row>
              )}
              {item.specFile && (
                <Row label="Spec">
                  <code className="block truncate font-mono text-[11px]" title={item.specFile}>
                    {item.specFile}
                  </code>
                </Row>
              )}
            </div>
            {decision && (
              <p className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <CircleDot className="size-3" /> Jev {decision.model} · {relativeTime(decision.assessedAt, now)}
              </p>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
