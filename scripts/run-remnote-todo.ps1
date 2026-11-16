param(
    [string]$Config = 'D:\AppData\WakeWire\workflows\remnote-todo\config.json',
    [string]$Entry = 'D:\Applications\WakeWire\node_modules\wakewire\dist\workflows\remnote-todo-cli.js',
    [string]$Node = 'C:\Program Files\nodejs\node.exe',
    [ValidateSet('scheduled','run','promote')][string]$Action = 'scheduled'
)
$ErrorActionPreference = 'Stop'
$log = Join-Path (Split-Path -Parent $Config) 'scheduler.log'
$maintenanceExit = 0
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($Action -eq 'promote' -or ($Action -eq 'scheduled' -and (Get-Date).Hour -eq 1)) {
    & $Node $Entry promote $Config 2>&1 | Tee-Object -FilePath $log -Append
    exit $LASTEXITCODE
}
if ($settings.maintenanceConfigFile -and -not $settings.maintenanceDocumentsFile) {
    $maintenanceEntry = Join-Path (Split-Path -Parent $Entry) 'remnote-maintenance-cli.js'
    & $Node $maintenanceEntry run $settings.maintenanceConfigFile 2>&1 | Tee-Object -FilePath $log -Append
    $maintenanceExit = $LASTEXITCODE
}
& $Node $Entry run $Config 2>&1 | Tee-Object -FilePath $log -Append
$todoExit = $LASTEXITCODE
if ($maintenanceExit -ne 0) { exit $maintenanceExit }
exit $todoExit
