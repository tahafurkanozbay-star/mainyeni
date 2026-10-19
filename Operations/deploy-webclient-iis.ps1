#requires -RunAsAdministrator
#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$BuildPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "Webclient.app\build"),
    [string]$Destination = "C:\inetpub\wwwroot\kentrehberiumit",
    [string]$SiteName = "Default Web Site"
)

$ErrorActionPreference = "Stop"
Import-Module WebAdministration

$buildRoot = [IO.Path]::GetFullPath($BuildPath)
$destinationRoot = [IO.Path]::GetFullPath($Destination)
$frontPoolName = "kentrehberiumit-webclient"

foreach ($requiredFile in @("index.html", "web.config")) {
    $path = Join-Path $buildRoot $requiredFile
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Üretim paketi dosyası bulunamadı: $path. Önce Operations\build-webclient-iis.ps1 çalıştırılmalı."
    }
}
$assetRoot = Join-Path $buildRoot "assets"
if (-not (Test-Path -LiteralPath $assetRoot -PathType Container) -or
    -not (Get-ChildItem -LiteralPath $assetRoot -File -Recurse | Select-Object -First 1)) {
    throw "Üretim paketi assets klasörü boş veya yok: $assetRoot"
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

$apps = @(Get-WebApplication -Site $SiteName)
$front = $apps | Where-Object { $_.Path -eq "/kentrehberiumit" } | Select-Object -First 1
if ($null -ne $front) {
    $frontPhysical = [Environment]::ExpandEnvironmentVariables([string]$front.PhysicalPath).TrimEnd("\")
    if (-not [string]::Equals($frontPhysical, $destinationRoot.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase)) {
        throw "IIS /kentrehberiumit uygulaması başka bir fiziksel yola işaret ediyor ($frontPhysical). Üzerine yazmadım."
    }
    if ($front.ApplicationPool -ne $frontPoolName) {
        throw "IIS /kentrehberiumit mevcut uygulama havuzu '$($front.ApplicationPool)'. Otomatik değiştirmedim; önce bu eşleşmeyi inceleyin."
    }
}

# Keep deployment bounded to the existing static frontend app. No API app pool,
# API child application, credentials, API binaries or service configuration are created.
if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
}

$frontPoolPath = "IIS:\AppPools\$frontPoolName"
if (-not (Test-Path -LiteralPath $frontPoolPath)) {
    New-WebAppPool -Name $frontPoolName | Out-Null
    Set-ItemProperty -LiteralPath $frontPoolPath -Name managedRuntimeVersion -Value ""
    Set-ItemProperty -LiteralPath $frontPoolPath -Name managedPipelineMode -Value "Integrated"
    Set-ItemProperty -LiteralPath $frontPoolPath -Name enable32BitAppOnWin64 -Value $false
}
else {
    $configuredFrontPool = Get-Item -LiteralPath $frontPoolPath
    if ([string]$configuredFrontPool.managedRuntimeVersion -ne "" -or $configuredFrontPool.enable32BitAppOnWin64) {
        throw "Frontend havuzu $frontPoolName, .NET CLR=No Managed Code ve 64-bit yapılandırmasına sahip değil. Otomatik değiştirmedim."
    }
}

$backupBase = "C:\inetpub\backups\kentrehberiumit"
$backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $backupBase $backupStamp
$buildEntries = @(Get-ChildItem -LiteralPath $buildRoot -Force | Select-Object -ExpandProperty Name)
$existingEntries = @($buildEntries | Where-Object { Test-Path -LiteralPath (Join-Path $destinationRoot $_) })
if ($existingEntries.Count -gt 0) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    foreach ($entry in $existingEntries) {
        Copy-Item -LiteralPath (Join-Path $destinationRoot $entry) -Destination $backupRoot -Recurse -Force
    }
    Write-Host "Mevcut statik web dosyalarının yedeği: $backupRoot" -ForegroundColor Yellow
}

# Replace the generated asset directory, then copy the new static client.
# Never use /MIR or /PURGE: unrelated existing paths at the IIS root are preserved.
$oldAssets = Join-Path $destinationRoot "assets"
if (Test-Path -LiteralPath $oldAssets -PathType Container) {
    Remove-Item -LiteralPath $oldAssets -Recurse -Force
}

& robocopy $buildRoot $destinationRoot /E /COPY:DAT /R:2 /W:2
$copyCode = $LASTEXITCODE
if ($copyCode -ge 8) {
    throw "Statik webclient kopyalaması başarısız oldu (kod $copyCode)."
}

if ($null -eq $front) {
    New-WebApplication -Site $SiteName -Name "kentrehberiumit" -PhysicalPath $destinationRoot -ApplicationPool $frontPoolName | Out-Null
    Write-Host "IIS uygulaması eklendi: /kentrehberiumit -> $destinationRoot"
}

if ((Get-WebAppPoolState -Name $frontPoolName).Value -ne "Started") {
    Start-WebAppPool -Name $frontPoolName
}

Write-Host ""
Write-Host "Statik webclient dağıtımı tamamlandı." -ForegroundColor Green
Write-Host "Webclient URL: https://cbs.ankara.bel.tr/kentrehberiumit/"
Write-Host "Kent Rehberi kaynağı: doğrudan https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi?tur="
Write-Host "Uygulama API'si yayımlanmadı; bu betik mevcut IIS /api eşlemesini veya user klasörünü değiştirmez."
