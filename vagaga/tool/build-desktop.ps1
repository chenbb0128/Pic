$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $projectRoot 'src-tauri\target'
$exePath = Join-Path $targetDir 'release\vagaga.exe'
$previousTargetDir = [Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR', 'Process')

Push-Location -LiteralPath $projectRoot
try {
    # Keep this project's build output inside the source tree, even when the
    # caller has configured a shared Cargo target directory elsewhere.
    $env:CARGO_TARGET_DIR = $targetDir
    Write-Host "Build output: $exePath"
    & pnpm tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop build failed (exit code $LASTEXITCODE)."
    }
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
        throw "Build completed but executable was not found: $exePath"
    }
    Write-Host "Executable: $exePath"
}
finally {
    [Environment]::SetEnvironmentVariable('CARGO_TARGET_DIR', $previousTargetDir, 'Process')
    Pop-Location
}
