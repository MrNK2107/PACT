# Renders HTML slides in this folder to docs/img/<name>.png at 3840x2160 (2x).
#   .\render.ps1 slide09_hub_loss slide10_no_double
param([Parameter(Mandatory = $true)][string[]]$Slides)
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$here = $PSScriptRoot
$img = Join-Path (Split-Path $here -Parent) "img"
foreach ($s in $Slides) {
  $out = Join-Path $img "$s.png"
  Remove-Item $out -ErrorAction SilentlyContinue
  $url = "file:///" + ((Join-Path $here "$s.html") -replace '\\', '/')
  Start-Process -FilePath $edge -Wait -WindowStyle Hidden -ArgumentList @(
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=1920,1080",
    "--virtual-time-budget=5000", "--screenshot=$out", $url)
  if (Test-Path $out) { "$s -> $out" } else { "$s FAILED" }
}
