<#
The Orchestra Board columns: Backlog, In Progress, Under Review, Done.
Built from the specs in <team folder>/tasks and the Orca tasks. Read-only: it calls run-list and task-list and
never `check`, because `check` marks messages as read.

  pwsh scripts/board.ps1 -TeamFolder <path>        every column; Done shows the newest only
  pwsh scripts/board.ps1 -TeamFolder <path> -All   every Done card
  pwsh scripts/board.ps1 -TeamFolder <path> -Json  every item with its details, as JSON (what the plugin reads)

-TeamFolder defaults to the folder this script is in. Column rules: README, "How cards move".
#>
param([switch]$All, [switch]$Json, [string]$TeamFolder = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$TeamFolder = (Resolve-Path -LiteralPath $TeamFolder).Path
$TasksDir = Join-Path $TeamFolder 'tasks'
$TeamFile = Join-Path $TeamFolder 'team.json'
$DoneShown = 5
# Agents come from team.json (edited in Orchestra Board → Settings); without it, from the agents/*.md file names.
$AgentIds = @(Get-ChildItem -Path (Join-Path $TeamFolder 'agents') -Filter '*.md' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.BaseName.ToLower() })
$AgentNames = @{}
if (Test-Path $TeamFile) {
  try {
    $teamAgents = @((Get-Content -Raw -Encoding utf8 $TeamFile | ConvertFrom-Json).agents)
    $AgentIds = @($teamAgents | ForEach-Object { "$($_.id)".ToLower() } | Where-Object { $_ })
    foreach ($agent in $teamAgents) { $AgentNames["$($agent.id)".ToLower()] = "$($agent.name)" }
  } catch { }
}
# One English label per state; `state` is the stable code the plugin styles by.
$StateLabels = @{
  'not-started'       = 'Not started'
  'start-requested'   = 'Start requested'
  'queued-deps'       = 'Queued: waiting on dependencies'
  'queued-ready'      = 'Queued: ready to start'
  'working'           = 'Working'
  'blocked'           = 'Blocked by decision gate'
  'cancelled'         = 'Cancelled'
  'failed'            = 'Failed: needs a look'
  'reviewing'         = 'In review'
  'reviewed'          = 'Reviewed'
  'review-done'       = 'Review delivered'
  'failed-resolved'   = 'Failed, resolved'
  'inline-done'       = 'Inline: reviewed in parent spec'
  'approved'          = 'Approved'
  'merged'            = 'Merged'
  'closed'            = 'Closed'
  'changes-requested' = 'Changes requested'
  'interim'           = 'Interim review'
  'not-reviewed'      = 'Not reviewed'
}
$BriefLimit = 30000
$PriorityRank = @{ P1 = 1; P2 = 2; P3 = 3 }
$DoneVerdicts = 'Approved', 'Merged', 'Closed'
$Columns = 'Backlog', 'In Progress', 'Under Review', 'Done'
$NameWidth = 44
# A worker report can be long; the board only needs enough of it to trace the work.
$ReportBodyLimit = 20000

