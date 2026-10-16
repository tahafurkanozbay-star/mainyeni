#requires -RunAsAdministrator
#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$BuildPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "Webclient.app\build"),
    [string]$Destination = "C:\inetpub\wwwroot\kentrehberiumit",
    [string]$SiteName = "Default Web Site",
    [string]$ApiApplicationPool = "kentrehberiumit"
)

$ErrorActionPreference = "Stop"
Import-Module WebAdministration

$buildRoot = [IO.Path]::GetFullPath($BuildPath)
$destinationRoot = [IO.Path]::GetFullPath($Destination)
$apiRoot = Join-Path $destinationRoot "user"

if (-not (Test-Path -LiteralPath (Join-Path $buildRoot "index.html") -PathType Leaf)) {
    throw "Derlenmiş index.html bulunamadı: $buildRoot. Önce Operations\build-webclient-iis.ps1 çalıştırılmalı."
}
if (-not (Test-Path -LiteralPath (Join-Path $buildRoot "web.config") -PathType Leaf)) {
    throw "Derlenmiş web.config bulunamadı: $buildRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $apiRoot "ankara-rehber-api-user.dll") -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $apiRoot "web.config") -PathType Leaf)) {
    throw "Mevcut User API yayın dosyaları bulunamadı: $apiRoot. API klasörü değiştirilmedi."
}

$site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
if ($null -eq $site) {
    throw "IIS sitesi bulunamadı: $SiteName"
}
if ([string]$site.State -ne "Started") {
    throw "IIS sitesi çalışmıyor: $SiteName. Güvenli yayın için site durumunu önce doğrulayın."
}

$bindings = @(Get-WebBinding -Name $SiteName -Protocol "https" -ErrorAction SilentlyContinue |
    Where-Object { $_.bindingInformation -match ":443:cbs\.ankara\.bel\.tr$" })
if ($bindings.Count -eq 0) {
    throw "Default Web Site üzerinde https *:443:cbs.ankara.bel.tr bağlaması doğrulanamadı. IIS bağlamasını otomatik değiştirmedim."
}

$apiPoolPath = "IIS:\AppPools\$ApiApplicationPool"
if (-not (Test-Path -LiteralPath $apiPoolPath)) {
    throw "Mevcut API uygulama havuzu bulunamadı: $ApiApplicationPool. API havuzu otomatik değiştirilmedi."
}

if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
}

$frontPoolName = "kentrehberiumit-webclient"
$frontPoolPath = "IIS:\AppPools\$frontPoolName"
if (-not (Test-Path -LiteralPath $frontPoolPath)) {
    New-WebAppPool -Name $frontPoolName | Out-Null
    Set-ItemProperty -LiteralPath $frontPoolPath -Name managedRuntimeVersion -Value ""
    Set-ItemProperty -LiteralPath $frontPoolPath -Name managedPipelineMode -Value "Integrated"
    Set-ItemProperty -LiteralPath $frontPoolPath -Name enable32BitAppOnWin64 -Value $false
}

$backupBase = "C:\inetpub\backups\kentrehberiumit"
$backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $backupBase $backupStamp
$managedEntries = @("index.html", "assets", "images", "fonts", "web.config", ".vite")

$existingEntries = @($managedEntries | Where-Object { Test-Path -LiteralPath (Join-Path $destinationRoot $_) })
if ($existingEntries.Count -gt 0) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    foreach ($entry in $existingEntries) {
        Copy-Item -LiteralPath (Join-Path $destinationRoot $entry) -Destination $backupRoot -Recurse -Force
    }
    Write-Host "Mevcut web dosyalarının yedeği: $backupRoot" -ForegroundColor Yellow
}

# Remove only the generated, fingerprinted client asset directory. Do not use
# /MIR or /PURGE: the co-located User API directory must be preserved.
$oldAssets = Join-Path $destinationRoot "assets"
if (Test-Path -LiteralPath $oldAssets -PathType Container) {
    Remove-Item -LiteralPath $oldAssets -Recurse -Force
}

& robocopy $buildRoot $destinationRoot /E /COPY:DAT /R:2 /W:2
$copyCode = $LASTEXITCODE
if ($copyCode -ge 8) {
    throw "Robocopy dağıtımı başarısız oldu (kod $copyCode). API klasörüne /MIR veya /PURGE uygulanmadı."
}

$apps = @(Get-WebApplication -Site $SiteName)
$front = $apps | Where-Object { $_.Path -eq "/kentrehberiumit" } | Select-Object -First 1
if ($null -eq $front) {
    New-WebApplication -Site $SiteName -Name "kentrehberiumit" -PhysicalPath $destinationRoot -ApplicationPool $frontPoolName | Out-Null
    Write-Host "IIS uygulaması eklendi: /kentrehberiumit -> $destinationRoot"
}
else {
    $frontPhysical = [Environment]::ExpandEnvironmentVariables([string]$front.PhysicalPath).TrimEnd("\")
    if (-not [string]::Equals($frontPhysical, $destinationRoot.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
        throw "IIS /kentrehberiumit uygulaması başka bir fiziksel yola işaret ediyor ($frontPhysical). Üzerine yazmadım."
    }
    if ($front.ApplicationPool -ne $frontPoolName) {
        throw "IIS /kentrehberiumit mevcut uygulama havuzu '$($front.ApplicationPool)'. Otomatik değiştirmedim; önce bu eşleşmeyi inceleyin."
    }
}

$apps = @(Get-WebApplication -Site $SiteName)
$apiApp = $apps | Where-Object { $_.Path -eq "/kentrehberiumit/api" } | Select-Object -First 1
if ($null -eq $apiApp) {
    New-WebApplication -Site $SiteName -Name "kentrehberiumit/api" -PhysicalPath $apiRoot -ApplicationPool $ApiApplicationPool | Out-Null
    Write-Host "IIS API uygulaması eklendi: /kentrehberiumit/api -> $apiRoot"
}
else {
    $apiPhysical = [Environment]::ExpandEnvironmentVariables([string]$apiApp.PhysicalPath).TrimEnd("\")
    if (-not [string]::Equals($apiPhysical, $apiRoot.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
        throw "IIS /kentrehberiumit/api başka bir fiziksel yola işaret ediyor ($apiPhysical). Otomatik değiştirmedim."
    }
    if ($apiApp.ApplicationPool -ne $ApiApplicationPool) {
        throw "IIS /kentrehberiumit/api havuzu '$($apiApp.ApplicationPool)'. Otomatik değiştirmedim."
    }
}

Start-WebAppPool -Name $frontPoolName
Write-Host ""
Write-Host "Dosyalar kopyalandı; API klasörü silinmedi." -ForegroundColor Green
Write-Host "Webclient URL: https://cbs.ankara.bel.tr/kentrehberiumit/"
Write-Host "API canlılık: https://cbs.ankara.bel.tr/kentrehberiumit/api/health/live"
Write-Host "Kent Rehberi verisi: https://cbs.ankara.bel.tr/kentrehberiumit/api/kent-rehberi?tur=42&limit=5"
Write-Host "Not: Bu betik API kodunu değiştirmez ve mevcut kentrehberiumit API havuzunu yeniden başlatmaz."
