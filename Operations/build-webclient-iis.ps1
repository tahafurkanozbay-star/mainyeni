#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$webclientRoot = Join-Path $repoRoot "Webclient.app"
$packagePath = Join-Path $webclientRoot "package.json"

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "Webclient.app/package.json bulunamadı. Betiği depo içindeki Operations klasöründen çalıştırın."
}

$nodeVersionText = (& node -p "process.versions.node" 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersionText)) {
    throw "Node.js bulunamadı. Webclient.app TOOLCHAIN.md dosyasındaki Node.js 24+ ve npm 11+ gereksinimlerini kurun."
}
$nodeVersion = [version]$nodeVersionText.Trim()
if ($nodeVersion -lt [version]"24.0.0") {
    throw "Node.js 24.0.0 veya üstü gerekir. Bulunan: $nodeVersion"
}

$npmVersionText = (& npm --version 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmVersionText)) {
    throw "npm bulunamadı."
}
$npmVersion = [version]$npmVersionText.Trim()
if ($npmVersion -lt [version]"11.0.0") {
    throw "npm 11.0.0 veya üstü gerekir. Bulunan: $npmVersion"
}

$keys = @(
    "VITE_KENT_REHBERI_SOURCE",
    "VITE_KENT_REHBERI_OVERVIEW_ON_STARTUP"
)
$oldValues = @{}
foreach ($key in $keys) {
    $oldValues[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

function Invoke-NpmChecked {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') başarısız oldu (kod $LASTEXITCODE)."
    }
}

function Invoke-NodeChecked {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & node @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "node $($Arguments -join ' ') başarısız oldu (kod $LASTEXITCODE)."
    }
}

function Invoke-NpmDiagnostic {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & npm @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Warning "Tanısal kontrol başarısız oldu (kod $exitCode): npm $($Arguments -join ' '). Tam kapsamlı ana-dal geçişi mevcut teknik borç nedeniyle engelleyici değildir; sıkı regresyon kontrolleri ayrıca çalıştırılır."
    }
}

