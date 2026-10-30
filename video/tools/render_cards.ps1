# Renders each card in video/cards/cards.html to video/cards/<id>.png (1920x1080, transparent where the card is).
param([string[]]$Cards = @("title","problem","split_a","split_b","gz_1","gz_2","gz_3","gz_4","verify","end"))
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$dir = "C:\Users\nanda\Desktop\projects\PACT\video\cards"
foreach ($c in $Cards) {
  Remove-Item "$dir\$c.png" -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $edge -PassThru -Wait -WindowStyle Hidden -ArgumentList @(
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1920,1080",
    "--default-background-color=00000000", "--virtual-time-budget=4000",
    "--screenshot=$dir\$c.png", "file:///C:/Users/nanda/Desktop/projects/PACT/video/cards/cards.html#$c")
  if (Test-Path "$dir\$c.png") { "$c ok" } else { "$c FAILED" }
}
