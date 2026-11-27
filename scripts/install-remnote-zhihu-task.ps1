param(
    [string]$Config = 'D:\AppData\WakeWire\workflows\remnote-zhihu\config.json',
    [string]$TaskName = 'WakeWire - RemNote Zhihu Articles',
    [switch]$Disabled,
    [string]$RuntimeRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$Pythonw = (Get-Command pythonw.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source,
    [string]$HiddenRunner = 'D:\Projects\DeveloperGovernance\run-hidden.pyw',
    [switch]$UpdateActionOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'remnote-task-action.ps1')
if ((Get-TimeZone).Id -ne 'China Standard Time') { throw 'This schedule requires China Standard Time.' }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Workflow configuration is missing.' }
$runner = Join-Path $RuntimeRoot 'scripts/run-remnote-zhihu.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'The scheduled workflow runner is missing.' }
$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing -and (@($existing.Actions).Count -ne 1 -or
    -not ([string]$existing.Actions[0].Arguments).Contains(('"'+$runner+'"'), [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Task name is already used by a different program.'
}
$arguments = '-NoLogo -NoProfile -WindowStyle Hidden -File "'+$runner+'" -Config "'+$Config+'"'
if ($UpdateActionOnly) {
    if (-not $existing -or $Disabled) { throw 'Action-only updates require an existing task and preserve its enabled state.' }
    Update-WakeWireRemNoteTaskAction -Task $existing -Arguments $arguments -WorkingDirectory $RuntimeRoot -Pythonw $Pythonw -HiddenRunner $HiddenRunner
    return
}
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$action = New-WakeWireRemNoteHiddenAction -PowerShell $pwsh -Arguments $arguments -WorkingDirectory $RuntimeRoot -Pythonw $Pythonw -HiddenRunner $HiddenRunner
$now = Get-Date
$triggers = @('09:30', '11:30', '15:30', '17:30', '20:30', '22:30' | ForEach-Object {
    $start = $now.Date.Add([TimeSpan]::Parse($_))
    if ($start -le $now) { $start = $start.AddDays(1) }
    New-ScheduledTaskTrigger -Daily -At $start
})
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
# The CLI also enforces each window. Do not catch up missed publication slots.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5) -Disable:$Disabled
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
# Registration does not execute a live publication.
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName,NextRunTime,LastRunTime,LastTaskResult
