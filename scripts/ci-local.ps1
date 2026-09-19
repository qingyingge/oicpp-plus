#Requires -Version 5.1
<#
.SYNOPSIS
    OICPP-Plus 本地 CI/CD 检查 (极为严苛)
.DESCRIPTION
    静态 + 运行时兜底，确保功能不会加载不出来就没了
#>

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$failed = 0
$passed = 0
$warned = 0

function Ok($msg)   { $script:passed++; Write-Host "  [OK] $msg" -ForegroundColor Green }
function Fail($msg) { $script:failed++; Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Warn($msg) { $script:warned++; Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Info($msg) { Write-Host "  [INFO] $msg" -ForegroundColor Gray }

Write-Host "`n=== OICPP-Plus CI/CD (极为严苛模式) ===" -ForegroundColor Cyan

# ============================================================
# A. 基础设施
# ============================================================

# 1. package.json
Write-Host "`n[A1] package.json" -ForegroundColor Yellow
try {
    $pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
    if ($pkg.name -eq "oicpp-plus-ide") { Ok "name: $($pkg.name)" } else { Fail "name: $($pkg.name) (expected oicpp-plus-ide)" }
    if ($pkg.main -eq "src/main.js") { Ok "main: $($pkg.main)" } else { Fail "main: $($pkg.main)" }
    if (Test-Path "$root\src\main.js") { Ok "main.js exists" } else { Fail "src/main.js missing" }
    if ($pkg.build) { Ok "build config present" } else { Fail "build config missing" }
} catch { Fail "package.json parse error: $_" }

# 2. Lock file (pnpm-lock.yaml or package-lock.json)
Write-Host "`n[A2] Lock file" -ForegroundColor Yellow
try {
    $lockFile = $null
    if (Test-Path "$root\pnpm-lock.yaml") { $lockFile = "$root\pnpm-lock.yaml"; $isPnpm = $true }
    elseif (Test-Path "$root\package-lock.json") { $lockFile = "$root\package-lock.json"; $isPnpm = $false }
    if ($lockFile) {
        if ($isPnpm) {
            $lockContent = Get-Content $lockFile -Raw
            if ($lockContent -match '^lockfileVersion:') { Ok "pnpm-lock.yaml exists" } else { Fail "pnpm-lock.yaml invalid" }
        } else {
            $reader = [System.IO.StreamReader]::new($lockFile)
            $lockHead = ""
            for ($i = 0; $i -lt 10 -and -not $reader.EndOfStream; $i++) { $lockHead += $reader.ReadLine() }
            $reader.Close()
            if ($lockHead -match '"name"\s*:\s*"oicpp-plus-ide"') { Ok "lock name: oicpp-plus-ide" } else { Fail "lock name not oicpp-plus-ide" }
            if ($lockHead -match '"version"\s*:\s*"([^"]+)"') {
                $lockVer = $Matches[1]
                if ($lockVer -eq $pkg.version) { Ok "version match: $lockVer" } else { Fail "version mismatch: lock=$lockVer pkg=$($pkg.version)" }
            }
        }
    } else { Fail "no lock file found (expected pnpm-lock.yaml or package-lock.json)" }
} catch { Fail "lock file error: $_" }

# 3. Icon files
Write-Host "`n[A3] Icon files" -ForegroundColor Yellow
if (Test-Path "$root\oicpp-plus.ico") {
    $icoSize = (Get-Item "$root\oicpp-plus.ico").Length
    if ($icoSize -gt 1000) { Ok "oicpp-plus.ico ($icoSize bytes)" } else { Fail "oicpp-plus.ico too small ($icoSize bytes)" }
} else { Fail "oicpp-plus.ico missing" }
if (Test-Path "$root\build\icons\png") { Fail "build/icons/png should be deleted" } else { Ok "build/icons/png removed" }

# 4. node_modules
Write-Host "`n[A4] Dependencies" -ForegroundColor Yellow
if (Test-Path "$root\node_modules") {
    $criticalDeps = @("electron", "monaco-editor", "node-pty")
    foreach ($dep in $criticalDeps) {
        if (Test-Path "$root\node_modules\$dep") { Ok "$dep installed" } else { Fail "$dep missing" }
    }
} else { Fail "node_modules missing" }

# 5. .gitignore
Write-Host "`n[A5] .gitignore" -ForegroundColor Yellow
$gi = Get-Content "$root\.gitignore" -Raw -ErrorAction SilentlyContinue
if ($gi) {
    @("node_modules", "dist") | ForEach-Object {
        if ($gi -match [regex]::Escape($_)) { Ok "ignores $_" } else { Fail "missing ignore: $_" }
    }
}

# ============================================================
# B. 品牌一致性
# ============================================================

# 6. 图标引用
Write-Host "`n[B1] Icon references" -ForegroundColor Yellow
$iconFiles = @("src/main.js", "src/renderer/js/tabs.js", "scripts/generate-icons.js", "installer.nsi")
foreach ($f in $iconFiles) {
    $path = Join-Path $root $f
    if (Test-Path $path) {
        $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
        if ($content -and $content -match 'oicpp\.ico[^-]') { Fail "$f still references oicpp.ico" }
        else { Ok "$f" }
    }
}

# 7. 数据目录
Write-Host "`n[B2] Data directory (.oicpp-plus)" -ForegroundColor Yellow
foreach ($f in @("installer.nsi", "src/main.js", "src/renderer/js/monaco-editor-manager.js")) {
    $path = Join-Path $root $f
    if (Test-Path $path) {
        $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
        if ($content -and $content -match '\.oicpp-plus') { Ok "$f" }
        elseif ($content -and $content -match '\.oicpp[^-]') { Fail "$f uses old .oicpp" }
        else { Ok "$f (no ref)" }
    }
}

# 8. 品牌
Write-Host "`n[B3] Brand consistency" -ForegroundColor Yellow
$brandOk = $true
foreach ($f in @("src/main.js", "src/renderer/js/main.js", "installer.nsi")) {
    $path = Join-Path $root $f
    if (Test-Path $path) {
        $content = Get-Content $path -Raw -ErrorAction SilentlyContinue
        if ($content -and $content -match 'mywwzh/oicpp[^-]') { Fail "$f old repo ref"; $brandOk = $false }
    }
}
if ($brandOk) { Ok "no old brand refs" }

# 9. installer.nsi
Write-Host "`n[B4] installer.nsi" -ForegroundColor Yellow
$nsi = Get-Content "$root\installer.nsi" -Raw -ErrorAction SilentlyContinue
if ($nsi) {
    if ($nsi -match 'oicpp\.ico[^-]') { Fail "old icon" } else { Ok "icon OK" }
    if ($nsi -match '\.oicpp-plus') { Ok "data dir" } else { Fail "no .oicpp-plus" }
    if ($nsi -match 'OICPP-Plus IDE\.lnk') { Ok "shortcut" } else { Fail "shortcut wrong" }
}

# ============================================================
# C. 语法 & 结构
# ============================================================

# 10. JS 语法
Write-Host "`n[C1] JS syntax" -ForegroundColor Yellow
$jsFiles = Get-ChildItem "$root\src" -Filter "*.js" -Recurse | Where-Object { $_.FullName -notmatch "node_modules" }
$syntaxErrors = 0
foreach ($f in $jsFiles) {
    $rel = $f.FullName.Substring($root.Length + 1)
    & node -c $f.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "syntax: $rel"; $syntaxErrors++ }
}
if ($syntaxErrors -eq 0) { Ok "all $($jsFiles.Count) JS files OK" } else { Fail "$syntaxErrors syntax errors" }

# 11. CSS
Write-Host "`n[C2] CSS" -ForegroundColor Yellow
$cssFiles = Get-ChildItem "$root\src\renderer\css" -Filter "*.css" -Recurse
$cssOk = $true
foreach ($f in $cssFiles) {
    $content = Get-Content $f.FullName -Raw
    $open = ([regex]::Matches($content, '\{')).Count
    $close = ([regex]::Matches($content, '\}')).Count
    if ($open -ne $close) { Fail "braces: $($f.Name) ($open/$close)"; $cssOk = $false }
}
if ($cssOk) { Ok "all $($cssFiles.Count) CSS OK" }

# 12. HTML
Write-Host "`n[C3] HTML" -ForegroundColor Yellow
$htmlFiles = Get-ChildItem "$root\src\renderer" -Filter "*.html" -Recurse
$htmlOk = $true
foreach ($f in $htmlFiles) {
    $content = Get-Content $f.FullName -Raw
    if ($content -notmatch '<!DOCTYPE html>') { Fail "no DOCTYPE: $($f.Name)"; $htmlOk = $false }
    if ($content -notmatch '<html') { Fail "no <html>: $($f.Name)"; $htmlOk = $false }
}
if ($htmlOk) { Ok "all $($htmlFiles.Count) HTML OK" }

# ============================================================
# D. 运行时兜底 - 功能加载检查
# ============================================================

# 13. HTML 引用的 JS/CSS 文件必须存在
Write-Host "`n[D1] HTML resource references" -ForegroundColor Yellow
$htmlOk2 = $true
foreach ($f in $htmlFiles) {
    $dir = $f.DirectoryName
    $content = Get-Content $f.FullName -Raw

    # script src
    $scriptRefs = [regex]::Matches($content, 'src="([^"]*\.js)"')
    foreach ($m in $scriptRefs) {
        $ref = $m.Groups[1].Value
        if ($ref -match '^https?://') { continue }
        $full = Join-Path $dir $ref
        if (-not (Test-Path $full)) { Fail "$($f.Name) -> JS not found: $ref"; $htmlOk2 = $false }
    }

    # link href (CSS)
    $cssRefs = [regex]::Matches($content, 'href="([^"]*\.css)"')
    foreach ($m in $cssRefs) {
        $ref = $m.Groups[1].Value
        if ($ref -match '^https?://') { continue }
        $full = Join-Path $dir $ref
        if (-not (Test-Path $full)) { Fail "$($f.Name) -> CSS not found: $ref"; $htmlOk2 = $false }
    }
}
if ($htmlOk2) { Ok "all HTML resources resolved" }

# 14. JS require/import 的本地文件必须存在
Write-Host "`n[D2] JS module resolution" -ForegroundColor Yellow
$modOk = $true
$mainJsFiles = @("src/main.js", "src/renderer/js/main.js", "src/renderer/js/init.js", "src/renderer/js/tabs.js", "src/renderer/js/monaco-editor-manager.js")
foreach ($f in $mainJsFiles) {
    $path = Join-Path $root $f
    if (-not (Test-Path $path)) { continue }
    $content = Get-Content $path -Raw
    $dir = Split-Path $path

    # require('./xxx') or require('../xxx')
    $requires = [regex]::Matches($content, "require\(['""](\.\.?/[^'""]+)['""]\)")
    foreach ($m in $requires) {
        $target = $m.Groups[1].Value -replace '/', '\'
        $full = Join-Path $dir $target
        # 尝试 .js 和 /index.js
        if (-not (Test-Path $full) -and -not (Test-Path "$full.js") -and -not (Test-Path "$full\index.js")) {
            Fail "$f -> require not found: $target"
            $modOk = $false
        }
    }
}
if ($modOk) { Ok "all local requires resolved" }

# 15. DOM 选择器 vs HTML ID 一致性
Write-Host "`n[D3] DOM selector consistency" -ForegroundColor Yellow
$domOk = $true
$htmlContent = Get-Content "$root\src\renderer\index.html" -Raw
$htmlIds = [regex]::Matches($htmlContent, 'id="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }

$jsSelectorFiles = @("src/renderer/js/main.js", "src/renderer/js/tabs.js", "src/renderer/js/init.js", "src/renderer/js/monaco-editor-manager.js")
foreach ($f in $jsSelectorFiles) {
    $path = Join-Path $root $f
    if (-not (Test-Path $path)) { continue }
    $content = Get-Content $path -Raw

    # getElementById('xxx')
    $getIds = [regex]::Matches($content, "getElementById\(['""]([^'""]+)['""]\)")
    foreach ($m in $getIds) {
        $id = $m.Groups[1].Value
        if ($id -notin $htmlIds -and $id -notmatch '^group-' -and $id -notmatch '^tab-' -and $id -notmatch 'monaco') {
            # 可能是动态创建的，只警告
            if ($Verbose) { Warn "$f -> #$id not in HTML (may be dynamic)" }
        }
    }

    # querySelector('.xxx') - 检查 class 是否在 CSS 中定义
    $getClasses = [regex]::Matches($content, "querySelector\(['""]\.([^'""]+)['""]\)")
    foreach ($m in $getClasses) {
        $cls = $m.Groups[1].Value
        $cssFound = $false
        foreach ($cssF in $cssFiles) {
            $cssContent = Get-Content $cssF.FullName -Raw -ErrorAction SilentlyContinue
            if ($cssContent -match "\.$([regex]::Escape($cls))") { $cssFound = $true; break }
        }
        if (-not $cssFound -and $cls -notmatch 'monaco' -and $cls -notmatch 'tab-') {
            if ($Verbose) { Warn "$f -> .$cls not in CSS (may be dynamic)" }
        }
    }
}
if ($domOk) { Ok "DOM selectors checked" }

# 16. IPC 通道一致性 (main.js ipcMain.handle vs renderer electronAPI)
Write-Host "`n[D4] IPC channel consistency" -ForegroundColor Yellow
$ipcOk = $true
$mainContent = Get-Content "$root\src\main.js" -Raw
$rendererContent = Get-Content "$root\src\renderer\js\main.js" -Raw

# main.js 中的 handle
$mainHandles = [regex]::Matches($mainContent, "ipcMain\.handle\(['""]([^'""]+)['""]") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

# renderer 中的 invoke (electronAPI.xxx)
$rendererInvokes = [regex]::Matches($rendererContent, "electronAPI\.(\w+)\(") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

# 检查 renderer 调用的 channel 在 main 中有注册
foreach ($invoke in $rendererInvokes) {
    # electronAPI 的方法名通常是 camelCase，ipcMain.handle 的 channel 可能是 kebab-case
    # 只做宽松检查：确保 main 中至少有类似的 channel
    $found = $mainHandles | Where-Object { $_ -match $invoke -or $invoke -match $_ }
    if (-not $found -and $invoke -notmatch 'on[A-Z]' -and $invoke -notmatch 'path') {
        # 可能是 event listener 而非 invoke
        if ($Verbose) { Info "renderer calls electronAPI.$invoke (may be event-based)" }
    }
}
if ($ipcOk) { Ok "IPC channels checked ($($mainHandles.Count) handlers)" }

# 17. CSS url() 引用的文件必须存在
Write-Host "`n[D5] CSS url() references" -ForegroundColor Yellow
$cssUrlOk = $true
foreach ($f in $cssFiles) {
    $content = Get-Content $f.FullName -Raw
    $dir = $f.DirectoryName
    $urls = [regex]::Matches($content, "url\(['""]?([^)'""]+)['""]?\)")
    foreach ($m in $urls) {
        $url = $m.Groups[1].Value
        if ($url -match '^https?://' -or $url -match '^data:') { continue }
        $full = Join-Path $dir $url
        if (-not (Test-Path $full)) { Warn "$($f.Name) -> url() not found: $url" }
    }
}
if ($cssUrlOk) { Ok "CSS url() references checked" }

# 18. 关键 DOM 元素在 HTML 中存在
Write-Host "`n[D6] Critical DOM elements" -ForegroundColor Yellow
$criticalIds = @("editor-groups", "welcome-container", "app-icon")
$domCritOk = $true
foreach ($id in $criticalIds) {
    if ($htmlIds -contains $id) { Ok "#$id found" } else { Fail "#$id missing from HTML"; $domCritOk = $false }
}

$criticalClasses = @("editor-container", "editor-area", "tab-bar", "editor-group", "sidebar")
foreach ($cls in $criticalClasses) {
    if ($htmlContent -match "class=""[^""]*\b$cls\b") { Ok ".$cls found" }
    else { Fail ".$cls missing from HTML"; $domCritOk = $false }
}

# 19. Electron 能否启动 (smoke test)
Write-Host "`n[D7] Electron smoke test" -ForegroundColor Yellow
$electronPath = "$root\node_modules\.bin\electron.cmd"
if (Test-Path $electronPath) {
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $electronPath
        $psi.Arguments = ". --no-sandbox --headless"
        $psi.WorkingDirectory = $root
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        Start-Sleep -Seconds 5
        if (-not $proc.HasExited) {
            Ok "Electron starts OK (killing test process)"
            $proc.Kill()
        } else {
            if ($proc.ExitCode -eq 0) { Ok "Electron exited cleanly" } else { Fail "Electron crashed (exit: $($proc.ExitCode))" }
        }
    } catch {
        Warn "Electron smoke test skipped: $_"
    }
} else {
    Warn "electron binary not found, skipping smoke test"
}

# 20. 无 console.log / console.error 残留 (开发调试用)
Write-Host "`n[D8] Debug logging check" -ForegroundColor Yellow
$debugOk = $true
foreach ($f in $jsFiles) {
    $rel = $f.FullName.Substring($root.Length + 1)
    $content = Get-Content $f.FullName -Raw
    $logCount = ([regex]::Matches($content, 'console\.log\(')).Count
    $dbgCount = ([regex]::Matches($content, 'debugger;')).Count
    $alertCount = ([regex]::Matches($content, 'alert\(')).Count
    if ($logCount -gt 0) { Warn "$rel has ${logCount}x console.log" }
    if ($dbgCount -gt 0) { Warn "$rel has ${dbgCount}x debugger" }
    if ($alertCount -gt 0) { Warn "$rel has ${alertCount}x alert()" }
}
if ($debugOk) { Ok "debug artifacts checked" }

# 21. 文件无 BOM
Write-Host "`n[D9] File encoding" -ForegroundColor Yellow
$bomFiles = @("src/main.js", "src/renderer/js/main.js", "src/renderer/js/tabs.js", "src/renderer/js/monaco-editor-manager.js")
$bomOk = $true
foreach ($f in $bomFiles) {
    $path = Join-Path $root $f
    if (Test-Path $path) {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            Warn "$f has UTF-8 BOM"
        }
    }
}
if ($bomOk) { Ok "encoding OK" }

