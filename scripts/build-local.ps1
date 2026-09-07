[CmdletBinding()]
param(
    [string]$RuntimePath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($RuntimePath)) {
    $RuntimePath = Join-Path (Split-Path -Parent $projectRoot) 'CodexPet-runtime'
}
$runtimeDirectory = [System.IO.Path]::GetFullPath($RuntimePath)

Push-Location $projectRoot
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    cargo test --manifest-path src-tauri\Cargo.toml
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    cargo build --release --manifest-path src-tauri\Cargo.toml --features tauri/custom-protocol
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    Copy-Item -LiteralPath 'src-tauri\target\release\codexpet.exe' -Destination (Join-Path $runtimeDirectory 'CodexPet.exe') -Force
    $voiceDirectory = Join-Path $runtimeDirectory 'voice'
    New-Item -ItemType Directory -Force -Path $voiceDirectory | Out-Null
    foreach ($category in 'idle','running','waiting_input','waiting_choice','permission','completed','failed','interrupted','headpat') {
        New-Item -ItemType Directory -Force -Path (Join-Path $voiceDirectory $category) | Out-Null
    }
} finally {
    Pop-Location
}
