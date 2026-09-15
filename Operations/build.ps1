[CmdletBinding()]
param(
    [Parameter()]
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")),

    [Parameter()]
    [string]$OutputRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "artifacts"),

    [Parameter()]
    [ValidateSet("User", "Admin", "All")]
    [string]$Target = "All",

    [Parameter()]
    [ValidateSet("Release", "Debug")]
    [string]$Configuration = "Release",

    [Parameter()]
    [string]$RuntimeIdentifier = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        Write-Host "> $Executable $($Arguments -join ' ')" -ForegroundColor Cyan
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Executable exited with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Reset-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path $Path) {
        Remove-Item $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Compress-Directory {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (Test-Path $Destination) {
        Remove-Item $Destination -Force
    }

    Compress-Archive -Path (Join-Path $Source "*") -DestinationPath $Destination -CompressionLevel Optimal
}

function Build-WebClient {
    param(
        [Parameter(Mandatory = $true)][string]$Folder,
        [Parameter(Mandatory = $true)][string]$ArtifactName
    )

    $projectPath = Join-Path $RepositoryRoot $Folder
    $buildPath = Join-Path $projectPath "build"
    $artifactDirectory = Join-Path $OutputRoot $ArtifactName
    Reset-Directory $artifactDirectory

    Invoke-CheckedCommand -Executable "npm" -Arguments @("ci") -WorkingDirectory $projectPath
    Invoke-CheckedCommand -Executable "npm" -Arguments @("test", "--", "--watchAll=false", "--runInBand") -WorkingDirectory $projectPath

    $previousCi = $env:CI
    $previousNodeOptions = $env:NODE_OPTIONS
    try {
        $env:CI = "true"
        # CRA 4/Webpack 4 still needs the OpenSSL compatibility provider on current Node LTS.
        $env:NODE_OPTIONS = "--openssl-legacy-provider"
        Invoke-CheckedCommand -Executable "npm" -Arguments @("run", "build") -WorkingDirectory $projectPath
    }
    finally {
        $env:CI = $previousCi
        $env:NODE_OPTIONS = $previousNodeOptions
    }

    Copy-Item -Path (Join-Path $buildPath "*") -Destination $artifactDirectory -Recurse -Force
    Compress-Directory -Source $artifactDirectory -Destination (Join-Path $OutputRoot "$ArtifactName.zip")
}

function Build-DotnetApi {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectFile,
        [Parameter(Mandatory = $true)][string]$ArtifactName
    )

    $projectPath = Join-Path $RepositoryRoot $ProjectFile
    $artifactDirectory = Join-Path $OutputRoot $ArtifactName
    Reset-Directory $artifactDirectory

    $arguments = @(
        "publish",
        $projectPath,
        "--configuration", $Configuration,
        "--output", $artifactDirectory,
        "--self-contained", "false"
    )

    if (-not [string]::IsNullOrWhiteSpace($RuntimeIdentifier)) {
        $arguments += @("--runtime", $RuntimeIdentifier)
    }

    Invoke-CheckedCommand -Executable "dotnet" -Arguments $arguments -WorkingDirectory $RepositoryRoot
    Compress-Directory -Source $artifactDirectory -Destination (Join-Path $OutputRoot "$ArtifactName.zip")
}

$RepositoryRoot = (Resolve-Path $RepositoryRoot).Path
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$OutputRoot = (Resolve-Path $OutputRoot).Path

Write-Host "Repository: $RepositoryRoot"
Write-Host "Artifacts:  $OutputRoot"
Write-Host "Target:     $Target"
Write-Host "Config:     $Configuration"

if ($Target -in @("User", "All")) {
    Build-WebClient -Folder "Webclient.app" -ArtifactName "webclient-user"
    Build-DotnetApi -ProjectFile "Api.User/Api.User.csproj" -ArtifactName "api-user"
}

if ($Target -in @("Admin", "All")) {
    Build-WebClient -Folder "Webclient.admin" -ArtifactName "webclient-admin"
    Build-DotnetApi -ProjectFile "Api.Admin/Api.Admin.csproj" -ArtifactName "api-admin"
}

Write-Host "Release packaging completed successfully." -ForegroundColor Green
