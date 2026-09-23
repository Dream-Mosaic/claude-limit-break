# clb6-snap.ps1 -Label <label> [-SessionId <id>] [-Log <path>]
# Appends a timestamped snapshot of the live Claude processes to the log, so the
# pid observations do not depend on anyone remembering them. Read-only: it lists
# processes, it does not touch any session.
#
# The log defaults to the temp directory, not next to this script: the script
# lives in the repo and its output does not belong there.
param(
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$SessionId,
  [string]$Log = (Join-Path $env:TEMP 'clb6-log.txt')
)

$log = $Log
$rows = (claude agents --json | Out-String | ConvertFrom-Json)
if ($SessionId) { $rows = $rows | Where-Object sessionId -eq $SessionId }

"=== $Label  $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')" | Add-Content $log
if ($rows) {
  $rows | ForEach-Object { "    pid=$($_.pid) kind=$($_.kind) status=$($_.status) session=$($_.sessionId) cwd=$($_.cwd)" } | Add-Content $log
} else {
  '    (no matching live process)' | Add-Content $log
}
Get-Content $log -Tail 6
