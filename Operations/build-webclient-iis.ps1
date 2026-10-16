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
    "VITE_API_URL",
    "VITE_KENT_REHBERI_SOURCE",
    "VITE_PUBLIC_MAP_ONLY_MODE",
    "VITE_LOCAL_BOOTSTRAP_PREVIEW",
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

Push-Location $webclientRoot
try {
    Write-Host "1/4 - Kilitli bağımlılıklar yükleniyor..." -ForegroundColor Cyan
    Invoke-NpmChecked -Arguments @("ci")

    # Run tests and repository quality gates without the production-only flag.
    # This ensures unit tests exercise the normal API contract as well as the
    # separately tested public map-only mode.
    $env:VITE_API_URL = "/api"
    $env:VITE_KENT_REHBERI_SOURCE = "planaski"
    $env:VITE_PUBLIC_MAP_ONLY_MODE = "false"
    $env:VITE_LOCAL_BOOTSTRAP_PREVIEW = "true"
    $env:VITE_KENT_REHBERI_OVERVIEW_ON_STARTUP = "false"

    Write-Host "2/4 - Lint, tür denetimi, testler ve genel doğrulama çalıştırılıyor..." -ForegroundColor Cyan
    Invoke-NpmChecked -Arguments @("run", "verify")

    # Build the actual IIS release only after the complete normal-mode checks pass.
    # Kent Rehberi data is fetched directly from the official PlanASKI endpoint
    # by the browser. The upstream must allow CORS from the deployed CBS origin.
    # Keep the same-origin API base for other application endpoints.
    $env:VITE_API_URL = "/kentrehberiumit/api"
    $env:VITE_KENT_REHBERI_SOURCE = "planaski"
    $env:VITE_PUBLIC_MAP_ONLY_MODE = "true"
    $env:VITE_LOCAL_BOOTSTRAP_PREVIEW = "false"
    $env:VITE_KENT_REHBERI_OVERVIEW_ON_STARTUP = "false"

    Write-Host "3/4 - IIS alt-yoluna göre üretim paketi derleniyor..." -ForegroundColor Cyan
    Invoke-NpmChecked -Arguments @("run", "build")

    Write-Host "4/4 - Üretim paketi bütünlüğü doğrulanıyor..." -ForegroundColor Cyan
    Invoke-NpmChecked -Arguments @("run", "build:verify")

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
    Write-Host "API tabanı: /kentrehberiumit/api"
    Write-Host "Kent Rehberi veri kaynağı: doğrudan resmi PlanASKI API (tarayıcı CORS izni gerektirir)"
}
finally {
    foreach ($key in $keys) {
        [Environment]::SetEnvironmentVariable($key, $oldValues[$key], "Process")
    }
    Pop-Location
}
