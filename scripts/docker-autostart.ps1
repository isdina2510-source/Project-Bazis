# Автозапуск сайта в Docker (docker-compose.yml). Две задачи планировщика от имени текущего пользователя:
#   «Bazis Docker» — при входе в Windows: запускает Docker Desktop, поднимает сайт и ждёт, пока он станет healthy;
#   «Bazis Docker Watchdog» — каждые 5 минут: если Docker Desktop закрылся или упал, запускает его снова
#     (контейнер поднимается сам — restart: unless-stopped; остановленный вручную через docker compose stop/down не трогаем).
#     Если контейнер работает, но HEALTHCHECK (GET /api/health) два раза подряд сообщает unhealthy — docker restart,
#     запись в журнал и оповещение владельцу (notify/cli.js). Сам Docker unhealthy-контейнер не перезапускает.
# Docker Desktop работает только при вошедшем пользователе: чтобы сайт поднимался после перезагрузки без человека,
# включите автовход (setup-autologon.bat) — тогда после автовхода задача сразу блокирует экран.
# Вызывается из install-docker-autostart.bat и uninstall-docker-autostart.bat.
param(
  [ValidateSet("install", "uninstall", "status", "logon", "watch")]
  [string]$Action = "status"
)
$ErrorActionPreference = "Stop"

$TaskName = "Bazis Docker"
$WatchTaskName = "Bazis Docker Watchdog"
$LegacyTaskName = "Bazis Site"
$Root = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $Root "docker-compose.yml"
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "docker-autostart.log"
# Сколько проверок подряд (раз в 5 минут) контейнер был unhealthy; файл — потому что каждая проверка — новый процесс.
$UnhealthyFile = Join-Path $LogDir "docker-unhealthy.txt"
$UnhealthyLimit = 2
$EngineWaitSeconds = 300
$HealthWaitSeconds = 180

function Write-Log([string]$Message) {
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) {
    Move-Item -Force $LogFile ($LogFile -replace '\.log$', '.old.log')
  }
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  Write-Host $line
}

# Планировщик запускает задачу с PATH на момент входа — docker.exe ищем и по известным путям установки.
# BAZIS_DOCKER_EXE — подмена docker для тестов (test/docker-watchdog.test.js).
function Get-DockerExe {
  if ($env:BAZIS_DOCKER_EXE) { return $env:BAZIS_DOCKER_EXE }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"),
    (Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe")
  )
  $fromPath = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($fromPath) { $candidates = @($fromPath.Source) + $candidates }
  $found = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $found) { throw "docker.exe не найден — установлен ли Docker Desktop?" }
  $found
}

