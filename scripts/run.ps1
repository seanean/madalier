# Runs the Flask dev server (Windows PowerShell equivalent of `make run`).
# Run from repo root:  .\scripts\run.ps1

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$venvPython = Join-Path $RepoRoot 'venv\Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    Write-Error "Run .\scripts\setup.ps1 first (missing $venvPython)."
    exit 1
}

Set-Location $RepoRoot
& $venvPython (Join-Path $RepoRoot 'app.py')