Push-Location $webclientRoot
try {
    Write-Host "1/4 - Kilitli bağımlılıklar yükleniyor..." -ForegroundColor Cyan
    Invoke-NpmChecked -Arguments @("ci")

    # The application bootstraps locally and fetches Kent Rehberi data directly
    # from the fixed official PlanASKI endpoint in both tests and production.
    $env:VITE_KENT_REHBERI_SOURCE = "planaski"
    $env:VITE_KENT_REHBERI_OVERVIEW_ON_STARTUP = "false"

    Write-Host "2/4 - CI ile uyumlu kalite kapıları çalıştırılıyor..." -ForegroundColor Cyan

    # These repository audits are strict and block publication on regressions.
    $strictNpmScripts = @(
        "dependency:verify",
        "quality:module-graph",
        "quality:language-ratchet",
        "quality:platform-boundaries",
        "quality:browser-runtime",
        "quality:gis-query-governance",
        "quality:spatial-selection-index",
        "quality:kent-rehberi-all-layers",
        "quality:release-evidence",
        "quality:experience",
        "quality:vite"
    )
    foreach ($scriptName in $strictNpmScripts) {
        Invoke-NpmChecked -Arguments @("run", $scriptName)
    }

    # Match CI policy: keep full-project lint visible, but do not fail on
    # known legacy warnings in untouched files. Enforce zero warnings for the
    # Kent Rehberi direct-source files that this release depends on.
    Invoke-NpmChecked -Arguments @("run", "lint")
    Invoke-NpmChecked -Arguments @(
        "exec", "--", "oxlint", "--deny-warnings",
        "src/data-services/kentRehberiPlanAskiDirect.ts",
        "src/Components/App/KentRehberiDataLayer.tsx"
    )

    # The complete application typecheck is diagnostic during the staged
    # migration; blocking typechecks are the same isolated boundaries used in CI.
    Invoke-NpmDiagnostic -Arguments @(
        "exec", "--", "tsc", "--noEmit", "-p", "tsconfig.json", "--pretty", "false"
    )
    Invoke-NpmChecked -Arguments @(
        "exec", "--", "tsc", "--noEmit", "-p", "tsconfig.supervision.json", "--pretty", "false"
    )
    Invoke-NpmChecked -Arguments @("run", "typecheck:platform-tests", "--", "--pretty", "false")
    Invoke-NpmChecked -Arguments @("run", "typecheck:gis-modern-core", "--", "--pretty", "false")

    # CI treats the full Vitest suite as diagnostic during baseline migration;
    # the hardened runtime subset plus tooling tests remain blocking here.
    $fullVitestReport = Join-Path $env:TEMP "kentrehberiumit-vitest-diagnostic.json"
    Invoke-NpmDiagnostic -Arguments @(
        "exec", "--", "vitest", "run", "--reporter=json", "--outputFile", $fullVitestReport
    )
    Invoke-NpmChecked -Arguments @(
        "exec", "--", "vitest", "run",
        "src/platform/runtime/supervision/dependencyGraph.test.ts",
        "src/platform/runtime/supervision/healthRegistry.test.ts",
        "src/platform/runtime/supervision/lifecycleCoordinator.test.ts",
        "src/platform/runtime/supervision/requestCoordinator.test.ts",
        "src/platform/runtime/supervision/requestCoordinator.fairness.test.ts",
        "src/platform/runtime/supervision/runtimeSupervisor.test.ts",
        "src/platform/runtime/resilience.hardening.test.ts"
    )
    Invoke-NpmChecked -Arguments @("run", "test:tooling")
    Invoke-NpmChecked -Arguments @("run", "test:build-budget")
    Invoke-NpmChecked -Arguments @("audit", "--omit=dev", "--audit-level=high")

    # Build a static-only client. No same-origin or local User API is configured.
    # Kent Rehberi data is fetched from PlanASKI by the browser; the upstream must
    # allow CORS from the deployed CBS origin.
    $env:VITE_KENT_REHBERI_SOURCE = "planaski"
    $env:VITE_KENT_REHBERI_OVERVIEW_ON_STARTUP = "false"

    Write-Host "3/4 - IIS alt-yoluna göre üretim paketi derleniyor..." -ForegroundColor Cyan
    Invoke-NpmChecked -Arguments @("run", "build")

    Write-Host "4/4 - Üretim paketi bütünlüğü ve derleme bütçesi doğrulanıyor..." -ForegroundColor Cyan
    Invoke-NpmChecked -Arguments @("run", "build:verify")
    Invoke-NodeChecked -Arguments @("scripts/web-build-budget.mjs", "build", "--strict")

    $buildRoot = Join-Path $webclientRoot "build"
    $required = @(
        (Join-Path $buildRoot "index.html"),
        (Join-Path $buildRoot "web.config"),
        (Join-Path $buildRoot ".vite/manifest.json")
    )
    foreach ($file in $required) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Üretim paketi eksik dosya içeriyor: $file"
        }
    }
    $assetRoot = Join-Path $buildRoot "assets"
    if (-not (Test-Path -LiteralPath $assetRoot -PathType Container) -or
        -not (Get-ChildItem -LiteralPath $assetRoot -File -Recurse | Select-Object -First 1)) {
        throw "Üretim paketi assets klasörü boş veya yok."
    }

    Write-Host ""
    Write-Host "Üretim paketi hazır:" -ForegroundColor Green
    Write-Host $buildRoot
    Write-Host "Hedef URL: https://cbs.ankara.bel.tr/kentrehberiumit/"
    Write-Host "Dağıtım modeli: statik istemci; uygulama API'si yok"
    Write-Host "Kent Rehberi veri kaynağı: doğrudan resmi PlanASKI API (tarayıcı CORS izni gerektirir)"
}
finally {
    foreach ($key in $keys) {
        [Environment]::SetEnvironmentVariable($key, $oldValues[$key], "Process")
    }
    Pop-Location
}
