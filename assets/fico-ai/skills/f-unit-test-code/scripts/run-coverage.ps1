# Usage: run-coverage.ps1 -Module <gradle module> -Tests <FQCN,...> -Out <dir> [-Project <root>]
# PowerShell port of run-coverage.sh; Windows PowerShell 5.1 and PowerShell 7 alike.
# Always exits 0 after arguments are valid; facts go to <out>/status.json.
# Not executed in the development environment (macOS without PowerShell): see the skill's SKILL.md.
# ponytail: no [CmdletBinding()] on purpose: unknown arguments then land in $args and exit 2 like the sh version,
# instead of a parameter-binding error that the script cannot catch.
param([string]$Module, [string[]]$Tests, [string]$Out, [string]$Project = '.')

$ErrorActionPreference = 'Continue'
$usage = 'usage: run-coverage.ps1 -Module <gradle module> -Tests <FQCN,...> -Out <dir> [-Project <root>]'
function Exit-Usage([string]$msg) { [Console]::Error.WriteLine($msg); exit 2 }

# -Tests a,b arrives as one string through -File and as an array from inside PowerShell; both become "a,b".
$testList = ($Tests | Where-Object { $_ }) -join ','
if (-not $Module -or -not $testList -or -not $Out -or $args.Count -gt 0) { Exit-Usage $usage }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$fwd = { param([string]$p) $p -replace '\\', '/' }
$here = & $fwd $PSScriptRoot
$tools = & $fwd ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../tools')))
$init = "$here/init.gradle"

try {
  New-Item -ItemType Directory -Force -Path $Out -ErrorAction Stop | Out-Null
  $out = & $fwd (Resolve-Path -LiteralPath $Out -ErrorAction Stop).ProviderPath
} catch { Exit-Usage "cannot create output dir: $Out" }
try {
  Set-Location -LiteralPath $Project -ErrorAction Stop
  # .NET file APIs resolve relative paths against the process directory, not the PowerShell location.
  [Environment]::CurrentDirectory = (Get-Location).ProviderPath
} catch { Exit-Usage "no such project dir: $Project" }

# Accept :a:b, a:b and a/b alike: $gmod is the Gradle path without the leading colon, $mdir its directory.
$gmod = ($Module -replace '/', ':') -replace '^:', ''
$mdir = $gmod -replace ':', '/'
$log = "$out/gradle.log"

function Write-Log([string[]]$lines, [bool]$append) {
  if ($null -eq $lines) { $lines = @() }
  if ($append) { [System.IO.File]::AppendAllLines($log, $lines, $utf8) } else { [System.IO.File]::WriteAllLines($log, $lines, $utf8) }
}

# Patterns shared with the plugin's env-failure.ts (a test checks they are identical; keep them in sync).
# Dependency/network failures (matched case-insensitively, like grep -i):
$resolution = 'No cached version|offline mode|Could not resolve|Could not GET|Could not HEAD|Could not download|Could not find [A-Za-z0-9_.:-]+:[A-Za-z0-9_.-]+:|Unable to load Maven meta-data|status code (401|403|407|429|5[0-9][0-9])|Server returned HTTP response code: (401|403|407|429|5[0-9][0-9])|Connection (refused|reset|timed out)|UnknownHost|Read timed out'
# javac errors (case-sensitive, -cmatch): javac echoes source lines, so a log with one is never a resolution failure.
$javac = '\.java:[0-9]+: error:'
# javac errors in production sources: offline, a stale cached SNAPSHOT looks like this.
$mainJavac = 'src[/\\]main[/\\]java[/\\].*\.java:[0-9]+: error:'

function Read-Log { [System.IO.File]::ReadAllText($log, [System.Text.Encoding]::UTF8) }

function Write-Status([string]$compile, [string]$coverage) {
  $tail = ''
  if (Test-Path -LiteralPath $log) {
    # UTF8Encoding replaces invalid bytes (e.g. CP949 output) with U+FFFD instead of failing.
    $lines = @([System.IO.File]::ReadAllLines($log, [System.Text.Encoding]::UTF8))
    $last = @($lines | Select-Object -Last 40)
    # The first environment line leads the tail: the plugin judges from status.json, which keeps only 40 lines.
    if (-not ((Read-Log) -cmatch $javac)) {
      $envLine = @($lines | Where-Object { $_ -match $resolution } | Select-Object -First 1)
      if ($envLine.Count -gt 0) { $last = @("[run-coverage] first environment line: $($envLine[0])") + $last }
    }
    $tail = ($last -join "`n") -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ''
  }
  $json = [ordered]@{ compile = $compile; log = [string]$tail; coverage = $coverage } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText("$out/status.json", $json + "`n", $utf8)
}

