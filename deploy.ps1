# Push an update to your phone. Run from this folder:  .\deploy.ps1 "what changed"
# Bumps the version, commits and pushes to GitHub. The phone picks it up next time the app opens.
param([string]$msg = "update")
$f = "js/version.js"
$c = Get-Content $f -Raw
if ($c -match "APP_VERSION = '(\d+)\.(\d+)\.(\d+)'") {
  $v = "$($matches[1]).$($matches[2]).$([int]$matches[3] + 1)"
  $c = $c -replace "APP_VERSION = '[^']+'", "APP_VERSION = '$v'"
  Set-Content $f $c -NoNewline
  git add -A
  git commit -m "v${v}: $msg"
  git push
  Write-Host "Pushed version $v. Open the app on your phone to get it (GitHub Pages takes about 1 minute)."
}
