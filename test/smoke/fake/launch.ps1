# Smoke kit, part 2: opens this repo's dev build (run `npm run compile` first) in an isolated
# VS Code window with its own profile and the fake Claude config dir made by prepare.js.
# Usage:  .\launch.ps1            -> window 1 on the trusted folder
#         .\launch.ps1 -Second    -> window 2 on the untrusted folder, as a second VS Code instance
# An instance runs only one Extension Development Host window, so window 2 gets its own profile
# (same settings). Both watch the same fake config dir and share the claims in the temp folder,
# which is what keeps two windows from resuming the same session.
param([switch]$Second)
$root = Join-Path ([IO.Path]::GetTempPath()) 'lb-smoke-kit\fake'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not (Test-Path (Join-Path $root 'state.json'))) { throw "Run 'node prepare.js' first." }
$env:CLAUDE_CONFIG_DIR = Join-Path $root 'home'
$profile1 = Join-Path $root 'profile'
if ($Second) {
  $prof = Join-Path $root 'profile2'
  New-Item -ItemType Directory -Force (Join-Path $prof 'User') | Out-Null
  Copy-Item (Join-Path $profile1 'User\settings.json') (Join-Path $prof 'User\settings.json') -Force
  $folder = Join-Path $root 'ws-untrusted'
} else {
  $prof = $profile1
  $folder = Join-Path $root 'ws-trusted'
}
& code --user-data-dir $prof --disable-extensions --extensionDevelopmentPath=$repo --new-window $folder
