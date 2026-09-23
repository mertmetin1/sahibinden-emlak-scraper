# Starts Postgres/Redis (docker), then API + worker + Next.js bound for LAN.
# Watches storage/desktop-stack.stop (written by POST /api/stack/stop).
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root
$env:Path = "$env:APPDATA\npm;$env:Path"
$env:DESKTOP_STACK = '1'
$env:API_HOST = '0.0.0.0'
$Host.UI.RawUI.WindowTitle = 'Sahibinden Panel'

$storage = Join-Path $Root 'storage'
$logDir = Join-Path $storage 'logs'
$stopFile = Join-Path $storage 'desktop-stack.stop'
$pidFile = Join-Path $storage 'desktop-stack.json'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if (Test-Path $stopFile) { Remove-Item $stopFile -Force }

function Test-ListenPort([int]$Port) {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return [bool]($listeners | Where-Object { $_.Port -eq $Port })
}

function Wait-ListenPort([int]$Port, [int]$Seconds = 90) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ListenPort $Port) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Get-LanUrls([int]$Port = 3000) {
    $urls = New-Object System.Collections.Generic.List[string]
    [void]$urls.Add("http://127.0.0.1:$Port")
    foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($nic.OperationalStatus -ne 'Up') { continue }
        foreach ($addr in $nic.GetIPProperties().UnicastAddresses) {
            if ($addr.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
            $ip = $addr.Address.ToString()
            if ($ip -like '127.*') { continue }
            [void]$urls.Add("http://${ip}:$Port")
        }
    }
    return $urls.ToArray()
}

function Stop-Tree([int]$ProcessId) {
    if ($ProcessId -le 0) { return }
    cmd /c "taskkill /PID $ProcessId /T /F >nul 2>&1"
}

function Stop-TitledWindows {
    foreach ($title in @('Sahibinden API*', 'Sahibinden Worker*', 'Sahibinden Web*')) {
        cmd /c "taskkill /FI `"WINDOWTITLE eq $title`" /T /F >nul 2>&1"
    }
}

function Import-PidFile {
    if (-not (Test-Path $pidFile)) { return $null }
    try { return Get-Content -Raw $pidFile | ConvertFrom-Json } catch { return $null }
}

$script:started = @{}

function Start-ServiceWindow([string]$Title, [string]$Command) {
    $proc = Start-Process -FilePath 'cmd.exe' -WorkingDirectory $Root -WindowStyle Minimized -PassThru -ArgumentList @(
        '/k',
        "title $Title && set DESKTOP_STACK=1 && set API_HOST=0.0.0.0 && set PATH=%APPDATA%\npm;%PATH% && $Command"
    )
    $script:started[$Title] = $proc.Id
    return $proc.Id
}

try {
    Write-Host ''
    Write-Host 'Sahibinden Panel baslatiliyor...'
    Write-Host "Klasor: $Root"
    Write-Host ''

    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { throw 'Docker bulunamadi. Postgres/Redis icin Docker Desktop gerekli.' }
    docker compose -f (Join-Path $Root 'docker-compose.yml') up -d postgres redis | Out-Host
    if (-not (Wait-ListenPort 5433 60)) { throw 'Postgres :5433 acilmadi.' }
    if (-not (Wait-ListenPort 6379 60)) { throw 'Redis :6379 acilmadi.' }
    Write-Host 'Postgres + Redis hazir.'

    $pnpm = Join-Path $env:APPDATA 'npm\pnpm.cmd'
    if (-not (Test-Path $pnpm)) { $pnpm = 'pnpm' }

    if (Test-ListenPort 3001) {
        Write-Host 'API zaten :3001 uzerinde — yeniden baslatilmiyor.'
    } else {
        [void](Start-ServiceWindow 'Sahibinden API' "`"$pnpm`" --filter @sahibindenbot/api start")
        if (-not (Wait-ListenPort 3001 90)) { throw 'API :3001 acilmadi. Sahibinden API penceresine bakin.' }
        Write-Host 'API :3001'
    }

    $alive = Join-Path $storage 'worker.alive'
    $workerFresh = $false
    if (Test-Path $alive) {
        $age = [DateTime]::UtcNow - (Get-Item $alive).LastWriteTimeUtc
        $workerFresh = $age.TotalSeconds -lt 30
    }
    $wmic = cmd /c "wmic process where name='node.exe' get CommandLine /format:list 2>nul"
    $workerProcess = $wmic -match 'apps\\worker|@sahibindenbot/worker'
    if ($workerFresh -or $workerProcess) {
        Write-Host 'Worker zaten calisiyor — yeniden baslatilmiyor.'
    } else {
        [void](Start-ServiceWindow 'Sahibinden Worker' "`"$pnpm`" --filter @sahibindenbot/worker start")
        Write-Host 'Worker baslatildi.'
    }

    if (Test-ListenPort 3000) {
        Write-Host 'Web zaten :3000 uzerinde — yeniden baslatilmiyor.'
    } else {
        [void](Start-ServiceWindow 'Sahibinden Web' "`"$pnpm`" --filter @sahibindenbot/web dev")
        if (-not (Wait-ListenPort 3000 90)) { throw 'Web :3000 acilmadi. Sahibinden Web penceresine bakin.' }
        Write-Host 'Web :3000 (0.0.0.0)'
    }

    @{
        apiPid    = $script:started['Sahibinden API']
        workerPid = $script:started['Sahibinden Worker']
        webPid    = $script:started['Sahibinden Web']
        startedAt = (Get-Date).ToString('o')
        root      = $Root
    } | ConvertTo-Json | Set-Content -Encoding utf8 $pidFile

    try {
        $rule = 'Sahibinden Panel Web 3000'
        $existing = netsh advfirewall firewall show rule name="$rule" 2>$null
        if (-not ($existing -match $rule)) {
            netsh advfirewall firewall add rule name="$rule" dir=in action=allow protocol=TCP localport=3000 profile=private | Out-Null
        }
    } catch {
        Write-Host 'Not: Windows Guvenlik Duvari kurali eklenemedi (yonetici gerekebilir).'
    }

    $urls = Get-LanUrls 3000
    Write-Host ''
    Write-Host 'Panel acik. Bu agdaki cihazlar:'
    foreach ($url in $urls) { Write-Host "  $url" }
    Write-Host ''
    Write-Host 'Durdurmak: panelde Ayarlar > Paneli ve worker''i durdur  veya bu pencerede Ctrl+C'
    Write-Host ''

    $local = 'http://127.0.0.1:3000'
    try { Start-Process $local } catch { Write-Host "Tarayici acilamadi: $local" }

    while (-not (Test-Path $stopFile)) {
        Start-Sleep -Seconds 2
    }
    Write-Host 'Panelden kapatma istegi alindi.'
}
finally {
    Write-Host 'Servisler durduruluyor...'
    $saved = Import-PidFile
    if ($saved) {
        foreach ($id in @($saved.apiPid, $saved.workerPid, $saved.webPid)) {
            if ($id) { Stop-Tree ([int]$id) }
        }
    }
    foreach ($id in $script:started.Values) { Stop-Tree ([int]$id) }
    Stop-TitledWindows
    if (Test-Path $stopFile) { Remove-Item $stopFile -Force -ErrorAction SilentlyContinue }
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
    Write-Host 'Kapandi. Postgres/Redis Docker''da kalir.'
}
