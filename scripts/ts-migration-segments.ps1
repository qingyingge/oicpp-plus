#requires -Version 5.1
<#
.SYNOPSIS
  Recomputes the monaco-editor-manager.js segment table in docs/TS_MIGRATION_PLAN.md

.DESCRIPTION
  The segment boundaries in the plan are line numbers. Line numbers rot: the
  file grew 9076 -> 9098 between plan revisions and every anchor silently
  became wrong. This script recomputes them and verifies the invariants, so a
  drifted table fails loudly instead of quietly.

  Emits docs/ts-migration-segments.json and prints a markdown table.

  Segments are contiguous, gap-free, cover every method exactly once.
  Header = lines 1..4 (file comment / const / blank / class declaration).

  Caveat: method START lines come from a regex on the declaration and are exact;
  method END lines are found by brace-depth counting, which over-counts when a
  body contains braces inside regex/string literals (the 3 dead-code methods
  near EOF are affected). Segmentation only uses START lines, so the boundaries
  are exact; the END lines only feed the self-containment metric.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ts-migration-segments.ps1
#>
[CmdletBinding()]
param([string]$Path = 'src\renderer\js\monaco-editor-manager.js')

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$full = Resolve-Path $Path
$lines = [System.IO.File]::ReadAllLines($full)
$total = $lines.Count

# ---- method table: name + start..end ---------------------------------------
$methods = @()
for ($i = 0; $i -lt $total; $i++) {
    if ($lines[$i] -match '^    (static |async |get |set )*([A-Za-z_$#][A-Za-z0-9_$]*)\s*\(') {
        $depth = 0; $started = $false; $end = $i
        for ($j = $i; $j -lt $total; $j++) {
            foreach ($ch in $lines[$j].ToCharArray()) {
                if ($ch -eq '{') { $depth++; $started = $true }
                elseif ($ch -eq '}') { $depth-- }
            }
            if ($started -and $depth -eq 0) { $end = $j; break }
            if (-not $started -and $lines[$j] -match ';\s*$') { $end = $j; break }
        }
        $methods += [pscustomobject]@{ name = $matches[2]; start = ($i + 1); end = ($end + 1) }
    }
}

# ---- segment definition ----------------------------------------------------
# Boundaries sit between method declaration lines. If the file shifts, adjust
# here and re-run; the coverage assertions below will catch a mistake.
$SEG = @(
    @{ n = 'lifecycle';          s = 5;    e = 364  }
    @{ n = 'lsp-providers';      s = 365;  e = 2815 }
    @{ n = 'theme+colors';       s = 2816; e = 3512 }
    @{ n = 'semantic-hl';        s = 3513; e = 3618 }
    @{ n = 'keybindings';        s = 3619; e = 4018 }
    @{ n = 'groups+open';        s = 4019; e = 4877 }
    @{ n = 'diag+markers';       s = 4878; e = 5301 }
    @{ n = 'breakpoints';        s = 5302; e = 5407 }
    @{ n = 'path+lang';          s = 5408; e = 5485 }
    @{ n = 'tab-ops+diff';       s = 5486; e = 5845 }
    @{ n = 'settings-apply';     s = 5846; e = 6064 }
    @{ n = 'file-ops';           s = 6065; e = 6214 }
    @{ n = 'bulk-apply';         s = 6215; e = 6448 }
    @{ n = 'clipboard+fmt';      s = 6449; e = 6697 }
    @{ n = 'completion';         s = 6698; e = 7006 }
    @{ n = 'rename';             s = 7007; e = 7132 }
    @{ n = 'selection-guard';    s = 7133; e = 7399 }
    @{ n = 'cpp-parser';         s = 7400; e = 8033 }
    @{ n = 'include-resolution'; s = 8034; e = 8964 }
    @{ n = 'open-at-pos';        s = 8965; e = 9033 }
    @{ n = 'legacy-dead';        s = 9034; e = 9098 }
)

# ---- invariants ------------------------------------------------------------
$fail = @()
$sum = 0; $prev = 5
foreach ($g in $SEG) {
    if ($g.s -ne $prev) { $fail += "gap/overlap at $($g.n): expected start $prev, table says $($g.s)" }
    $prev = $g.e + 1
    $sum += ($g.e - $g.s + 1)
}
if ($prev -ne $total + 1) { $fail += "tail gap: last segment ends $($SEG[-1].e), file is $total lines" }
if (($sum + 4) -ne $total) { $fail += "line conservation broken: $sum + 4 header != $total" }
if ($methods[0].start -ne 5) { $fail += "first method is at line $($methods[0].start), expected 5 (header is 1..4)" }
if ($methods[-1].start -lt 5) { $fail += 'a method was found inside the header region' }

