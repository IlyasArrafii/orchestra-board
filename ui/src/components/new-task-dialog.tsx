import { useEffect, useState } from 'react'
import { CircleDashed, Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { Agent } from '@protocol'
import { slugify } from '@shared/model'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { messageOf, request } from '@/lib/orca'
import { AgentAvatar, PriorityIcon } from './icons'

type Priority = 'P1' | 'P2' | 'P3'

/** A new spec in tasks/, which lands in Backlog. Jev can pick the agent now, or when the task starts. */
export function NewTaskDialog({ open, agents, jevReady, onClose, onCreated }: { open: boolean; agents: Agent[]; jevReady: boolean; onClose: () => void; onCreated: (key: string) => void }) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<Priority>('P2')
  const [assignee, setAssignee] = useState('later')
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const workers = agents.filter((agent) => agent.agent && agent.active)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setPriority('P2')
    setAssignee(jevReady ? 'jev' : 'later')
    setBusy(false)
    request('task.template')
      .then((result) => setBrief(result.brief))
      .catch(() => setBrief('## Goal\n\n## Context\n\n## Acceptance criteria\n- [ ] '))
  }, [open, jevReady])

  const slug = slugify(title)
  const prefix = assignee === 'jev' || assignee === 'later' ? 'unassigned' : assignee

  const create = async () => {
    setBusy(true)
    try {
      const result = await request('task.create', { title, priority, assignee, brief })
      toast.success(result.message)
      onCreated(result.key)
    } catch (error) {
      toast.error(messageOf(error))
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>Writes a spec in tasks/. It waits in Backlog until you drag it to In Progress.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Add the login endpoint" autoFocus />
            {slug && <p className="text-[11px] text-muted-foreground">File: tasks/{prefix}-{slug}.md</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(value) => setPriority(value as Priority)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['P1', 'P2', 'P3'] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      <PriorityIcon priority={value} /> {value} · {value === 'P1' ? 'Urgent' : value === 'P2' ? 'Normal' : 'Can wait'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Assignee</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jev" disabled={!jevReady}>
                    <Sparkles /> Jev picks now{!jevReady && ' (add a token in Settings)'}
                  </SelectItem>
                  <SelectItem value="later">
                    <CircleDashed /> Decide at start
                  </SelectItem>
                  <SelectSeparator />
                  {workers.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      <AgentAvatar persona={agent.id} agents={agents} className="size-4 text-[9px]" /> {agent.name}
                      <span className="text-muted-foreground">· {agent.role}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-brief">Brief</Label>
            <Textarea id="task-brief" value={brief} onChange={(event) => setBrief(event.target.value)} className="min-h-[300px] font-mono text-xs leading-relaxed" spellCheck={false} />
            <p className="text-[11px] text-muted-foreground">The agent sees only this spec, so give it the context it needs. The agent's prompt is put above it.</p>
            {assignee === 'later' && <p className="text-[11px] text-muted-foreground">With no assignee, Jev picks the agent that fits best when you drag the card to In Progress.</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={create} disabled={busy || !slug}>
            {busy && <Loader2 className="animate-spin" />}
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
