# Builds the KPIT Sparkle expert-review deck from the official template via PowerPoint COM.
#   .\render.ps1 ; .\render.ps1 p5_collage -Size "996,740" ; (JPEG + video prep, see README in this folder)
#   .\build_pptx.ps1 -Template "<path to Sparkle Idea presentation template 2026-27.pptx>"
# Keeps the template's slide order, titles, layouts and footer; content goes below each title.
param(
  [string]$Template = "$env:USERPROFILE\Downloads\Sparkle Idea presentation template 2026-27.pptx",
  [string]$OutName = "INSP27001692_PANGnovates.pptx"
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$out = Join-Path $here "out"
$final = Join-Path $out $OutName
# work on a scratch copy; the finished file is replaced only after a successful save
$dst = Join-Path $out ("_building_" + $OutName)
Copy-Item $Template $dst -Force

# content box under the title, inside the footer rule (points; slide is 960 x 540)
$L = 42; $T = 54; $W = 878; $H = [math]::Round(878 * 852 / 1776, 1)

$pp = New-Object -ComObject PowerPoint.Application
$p = $pp.Presentations.Open($dst, $false, $false, $false)

function Get-Layout($name) { foreach ($l in $p.SlideMaster.CustomLayouts) { if ($l.Name -eq $name) { return $l } } throw "layout $name" }
function Clear-Body($s) {
  # remove the [GUIDE] placeholders and text boxes, keep the title; a filled placeholder
  # only empties on the first Delete, so repeat until none is left
  for ($pass = 0; $pass -lt 3; $pass++) {
    for ($i = $s.Shapes.Count; $i -ge 1; $i--) {
      $sh = $s.Shapes.Item($i)
      $isBodyPh = ($sh.Type -eq 14 -and $sh.PlaceholderFormat.Type -ne 1)
      if ($isBodyPh -or $sh.Type -eq 17) { $sh.Delete() }
    }
  }
}
function Add-Panel($s, $img) { $null = $s.Shapes.AddPicture((Join-Path $out $img), 0, -1, $L, $T, $W, $H) }
function Set-Notes($s, $text) { $s.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = $text }
function Find-Slide($title) {
  foreach ($s in $p.Slides) { if ($s.Shapes.HasTitle -and $s.Shapes.Title.TextFrame.TextRange.Text.Trim() -eq $title) { return $s } }
  throw "slide '$title' not found"
}
function Set-Bullets($sh, [string[]]$lines, [double]$size) {
  $tr = $sh.TextFrame.TextRange
  $tr.Text = ($lines -join "`r")
  $tr.Font.Size = $size
  $tr.Font.Color.RGB = 0x201F23
  for ($k = 1; $k -le $tr.Paragraphs().Count; $k++) {
    $para = $tr.Paragraphs($k)
    $para.ParagraphFormat.SpaceAfter = 6
    $para.IndentLevel = 1
    $para.Font.Italic = 0
    $para.ParagraphFormat.Bullet.Visible = -1
    $para.ParagraphFormat.Bullet.Character = 8226
    $para.Font.Bold = 0
    $idx = $para.Text.IndexOf(": ")
    if ($idx -gt 0 -and $idx -lt 40) { $para.Characters(1, $idx + 1).Font.Bold = -1 }
  }
}

# 0. the Guidelines slide is instructions for teams, not content
$p.Slides.Item(1).Delete()

# 1. Opening slide: fill the four value placeholders by position (top to bottom)
$open = $p.Slides.Item(1)
$ph = @($open.Shapes | Where-Object { $_.Type -eq 14 } | Sort-Object { $_.Top })
$ph[0].TextFrame.TextRange.Text = "Decentralized Multi-agent Coordination for Autonomous Logistics"
$ph[1].TextFrame.TextRange.Text = "PACT: Partition-Aware Coordination for Transport"
$ph[2].TextFrame.TextRange.Text = "PANGnovates · Saveetha Engineering College"
$ph[3].TextFrame.TextRange.Text = (@(
  "Nanda Kishor Suresh Priya: Team Lead & System Architect",
  "Ganesh Kumar T: Robotics & Simulation Engineer",
  "Aman Singh: Verification & Benchmarking Lead",
  "Paul Shervin P: Research & Documentation Lead",
  "Dr. Karthika R N: Project Guide / Mentor") -join "`r")
$ph[3].TextFrame.TextRange.Font.Size = 15
$ph[3].TextFrame.TextRange.ParagraphFormat.SpaceBefore = 0
$ph[3].TextFrame.TextRange.ParagraphFormat.SpaceAfter = 3
Set-Notes $open "0:00-0:45. Who we are, the category, one line: a drone delivery fleet that keeps working when the central brain goes dark."

# 2. What is the innovation in your idea? (+ continuation with the same title)
$inn = Find-Slide "What is the innovation in your idea?"
Clear-Body $inn; Add-Panel $inn "s3_innovation.jpg"
Set-Notes $inn "0:45-2:30. Read KPIT's own problem statement. Three failure modes: single point of failure, radio partitions, double dispatch. Our idea: every drone is its own dispatcher, and no parcel can ever have two owners."
$inn2 = $inn.Duplicate().Item(1)
Clear-Body $inn2
for ($i = $inn2.Shapes.Count; $i -ge 1; $i--) { if ($inn2.Shapes.Item($i).Type -eq 13) { $inn2.Shapes.Item($i).Delete() } }
Add-Panel $inn2 "s3b_mechanism.jpg"
Set-Notes $inn2 "2:30-4:30. Walk the four ideas left to right. Spend most time on 02 fenced ownership: epoch, lease, zombie-stop, depot hands the parcel only to the highest epoch. Close on the band: held in every run."

# 3. Key Differentiators:
$dif = Find-Slide "Key Differentiators:"
Clear-Body $dif; Add-Panel $dif "s4_differentiators.jpg"
Set-Notes $dif "4:30-6:00. Same maps, faults and seeds for four systems. The plain auction is our own auction with fencing removed, so it isolates what fencing adds. Three numbers: 86.3 vs 56.8, 0 vs 17.8, 9.9 s vs 62-68 s. Confirmed again in the ROS 2 build."

# 4. Prototype/Proof of concept: the template's own video layout, then its image layout
$pro = Find-Slide "Prototype/Proof of concept"
# keep the template's own slide and layout; reuse its body placeholder for the highlights
$hl = $null
foreach ($sh in $pro.Shapes) { if ($sh.Type -eq 14 -and $sh.PlaceholderFormat.Type -ne 1) { $hl = $sh } }
$hl.Left = 556; $hl.Top = 60; $hl.Width = 364; $hl.Height = 410
$mw = 494; $mh = [math]::Round($mw * 9 / 16, 1); $mt = 60 + (410 - $mh) / 2
$vid = $pro.Shapes.AddMediaObject2((Join-Path $out "pact_demo_60s.mp4"), 0, -1, $L, $mt, $mw, $mh)
$vid.Name = "PACT demo video"
$vid.MediaFormat.SetDisplayPicture(30000)
Set-Bullets $hl @(
  "Same city, same seed, same orders, run twice: a central hub on one side, PACT on the other.",
  "Hub killed at 3:00: the central fleet stops taking new work; PACT stays at 86.3% on time.",
  "Radio splits the fleet: across 240 runs, PACT made 0 double deliveries.",
  "Every run replays exactly from its seed in the replay viewer.",
  "Full 3-minute walkthrough: QR code on the Technical Details slide.") 15
Set-Notes $pro "6:00-8:00. Play the 65-second video (click to play). Then point at the hub-loss moment and the zero duplicates."

$proImg = $pro.Duplicate().Item(1)
for ($i = $proImg.Shapes.Count; $i -ge 1; $i--) { if ($proImg.Shapes.Item($i).Type -eq 16) { $proImg.Shapes.Item($i).Delete() } }
$hl2 = $null
foreach ($sh in $proImg.Shapes) { if ($sh.Type -eq 14 -and $sh.PlaceholderFormat.Type -ne 1) { $hl2 = $sh } }
$cw2 = 494; $ch2 = [math]::Round($cw2 * 740 / 996, 1)
$null = $proImg.Shapes.AddPicture((Join-Path $out "p5_collage.jpg"), 0, -1, $L, 60 + (410 - $ch2) / 2, $cw2, $ch2)
Set-Bullets $hl2 @(
  "Two independent builds of the same protocol.",
  "sim3d: browser simulator in TypeScript and Three.js; 8 city maps, about 30 fault scenarios, live or headless.",
  "AeroPACT: ROS 2 Jazzy C++ lifecycle nodes, one container per drone, in Gazebo Harmonic.",
  "PX4 v1.16 SITL: real autopilot software in the loop over uXRCE-DDS.",
  "Tests: 391 simulator tests, 75/75 scenario checks; 692 AeroPACT tests, 9/9 acceptance, 4/4 PX4 SITL.") 14
Set-Notes $proImg "8:00-9:00. Not a mock-up: a working simulator and a ROS 2 robotics stack with PX4 autopilots. Mention the test counts and that every result is reproducible from a seed."

# 5. Future Plans/potential next steps
$fut = Find-Slide "Future Plans/potential next steps"
Clear-Body $fut; Add-Panel $fut "s6_future.jpg"
Set-Notes $fut "9:00-10:30. Software is done; hardware is next. Each phase has a date and a measurable target. Phase 2 is the moment of truth: kill the hub and cut the radio during live indoor flights."

# 6. Technical Details and Reports (+ continuation with the same title)
$tec = Find-Slide "Technical Details and Reports"
Clear-Body $tec; Add-Panel $tec "s7_architecture.jpg"
Set-Notes $tec "10:30-12:00. The per-drone stack, top to bottom. Stress that the safety supervisor never imports coordination code, and that each part rests on published research."
$tec2 = $tec.Duplicate().Item(1)
for ($i = $tec2.Shapes.Count; $i -ge 1; $i--) { if ($tec2.Shapes.Item($i).Type -eq 13) { $tec2.Shapes.Item($i).Delete() } }
Add-Panel $tec2 "s7b_results.jpg"
# clickable link cards over the three QR tiles at the bottom of the panel
$k = $W / 1776
$links = @("https://github.com/MrNK2107/PACT",
  "https://drive.google.com/file/d/1qlPbHO_VTEOLMpG-KsM2Ratiawf_xRO6/view?usp=sharing",
  "https://drive.google.com/drive/folders/1-udBn0FYfy1-YIIxnf0yAcD5kpeAF4en?usp=sharing")
$cw = (1776 - 28) / 3
for ($j = 0; $j -lt 3; $j++) {
  $r = $tec2.Shapes.AddShape(1, $L + $j * ($cw + 14) * $k, $T + 656 * $k, $cw * $k, 196 * $k)
  $r.Fill.Transparency = 1; $r.Line.Visible = 0; $r.Name = "link $j"
  $r.ActionSettings.Item(1).Hyperlink.Address = $links[$j]
}
Set-Notes $tec2 "12:00-13:30. Two results with confidence intervals, then the honest limits. Judges will ask about the plain auction's higher on-time rate: it flies parcels twice. 13:30-15:00: questions."

$p.Save()
"slides: $($p.Slides.Count)"
foreach ($s in $p.Slides) { $t = if ($s.Shapes.HasTitle) { $s.Shapes.Title.TextFrame.TextRange.Text } else { "(" + $s.CustomLayout.Name + ")" }; "  $($s.SlideIndex): $t" }
$p.Close()
Move-Item $dst $final -Force
"{0:N1} MB -> {1}" -f ((Get-Item $final).Length / 1MB), $final
