# Smoke kit, part 1: packages this repo into a .vsix (or uses -Vsix), installs it and the Claude Code extension into
# an isolated VS Code (own profile and extensions folder), and opens a window.
#   .\launch.ps1                 -> window on <tmp>\lb-smoke: watches A, B and W (the R rows, L7, L15)
#   .\launch.ps1 -Folder a       -> window on A's folder, so a Claude panel there can open session A (the panel rows)
#   .\launch.ps1 -Folder a -Second  -> another window in the same VS Code, without reinstalling (L9)
# Uses your real Claude login. Each window watches only its own folder.
param([string]$Vsix, [ValidateSet('root', 'a', 'w')][string]$Folder = 'root', [switch]$Second)
$ErrorActionPreference = 'Stop'
$kit = Join-Path ([IO.Path]::GetTempPath()) 'lb-smoke-kit\real'
$ws = Join-Path ([IO.Path]::GetTempPath()) 'lb-smoke'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$statePath = Join-Path $kit 'state.json'
if (-not (Test-Path $statePath)) { Write-Error "Run 'node setup.js' first."; exit 1 }
$state = Get-Content $statePath -Raw | ConvertFrom-Json
$target = switch ($Folder) { 'root' { $ws } 'a' { $state.sessions.a.cwd } 'w' { $state.sessions.w.cwd } }
if (-not $target -or -not (Test-Path $target)) { Write-Error "No folder for '$Folder' in state.json; run 'node setup.js' again."; exit 1 }

$prof = Join-Path $kit 'profile'
$exts = Join-Path $kit 'extensions'
Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue

if (-not $Second) {
  if (-not $Vsix) {
    $Vsix = Join-Path $kit 'limit-break.vsix'
    Push-Location $repo
    try { & npx --yes @vscode/vsce package --out $Vsix; if ($LASTEXITCODE -ne 0) { Write-Error 'vsce package failed'; exit 1 } }
    finally { Pop-Location }
  }
  & code --user-data-dir $prof --extensions-dir $exts --install-extension $Vsix --force
  if ($LASTEXITCODE -ne 0) { Write-Error "Installing $Vsix failed."; exit 1 }
  # The panel rows need Claude Code's own extension in this isolated window.
  & code --user-data-dir $prof --extensions-dir $exts --install-extension anthropic.claude-code
  if ($LASTEXITCODE -ne 0) { Write-Error 'Installing the Claude Code extension (anthropic.claude-code) failed.'; exit 1 }
}
& code --user-data-dir $prof --extensions-dir $exts --new-window $target