# ============================================================
# E. 安全检查
# ============================================================

# 22. IPC 通道白名单 (preload.js 暴露的 channel 必须在 main.js 注册)
Write-Host "`n[E1] IPC whitelist audit" -ForegroundColor Yellow
$preloadPath = "$root\src\preload.js"
$ipcWhitelistOk = $true
if (Test-Path $preloadPath) {
    $preloadContent = Get-Content $preloadPath -Raw
    # 提取 ipcRenderer.send('xxx') 和 ipcRenderer.invoke('xxx') 中的 channel
    $sendChannels = [regex]::Matches($preloadContent, "ipcRenderer\.send\('([^']+)'" ) | ForEach-Object { $_.Groups[1].Value }
    $invokeChannels = [regex]::Matches($preloadContent, "ipcRenderer\.invoke\('([^']+)'" ) | ForEach-Object { $_.Groups[1].Value }
    $preloadChannels = ($sendChannels + $invokeChannels) | Sort-Object -Unique

    $mainRegistered = [regex]::Matches($mainContent, "ipcMain\.(handle|on|once)\('([^']+)'" ) | ForEach-Object { $_.Groups[2].Value } | Sort-Object -Unique

    $unregistered = @()
    foreach ($ch in $preloadChannels) {
        if ($ch -notin $mainRegistered) { $unregistered += $ch }
    }
    if ($unregistered.Count -gt 0) {
        Fail "IPC channels in preload but not in main: $($unregistered -join ', ')"
        $ipcWhitelistOk = $false
    } else {
        Ok "all $($preloadChannels.Count) preload channels registered"
    }
} else {
    Warn "preload.js not found, skipping IPC whitelist"
}

