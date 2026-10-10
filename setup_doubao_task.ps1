# Doubao signer autostart + daily keep-alive
# Usage: run this file in an ADMINISTRATOR PowerShell window
$taskName = "DoubaoSignService"
$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$bat = Join-Path $dir "doubao_signer.bat"

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$bat`""
$tLogon = New-ScheduledTaskTrigger -AtLogOn
$tDaily = New-ScheduledTaskTrigger -Daily -At "08:20"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBattery -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($tLogon, $tDaily) -Settings $settings -Force

Write-Host "OK: task '$taskName' created."
Write-Host "  Trigger 1: at user logon"
Write-Host "  Trigger 2: daily 08:20 (keep-alive, also catches missed runs via StartWhenAvailable)"
Write-Host "Run now to test:  schtasks /run /tn $taskName"