# Runs a native command with stdout and stderr captured into gradle.log; returns its exit code.
function Invoke-Logged([string]$exe, [string[]]$argv, [bool]$append) {
  $lines = @(& $exe @argv 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
    })
  $code = $LASTEXITCODE
  Write-Log $lines $append
  return $code
}

# Offline first (no repository round-trip for cached SNAPSHOTs); once online only when the offline run failed
# on dependency resolution or on main-source javac errors. Test-source javac errors never go online.
# Output to gradle.log, closed by a line naming the mode used. Returns the exit code.
function Invoke-Gradle([string[]]$argv) {
  $mode = 'offline'
  $code = Invoke-Logged $gradle ($prefix + $argv + @('--offline')) $false
  if ($code -ne 0) {
    $text = Read-Log
    if ($text -cmatch $mainJavac) { $mode = 'offline failed with main-source errors -> retried online' }
    elseif (-not ($text -cmatch $javac) -and ($text -match $resolution)) { $mode = 'offline failed on dependency resolution -> retried online' }
    if ($mode -ne 'offline') { $code = Invoke-Logged $gradle ($prefix + $argv) $false }
  }
  Write-Log @("[run-coverage] gradle mode: $mode") $true
  return $code
}

try {
  foreach ($stale in @('jacoco.exec', 'jacoco.xml', 'test-results', 'status.json')) {
    Remove-Item -LiteralPath "$out/$stale" -Recurse -Force -ErrorAction SilentlyContinue
  }

  $windows = $env:OS -eq 'Windows_NT'
  $prefix = @()
  if ($windows -and (Test-Path -LiteralPath 'gradlew.bat')) { $gradle = (Join-Path (Get-Location).ProviderPath 'gradlew.bat') }
  elseif (-not $windows -and (Test-Path -LiteralPath 'gradlew')) { $gradle = 'sh'; $prefix = @('./gradlew') }
  elseif (Get-Command gradle -ErrorAction SilentlyContinue) { $gradle = 'gradle' }
  else {
    Write-Log @('neither the Gradle wrapper nor gradle found') $false
    Write-Status 'fail' 'missing'
    exit 0
  }

  $code = Invoke-Gradle @(":${gmod}:testClasses", '-I', $init)
  if ($code -ne 0) { Write-Status 'fail' 'missing'; exit 0 }

  Remove-Item -LiteralPath "$mdir/build/test-results/test" -Recurse -Force -ErrorAction SilentlyContinue
  # cleanTest forces a real run; a cached/UP-TO-DATE test task would write no jacoco.exec
  $null = Invoke-Gradle @(":${gmod}:cleanTest", ":${gmod}:test", '--continue', '-I', $init,
    "-Pfut.agent=$tools/jacocoagent.jar", "-Pfut.exec=$out/jacoco.exec", "-Pfut.tests=$testList")

  if (Test-Path -LiteralPath "$mdir/build/test-results/test" -PathType Container) {
    Copy-Item -LiteralPath "$mdir/build/test-results/test" -Destination "$out/test-results" -Recurse -Force
  }

  $coverage = 'missing'
  $java = 'java'
  if ($env:JAVA_HOME) {
    $exeName = 'java'
    if ($windows) { $exeName = 'java.exe' }
    $candidate = Join-Path (Join-Path $env:JAVA_HOME 'bin') $exeName
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $java = $candidate }
  }
  if ((Test-Path -LiteralPath "$out/jacoco.exec" -PathType Leaf) -and (Test-Path -LiteralPath "$mdir/build/classes/java/main" -PathType Container)) {
    $code = Invoke-Logged $java @('-jar', "$tools/jacococli.jar", 'report', "$out/jacoco.exec",
      '--classfiles', "$mdir/build/classes/java/main", '--sourcefiles', "$mdir/src/main/java",
      '--xml', "$out/jacoco.xml") $true
    if ($code -eq 0 -and (Test-Path -LiteralPath "$out/jacoco.xml" -PathType Leaf)) { $coverage = 'ok' }
  }
  Write-Status 'ok' $coverage
} catch {
  # Never leave the run without facts: an unexpected error is recorded as a failed build.
  try { Write-Log @("run-coverage.ps1 error: $($_.Exception.Message)") $true } catch { }
  try { Write-Status 'fail' 'missing' } catch { }
}
exit 0
