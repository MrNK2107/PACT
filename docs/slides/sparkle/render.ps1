# Renders the Sparkle content panels to out/<name>.png at 3552x1704 (2x the 1776x852 canvas).
#   .\render.ps1 s3_innovation s4_differentiators
#   .\render.ps1            (renders every s*.html)
param([string[]]$Slides, [string]$Size = "1776,852")
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$here = $PSScriptRoot
$out = Join-Path $here "out"
New-Item -ItemType Directory -Force $out | Out-Null
if (-not $Slides) { $Slides = Get-ChildItem $here -Filter "s*.html" | ForEach-Object { $_.BaseName } }
foreach ($s in $Slides) {
  $png = Join-Path $out "$s.png"
  Remove-Item $png -ErrorAction SilentlyContinue
  $url = "file:///" + ((Join-Path $here "$s.html") -replace '\\', '/')
  Start-Process -FilePath $edge -Wait -WindowStyle Hidden -ArgumentList @(
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=$Size",
    "--virtual-time-budget=6000", "--screenshot=$png", $url)
  if (Test-Path $png) { "$s -> $png" } else { "$s FAILED" }
}