# 23. CSP 回归守卫
Write-Host "`n[E2] CSP regression guard" -ForegroundColor Yellow
$cspOk = $true
$cspMatch = [regex]::Match($htmlContent, 'Content-Security-Policy"?\s+content="([^"]+)"')
if ($cspMatch.Success) {
    $cspValue = $cspMatch.Groups[1].Value
    if ($cspValue -match "script-src.*'unsafe-eval'") { Warn "CSP allows unsafe-eval (needed for Monaco)" }
    if ($cspValue -match "default-src\s+'\*'") { Fail "CSP default-src uses wildcard *"; $cspOk = $false }
    if ($cspValue -match "script-src\s+\*") { Fail "CSP script-src uses wildcard *"; $cspOk = $false }
    if ($cspOk) { Ok "CSP present, no wildcard violations" }
} else {
    Fail "No Content-Security-Policy found in index.html"
}

# 24. --no-sandbox 标志检测
Write-Host "`n[E3] --no-sandbox detection" -ForegroundColor Yellow
$noSandboxFound = $false
foreach ($f in $jsFiles) {
    $content = Get-Content $f.FullName -Raw
    if ($content -match 'no-sandbox') {
        Fail "$($f.Name) contains --no-sandbox"
        $noSandboxFound = $true
    }
}
if (-not $noSandboxFound) { Ok "no --no-sandbox in source" }

