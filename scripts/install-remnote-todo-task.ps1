param(
    [string]$Config = 'D:\AppData\WakeWire\workflows\remnote-todo\config.json',
    [string]$TaskName = 'WakeWire - RemNote Todo 0200',
    [string]$RuntimeRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$Pythonw = (Get-Command pythonw.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source,
    [string]$HiddenRunner = 'D:\Projects\DeveloperGovernance\run-hidden.pyw',
    [switch]$UpdateActionOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'remnote-task-action.ps1')
if ((Get-TimeZone).Id -ne 'China Standard Time') { throw 'This schedule requires China Standard Time.' }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Workflow configuration is missing.' }
$runner = Join-Path $RuntimeRoot 'scripts/run-remnote-todo.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'The scheduled workflow runner is missing.' }
$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing -and (@($existing.Actions).Count -ne 1 -or
    -not ([string]$existing.Actions[0].Arguments).Contains(('"'+$runner+'"'), [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Task name is already used by a different program.'
}
$arguments = '-NoLogo -NoProfile -WindowStyle Hidden -File "'+$runner+'" -Config "'+$Config+'"'
if ($UpdateActionOnly) {
    if (-not $existing) { throw 'The scheduled task must exist to update its action.' }
    Update-WakeWireRemNoteTaskAction -Task $existing -Arguments $arguments -WorkingDirectory $RuntimeRoot -Pythonw $Pythonw -HiddenRunner $HiddenRunner
    return
}
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$action = New-WakeWireRemNoteHiddenAction -PowerShell $pwsh -Arguments $arguments -WorkingDirectory $RuntimeRoot -Pythonw $Pythonw -HiddenRunner $HiddenRunner
$now = Get-Date
$triggers = @(1, 2, 11, 17 | ForEach-Object {
    $start = $now.Date.AddHours($_)
    if ($start -le $now) { $start = $start.AddDays(1) }
    New-ScheduledTaskTrigger -Daily -At $start
})
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 23) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
# Registration never runs the live document. First dispatch occurs at the saved next trigger.
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName,NextRunTime,LastRunTime,LastTaskResult
