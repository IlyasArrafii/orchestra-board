import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Bot, Gauge, Loader2, Plus, Sparkles, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { Agent, DetectedAgent, JevStatus, Team, TeamState } from '@protocol'
import { relativeTime } from '@shared/model'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { messageOf, request } from '@/lib/orca'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '../icons'
import { AgentDialog } from './agent-dialog'

export type SettingsTab = 'agents' | 'teams' | 'jev' | 'board'

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Bot }> = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'teams', label: 'Teams', icon: Users },
  { id: 'jev', label: 'Jev decisions', icon: Sparkles },
  { id: 'board', label: 'Board', icon: Gauge }
]

function flagsOf(agent: Agent): string {
  if (!agent.agent) return 'Lead · not a worker'
  return [agent.agent, agent.model, agent.model && agent.effort ? agent.effort : null].filter(Boolean).join(' · ')
}

function PanelHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  )
}

function AgentsPanel({ state, onState }: { state: TeamState; onState: (state: TeamState) => void }) {
  const [editing, setEditing] = useState<{ agent: Agent | null } | null>(null)
  const [detected, setDetected] = useState<DetectedAgent[]>([])
  const [detectError, setDetectError] = useState<string | null>(null)
  const detect = useCallback((refresh: boolean) => {
    request('agents.detect', { refresh })
      .then((result) => {
        setDetected(result.agents)
        setDetectError(result.error)
      })
      .catch((error) => setDetectError(messageOf(error)))
  }, [])
  useEffect(() => detect(false), [detect])
  const teams = new Map(state.config.teams.map((team) => [team.id, team.name]))
  const label = (id: string | null) => detected.find((entry) => entry.id === id)?.label ?? id

  return (
    <div>
      <PanelHeader
        title="Agents"
        description="Who works on this team, how Orca starts them, and the prompt each one gets."
        action={
          <Button onClick={() => setEditing({ agent: null })}>
            <Plus /> Add agent
          </Button>
        }
      />
      <div className="divide-y overflow-hidden rounded-lg border">
        {state.config.agents.map((agent) => (
          <button key={agent.id} type="button" onClick={() => setEditing({ agent })} className="grid w-full grid-cols-[32px_minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,1.5fr)_auto] items-center gap-3 px-4 py-3 text-left hover:bg-accent/50">
            <AgentAvatar persona={agent.id} agents={state.config.agents} className="size-8 text-xs" />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium">{agent.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{agent.role}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">{agent.team ? teams.get(agent.team) ?? agent.team : 'No team'}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={flagsOf(agent)}>
              {agent.agent ? `${label(agent.agent)} · ${[agent.model, agent.model && agent.effort].filter(Boolean).join(' · ') || 'own config'}` : 'Lead · not a worker'}
            </span>
            <Badge variant={agent.active ? 'secondary' : 'outline'} className={cn('rounded-full text-[11px] font-normal', agent.active && 'bg-status-done/15 text-status-done')}>
              {agent.active ? 'Active' : 'Inactive'}
            </Badge>
          </button>
        ))}
      </div>
      <AgentDialog
        open={editing !== null}
        agent={editing?.agent ?? null}
        state={state}
        detected={detected}
        detectError={detectError}
        onRedetect={() => detect(true)}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          onState(next)
          setEditing(null)
        }}
      />
    </div>
  )
}