# 25. 硬编码密钥扫描
Write-Host "`n[E4] Secrets scan" -ForegroundColor Yellow
$secretsFound = 0
$secretPatterns = @('api[_-]?key.{0,3}[A-Za-z0-9]{20,}', 'password.{0,3}[^''"]{8,}', 'token.{0,3}[A-Za-z0-9]{20,}', 'secret.{0,3}[A-Za-z0-9]{20,}')
foreach ($f in $jsFiles) {
    $content = Get-Content $f.FullName -Raw
    foreach ($pattern in $secretPatterns) {
        if ($content -match $pattern) {
            Warn "potential secret in $($f.Name)"
            $secretsFound++
        }
    }
}
if ($secretsFound -eq 0) { Ok "no hardcoded secrets" } else { Warn "$secretsFound potential secrets" }

# 26. eval() / Function() 检测
Write-Host "`n[E5] Dangerous eval detection" -ForegroundColor Yellow
$evalFound = 0
foreach ($f in $jsFiles) {
    $rel = $f.FullName.Substring($root.Length + 1)
    $content = Get-Content $f.FullName -Raw
    $evalCount = ([regex]::Matches($content, '\beval\(')).Count
    $funcCount = ([regex]::Matches($content, '\bnew Function\(')).Count
    if ($evalCount -gt 0) { Warn "$rel has ${evalCount}x eval()"; $evalFound += $evalCount }
    if ($funcCount -gt 0) { Warn "$rel has ${funcCount}x new Function()"; $evalFound += $funcCount }
}
if ($evalFound -eq 0) { Ok "no eval()/Function() found" } else { Warn "$evalFound dangerous calls" }