function Invoke-Orca {
  param([Parameter(Mandatory)][string[]]$Arguments)
  # The exit code decides failure; stderr lines must not stop the script on their own.
  $ErrorActionPreference = 'Continue'
  $lines = & orca @Arguments --json 2>&1
  $stdout = ($lines | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
  $stderr = ($lines | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "orca $($Arguments -join ' ') exited $LASTEXITCODE. $stderr $stdout".Trim() }
  $parsed = $stdout | ConvertFrom-Json
  if (-not $parsed.ok) { throw "orca $($Arguments -join ' ') did not answer ok: $stdout" }
  $parsed.result
}

# Each task comes back with the objective of its Run.
function Get-OrcaTasks {
  $tasks = [System.Collections.Generic.List[object]]::new()
  $cursor = $null
  do {
    $arguments = @('orchestration', 'run-list', '--full')
    if ($cursor) { $arguments += '--cursor', $cursor }
    $page = Invoke-Orca $arguments
    foreach ($run in @($page.runs | Where-Object { $_ -and -not $_.legacy })) {
      foreach ($task in @((Invoke-Orca 'orchestration', 'task-list', '--run', $run.id, '--full').tasks | Where-Object { $_ })) {
        $tasks.Add([pscustomobject]@{ Task = $task; RunObjective = "$($run.objective)" })
      }
    }
    $previous = $cursor
    $cursor = $page.nextCursor
  } while ($cursor -and $cursor -ne $previous)
  $tasks
}

# Orca mixes "2026-11-07 16:41:23" (UTC, no zone) and ISO strings that ConvertFrom-Json may already turn into DateTime.
function Get-UtcKey($Value) {
  if ($null -eq $Value -or "$Value" -eq '') { return '' }
  $styles = [Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal'
  $date = if ($Value -is [datetime]) { $Value.ToUniversalTime() } else { [datetime]::Parse("$Value", [Globalization.CultureInfo]::InvariantCulture, $styles) }
  $date.ToString('yyyy-MM-ddTHH:mm:ss')
}

function Get-UtcIso($Value) {
  $key = Get-UtcKey $Value
  if ($key) { "${key}Z" } else { $null }
}

function Get-ReviewText([string]$Text) {
  $heading = [regex]::Match($Text, '(?m)^## Review\s*$')
  if ($heading.Success) { $Text.Substring($heading.Index + $heading.Length) } else { $null }
}

# The last verdict line under "## Review" decides; lines such as "Rizki — …" or "Follow-up — …" are notes, not verdicts.
function Get-Verdict([string]$Text) {
  $review = Get-ReviewText $Text
  if ($null -eq $review) { return $null }
  $verdict = $null
  foreach ($line in $review.Split("`n")) {
    if ($line -cmatch '^(Approved|Merged|Closed|Changes requested|Interim|Rework)\b') { $verdict = $Matches[1] }
  }
  # "Rework" (written by Orchestra Board when the agent restarts after "Changes requested") opens a new round.
  if ($verdict -eq 'Rework') { return $null }
  $verdict
}

function Read-Spec([System.IO.FileInfo]$File) {
  $text = (Get-Content -Raw -Encoding utf8 $File.FullName) -replace "`r`n", "`n"
  $persona, $name = $File.BaseName -split '-', 2
  # tasks/unassigned-<name>.md (or any prefix that is not an agent) is a spec with no assignee yet.
  if ($AgentIds -notcontains $persona.ToLower()) { $persona = '-' }
  $review = Get-ReviewText $text
  $beforeReview = if ($null -ne $review) { $text.Substring(0, $text.Length - $review.Length) } else { $text }
  $startRequested = if ($beforeReview -match '(?m)^\*\*Start requested:\*\*\s*(.+)$') { $Matches[1].Trim() } else { $null }
  # A review spec written by Orchestra Board names the card it reviews and the round.
  $reviews = $null
  $reviewRound = $null
  if ($beforeReview -match '(?m)^\*\*Reviews:\*\*\s*(tasks/[^\s]+\.md)(?:\s*\(round\s*(\d+)\))?') {
    $reviews = $Matches[1]
    $reviewRound = if ($Matches[2]) { [int]$Matches[2] } else { 1 }
  }
  # Assigned outside `if`: an `if` expression unrolls a one-element array into a plain string.
  $reviewLines = @()
  if ($null -ne $review) { $reviewLines = @($review.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  [pscustomobject]@{
    File        = $File
    Persona     = $persona
    Name        = if ($name) { $name } else { $File.BaseName }
    Priority    = if ($text -match '(?m)^\*\*Priority:\*\*\s*(P[1-3])\b') { $Matches[1].ToUpper() } else { '-' }
    Heading     = if ($text -match '(?m)^# Task:.*$') { $Matches[0].TrimEnd() } else { $null }
    Text        = $text
    Verdict     = Get-Verdict $text
    ReviewLines = $reviewLines
    StartRequested = $startRequested
    Reviews     = $reviews
    ReviewRound = $reviewRound
    Modified    = $File.LastWriteTimeUtc
  }
}

function Get-TaskResult($Task) {
  $raw = "$($Task.result)".Trim()
  if (-not $raw.StartsWith('{')) { return $null }
  try { $raw | ConvertFrom-Json } catch { $null }
}

function Test-Cancelled($Task) {
  $result = "$($Task.result)".Trim()
  -not $result.StartsWith('{') -and $result -match 'cancel'
}

# Returns column and state code.
function Get-Placement($Task, $Spec) {
  if (-not $Task) {
    if ($Spec.Verdict -in $DoneVerdicts) { return 'Done', $Spec.Verdict.ToLower() }
    # Version 0.3 of the board wrote this line to ask the coordinator to start the card.
    if ($Spec.StartRequested) { return 'In Progress', 'start-requested' }
    return 'Backlog', 'not-started'
  }
  switch ($Task.status) {
    'pending' { return 'Backlog', 'queued-deps' }
    'ready' { return 'Backlog', 'queued-ready' }
    'dispatched' { return 'In Progress', 'working' }
    'blocked' { return 'In Progress', 'blocked' }
    'failed' {
      if (Test-Cancelled $Task) { return 'Done', 'cancelled' }
      if ($Spec -and $Spec.Verdict -in $DoneVerdicts) { return 'Done', 'failed-resolved' }
      return 'Under Review', 'failed'
    }
    'completed' {
      if (-not $Spec) { return 'Done', 'inline-done' }
      if ($Spec.Verdict -in $DoneVerdicts) { return 'Done', $Spec.Verdict.ToLower() }
      # A finished review is done; its verdict shows on the card it reviews.
      if ($Spec.Reviews -and -not $Spec.Verdict) { return 'Done', 'review-done' }
      if ($Spec.Verdict -eq 'Changes requested') { return 'In Progress', 'changes-requested' }
      if ($Spec.Verdict -eq 'Interim') { return 'Under Review', 'interim' }
      return 'Under Review', 'not-reviewed'
    }
    default { return 'In Progress', 'unknown' }
  }
}

function Get-StateLabel([string]$State, $Task) {
  if ($State -eq 'unknown') { return "Orca status: $($Task.status)" }
  $StateLabels[$State]
}

# The brief is what new-task.ps1 puts after the first `---` line, below the persona (and team) prompt.
function Get-Brief([string]$Text, [switch]$WholeText) {
  $separator = [regex]::Match($Text, '(?m)^---\s*$')
  $brief = if ($separator.Success -and -not $WholeText) { $Text.Substring($separator.Index + $separator.Length) } else { $Text }
  $review = [regex]::Match($brief, '(?m)^## Review\s*$')
  if ($review.Success) { $brief = $brief.Substring(0, $review.Index) }
  $brief = $brief.Trim()
  if ($brief.Length -gt $BriefLimit) { $brief = $brief.Substring(0, $BriefLimit) + "`n…" }
  $brief
}

function New-Item-Record($Entry, $Spec) {
  $task = $Entry.Task
  $column, $state = Get-Placement $task $Spec
  $label = Get-StateLabel $state $task
  $result = if ($task) { Get-TaskResult $task } else { $null }
  $deps = @()
  if ($task -and "$($task.deps)".Trim()) { try { $deps = @("$($task.deps)" | ConvertFrom-Json) } catch { $deps = @() } }
  $body = "$($result.body)"
  if ($body.Length -gt $ReportBodyLimit) { $body = $body.Substring(0, $ReportBodyLimit) + "`n…" }

  if ($Spec) {
    $persona = $Spec.Persona
    $title = if ($Spec.Heading) { $Spec.Heading -replace '^# Task:\s*', '' } else { $Spec.Name }
  } else {
    $taskTitle = "$($task.task_title)"
    $persona = if ($taskTitle -match '^(\w+):' -and $AgentIds -contains $Matches[1].ToLower()) { $Matches[1].ToLower() } else { '-' }
    $title = $taskTitle
  }

  [pscustomobject]@{
    key          = if ($Spec) { "spec:$($Spec.File.BaseName)" } else { "task:$($task.id)" }
    column       = $column
    state        = $state
    label        = $label
    # An inline spec has no persona above a `---` line, so any `---` in it is just a divider.
    brief        = if ($Spec) { Get-Brief $Spec.Text } else { Get-Brief ("$($task.spec)" -replace "`r`n", "`n") -WholeText }
    priority     = if ($Spec) { $Spec.Priority } else { '-' }
    persona      = $persona
    name         = if ($Spec) { $Spec.Name } else { $title }
    title        = $title
    specFile     = if ($Spec) { "tasks/$($Spec.File.Name)" } else { $null }
    startRequested = if ($Spec) { $Spec.StartRequested } else { $null }
    reviews      = if ($Spec) { $Spec.Reviews } else { $null }
    reviewRound  = if ($Spec) { $Spec.ReviewRound } else { $null }
    reviewer     = $null
    specModified = if ($Spec) { Get-UtcIso $Spec.Modified } else { $null }
    taskId       = $task.id
    olderTaskIds = @($Entry.Older)
    runId        = $task.run_id
    runObjective = if ($task) { $Entry.RunObjective } else { $null }
    status       = $task.status
    deps         = $deps
    createdAt    = if ($task) { Get-UtcIso $task.created_at } else { $null }
    completedAt  = if ($task) { Get-UtcIso $task.completed_at } else { $null }
    time         = if ($task) { Get-UtcKey ($task.completed_at ?? $task.created_at) } else { Get-UtcKey $Spec.Modified }
    report       = if ($result) {
      [pscustomobject]@{
        outcome       = $result.outcome
        subject       = $result.subject
        body          = $body
        filesModified = @($result.filesModified | Where-Object { $_ })
      }
    } else { $null }
    review       = if ($Spec -and $Spec.ReviewLines.Count) { [pscustomobject]@{ verdict = $Spec.Verdict; lines = @($Spec.ReviewLines) } } else { $null }
  }
}

function Format-Cell([string]$Text, [int]$Width) {
  if ($Text.Length -le $Width) { return $Text.PadRight($Width) }
  $Text.Substring(0, $Width - 3) + '...'
}

$tasks = @(Get-OrcaTasks | ForEach-Object {
    [pscustomobject]@{
      Task         = $_.Task
      RunObjective = $_.RunObjective
      Spec         = ("$($_.Task.spec)" -replace "`r`n", "`n").TrimEnd()
      Used         = $false
    }
  })

$items = [System.Collections.Generic.List[object]]::new()

foreach ($file in @(Get-ChildItem -Path $TasksDir -Filter '*.md' -File -ErrorAction SilentlyContinue)) {
  $spec = Read-Spec $file
  # Orca keeps the spec as it was at start; reviews are only appended ("## Review"), so the file starts with it.
  $hits = @($tasks | Where-Object { $_.Spec -and $spec.Text.StartsWith($_.Spec, [StringComparison]::Ordinal) })
  # Fallback for a spec edited after start, e.g. a changed Priority line.
  if (-not $hits -and $spec.Heading) { $hits = @($tasks | Where-Object { ($_.Spec -split "`n") -ccontains $spec.Heading }) }
  $hits | ForEach-Object { $_.Used = $true }
  $sorted = @($hits | Sort-Object { Get-UtcKey $_.Task.created_at })
  $latest = $sorted | Select-Object -Last 1
  $entry = [pscustomobject]@{
    Task         = $latest.Task
    RunObjective = $latest.RunObjective
    Older        = @($sorted | Select-Object -SkipLast 1 | ForEach-Object { $_.Task.id })
  }
  $items.Add((New-Item-Record $entry $spec))
}

# Tasks started with an inline --spec have no file, so they carry no Priority and no "## Review".
foreach ($task in @($tasks | Where-Object { -not $_.Used })) {
  $entry = [pscustomobject]@{ Task = $task.Task; RunObjective = $task.RunObjective; Older = @() }
  $items.Add((New-Item-Record $entry $null))
}

# Link each review card to the card it reviews. A review counts for the card's current round (one round
# per task run); while it runs the card reads "In review: <name>", once it is back "Reviewed by <name>".
foreach ($reviewItem in @($items | Where-Object { $_.reviews })) {
  $original = $items | Where-Object { $_.specFile -eq $reviewItem.reviews } | Select-Object -First 1
  if (-not $original) { continue }
  $round = if ($original.taskId) { @($original.olderTaskIds).Count + 1 } else { 1 }
  if ($reviewItem.reviewRound -ne $round) { continue }
  $previous = $original.reviewer
  if ($previous -and $previous.key -gt $reviewItem.key) { continue }
  $original.reviewer = [pscustomobject]@{ key = $reviewItem.key; persona = $reviewItem.persona; round = $round; status = $reviewItem.status }
  if ($original.column -eq 'Under Review' -and $original.state -in 'not-reviewed', 'reviewing', 'reviewed') {
    $name = if ($AgentNames[$reviewItem.persona]) { $AgentNames[$reviewItem.persona] } else { $reviewItem.persona }
    if ($reviewItem.status -eq 'completed') {
      $original.state = 'reviewed'
      $original.label = "Reviewed by $name"
    } else {
      $original.state = 'reviewing'
      $original.label = "In review: $name"
    }
  }
}

if ($Json) {
  [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    teamFolder  = $TeamFolder
    columns     = $Columns
    items       = @($items)
  } | ConvertTo-Json -Depth 8 -Compress
  return
}

foreach ($column in $Columns) {
  $rows = @($items | Where-Object column -EQ $column)
  if ($column -eq 'Done') {
    $rows = @($rows | Sort-Object time -Descending)
  } else {
    $rows = @($rows | Sort-Object { $PriorityRank[$_.priority] ?? 9 }, time)
  }
  $hidden = 0
  if ($column -eq 'Done' -and -not $All -and $rows.Count -gt $DoneShown) {
    $hidden = $rows.Count - $DoneShown
    $rows = @($rows | Select-Object -First $DoneShown)
  }
  $header = "$column ($($rows.Count + $hidden))"
  if ($hidden) { $header += "  $DoneShown newest; -All shows every one" }
  Write-Output $header
  if (-not $rows) { Write-Output '  (empty)' }
  foreach ($row in $rows) {
    $persona = if ($row.persona -eq '-') { '-' } else { (Get-Culture).TextInfo.ToTitleCase($row.persona) }
    $line = '  {0,-3} {1,-7}{2} {3}' -f $row.priority, $persona, (Format-Cell $row.name $NameWidth), $row.label
    if ($row.taskId) { $line += "  $($row.taskId)" }
    Write-Output $line
  }
  Write-Output ''
}
