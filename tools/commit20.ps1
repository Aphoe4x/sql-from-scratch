# tools/commit20.ps1 — `git commit` wrapper that stamps every commit with a fixed
# date so GitHub counts them for the 20th even though the PC's clock says Nov 19.
# Usage:
#   .\tools\commit20.ps1 -m "stage 28"                 # default date: 2026-11-20T00:00:00+00:00
#   .\tools\commit20.ps1 -Date 2026-11-20T07:00:00+00:00 -m "stage 28"
# It also works from any other shell with the two env vars set:
#   $env:GIT_AUTHOR_DATE="2026-11-20T00:00:00+00:00"; $env:GIT_COMMITTER_DATE="2026-11-20T00:00:00+00:00"; git commit -m "stage 28"
param(
  [string]$Date = "2026-11-20T00:00:00+00:00",
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$GitArgs = @()
)
$env:GIT_AUTHOR_DATE    = $Date
$env:GIT_COMMITTER_DATE = $Date
git commit @GitArgs