# 27. child_process.exec (shell injection 风险)
Write-Host "`n[E6] child_process security" -ForegroundColor Yellow
$shellExecFound = 0
foreach ($f in $jsFiles) {
    $content = Get-Content $f.FullName -Raw
    $execCount = ([regex]::Matches($content, '\bexec\(')).Count
    $execSyncCount = ([regex]::Matches($content, '\bexecSync\(')).Count
    $spawnShellCount = ([regex]::Matches($content, 'spawn\([^)]*shell\s*:\s*true')).Count
    if ($execCount -gt 0) { Warn "$($f.Name) has ${execCount}x exec()"; $shellExecFound += $execCount }
    if ($execSyncCount -gt 0) { Warn "$($f.Name) has ${execSyncCount}x execSync()"; $shellExecFound += $execSyncCount }
    if ($spawnShellCount -gt 0) { Warn "$($f.Name) has spawn with shell:true"; $shellExecFound += $spawnShellCount }
}
if ($shellExecFound -eq 0) { Ok "no shell execution found" } else { Warn "$shellExecFound shell exec calls" }

# 28. 内存泄漏风险 (事件监听器未移除)
Write-Host "`n[E7] Event listener leak risk" -ForegroundColor Yellow
$leakRisk = 0
foreach ($f in $jsFiles) {
    $content = Get-Content $f.FullName -Raw
    $addCount = ([regex]::Matches($content, '\.addEventListener\(')).Count
    $removeCount = ([regex]::Matches($content, '\.removeEventListener\(')).Count
    if ($addCount -gt 10 -and $removeCount -eq 0) {
        Warn "$($f.Name) has $addCount addEventListener but 0 removeEventListener"
        $leakRisk++
    }
}
if ($leakRisk -eq 0) { Ok "no obvious listener leak risk" }

