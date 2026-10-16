[CmdletBinding()]
param(
    [ValidateSet("Release", "Debug")]
    [string]$Configuration = "Release",
    [ValidateSet("win-x64", "win-arm64")]
    [string]$RuntimeIdentifier = "win-x64",
    [string]$OutputRoot = (Join-Path $PSScriptRoot "..\artifacts\iis-api-user")
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputCandidate = if ([System.IO.Path]::IsPathRooted($OutputRoot)) { $OutputRoot } else { Join-Path $repositoryRoot $OutputRoot }
$outputDirectory = [System.IO.Path]::GetFullPath($outputCandidate)
$artifactsDirectory = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "artifacts")).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$artifactsPrefix = $artifactsDirectory + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputDirectory.StartsWith($artifactsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must be a child directory of '$artifactsDirectory'."
}
$publishDirectory = Join-Path $outputDirectory "publish"
$archivePath = Join-Path $outputDirectory "api-user-iis.zip"
$projectPath = Join-Path $repositoryRoot "Api.User\Api.User.csproj"
if (-not (Test-Path -LiteralPath $projectPath -PathType Leaf)) { throw "Api.User project was not found: $projectPath" }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
if (Test-Path -LiteralPath $publishDirectory) { Remove-Item -LiteralPath $publishDirectory -Recurse -Force }
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
New-Item -ItemType Directory -Path $publishDirectory -Force | Out-Null
$previousTelemetryOptOut = $env:DOTNET_CLI_TELEMETRY_OPTOUT
$previousNoLogo = $env:DOTNET_NOLOGO
try {
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
    $env:DOTNET_NOLOGO = "1"
    $arguments = @("publish", $projectPath, "--configuration", $Configuration, "--runtime", $RuntimeIdentifier, "--output", $publishDirectory, "--self-contained", "false")
    Push-Location $repositoryRoot
    try {
        Write-Host "> dotnet $($arguments -join ' ')" -ForegroundColor Cyan
        & dotnet @arguments
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE." }
    }
    finally { Pop-Location }
}
finally {
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = $previousTelemetryOptOut
    $env:DOTNET_NOLOGO = $previousNoLogo
}
foreach ($file in @("ankara-rehber-api-user.dll", "web.config", "appsettings.json")) {
    $path = Join-Path $publishDirectory $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Published API artifact is incomplete; missing '$file'." }
}
if (Test-Path -LiteralPath (Join-Path $publishDirectory "ankara-rehber-api-admin.dll")) {
    throw "Admin API assembly unexpectedly appeared in the User API publish output."
}
Compress-Archive -Path (Join-Path $publishDirectory "*") -DestinationPath $archivePath -CompressionLevel Optimal
$archive = Get-Item -LiteralPath $archivePath
Write-Host "User API-only IIS publish completed." -ForegroundColor Green
Write-Host "Publish folder: $publishDirectory"
Write-Host "Deployable ZIP: $($archive.FullName)"
Write-Host ("ZIP size: {0:N2} MiB" -f ($archive.Length / 1MB))
Write-Host "This script does not configure IIS, DNS, TLS, CORS or database credentials."
