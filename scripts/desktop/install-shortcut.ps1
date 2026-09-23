# Creates/updates a Desktop shortcut that launches the LAN panel.
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$bat = Join-Path $PSScriptRoot 'start.bat'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Sahibinden Panel.lnk'

$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut($lnkPath)
$s.TargetPath = $bat
$s.WorkingDirectory = $Root
$s.WindowStyle = 1
$s.Description = 'Sahibinden yerel panel (web + API + worker, lokal ag)'
$s.Save()

Write-Host "Masaustu kisayolu: $lnkPath"
Write-Host "Hedef: $bat"
