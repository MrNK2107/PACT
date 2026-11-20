# Model-check PACT's fenced ownership with TLC.  Needs Java 11+ and tools\tla2tools.jar
# (https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar).
#   .\run.ps1            correct model + both mutants, logs in this folder
$here = $PSScriptRoot
$jar = Join-Path $here "tools\tla2tools.jar"
if (-not (Test-Path $jar)) { throw "missing $jar" }
foreach ($cfg in "MC.cfg", "MC_mutant_nofence.cfg", "MC_mutant_nomargin.cfg") {
  $log = Join-Path $here ($cfg -replace '\.cfg$', '.log')
  Write-Host "== $cfg"
  & java -XX:+UseParallelGC -cp $jar tlc2.TLC -workers auto -deadlock -config (Join-Path $here $cfg) -metadir (Join-Path $here "states") (Join-Path $here "PACTOwnership.tla") *>&1 | Tee-Object -FilePath $log | Select-String -Pattern "Error:|violated|Model checking completed|states generated|distinct states|depth"
}
