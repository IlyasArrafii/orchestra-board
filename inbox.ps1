<#
Orchestra Board's own terminal. Orca binds the board's Run to it, so agents the board starts report here
instead of to a coordinator session. The board follows those agents by their task status and answers
their questions itself; this window only takes the wake-up lines Orca types, so they do nothing.

Closing this tab is fine: the board opens a new one at the next start and moves its Run there.
#>
$Host.UI.RawUI.WindowTitle = 'Orchestra Board'
Write-Host 'Orchestra Board' -ForegroundColor Cyan
Write-Host 'Agents started from Orchestra Board report to this terminal. The board reads their status and'
Write-Host 'answers their questions itself, so there is nothing to do here. You can close this tab; the'
Write-Host 'board opens a new one when it next starts an agent.'
while ($true) {
  $line = [Console]::ReadLine()
  if ($null -eq $line) { Start-Sleep -Seconds 1 }
}
