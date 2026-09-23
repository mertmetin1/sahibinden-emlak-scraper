# Stops API / worker / web started by the desktop shortcut. Leaves Docker DB/Redis up.
$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$storage = Join-Path $Root 'storage'
$stopFile = Join-Path $storage 'desktop-stack.stop'
$pidFile = Join-Path $storage 'desktop-stack.json'

New-Item -ItemType Directory -Force -Path $storage | Out-Null
Set-Content -Encoding utf8 $stopFile ((Get-Date).ToString('o'))

function Stop-Tree([int]$ProcessId) {
    if ($ProcessId -le 0) { return }
    cmd /c "taskkill /PID $ProcessId /T /F >nul 2>&1"
}

if (Test-Path $pidFile) {
    try {
        $saved = Get-Content -Raw $pidFile | ConvertFrom-Json
        foreach ($id in @($saved.apiPid, $saved.workerPid, $saved.webPid)) {
            if ($id) { Stop-Tree ([int]$id) }
        }
    } catch {}
}

foreach ($title in @('Sahibinden API*', 'Sahibinden Worker*', 'Sahibinden Web*', 'Sahibinden Panel*')) {
    cmd /c "taskkill /FI `"WINDOWTITLE eq $title`" /T /F >nul 2>&1"
}

Start-Sleep -Seconds 1
if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
Write-Host 'Panel / API / worker durduruldu. Postgres ve Redis calismaya devam eder.'
