function New-WakeWireRemNoteHiddenAction {
    param(
        [Parameter(Mandatory)][string]$PowerShell,
        [Parameter(Mandatory)][string]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$Pythonw,
        [Parameter(Mandatory)][string]$HiddenRunner
    )
    foreach ($file in @($PowerShell, $Pythonw, $HiddenRunner)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing task runtime: $file" }
    }
    $command = '"{0}" --no-timeout -- "{1}" {2}' -f $HiddenRunner, $PowerShell, $Arguments
    New-ScheduledTaskAction -Execute $Pythonw -Argument $command -WorkingDirectory $WorkingDirectory
}

function Update-WakeWireRemNoteTaskAction {
    param(
        [Parameter(Mandatory)]$Task,
        [Parameter(Mandatory)][string]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$Pythonw,
        [Parameter(Mandatory)][string]$HiddenRunner
    )
    if ($Task.State -notin 'Ready', 'Disabled' -or @($Task.Actions).Count -ne 1) {
        throw 'The existing task must be idle and have one action.'
    }
    $previous = $Task.Actions[0]
    if ([IO.Path]::GetFullPath($previous.WorkingDirectory).TrimEnd('\') -ne [IO.Path]::GetFullPath($WorkingDirectory).TrimEnd('\')) {
        throw 'The existing task is not bound to the supplied runtime directory.'
    }
    if ($previous.Arguments -eq $Arguments -and [IO.Path]::GetFileName($previous.Execute) -eq 'pwsh.exe') {
        $action = New-WakeWireRemNoteHiddenAction -PowerShell $previous.Execute -Arguments $Arguments -WorkingDirectory $previous.WorkingDirectory -Pythonw $Pythonw -HiddenRunner $HiddenRunner
        Set-ScheduledTask -TaskName $Task.TaskName -TaskPath $Task.TaskPath -Action $action | Out-Null
    } else {
        $prefix = '"' + $HiddenRunner + '" --no-timeout -- '
        $pattern = '^' + [regex]::Escape($prefix) + '"([^"]+)" ' + [regex]::Escape($Arguments) + '$'
        if ($previous.Execute -ne $Pythonw -or $previous.Arguments -notmatch $pattern) {
            throw 'The existing action does not match the expected workflow invocation.'
        }
    }
    Get-ScheduledTaskInfo -TaskName $Task.TaskName -TaskPath $Task.TaskPath |
        Select-Object TaskName,NextRunTime,LastRunTime,LastTaskResult
}