# ---- per-segment metrics ---------------------------------------------------
$owner = @{}
foreach ($g in $SEG) {
    foreach ($m in $methods) {
        if ($m.start -ge $g.s -and $m.start -le $g.e) { $owner[$m.name] = $g.n }
    }
}
$rows = @()
$edges = @{}
foreach ($g in $SEG) {
    $mine = @($methods | Where-Object { $_.start -ge $g.s -and $_.start -le $g.e })
    $selfCont = 0; $xseg = 0
    foreach ($m in $mine) {
        $stop = [Math]::Min($m.end, $total)
        $body = ($lines[($m.start - 1)..($stop - 1)] -join "`n")
        $hasInternal = $false; $hasExternal = $false
        foreach ($t in [regex]::Matches($body, 'this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(')) {
            $tgt = $t.Groups[1].Value
            if (-not $owner.ContainsKey($tgt)) { continue }
            if ($owner[$tgt] -eq $g.n) { $hasInternal = $true }
            else {
                $hasExternal = $true; $xseg++
                $k = $g.n + '->' + $owner[$tgt]
                if ($edges.ContainsKey($k)) { $edges[$k]++ } else { $edges[$k] = 1 }
            }
        }
        if ($hasInternal -and -not $hasExternal) { $selfCont++ }
    }
    $rows += [pscustomobject]@{
        n = $g.n; s = $g.s; e = $g.e; lines = ($g.e - $g.s + 1); methods = $mine.Count
        selfContainedPct = $(if ($mine.Count) { [math]::Round(100.0 * $selfCont / $mine.Count) } else { 0 })
        crossSegmentCalls = $xseg; inDegree = 0
    }
}
foreach ($k in $edges.Keys) {
    $p = $k -split '->'
    $r = $rows | Where-Object { $_.n -eq $p[1] }
    $r.inDegree += $edges[$k]
}

# ---- dead code check -------------------------------------------------------
$dead = @('parseFunctions', 'parseStructsAndClasses', 'removeComments')
$deadReport = @()
foreach ($n in $dead) {
    $m = $methods | Where-Object { $_.name -eq $n }
    $internal = 0
    if ($m) {
        $body = ($lines[($m.start - 1)..([Math]::Min($m.end, $total) - 1)] -join "`n")
        $internal = ([regex]::Matches($body, "this\.$n\s*\(")).Count
    }
    $external = (Get-ChildItem src, tests -Recurse -Include *.js -File -ErrorAction SilentlyContinue |
        Select-String -Pattern "\.$n\s*\(" | Where-Object { $_.Path -notlike '*monaco-editor-manager.js' }).Count
    $deadReport += [pscustomobject]@{ name = $n; start = $m.start; end = $m.end; internalCalls = $internal; externalCalls = $external }
}
foreach ($d in $deadReport) {
    if ($d.externalCalls -gt 0) { $fail += "dead-code candidate $($d.name) HAS $external external caller(s)" -replace '\$external', $d.externalCalls }
}

# ---- report ----------------------------------------------------------------
Write-Host "file=$Path  lines=$total  methods=$($methods.Count)  segments=$($SEG.Count)"
if ($fail.Count) {
    Write-Host ''
    Write-Host 'INVARIANT FAILURES:' -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host ''
    Write-Host 'The segment table has drifted. Fix $SEG and re-run.' -ForegroundColor Yellow
    exit 1
}
Write-Host 'invariants OK: contiguous, no gaps, line-conserving, every method assigned once'
Write-Host ''
Write-Host '| segment | lines | methods | self-contained | cross-seg this. | in-degree |'
Write-Host '|---|---:|---:|---:|---:|---:|'
foreach ($r in $rows) {
    Write-Host "| ``$($r.n)`` | $($r.lines) | $($r.methods) | $($r.selfContainedPct)% | $($r.crossSegmentCalls) | $($r.inDegree) |"
}
Write-Host ''
Write-Host ("cross-segment this. calls : {0}" -f (($rows | Measure-Object crossSegmentCalls -Sum).Sum))
Write-Host ("distinct segment edges   : {0}" -f $edges.Count)
Write-Host ''
Write-Host 'dead-code candidates:'
foreach ($d in $deadReport) {
    Write-Host ("  {0,-24} {1}-{2}  internal={3} external={4}" -f $d.name, $d.start, $d.end, $d.internalCalls, $d.externalCalls)
}

$payload = [ordered]@{
    file     = ($Path -replace '\\', '/')
    head     = (git rev-parse --short HEAD).Trim()
    lines    = $total
    methods  = $methods.Count
    header   = 4
    segments = @($rows)
    edges    = @($edges.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
        [pscustomobject]@{ from = ($_.Key -split '->')[0]; to = ($_.Key -split '->')[1]; calls = $_.Value }
    })
    deadCode = @($deadReport)
}
$dst = Join-Path (Get-Location).Path 'docs\ts-migration-segments.json'
[System.IO.File]::WriteAllText($dst, ($payload | ConvertTo-Json -Depth 6), [System.Text.Encoding]::UTF8)
Write-Host ''
Write-Host "wrote $dst"