function TeamDialog({ open, team, state, onClose, onSaved }: { open: boolean; team: Team | null; state: TeamState; onClose: () => void; onSaved: (state: TeamState) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setName(team?.name ?? '')
    setDescription(team?.description ?? '')
    setPrompt(team ? state.prompts.teams[team.id] ?? '' : '')
    setBusy(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, team?.id])
  const members = team ? state.config.agents.filter((agent) => agent.team === team.id) : []
  const call = async (run: () => Promise<TeamState>, done: string) => {
    setBusy(true)
    try {
      onSaved(await run())
      toast.success(done)
    } catch (error) {
      toast.error(messageOf(error))
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{team ? `Edit ${team.name}` : 'Add team'}</DialogTitle>
          <DialogDescription>A group of agents with a shared prompt, put above each member's own prompt.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="team-name">Team name</Label>
            <Input id="team-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Web team" autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="team-description">Description</Label>
            <Input id="team-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this team owns" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="team-prompt">Team prompt</Label>
            <Textarea id="team-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-[160px] font-mono text-xs" placeholder="Rules every member follows…" spellCheck={false} />
          </div>
          {team && <p className="text-xs text-muted-foreground">{members.length ? `Members: ${members.map((agent) => agent.name).join(', ')}` : 'No members yet.'}</p>}
        </div>
        <DialogFooter className="sm:justify-between">
          {team ? (
            <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={busy || members.length > 0} onClick={() => call(() => request('team.deleteTeam', { id: team.id }), `Removed ${team.name}.`)}>
              {members.length ? 'Has members' : 'Delete'}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || !name.trim()}
              onClick={() => call(() => request('team.saveTeam', { team: { id: team?.id ?? '', name: name.trim(), description: description.trim() }, prompt, create: !team }), team ? `Saved ${name}.` : `Added ${name}.`)}
            >
              {busy && <Loader2 className="animate-spin" />}
              {team ? 'Save changes' : 'Create team'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TeamsPanel({ state, onState }: { state: TeamState; onState: (state: TeamState) => void }) {
  const [editing, setEditing] = useState<{ team: Team | null } | null>(null)
  return (
    <div>
      <PanelHeader
        title="Teams"
        description="Groups of agents that share a prompt."
        action={
          <Button onClick={() => setEditing({ team: null })}>
            <Plus /> Add team
          </Button>
        }
      />
      <div className="divide-y overflow-hidden rounded-lg border">
        {state.config.teams.map((team) => {
          const members = state.config.agents.filter((agent) => agent.team === team.id)
          return (
            <button key={team.id} type="button" onClick={() => setEditing({ team })} className="grid w-full grid-cols-[minmax(0,2fr)_auto_auto] items-center gap-4 px-4 py-3 text-left hover:bg-accent/50">
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{team.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{team.description || 'No description'}</span>
              </span>
              <span className="flex -space-x-1.5">
                {members.map((agent) => (
                  <AgentAvatar key={agent.id} persona={agent.id} agents={state.config.agents} className="ring-2 ring-background" />
                ))}
              </span>
              <Badge variant="outline" className="rounded-full text-[11px] font-normal text-muted-foreground">
                {state.prompts.teams[team.id] ? 'Has prompt' : 'No prompt'}
              </Badge>
            </button>
          )
        })}
        {!state.config.teams.length && <p className="px-4 py-6 text-center text-sm text-muted-foreground">No teams yet.</p>}
      </div>
      <TeamDialog
        open={editing !== null}
        team={editing?.team ?? null}
        state={state}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          onState(next)
          setEditing(null)
        }}
      />
    </div>
  )
}

function JevPanel({ status, onStatus }: { status: JevStatus | null; onStatus: (status: JevStatus) => void }) {
  const [token, setToken] = useState('')
  const [model, setModel] = useState(status?.model ?? 'jev-latest')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => setModel(status?.model ?? 'jev-latest'), [status?.model])
  const run = async (label: string, call: () => Promise<unknown>) => {
    setBusy(label)
    try {
      const result = await call()
      if (result && typeof result === 'object' && 'configured' in result) onStatus(result as JevStatus)
      if (result && typeof result === 'object' && 'message' in result) {
        const { ok, message } = result as { ok: boolean; message: string }
        if (ok) toast.success(message)
        else toast.error(message)
      } else toast.success(`${label}: done.`)
    } catch (error) {
      toast.error(messageOf(error))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="max-w-2xl">
      <PanelHeader title="Jev decisions" description="TypeSafe's Jev judges each card: the best agent for it, how well the assigned agent fits, and how urgent it is." />
      <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-xs">
        <Badge variant={status?.configured ? 'secondary' : 'outline'} className={cn('rounded-full font-normal', status?.configured && 'bg-status-done/15 text-status-done')}>
          {status?.configured ? 'Key saved' : 'No key'}
        </Badge>
        {status?.configured && <span className="text-muted-foreground">ends in {status.last4} · {status.protection === 'os-keyring' ? 'encrypted with the OS keyring' : status.protection}</span>}
        {status && <span className="text-muted-foreground">{status.pending ? `${status.pending} waiting` : status.lastAssessedAt ? `last assessed ${relativeTime(status.lastAssessedAt, Date.now())}` : 'nothing assessed yet'}</span>}
        {status?.lastError && <p className="basis-full text-destructive">{status.lastError}</p>}
      </div>
      <div className="grid gap-5">
        <div className="grid gap-1.5">
          <Label htmlFor="jev-key">TypeSafe API key</Label>
          <div className="flex gap-2">
            <Input id="jev-key" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={status?.configured ? `Saved key ends in ${status.last4}` : 'Paste your TypeSafe API key'} autoComplete="off" />
            <Button disabled={!token.trim() || busy !== null} onClick={() => run('Saving key', async () => { const next = await request('jev.setToken', { token }); setToken(''); return next })}>
              Save key
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Kept in the plugin's encrypted secrets; this page never sees it. Only the worker uses it, to call api.typesafe.ai.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!status?.configured || busy !== null} onClick={() => run('Testing', () => request('jev.test'))}>
            {busy === 'Testing' && <Loader2 className="animate-spin" />} Test connection
          </Button>
          <Button variant="outline" disabled={!status?.configured || busy !== null} onClick={() => run('Queueing', () => request('jev.assessAll', {}))}>
            Assess missing cards
          </Button>
          <Button variant="outline" disabled={!status?.configured || busy !== null} onClick={() => run('Queueing', () => request('jev.assessAll', { all: true }))}>
            Re-assess every card
          </Button>
          {status?.configured && (
            <Button variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={busy !== null} onClick={() => run('Removing key', () => request('jev.clearToken'))}>
              Remove key
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <div>
            <Label htmlFor="jev-auto">Assess automatically</Label>
            <p className="text-[11px] text-muted-foreground">When a card's brief, the agents or the prompts change.</p>
          </div>
          <Switch id="jev-auto" checked={status?.auto ?? true} onCheckedChange={(value) => orca.settings.set('jevAuto', value).then(() => status && onStatus({ ...status, auto: value }))} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="jev-model">Model</Label>
          <div className="flex gap-2">
            <Input id="jev-model" value={model} onChange={(event) => setModel(event.target.value)} />
            <Button variant="outline" onClick={() => run('Saving model', () => orca.settings.set('jevModel', model.trim() || 'jev-latest'))}>
              Save
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">jev-latest follows the newest stable Jev.</p>
        </div>
        <div className="space-y-3 border-t pt-4 text-[13px] text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">What is sent.</span> One request per card, with all its questions: its title and brief (up to 12,000 characters), and each active worker's name, role and the first 900 characters of its prompt.
          </p>
          <p>
            <span className="font-medium text-foreground">What comes back.</span> The best agent with a probability for each, how well every active agent fits (Poor / Partial / Good / Strong), the best reviewer other than the implementer, and a P1–P3 suggestion. Cached until the card or the agents change.
          </p>
          <p>
            <span className="font-medium text-foreground">Cost.</span> TypeSafe charges per input token ($0.042 per million for Jev 1.14, per its docs on 2026-11-08); a card is a few thousand tokens.
          </p>
        </div>
      </div>
    </div>
  )
}

function BoardPanel({ folder, onResetLayout }: { folder: string; onResetLayout: () => void }) {
  const [seconds, setSeconds] = useState('60')
  const [autoReview, setAutoReview] = useState(true)
  useEffect(() => {
    orca.settings.get('refreshSeconds').then((value) => typeof value === 'number' && setSeconds(String(value)))
    orca.settings.get('autoReview').then((value) => setAutoReview(value !== false))
  }, [])
  return (
    <div className="max-w-2xl">
      <PanelHeader title="Board" description="Where the board reads from and how often it refreshes." />
      <div className="grid gap-5">
        <div className="grid gap-1.5">
          <Label>Team folder</Label>
          <code className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">{folder || '—'}</code>
          <p className="text-[11px] text-muted-foreground">scripts/board.ps1 decides the columns (README, "How cards move"). Change the folder in Orca → Settings → Plugins → Orchestra Board.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="refresh">Auto refresh (seconds)</Label>
          <div className="flex gap-2">
            <Input id="refresh" type="number" min={15} max={3600} value={seconds} onChange={(event) => setSeconds(event.target.value)} className="w-32" />
            <Button
              variant="outline"
              onClick={() =>
                orca.settings
                  .set('refreshSeconds', Math.max(15, Math.min(3600, Number(seconds) || 60)))
                  .then(() => toast.success('Saved.'))
                  .catch((error) => toast.error(messageOf(error)))
              }
            >
              Save
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">The board also refreshes when tasks/, agents/ or teams/ change, and when an agent changes status.</p>
        </div>
        <div className="grid gap-1.5">
          <Label>How cards move</Label>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Backlog → In Progress starts the assignee in Orca right away. With no assignee, Jev picks the agent that fits best.</li>
            <li>When the agent reports, the card goes to Under Review and Jev picks a reviewer, never the implementer.</li>
            <li>You decide Done (merged, PR open or closed), or send it back to In Progress with changes.</li>
          </ul>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
          <div>
            <Label htmlFor="auto-review">Start a review automatically</Label>
            <p className="text-[11px] text-muted-foreground">For cards the board started, once the agent reports. Needs a Jev key. Off: use Review in the card.</p>
          </div>
          <Switch
            id="auto-review"
            checked={autoReview}
            onCheckedChange={(value) =>
              orca.settings
                .set('autoReview', value)
                .then(() => setAutoReview(value))
                .catch((error) => toast.error(messageOf(error)))
            }
          />
        </div>
        <div>
          <Button variant="outline" onClick={onResetLayout}>
            Reset Flow layout
          </Button>
        </div>
      </div>
    </div>
  )
}

export function SettingsView({ tab, onTab, folder, onTeamChanged, onResetLayout }: { tab: SettingsTab; onTab: (tab: SettingsTab) => void; folder: string; onTeamChanged: () => void; onResetLayout: () => void }) {
  const [state, setState] = useState<TeamState | null>(null)
  const [error, setError] = useState('')
  const [jev, setJev] = useState<JevStatus | null>(null)
  useEffect(() => {
    request('team.load')
      .then(setState)
      .catch((failure) => setError(messageOf(failure)))
    request('jev.status').then(setJev).catch(() => undefined)
    const subscription = orca.plugin.on('jev.changed', (status) => setJev(status))
    return () => subscription.dispose()
  }, [])
  const update = (next: TeamState) => {
    setState(next)
    onTeamChanged()
  }
  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)]">
      <nav className="flex gap-1 border-b p-3 md:flex-col md:border-r md:border-b-0 md:p-4" aria-label="Settings sections">
        <h2 className="hidden px-2 pb-2 text-sm font-semibold md:block">Settings</h2>
        {TABS.map((entry) => (
          <Button key={entry.id} variant={tab === entry.id ? 'secondary' : 'ghost'} size="sm" className="justify-start" onClick={() => onTab(entry.id)}>
            <entry.icon /> {entry.label}
          </Button>
        ))}
      </nav>
      <div className="min-h-0 overflow-y-auto px-6 py-6 md:px-8">
        {tab === 'jev' ? (
          <JevPanel status={jev} onStatus={setJev} />
        ) : tab === 'board' ? (
          <BoardPanel folder={folder} onResetLayout={onResetLayout} />
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !state ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tab === 'teams' ? (
          <TeamsPanel state={state} onState={update} />
        ) : (
          <AgentsPanel state={state} onState={update} />
        )}
      </div>
    </div>
  )
}
