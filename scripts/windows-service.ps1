# Сайт как служба Windows: задача планировщика «Bazis Site» запускает run-server.bat при старте компьютера
# от имени SYSTEM — без входа в систему и без открытого окна. Вызывается из install-service.bat,
# uninstall-service.bat и update-site.bat.
param(
  [ValidateSet("install", "uninstall", "restart", "status")]
  [string]$Action = "status"
)
$ErrorActionPreference = "Stop"

$TaskName = "Bazis Site"
$Root = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $Root "run-server.bat"

function Get-SitePort {
  $port = 8787
  $envFile = Join-Path $Root ".env"
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$' } | Select-Object -Last 1
    if ($line -match '(\d+)') { $port = [int]$Matches[1] }
  }
  $port
}

# server.js --check-config проверяет .env и сразу выходит; при ошибке работающий сайт не трогаем.
function Assert-SiteConfig {
  $node = Join-Path $Root ".tools\node-v22.20.0-win-x64\node.exe"
  if (-not (Test-Path $node)) { $node = "node" }
  Push-Location $Root
  try {
    & $node server.js --check-config
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { throw "Настройки сервера неверны (см. сообщение выше) — служба не изменена." }
}

function Get-Task {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# Завершение задачи останавливает run-server.bat; node, слушающий порт сайта, добиваем отдельно,
# иначе новый запуск упрётся в занятый порт.
function Stop-Site {
  if (Get-Task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  $port = Get-SitePort
  for ($i = 0; $i -lt 10; $i++) {
    $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    $nodes = @($owners | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_.ProcessName -eq "node" })
    if (-not $nodes.Count) { return }
    if ($i -eq 5) { $nodes | Stop-Process -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
}

switch ($Action) {
  "install" {
    if (-not (Test-Path $Runner)) { throw "Не найден $Runner" }
    if (Get-ScheduledTask -TaskName "Bazis Docker" -ErrorAction SilentlyContinue) {
      throw "Сайт запускается в Docker (задача «Bazis Docker») — служба заняла бы тот же порт и работала бы со старой папкой data. " +
        "Если вы возвращаетесь к запуску без Docker, сначала запустите uninstall-docker-autostart.bat."
    }
    Assert-SiteConfig
    $taskAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$Runner`" service`"" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    # ExecutionTimeLimit 0 — без лимита (по умолчанию планировщик снимает задачу через 3 дня).
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Stop-Site
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings `
      -Principal $principal -Description "Bazis site + CRM (run-server.bat service)" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Служба «$TaskName» установлена и запущена: http://127.0.0.1:$(Get-SitePort)"
    Write-Host "Журнал сервера: $(Join-Path $Root 'server-run.log')"
  }
  "uninstall" {
    if (-not (Get-Task)) { Write-Host "Служба «$TaskName» не установлена."; break }
    Stop-Site
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Служба «$TaskName» остановлена и удалена."
  }
  "restart" {
    if (-not (Get-Task)) { Write-Host "Служба «$TaskName» не установлена."; exit 2 }
    Assert-SiteConfig
    Stop-Site
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Служба «$TaskName» перезапущена."
  }
  "status" {
    $task = Get-Task
    if (-not $task) { Write-Host "Служба «$TaskName» не установлена."; break }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Служба «$TaskName»: $($task.State), последний запуск $($info.LastRunTime), код $($info.LastTaskResult)"
  }
}