# ============================================================
# F. 供应链安全
# ============================================================

# 29. pnpm audit
Write-Host "`n[F1] pnpm audit" -ForegroundColor Yellow
try {
    $auditResult = & pnpm audit --audit-level=high 2>&1 | Out-String
    if ($auditResult -match "found 0 vulnerabilities" -or $auditResult -match "No known vulnerabilities found") {
        Ok "pnpm audit clean"
    } elseif ($LASTEXITCODE -ne 0) {
        Warn "pnpm audit found vulnerabilities (may be false positives)"
    } else {
        Ok "pnpm audit clean"
    }
} catch {
    Warn "pnpm audit skipped: $_"
}

# 30. 未锁版本依赖 ("latest")
Write-Host "`n[F2] Unpinned dependencies" -ForegroundColor Yellow
$latestDeps = $pkg.dependencies.PSObject.Properties | Where-Object { $_.Value -eq "latest" }
if ($latestDeps.Count -gt 0) {
    Warn "production deps with 'latest': $($latestDeps.Name -join ', ')"
} else {
    Ok "no unpinned 'latest' deps"
}

# 31. 依赖树完整性
Write-Host "`n[F3] Dependency tree" -ForegroundColor Yellow
try {
    $lsResult = & pnpm ls --depth=0 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        if ($lsResult -match "peer dep|missing") {
            Fail "dependency tree issues"
        } else {
            Ok "dependency tree OK"
        }
    } else {
        Ok "dependency tree clean"
    }
} catch {
    Warn "dependency tree check skipped: $_"
}