function Get-DockerDesktopExe {
  @(
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
    (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe")
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Invoke-Docker {
  # Docker пишет предупреждения в stderr; при Stop PowerShell 5.1 счёл бы их ошибкой — важен только код выхода.
  $ErrorActionPreference = "Continue"
  $out = & $script:Docker @args 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($out | Out-String).Trim() }
}

function Test-Engine {
  (Invoke-Docker info --format "{{.ServerVersion}}").Code -eq 0
}

# Docker Desktop уже работает — сразу true; иначе запускаем и ждём движок до $EngineWaitSeconds.
function Start-Engine {
  if (Test-Engine) { return $true }
  Write-Log "Docker не отвечает — запускаю Docker Desktop"
  $started = Invoke-Docker desktop start --detach
  if ($started.Code -ne 0) {
    $exe = Get-DockerDesktopExe
    if (-not $exe) { Write-Log "ОШИБКА: Docker Desktop не найден"; return $false }
    Start-Process -FilePath $exe
  }
  $deadline = (Get-Date).AddSeconds($EngineWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (Test-Engine) { Write-Log "Docker запущен"; return $true }
  }
  Write-Log "ОШИБКА: Docker не запустился за $EngineWaitSeconds с. Откройте Docker Desktop и посмотрите сообщение в нём."
  $false
}

function Get-SiteContainer {
  $ps = Invoke-Docker compose -f $ComposeFile ps -a -q bazis
  if ($ps.Code -ne 0 -or -not $ps.Output) { return $null }
  ($ps.Output -split "\s+")[0]
}

function Get-UnhealthyCount {
  if (-not (Test-Path $UnhealthyFile)) { return 0 }
  $value = 0
  if ([int]::TryParse((Get-Content $UnhealthyFile -Raw).Trim(), [ref]$value)) { return $value }
  0
}

function Set-UnhealthyCount([int]$Count) {
  if ($Count -le 0) { Remove-Item -LiteralPath $UnhealthyFile -Force -ErrorAction SilentlyContinue; return }
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
  Set-Content -Path $UnhealthyFile -Value $Count -Encoding ASCII
}

# Оповещение через модуль notify в одноразовом контейнере: переменные Telegram он берёт из .env (env_file),
# этот скрипт .env не читает. Сбой оповещения только пишется в журнал.
function Send-OwnerAlert([string]$Text) {
  $result = Invoke-Docker compose -f $ComposeFile run --rm --no-deps -T bazis node notify/cli.js $Text
  if ($result.Code -eq 0) { Write-Log "Оповещение владельцу: $($result.Output)" }
  else { Write-Log "Оповещение владельцу не отправлено (код $($result.Code)): $($result.Output)" }
}

# Работающий контейнер, который HEALTHCHECK считает unhealthy, Docker не перезапускает (restart: unless-stopped
# срабатывает только при выходе процесса). Перезапускаем сами после $UnhealthyLimit проверок подряд.
function Watch-Health {
  $container = Get-SiteContainer
  if (-not $container) { Set-UnhealthyCount 0; return }
  $state = (Invoke-Docker inspect $container --format "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}").Output
  $parts = "$state" -split "\s+"
  if ($parts[0] -ne "running") { Set-UnhealthyCount 0; return }
  $health = if ($parts.Count -gt 1) { $parts[1] } else { "" }
  if ($health -ne "unhealthy") {
    if ((Get-UnhealthyCount) -gt 0 -and $health -eq "healthy") { Write-Log "Сайт снова healthy" }
    if ($health -ne "starting") { Set-UnhealthyCount 0 }
    return
  }
  $count = (Get-UnhealthyCount) + 1
  if ($count -lt $UnhealthyLimit) {
    Set-UnhealthyCount $count
    Write-Log "Сайт unhealthy (проверка $count из $UnhealthyLimit): GET /api/health не отвечает 200. Подробности: docker inspect $container"
    return
  }
  Set-UnhealthyCount 0
  Write-Log "Сайт unhealthy $UnhealthyLimit проверки подряд — перезапускаю контейнер $container"
  $restart = Invoke-Docker restart $container
  if ($restart.Code -ne 0) {
    Write-Log "ОШИБКА docker restart: $($restart.Output)"
    Send-OwnerAlert "Сайт не отвечает на проверку здоровья, и перезапустить контейнер не удалось: $($restart.Output)"
    return
  }
  Write-Log "Контейнер перезапущен"
  Send-OwnerAlert "Сайт не отвечал на проверку здоровья (/api/health) 10 минут — контейнер перезапущен. Причина — в docker compose logs."
}

function Wait-Healthy([string]$Container) {
  $deadline = (Get-Date).AddSeconds($HealthWaitSeconds)
  $status = ""
  while ((Get-Date) -lt $deadline) {
    $status = (Invoke-Docker inspect $Container --format "{{.State.Health.Status}}").Output
    if ($status -eq "healthy") { return $true }
    Start-Sleep -Seconds 5
  }
  Write-Log "ОШИБКА: сайт не стал healthy за $HealthWaitSeconds с (состояние: $status). Причина: docker compose logs --tail 50"
  $false
}

# Вход выполнила сама Windows (автовход) сразу после загрузки, а не человек: экран оставлять открытым нельзя.
# Ручной вход позже (после выхода из системы) не блокируем — по времени с загрузки.
function Test-AutoLogonBoot {
  $winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction SilentlyContinue
  $uptime = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
  $winlogon.AutoAdminLogon -eq "1" -and $uptime.TotalMinutes -lt 10
}

function Assert-NoLegacyService {
  if (Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue) {
    throw "Установлена служба «$LegacyTaskName» (install-service.bat) — она занимает тот же порт и работает со старой папкой data. " +
      "Сначала запустите uninstall-service.bat от имени администратора."
  }
}

function New-HiddenAction([string]$Mode) {
  # conhost --headless: задача работает без мигающего окна консоли.
  $arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Mode"
  New-ScheduledTaskAction -Execute "conhost.exe" -Argument $arguments -WorkingDirectory $Root
}

switch ($Action) {
  "install" {
    if (-not (Test-Path $ComposeFile)) { throw "Не найден $ComposeFile" }
    if (-not (Test-Path (Join-Path $Root "data\DATA-MOVED.txt"))) {
      throw "Рабочие данные — в папке data, а не в Docker. Перенесите их: switch-to-docker.bat (он же включит автозапуск)."
    }
    Assert-NoLegacyService
    $script:Docker = Get-DockerExe
    $user = "$env:USERDOMAIN\$env:USERNAME"
    # Interactive — задача работает в сеансе пользователя: Docker Desktop без него не запускается.
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
      -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

    # Без задержки: после автовхода экран должен заблокироваться как можно раньше.
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
    Register-ScheduledTask -TaskName $TaskName -Action (New-HiddenAction "logon") -Trigger $logon -Settings $settings `
      -Principal $principal -Description "Bazis: Docker Desktop + сайт (docker compose up -d) при входе в Windows" -Force | Out-Null

    $watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $WatchTaskName -Action (New-HiddenAction "watch") -Trigger $watch -Settings $settings `
      -Principal $principal -Description "Bazis: перезапуск Docker Desktop, если он закрылся или упал" -Force | Out-Null

    Write-Host "Автозапуск установлен: задачи «$TaskName» и «$WatchTaskName»."
    Write-Host "Журнал: $LogFile"
  }
  "uninstall" {
    foreach ($name in @($TaskName, $WatchTaskName)) {
      if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "Задача «$name» удалена."
      }
    }
    Write-Host "Сайт в Docker продолжает работать; остановить: docker compose down."
  }
  "status" {
    foreach ($name in @($TaskName, $WatchTaskName)) {
      $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      if (-not $task) { Write-Host "Задача «$name»: не установлена"; continue }
      $info = Get-ScheduledTaskInfo -TaskName $name
      Write-Host "Задача «$name»: $($task.State), последний запуск $($info.LastRunTime), код $($info.LastTaskResult)"
    }
  }
  "logon" {
    try {
      if (Test-AutoLogonBoot) {
        rundll32.exe user32.dll,LockWorkStation
        Write-Log "Автовход после загрузки: экран заблокирован"
      }
      $script:Docker = Get-DockerExe
      Write-Log "Вход в Windows: запуск сайта"
      if (-not (Start-Engine)) { exit 1 }
      # up -d не трогает уже работающий контейнер; если образа нет — соберёт его.
      $up = Invoke-Docker compose -f $ComposeFile up -d
      if ($up.Code -ne 0) { Write-Log "ОШИБКА docker compose up: $($up.Output)"; exit 1 }
      $container = Get-SiteContainer
      if (-not $container) { Write-Log "ОШИБКА: контейнер сайта не найден после docker compose up"; exit 1 }
      if (-not (Wait-Healthy $container)) { exit 1 }
      Write-Log "Сайт работает"
    } catch {
      Write-Log "ОШИБКА: $($_.Exception.Message)"
      exit 1
    }
  }
  "watch" {
    try {
      $script:Docker = Get-DockerExe
      if (-not (Start-Engine)) { exit 1 }
      Watch-Health
    } catch {
      Write-Log "ОШИБКА: $($_.Exception.Message)"
      exit 1
    }
  }
}
