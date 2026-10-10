# Doubao signer autostart + daily keep-alive
# Run in an ADMINISTRATOR PowerShell (or via install_doubao_autostart.bat)
$taskName = "DoubaoSignService"
$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$bat = Join-Path $dir "doubao_signer.bat"

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$bat`""
$tLogon = New-ScheduledTaskTrigger -AtLogOn
$tDaily = New-ScheduledTaskTrigger -Daily -At "08:20"

# Build settings dynamically: only pass params the local ScheduledTasks module actually supports.
# (Some Windows builds lack -DontStopIfGoingOnBattery / -RestartCount, which caused a hard failure before.)
$cmd = Get-Command New-ScheduledTaskSettingsSet
$sp = @{}
if ($cmd.Parameters.ContainsKey('AllowStartIfOnBatteries')) { $sp['AllowStartIfOnBatteries'] = $true }
if ($cmd.Parameters.ContainsKey('DontStopIfGoingOnBattery')) { $sp['DontStopIfGoingOnBattery'] = $true }
if ($cmd.Parameters.ContainsKey('StartWhenAvailable')) { $sp['StartWhenAvailable'] = $true }
if ($cmd.Parameters.ContainsKey('RestartCount')) { $sp['RestartCount'] = 5 }
if ($cmd.Parameters.ContainsKey('RestartInterval')) { $sp['RestartInterval'] = [TimeSpan]::FromMinutes(1) }
if ($cmd.Parameters.ContainsKey('ExecutionTimeLimit')) { $sp['ExecutionTimeLimit'] = [TimeSpan]::Zero }
$settings = New-ScheduledTaskSettingsSet @sp

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($tLogon, $tDaily) -Settings $settings -Force

# Verify the task really exists before reporting success.
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "OK: task '$taskName' created."
    Write-Host "  Trigger 1: at user logon"
    Write-Host "  Trigger 2: daily 08:20 (keep-alive)"
    if ($cmd.Parameters.ContainsKey('RestartCount')) { Write-Host "  Windows auto-restart on crash: enabled" } else { Write-Host "  Windows auto-restart: n/a (bat self-heal loop covers crashes)" }
    Write-Host "Run now to test:  schtasks /run /tn $taskName"
} else {
    Write-Error "FAILED: scheduled task was not created. Check the ScheduledTasks module / admin rights."
    exit 1
}