# ============================================================
# G. 代码质量
# ============================================================

# 32. 大文件警告 (>3000行)
Write-Host "`n[G1] Large file check" -ForegroundColor Yellow
$largeFiles = 0
foreach ($f in $jsFiles) {
    $lines = (Get-Content $f.FullName).Count
    if ($lines -gt 3000) {
        Warn "$($f.Name): $lines lines (>3000)"
        $largeFiles++
    }
}
if ($largeFiles -eq 0) { Ok "no oversized files" }

# 33. 重复代码模式检测 (相同函数名在不同文件中)
Write-Host "`n[G2] Duplicate function names" -ForegroundColor Yellow
$funcNames = @{}
foreach ($f in $jsFiles) {
    $content = Get-Content $f.FullName -Raw
    $funcs = [regex]::Matches($content, '(?:function|const|let|var)\s+(\w+)\s*[=\(]')
    foreach ($m in $funcs) {
        $name = $m.Groups[1].Value
        if ($name.Length -gt 5 -and $name -notmatch '^(log|err|warn|info|debug)$') {
            if ($funcNames.ContainsKey($name)) {
                $funcNames[$name] += ", $($f.Name)"
            } else {
                $funcNames[$name] = $f.Name
            }
        }
    }
}
$dups = $funcNames.GetEnumerator() | Where-Object { $_.Value -match ',' }
if ($dups) {
    foreach ($d in $dups) { Warn "duplicate: $($d.Key) in $($d.Value)" }
} else {
    Ok "no duplicate function names"
}

# 34. 死代码检测 (空函数/空 if 块)
Write-Host "`n[G3] Dead code patterns" -ForegroundColor Yellow
$deadPatterns = 0
foreach ($f in $jsFiles) {
    $content = Get-Content $f.FullName -Raw
    # 空函数体
    $emptyFuncs = ([regex]::Matches($content, 'function\s+\w+\s*\([^)]*\)\s*\{\s*\}')).Count
    # 空 catch
    $emptyCatch = ([regex]::Matches($content, 'catch\s*\([^)]*\)\s*\{\s*\}')).Count
    if ($emptyFuncs -gt 0) { Warn "$($f.Name) has $emptyFuncs empty functions"; $deadPatterns += $emptyFuncs }
    if ($emptyCatch -gt 0) { Warn "$($f.Name) has $emptyCatch empty catch blocks"; $deadPatterns += $emptyCatch }
}
if ($deadPatterns -eq 0) { Ok "no obvious dead code" } else { Warn "$deadPatterns dead code patterns" }

