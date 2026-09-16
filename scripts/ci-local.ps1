#Requires -Version 5.1
<#
.SYNOPSIS
    OICPP-Plus 本地 CI/CD 检查
.DESCRIPTION
    严格检查项目基本功能完整性
#>

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$failed = 0
$passed = 0

function Ok($msg) { $script:passed++; Write-Host "  [OK] $msg" -ForegroundColor Green }
function Fail($msg) { $script:failed++; Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "  [INFO] $msg" -ForegroundColor Gray }

Write-Host "`n=== OICPP-Plus CI/CD Check ===" -ForegroundColor Cyan

# 1. package.json
Write-Host "`n[1/12] package.json" -ForegroundColor Yellow
try {
    $pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
    if ($pkg.name -eq "oicpp-plus-ide") { Ok "name: $($pkg.name)" } else { Fail "name: $($pkg.name) (expected oicpp-plus-ide)" }
    if ($pkg.main -eq "src/main.js") { Ok "main: $($pkg.main)" } else { Fail "main: $($pkg.main)" }
    if (Test-Path "$root\src\main.js") { Ok "main.js exists" } else { Fail "src/main.js missing" }
    if ($pkg.build) { Ok "build config present" } else { Fail "build config missing" }
} catch { Fail "package.json parse error: $_" }

# 2. package-lock.json
Write-Host "`n[2/12] package-lock.json" -ForegroundColor Yellow
try {
    # package-lock.json 可能很大，用流式读取前 10 行检查 name 和 version
    $reader = [System.IO.StreamReader]::new("$root\package-lock.json")
    $lockHead = ""
    for ($i = 0; $i -lt 10 -and -not $reader.EndOfStream; $i++) { $lockHead += $reader.ReadLine() }
    $reader.Close()
    if ($lockHead -match '"name"\s*:\s*"oicpp-plus-ide"') { Ok "lock name: oicpp-plus-ide" } else { Fail "lock name not oicpp-plus-ide" }
    if ($lockHead -match '"version"\s*:\s*"([^"]+)"') {
        $lockVer = $Matches[1]
        if ($lockVer -eq $pkg.version) { Ok "version match: $lockVer" } else { Fail "version mismatch: lock=$lockVer pkg=$($pkg.version)" }
    }
} catch { Fail "package-lock.json error: $_" }

# 3. Icon files
Write-Host "`n[3/12] Icon files" -ForegroundColor Yellow
if (Test-Path "$root\oicpp-plus.ico") {
    $icoSize = (Get-Item "$root\oicpp-plus.ico").Length
    if ($icoSize -gt 1000) { Ok "oicpp-plus.ico ($icoSize bytes)" } else { Fail "oicpp-plus.ico too small ($icoSize bytes)" }
} else { Fail "oicpp-plus.ico missing" }
if (Test-Path "$root\build\icons\png") { Fail "build/icons/png should be deleted" } else { Ok "build/icons/png removed" }

# 4. Icon references in source
Write-Host "`n[4/12] Icon references" -ForegroundColor Yellow
$iconFiles = @("src/main.js", "src/renderer/js/tabs.js", "scripts/generate-icons.js", "installer.nsi")
foreach ($f in $iconFiles) {
    $path = Join-Path $root $f
    if (Test-Path $path) {
        $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
        if ($content -and $content -match 'oicpp\.ico[^-]') {
            Fail "$f still references oicpp.ico"
        } else { Ok "$f icon ref OK" }
    }
}

# 5. Data directory name
Write-Host "`n[5/12] Data directory (.oicpp-plus)" -ForegroundColor Yellow
$dirFiles = @("installer.nsi", "src/main.js", "src/renderer/js/monaco-editor-manager.js")
foreach ($f in $dirFiles) {
    $path = Join-Path $root $f
    if (Test-Path $path) {
        $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
        if ($content -and $content -match '\.oicpp-plus') { Ok "$f uses .oicpp-plus" }
        elseif ($content -and $content -match '\.oicpp[^-]') { Fail "$f uses old .oicpp directory" }
        else { Ok "$f no .oicpp reference" }
    }
}

