import { useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Agent, DetectedAgent, TeamState } from '@protocol'
import { slugify } from '@shared/model'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { messageOf, request } from '@/lib/orca'
import { Combobox } from '../combobox'

const LEAD = '__lead'
const DEFAULT = '__default'

/** Add or edit an agent. The ID comes from the name (it names the agent's files); the colour is random. */
export function AgentDialog({
  open,
  agent,
  state,
  detected,
  detectError,
  onRedetect,
  onClose,
  onSaved
}: {
  open: boolean
  agent: Agent | null
  state: TeamState
  detected: DetectedAgent[]
  detectError: string | null
  onRedetect: () => void
  onClose: () => void
  onSaved: (state: TeamState) => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [team, setTeam] = useState<string>('')
  const [cli, setCli] = useState<string>(LEAD)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<string>(DEFAULT)
  const [active, setActive] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(agent?.name ?? '')
    setRole(agent?.role ?? '')
    setTeam(agent?.team ?? state.config.teams[0]?.id ?? '')
    const startCli = agent ? agent.agent ?? LEAD : detected.find((entry) => entry.installed && entry.enabled && entry.isDefault)?.id ?? 'claude'
    const startModels = detected.find((entry) => entry.id === startCli)?.models ?? []
    setCli(startCli)
    // A new agent starts on the CLI's default model, so Effort has levels to offer.
    setModel(agent ? agent.model ?? '' : startModels.find((entry) => entry.isDefault)?.id ?? startModels[0]?.id ?? '')
    setEffort(agent?.effort ?? DEFAULT)
    setActive(agent?.active ?? true)
    setPrompt(agent ? state.prompts.agents[agent.id] ?? '' : '')
    setBusy(false)
    // Reset only when the dialog opens for another agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent?.id])

  const available = detected.filter((entry) => entry.installed && entry.enabled)
  const chosen = detected.find((entry) => entry.id === cli)
  const takes = cli === LEAD ? 'none' : chosen?.takes ?? 'model+effort'
  const models = chosen?.models ?? []
  const pickedModel = models.find((entry) => entry.id === model)
  const efforts = takes === 'model+effort' ? pickedModel?.efforts ?? [] : []

  // A new CLI brings its own models: keep the model only if the new CLI lists it, else use its default.
  const changeCli = (next: string) => {
    setCli(next)
    const nextModels = detected.find((entry) => entry.id === next)?.models ?? []
    if (!nextModels.some((entry) => entry.id === model)) setModel(nextModels.find((entry) => entry.isDefault)?.id ?? nextModels[0]?.id ?? '')
    setEffort(DEFAULT)
  }
  const changeModel = (next: string) => {
    setModel(next)
    const nextEfforts = models.find((entry) => entry.id === next)?.efforts ?? []
    if (!nextEfforts.some((entry) => entry.value === effort)) setEffort(DEFAULT)
  }

  const roleOptions = useMemo(() => [...new Set([...state.config.roles, ...(role ? [role] : [])])].map((value) => ({ value, label: value })), [state.config.roles, role])
  const modelOptions = models.map((entry) => ({ value: entry.id, label: entry.label, hint: entry.isDefault ? 'default' : entry.id !== entry.label ? entry.id : undefined }))
  const id = agent?.id ?? slugify(name, 28)
  const specs = agent ? state.specCounts[agent.id] ?? 0 : 0

  const save = async () => {
    setBusy(true)
    try {
      const payload: Agent = {
        id: agent?.id ?? '',
        name: name.trim(),
        role: role.trim(),
        team: team || null,
        agent: cli === LEAD ? null : cli,
        model: takes === 'none' ? null : model.trim() || null,
        effort: takes === 'model+effort' && effort !== DEFAULT && model.trim() ? effort : null,
        active,
        color: agent?.color ?? '',
        note: agent?.note ?? ''
      }
      const next = await request('team.saveAgent', { agent: payload, prompt, create: !agent })
      toast.success(agent ? `Saved ${payload.name}.` : `Added ${payload.name}.`)
      onSaved(next)
    } catch (error) {
      toast.error(messageOf(error))
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!agent) return
    setBusy(true)
    try {
      const next = await request('team.deleteAgent', { id: agent.id })
      toast.success(`Removed ${agent.name}. The prompt is kept in agents/.trash/.`)
      onSaved(next)
    } catch (error) {
      toast.error(messageOf(error))
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : 'Add agent'}</DialogTitle>
          <DialogDescription>Configure an AI agent for this team.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
          <div className="grid gap-1.5">
            <Label htmlFor="agent-name">Agent name</Label>
            <Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Code Reviewer Bot" autoFocus />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Role</Label>
              <Combobox value={role} options={roleOptions} onChange={setRole} placeholder="Select a role…" searchPlaceholder="Type to search or create…" creatable />
            </div>
            <div className="grid gap-1.5">
              <Label>Team</Label>
              <Select value={team || '__none'} onValueChange={(value) => setTeam(value === '__none' ? '' : value)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">No team</SelectItem>
                  {state.config.teams.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label>Agent CLI</Label>
              <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onRedetect}>
                <RefreshCw /> Detect again
              </Button>
            </div>
            <Select value={cli} onValueChange={changeCli}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {available.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                    <span className="text-muted-foreground">
                      {entry.isDefault ? '· Orca default' : ''} {entry.models.length ? `· ${entry.models.length} models` : ''}
                    </span>
                  </SelectItem>
                ))}
                {cli !== LEAD && !available.some((entry) => entry.id === cli) && (
                  <SelectItem value={cli}>
                    {chosen?.label ?? cli} <span className="text-muted-foreground">· not detected in Orca</span>
                  </SelectItem>
                )}
                <SelectSeparator />
                <SelectItem value={LEAD}>Lead · never started as a worker</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {detectError ? `Could not read Orca's agents: ${detectError}` : `${available.length} agents detected in Orca (installed and enabled).`}
            </p>
          </div>
          {cli !== LEAD && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Model</Label>
                {takes === 'none' ? (
                  <p className="flex h-9 items-center rounded-md border border-dashed px-3 text-xs text-muted-foreground">Uses {chosen?.label ?? cli}'s own config</p>
                ) : models.length ? (
                  <Combobox value={model} options={modelOptions} onChange={changeModel} placeholder="Select a model…" searchPlaceholder="Search models…" />
                ) : (
                  <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model id" />
                )}
              </div>
              <div className="grid gap-1.5">
                <Label>Effort</Label>
                {efforts.length ? (
                  <Select value={effort} onValueChange={setEffort}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT}>Default{pickedModel?.defaultEffort ? ` (${pickedModel.defaultEffort})` : ''}</SelectItem>
                      {efforts.map((entry) => (
                        <SelectItem key={entry.value} value={entry.value}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="flex h-9 items-center rounded-md border border-dashed px-3 text-xs text-muted-foreground">
                    {takes === 'model+effort' ? 'Pick a model first' : `${chosen?.label ?? cli} takes no effort level`}
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <Label htmlFor="agent-active">Active</Label>
              <p className="text-[11px] text-muted-foreground">Inactive agents are never suggested by Jev or offered as assignees.</p>
            </div>
            <Switch id="agent-active" checked={active} onCheckedChange={setActive} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-prompt">Prompt</Label>
            <Textarea
              id="agent-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={'# Name — Role\n\nYou are …'}
              className="min-h-[260px] font-mono text-xs leading-relaxed"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">{id ? `Saved to agents/${id}.md and put above every brief for this agent.` : 'Saved to agents/<name>.md and put above every brief for this agent.'}</p>
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          {agent ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={busy || specs > 0} title={specs ? `${agent.name} has ${specs} specs in tasks/. Deactivate instead.` : undefined}>
                  <Trash2 /> {specs ? `Has ${specs} specs` : 'Delete'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
                  <AlertDialogDescription>The agent leaves team.json and its prompt moves to agents/.trash/.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={remove}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !name.trim() || !role.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              {agent ? 'Save changes' : 'Create agent'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