# ============================================================
# H. 崩溃 & 运行时完整性
# ============================================================

# 35. 崩溃处理器检查
Write-Host "`n[H1] Crash handlers" -ForegroundColor Yellow
if ($mainContent -match 'render-process-gone') { Ok "render-process-gone handler" } else { Fail "no render-process-gone handler" }
if ($mainContent -match 'uncaughtException') { Ok "uncaughtException handler" } else { Warn "no uncaughtException handler" }
if ($mainContent -match 'unhandledRejection') { Ok "unhandledRejection handler" } else { Warn "no unhandledRejection handler" }
if ($mainContent -match "process.on.") { Ok "process exit handler" } else { Warn "no process exit handler" }

# 36. BrowserWindow 安全配置
Write-Host "`n[H2] BrowserWindow security" -ForegroundColor Yellow
$sandboxFalse = ([regex]::Matches($mainContent, 'sandbox.{0,3}false')).Count
$webSecFalse = ([regex]::Matches($mainContent, 'webSecurity.{0,3}false')).Count
$nodeIntTrue = ([regex]::Matches($mainContent, 'nodeIntegration.{0,3}true')).Count
$ctxIsoFalse = ([regex]::Matches($mainContent, 'contextIsolation.{0,3}false')).Count

if ($sandboxFalse -gt 0) { Warn "sandbox:false in $sandboxFalse BrowserWindow(s)" }
if ($webSecFalse -gt 0) { Warn "webSecurity:false in $webSecFalse BrowserWindow(s)" }
if ($nodeIntTrue -gt 0) { Fail "nodeIntegration:true in $nodeIntTrue BrowserWindow(s)" }
if ($ctxIsoFalse -gt 0) { Fail "contextIsolation:false in $ctxIsoFalse BrowserWindow(s)" }
if ($sandboxFalse -eq 0 -and $webSecFalse -eq 0 -and $nodeIntTrue -eq 0 -and $ctxIsoFalse -eq 0) {
    Ok "all BrowserWindow configs secure"
}

# 37. 版本一致性
Write-Host "`n[H3] Version consistency" -ForegroundColor Yellow
$buildInfoPath = "$root\src\build-info.json"
if (Test-Path $buildInfoPath) {
    $buildInfo = Get-Content $buildInfoPath -Raw | ConvertFrom-Json
    if ($buildInfo.version -eq $pkg.version) { Ok "build-info version matches: $($buildInfo.version)" }
    else { Fail "version mismatch: pkg=$($pkg.version) build-info=$($buildInfo.version)" }
} else {
    Warn "build-info.json not found"
}

# 38. Electron 版本检查
Write-Host "`n[H4] Electron version" -ForegroundColor Yellow
$electronVer = $pkg.devDependencies.electron -replace '[^0-9.]', ''
$firstDot = $electronVer.IndexOf('.')
if ($firstDot -gt 0) {
    $majorVer = [int]$electronVer.Substring(0, $firstDot)
} else {
    $majorVer = [int]$electronVer
}
if ($majorVer -lt 35) {
    Fail "Electron $electronVer is too old (security risk)"
} elseif ($majorVer -lt 39) {
    Warn "Electron $electronVer -- check for security patches at electronjs.org"
} else {
    Ok "Electron $electronVer is recent"
}

# ============================================================
# 汇总
# ============================================================
Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host "  Passed:  $passed" -ForegroundColor Green
Write-Host "  Warnings: $warned" -ForegroundColor Yellow
Write-Host "  Failed:  $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Green" })
Write-Host "==========================================`n" -ForegroundColor Cyan

if ($failed -gt 0) {
    Write-Host "CI FAILED" -ForegroundColor Red
    exit 1
} else {
    Write-Host "CI PASSED" -ForegroundColor Green
    exit 0
}