# 6. JS syntax check
Write-Host "`n[6/12] JS syntax" -ForegroundColor Yellow
$jsFiles = Get-ChildItem "$root\src" -Filter "*.js" -Recurse | Where-Object { $_.FullName -notmatch "node_modules" }
$syntaxErrors = 0
foreach ($f in $jsFiles) {
    $rel = $f.FullName.Substring($root.Length + 1)
    $check = & node -c $f.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail "syntax: $rel"
        $syntaxErrors++
    }
}
if ($syntaxErrors -eq 0) { Ok "all $($jsFiles.Count) JS files OK" } else { Fail "$syntaxErrors syntax errors" }

# 7. CSS check
Write-Host "`n[7/12] CSS" -ForegroundColor Yellow
$cssFiles = Get-ChildItem "$root\src\renderer\css" -Filter "*.css" -Recurse
$cssOk = $true
foreach ($f in $cssFiles) {
    $content = Get-Content $f.FullName -Raw
    $open = ([regex]::Matches($content, '\{')).Count
    $close = ([regex]::Matches($content, '\}')).Count
    if ($open -ne $close) { Fail "braces mismatch: $($f.Name) ($open open, $close close)"; $cssOk = $false }
}
if ($cssOk) { Ok "all $($cssFiles.Count) CSS files OK" }

# 8. HTML check
Write-Host "`n[8/12] HTML" -ForegroundColor Yellow
$htmlFiles = Get-ChildItem "$root\src\renderer" -Filter "*.html" -Recurse
$htmlOk = $true
foreach ($f in $htmlFiles) {
    $content = Get-Content $f.FullName -Raw
    if ($content -notmatch '<!DOCTYPE html>') { Fail "missing DOCTYPE: $($f.Name)"; $htmlOk = $false }
    if ($content -notmatch '<html') { Fail "missing html tag: $($f.Name)"; $htmlOk = $false }
}
if ($htmlOk) { Ok "all $($htmlFiles.Count) HTML files OK" }

# 9. installer.nsi
Write-Host "`n[9/12] installer.nsi" -ForegroundColor Yellow
$nsi = Get-Content "$root\installer.nsi" -Raw -ErrorAction SilentlyContinue
if ($nsi) {
    if ($nsi -match 'oicpp\.ico[^-]') { Fail "old icon reference" } else { Ok "icon ref OK" }
    if ($nsi -match '\.oicpp-plus') { Ok "data dir .oicpp-plus" } else { Fail "no .oicpp-plus dir" }
    if ($nsi -match 'OICPP-Plus IDE\.lnk') { Ok "shortcut name OK" } else { Fail "shortcut name wrong" }
}

# 10. node_modules
Write-Host "`n[10/12] Dependencies" -ForegroundColor Yellow
if (Test-Path "$root\node_modules") {
    $criticalDeps = @("electron", "monaco-editor", "node-pty")
    $depsOk = $true
    foreach ($dep in $criticalDeps) {
        if (Test-Path "$root\node_modules\$dep") { Ok "$dep installed" } else { Fail "$dep missing"; $depsOk = $false }
    }
} else { Fail "node_modules missing - run npm install" }

# 11. .gitignore
Write-Host "`n[11/12] .gitignore" -ForegroundColor Yellow
$gi = Get-Content "$root\.gitignore" -Raw -ErrorAction SilentlyContinue
if ($gi) {
    $mustIgnore = @("node_modules", "dist")
    foreach ($item in $mustIgnore) {
        if ($gi -match [regex]::Escape($item)) { Ok "ignores $item" } else { Fail "missing ignore: $item" }
    }
}

# 12. No old brand references
Write-Host "`n[12/12] Brand consistency" -ForegroundColor Yellow
$brandFiles = @("src/main.js", "src/renderer/js/main.js", "installer.nsi")
$brandOk = $true
foreach ($f in $brandFiles) {
    $path = Join-Path $root $f
    if (Test-Path $path) {
        $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
        if ($content -and $content -match 'mywwzh/oicpp[^-]') {
            Fail "$f references old repo mywwzh/oicpp"
            $brandOk = $false
        }
    }
}
if ($brandOk) { Ok "no old brand refs" }

# Summary
Write-Host "`n=== Result ===" -ForegroundColor Cyan
Write-Host "  Passed: $passed" -ForegroundColor Green
Write-Host "  Failed: $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Green" })
Write-Host "==============================`n" -ForegroundColor Cyan

if ($failed -gt 0) {
    Write-Host "CI FAILED" -ForegroundColor Red
    exit 1
} else {
    Write-Host "CI PASSED" -ForegroundColor Green
    exit 0
}
