#requires -Version 5.1
<#
.SYNOPSIS
  Re-measures the TypeScript migration baseline -> docs/ts-migration-baseline.js

.DESCRIPTION
  Single source of truth for the numbers quoted in docs/TS_MIGRATION_PLAN.md.
  Re-run whenever HEAD moves; the plan's line anchors, error counts and eff
  values all go stale as soon as the tree changes.

  Emits a .js file (not .json) on purpose: docs/ts-split-lab.html loads it with
  <script src>, which works over file:// where fetch() is blocked by CORS.

  Measured with NO @types/* installed -- that is intentional, it is the state
  the plan's numbers were quoted against. Do not "fix" it here.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ts-migration-baseline.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command tsc -ErrorAction SilentlyContinue)) {
  throw 'tsc not on PATH. Install typescript first: npm i -g typescript'
}

# ---- 1. files under test, and their LOC -----------------------------------
$allFiles = @(Get-ChildItem src -Recurse -Include *.js -File)
$absList  = @($allFiles | ForEach-Object { $_.FullName })
$rootLen  = (Get-Location).Path.Length + 1

# ---- 2. error counts, one tsc run per strictness ---------------------------
$flags = @(
  '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
  '--target', 'es2022', '--module', 'esnext',
  '--moduleResolution', 'bundler', '--lib', 'es2022,dom,dom.iterable'
)

# count error lines per file, for a given --strict value.
# NOTE: deliberately a flat pipeline, not a function. Returning a hashtable from
# a PowerShell function unrolls it, and $x / $X are the SAME variable -- both
# bite immediately and are hard to see.
function Get-ErrCounts {
  param([string]$StrictFlag, [string[]]$FileList)
  # tsconfig.json 已在仓库根目录，直接 project 模式跑；显式 flags 与 tsconfig 重复，
  # 只用 --strict 覆盖档位。文件列表模式会因 TS5112（有 tsconfig 又传文件）直接报错。
  $out = & tsc --noEmit --strict $StrictFlag 2>&1
  $map = @{}
  foreach ($line in $out) {
    if ("$line" -match '^(.+?)\(\d+,\d+\): error TS\d+:') {
      $key = $matches[1] -replace '\\', '/'
      if ($map.ContainsKey($key)) { $map[$key] += 1 } else { $map[$key] = 1 }
    }
  }
  ,$map          # comma stops PowerShell unrolling the hashtable
}

Write-Host "tsc $(& tsc --version) / HEAD $((git rev-parse --short HEAD).Trim()) / $($absList.Count) files"

Write-Host 'measuring --strict false ...'
$errLoose = Get-ErrCounts -StrictFlag 'false' -FileList $absList
Write-Host 'measuring --strict true ...'
$errStrict = Get-ErrCounts -StrictFlag 'true'  -FileList $absList

Write-Host ("  loose : {0,5} errors in {1} files" -f (($errLoose.Values | Measure-Object -Sum).Sum), $errLoose.Count)
Write-Host ("  strict: {0,5} errors in {1} files" -f (($errStrict.Values | Measure-Object -Sum).Sum), $errStrict.Count)

# ---- 3. which test file reads which source file ----------------------------
# Measured by grepping src/**.js literals out of each test. Update this table
# when tests are added/renamed, or docs/ts-split-lab.html goes stale silently.
$readBy = @(
  'security-regression|src/gdb-debugger.js'
  'security-regression|src/gdb-mi-debugger.js'
  'security-regression|src/main.js'
  'security-regression|src/main-process/compare-worker-v6.js'
  'security-regression|src/preload.js'
  'security-regression|src/renderer/js/compile-manager.js'
  'security-regression|src/renderer/js/init.js'
  'security-regression|src/renderer/js/main.js'
  'security-regression|src/renderer/js/settings-init.js'
  'security-regression|src/renderer/js/tabs.js'
  'security-regression|src/renderer/settings/compiler.js'
  'security-regression|src/renderer/settings/editor.js'
  'security-regression|src/utils/multi-thread-downloader.js'
  'security-regression|src/utils/process-supervisor.js'
  'audit-fixes|src/main.js'
  'audit-fixes|src/main-process/compare-engine-v2.js'
  'audit-fixes|src/preload.js'
  'audit-fixes|src/renderer/js/compile-manager.js'
  'audit-fixes|src/renderer/js/sidebar/cloudSync.js'
  'audit-fixes|src/renderer/settings/compiler.js'
  'bug-report|src/lang/index.js'
  'bug-report|src/main.js'
  'bug-report|src/renderer/js/sidebar.js'
  'bug-report|src/renderer/js/sidebar/sampleTester.js'
  'bug-report|src/renderer/js/tabs.js'
  'bug-report|src/renderer/settings/compiler.js'
  'bug-report|src/renderer/settings/editor.js'
  'cpp-highlight-e2e|src/renderer/js/monaco-editor-manager.js'
  'cpp-highlight-slots|src/renderer/js/monaco-editor-manager.js'
  'i18n|src/renderer/js/main.js'
  'lsp-audit|src/renderer/js/lsp-utils.js'
  'lsp|src/renderer/js/lsp-utils.js'
  'lsp-workspace|src/renderer/js/lsp-utils.js'
) | ForEach-Object {
  $t, $p = $_ -split '\|', 2
  [pscustomobject]@{ test = $t; path = $p }
}

# out of scope this round: read by tests but not being modified
$frozen = @('src/main.js', 'src/renderer/js/tabs.js', 'src/renderer/js/main.js')

# ---- 4. per-file rows ------------------------------------------------------
$rows = @(
  foreach ($fi in $allFiles) {
    $rel = $fi.FullName.Substring($rootLen) -replace '\\', '/'
    $nLoc    = (Get-Content $fi.FullName).Count
    $nLoose  = if ($errLoose.ContainsKey($rel))  { $errLoose[$rel]  } else { 0 }
    $nStrict = if ($errStrict.ContainsKey($rel)) { $errStrict[$rel] } else { 0 }
    if ($nLoose -eq 0 -and $nStrict -eq 0) { continue }

    [pscustomobject]@{
      f      = $rel
      loc    = $nLoc
      loose  = $nLoose
      strict = $nStrict
      eff    = [math]::Round($nLoc * 0.0022 + $nStrict * 0.0006 + $nLoose * 0.004, 3)
      tests  = @($readBy | Where-Object { $_.path -eq $rel } | ForEach-Object { $_.test } | Sort-Object -Unique)
      frozen = ($frozen -contains $rel)
    }
  }
) | Sort-Object eff -Descending

# ---- 5. emit ---------------------------------------------------------------
$payload = [ordered]@{
  meta = [ordered]@{
    head      = (git rev-parse --short HEAD).Trim()
    tsc       = (& tsc --version) -join ' '
    types     = 'none - no @types/* installed, this is the measured condition'
    generated = (Get-Date).ToString('yyyy-MM-dd HH:mm')
    formula   = 'eff = LOC*0.0022 + strict*0.0006 + loose*0.004'
    caveat    = 'eff coefficients are reverse-fitted against main.js: ranking only, not scheduling. 1 eff = k agent-days, k unmeasured.'
  }
  tests = [ordered]@{}
  files = @($rows)
}
foreach ($g in ($readBy | Group-Object test)) {
  $payload.tests[$g.Name] = @($g.Group | ForEach-Object { $_.path })
}

$dst = Join-Path (Get-Location).Path 'docs\ts-migration-baseline.js'
[System.IO.File]::WriteAllText(
  $dst,
  "window.TS_BASELINE = $($payload | ConvertTo-Json -Depth 6 -Compress);`n",
  [System.Text.Encoding]::UTF8)

Write-Host ''
Write-Host ("wrote {0}" -f $dst)
Write-Host ("  files with errors : {0}" -f $rows.Count)
Write-Host ("  eff total         : {0}" -f [math]::Round((($rows | Measure-Object eff -Sum).Sum), 2))
Write-Host ("  eff excl. frozen  : {0}" -f [math]::Round((($rows | Where-Object { -not $_.frozen } | Measure-Object eff -Sum).Sum), 2))
Write-Host ''
Write-Host 'Now open docs/ts-split-lab.html to re-split against this data.'