# Creates venv and installs dependencies (Windows PowerShell equivalent of `make setup`).
# Run from repo root:  .\scripts\setup.ps1
# If execution is blocked:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

$venvPython = Join-Path $RepoRoot 'venv\Scripts\python.exe'
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error 'Python is not on PATH. Install Python 3.10+ and try again.'
    exit 1
}

python -m venv (Join-Path $RepoRoot 'venv')
if (-not (Test-Path $venvPython)) {
    Write-Error 'venv creation failed (venv\Scripts\python.exe missing).'
    exit 1
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r (Join-Path $RepoRoot 'requirements.txt')
Write-Host 'Setup complete. Run .\scripts\run.ps1 or venv\Scripts\python.exe app.py'
