# Registers the skool+ bridge to start (hidden) whenever you log on to Windows.
# Run once from PowerShell:  pwsh -File bridge\install-startup.ps1
# Remove with:               Unregister-ScheduledTask -TaskName 'skool+ bridge' -Confirm:$false

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$script = Join-Path $root 'bridge\server.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'skool+ bridge' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'skool+ bridge'
Write-Host "skool+ bridge registered and started. Health: http://127.0.0.1:47391/health"
