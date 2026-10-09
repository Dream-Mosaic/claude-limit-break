# Smoke kit, part 1: packages this repo into a .vsix (or uses -Vsix), installs it into an
# isolated VS Code (own profile and extensions folder) and opens it on <tmp>\lb-smoke.
# Uses your real Claude login; only that folder is watched.
param([string]$Vsix)
$kit = Join-Path ([IO.Path]::GetTempPath()) 'lb-smoke-kit\real'
$ws = Join-Path ([IO.Path]::GetTempPath()) 'lb-smoke'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not (Test-Path (Join-Path $kit 'state.json'))) { throw "Run 'node setup.js' first." }
if (-not $Vsix) {
  $Vsix = Join-Path $kit 'limit-break.vsix'
  Push-Location $repo
  try { & npx --yes @vscode/vsce package --out $Vsix; if ($LASTEXITCODE -ne 0) { throw 'vsce package failed' } }
  finally { Pop-Location }
}
$prof = Join-Path $kit 'profile'
$exts = Join-Path $kit 'extensions'
Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
& code --user-data-dir $prof --extensions-dir $exts --install-extension $Vsix --force
& code --user-data-dir $prof --extensions-dir $exts --new-window $ws
