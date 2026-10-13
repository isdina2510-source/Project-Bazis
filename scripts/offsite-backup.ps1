# Копии данных сайта вне Docker: база PostgreSQL, выпущенные документы, печать и подпись, загруженные картинки —
# в обычные папки Windows. Резервные копии, которые делает сам сервер (data/backups), лежат в томе Docker: они не спасут,
# если удалить тома (docker compose down -v), сбросить Docker Desktop или потерять диск. Эти копии — спасут.
#
#   install   — задача планировщика «Bazis Backup» (каждый день в 03:00, пропущенный запуск — при первой возможности)
#               и сразу первая копия. -Target "D:\Bazis-backups;E:\Копии" — одна или несколько папок через «;»;
#   run       — сделать копию сейчас (без -Target — в папки, заданные при установке);
#   status    — задача и последние копии в каждой папке;
#   restore   — восстановить данные из копии (-From <папка копии>; без него — самая свежая), перед этим текущие данные
#               сохраняются такой же копией в data-before-restore-<дата> (при сбое восстановления они возвращаются);
#   uninstall — удалить задачу (сами копии остаются).
#
# Копия — папка bazis-<дата_время> с database.json.gz (вся база, scripts/backup-snapshot.js), data\documents, data\company,
# uploads и manifest.json (размер и SHA-256 каждого файла, число записей). Пока данные не перенесены из SQLite (до первого
# запуска новой версии), вместо database.json.gz копируется data\bazis.db. Снимок делается во временном контейнере сайта
# (docker compose run) — сайт и база продолжают работать. Копия засчитывается, только если после переноса в папку все контрольные суммы совпали;
# незавершённая копия лежит как _incomplete-<дата> и удаляется следующим запуском. Хранятся последние -Keep копий.
# Если копия не удалась, в папке появляется BACKUP-FAILED.txt с причиной; удачная копия его убирает.
param(
  [ValidateSet("install", "uninstall", "status", "run", "restore")]
  [string]$Action = "status",
  [string]$Target = "",
  [int]$Keep = 30,
  [string]$From = ""
)
$ErrorActionPreference = "Stop"

$TaskName = "Bazis Backup"
$Root = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $Root "docker-compose.yml"
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "backup.log"
# Имена закреплены в docker-compose.yml (name: project, image: bazis-site).
$Image = "bazis-site"
$DataVolume = "project_bazis-data"
$UploadsVolume = "project_bazis-uploads"
$FailedFlag = "BACKUP-FAILED.txt"
$BackupDirRe = '^bazis-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$'
$EngineWaitSeconds = 600
$HealthWaitSeconds = 180
$StaleHours = 48

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
function Get-DockerExe {
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

function Invoke-Docker {
  # Docker пишет предупреждения в stderr; при Stop PowerShell 5.1 счёл бы их ошибкой — важен только код выхода.
  $ErrorActionPreference = "Continue"
  $out = & $script:Docker @args 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($out | Out-String).Trim() }
}

function Invoke-Checked([string]$What) {
  $result = Invoke-Docker @args
  if ($result.Code -ne 0) { throw "$What не удалось (код $($result.Code)): $($result.Output)" }
  $result.Output
}

# Docker Desktop поднимает задача «Bazis Docker Watchdog» — здесь только ждём движок.
function Wait-Engine {
  $deadline = (Get-Date).AddSeconds($EngineWaitSeconds)
  while ($true) {
    if ((Invoke-Docker info --format "{{.ServerVersion}}").Code -eq 0) { return }
    if ((Get-Date) -ge $deadline) { throw "Docker не отвечает $EngineWaitSeconds с — откройте Docker Desktop." }
    Start-Sleep -Seconds 10
  }
}

function Assert-DockerData {
  if (-not (Test-Path (Join-Path $Root "data\DATA-MOVED.txt"))) {
    throw "Рабочие данные — в папке data, а не в Docker (switch-to-docker.bat не выполнялся): этот скрипт копирует данные из Docker."
  }
  # Тома базы PostgreSQL (project_bazis-pg) до первого запуска новой версии ещё нет — данные тогда в bazis.db тома data.
  foreach ($volume in @($DataVolume, $UploadsVolume)) {
    if ((Invoke-Docker volume inspect $volume).Code -ne 0) { throw "Нет тома Docker $volume — данные сайта не найдены." }
  }
  if ((Invoke-Docker image inspect $Image).Code -ne 0) { throw "Нет образа $Image — соберите его: update-site.bat." }
}

function Split-Targets([string]$Value) {
  @($Value -split ";" | ForEach-Object { $_.Trim().Trim('"') } | Where-Object { $_ } |
    ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique)
}

function Get-DefaultTargets {
  $system = $env:SystemDrive.TrimEnd("\").ToUpper()
  $other = Get-PSDrive -PSProvider FileSystem |
    Where-Object { $_.Root -match '^[A-Z]:\\$' -and $_.Name -ne $system.TrimEnd(":") -and $_.Free -gt 1GB } |
    Where-Object { (New-Object IO.DriveInfo $_.Root).DriveType -eq "Fixed" } |
    Select-Object -First 1
  if ($other) { return @("$($other.Root)Bazis-backups") }
  @(Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Bazis-backups")
}

function Get-InstalledTargets {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task -or $task.Actions[0].Arguments -notmatch '-Target "([^"]+)"') { return @() }
  Split-Targets $Matches[1]
}

function Get-Backups([string]$Dir) {
  if (-not (Test-Path $Dir)) { return @() }
  @(Get-ChildItem -Path $Dir -Directory | Where-Object { $_.Name -match $BackupDirRe } | Sort-Object Name)
}

function Get-BackupTime([string]$Name) {
  [datetime]::ParseExact($Name.Substring(6), "yyyy-MM-dd_HH-mm-ss", $null)
}

function Read-Manifest([string]$Dir) {
  $file = Join-Path $Dir "manifest.json"
  if (-not (Test-Path $file)) { throw "В $Dir нет manifest.json — это не копия или она не завершена." }
  Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
}

function Format-Counts($Manifest) {
  $c = $Manifest.counts
  "заказов $($c.orders), клиентов $($c.clients), товаров $($c.products), документов $($c.documents)"
}

# Каждый файл копии на месте и совпадает по SHA-256 с тем, что записано при снимке.
function Test-BackupFolder([string]$Dir) {
  $manifest = Read-Manifest $Dir
  foreach ($file in $manifest.files) {
    $full = Join-Path $Dir ($file.path -replace "/", "\")
    if (-not (Test-Path -LiteralPath $full)) { throw "В копии $Dir нет файла $($file.path)." }
    if ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ne $file.sha256) {
      throw "Файл $($file.path) в $Dir отличается от исходного."
    }
  }
  $manifest
}

# Разовый контейнер сайта (docker compose run): тома данных и DATABASE_URL — как у сайта, postgres запускается, если стоит.
# Сервер в нём не запускается; работающий сайт не останавливается.
function Invoke-Helper([string[]]$Mounts, [string[]]$Command) {
  $volumeArgs = @("-v", "${PSScriptRoot}:/scripts:ro")
  foreach ($mount in $Mounts) { $volumeArgs += @("-v", $mount) }
  $runArgs = @("compose", "-f", $ComposeFile, "run", "--rm", "-T", "--user", "root") + $volumeArgs + @("bazis") + $Command
  Invoke-Docker @runArgs
}

# Снимок базы и файлов прямо в папку $Staging на этом компьютере.
function New-Snapshot([string]$Staging) {
  New-Item -ItemType Directory -Force $Staging | Out-Null
  $run = Invoke-Helper @("${Staging}:/snapshot") @("node", "--no-warnings", "/scripts/backup-snapshot.js", "snapshot", "/snapshot")
  if ($run.Code -ne 0 -or $run.Output -notmatch "(?m)^ok\r?$") { throw "Снимок не сделан: $($run.Output)" }
}

function Remove-OldBackups([string]$Dir, [string]$Current) {
  Get-ChildItem -Path $Dir -Directory -Filter "_incomplete-*" | Where-Object { $_.Name -ne $Current } |
    ForEach-Object { Remove-Item -Recurse -Force -LiteralPath $_.FullName }
  $backups = Get-Backups $Dir
  if ($backups.Count -gt $Keep) {
    $backups | Select-Object -First ($backups.Count - $Keep) | ForEach-Object { Remove-Item -Recurse -Force -LiteralPath $_.FullName }
  }
}

function Copy-ToTarget([string]$Staging, [string]$Dir, [string]$Stamp) {
  New-Item -ItemType Directory -Force $Dir | Out-Null
  $incomplete = "_incomplete-$Stamp"
  $temp = Join-Path $Dir $incomplete
  New-Item -ItemType Directory -Force $temp | Out-Null
  Copy-Item -Path (Join-Path $Staging "*") -Destination $temp -Recurse -Force
  Test-BackupFolder $temp | Out-Null
  Rename-Item -LiteralPath $temp -NewName "bazis-$Stamp"
  Remove-OldBackups $Dir ""
  Remove-Item -Force -LiteralPath (Join-Path $Dir $FailedFlag) -ErrorAction SilentlyContinue
  Join-Path $Dir "bazis-$Stamp"
}

function Write-FailedFlag([string]$Dir, [string]$Reason) {
  try {
    New-Item -ItemType Directory -Force $Dir | Out-Null
    $text = "Копия $(Get-Date -Format 'yyyy-MM-dd HH:mm') не удалась: $Reason`r`nПодробности: $LogFile`r`n"
    [IO.File]::WriteAllText((Join-Path $Dir $FailedFlag), $text, (New-Object Text.UTF8Encoding($true)))
  } catch {
    Write-Log "Не удалось записать $FailedFlag в ${Dir}: $($_.Exception.Message)"
  }
}

# Одна копия во все папки. Возвращает true, если во все папки копия легла и прошла проверку.
function Invoke-Backup([string[]]$Targets) {
  $stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
  $staging = Join-Path $env:TEMP "bazis-backup-$stamp"
  try {
    $script:Docker = Get-DockerExe
    Wait-Engine
    Assert-DockerData
    New-Snapshot $staging
    $manifest = Test-BackupFolder $staging
  } catch {
    Write-Log "ОШИБКА копии: $($_.Exception.Message)"
    foreach ($dir in $Targets) { Write-FailedFlag $dir $_.Exception.Message }
    Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
    return $false
  }

  $ok = $true
  foreach ($dir in $Targets) {
    try {
      $done = Copy-ToTarget $staging $dir $stamp
      Write-Log "Копия готова: $done ($(Format-Counts $manifest), файлов $($manifest.files.Count))"
    } catch {
      $ok = $false
      Write-Log "ОШИБКА копии в ${dir}: $($_.Exception.Message)"
      Write-FailedFlag $dir $_.Exception.Message
    }
  }
  Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
  $ok
}

function Wait-Healthy {
  $deadline = (Get-Date).AddSeconds($HealthWaitSeconds)
  $status = ""
  while ((Get-Date) -lt $deadline) {
    $id = ((Invoke-Docker compose -f $ComposeFile ps -q bazis).Output -split "\s+")[0]
    if ($id) {
      $status = (Invoke-Docker inspect $id --format "{{.State.Health.Status}}").Output
      if ($status -eq "healthy") { return $true }
    }
    Start-Sleep -Seconds 5
  }
  Write-Log "Сайт не стал healthy за $HealthWaitSeconds с (состояние: $status). Причина: docker compose logs --tail 50"
  $false
}

# Данные из копии $Dir — в базу и тома: проверка копии, файлы документов, печати и картинок, затем база одной транзакцией,
# в конце сверка восстановленного с manifest.json. Копия времён SQLite (data\bazis.db) переносится в PostgreSQL.
# Печать и подпись не удаляются, а дополняются: имена файлов — по хешу содержимого, а в старых копиях папки company нет.
# Возвращает результат docker (Code, Output).
function Restore-Snapshot([string]$Dir) {
  $tool = "node --no-warnings /scripts/backup-snapshot.js"
  Invoke-Helper @("${Dir}:/restore:ro") @("sh", "-c", ("set -e; $tool verify /restore; " +
    "rm -rf /app/data/documents; find /app/images/uploads -mindepth 1 -delete; " +
    "if [ -d /restore/data ]; then cp -r /restore/data/. /app/data/; fi; cp -r /restore/uploads/. /app/images/uploads/; " +
    "rm -f /app/data/bazis.db /app/data/bazis.db-wal /app/data/bazis.db-shm; " +
    "chown -R node:node /app/data /app/images/uploads; " +
    "$tool restore-db /restore; $tool verify-restored /restore"))
}

function Invoke-Restore([string]$Source) {
  $manifest = Test-BackupFolder $Source
  Write-Host ""
  Write-Host "Копия: $Source"
  Write-Host "Создана: $(([datetime]$manifest.createdAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm')), $(Format-Counts $manifest)"
  Write-Host "Все заказы, клиенты, товары, документы и картинки, появившиеся после этой копии, будут заменены её содержимым"
  Write-Host "(текущие данные сначала сохранятся в отдельную папку). Сайт на время восстановления остановится."
  if ((Read-Host "Чтобы продолжить, введите ДА") -ne "ДА") { Write-Host "Отменено."; return }

  $script:Docker = Get-DockerExe
  Wait-Engine
  Assert-DockerData

  Write-Log "Восстановление из $Source"
  # Останавливается только сайт: база нужна для восстановления.
  Invoke-Checked "Остановка сайта" compose -f $ComposeFile stop bazis | Out-Null

  $stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
  $safe = Join-Path $Root "data-before-restore-$stamp"
  $haveSafe = $true
  try {
    New-Snapshot $safe
    Write-Log "Текущие данные сохранены в $safe"
  } catch {
    $haveSafe = $false
    Write-Log "Текущие данные сохранить не удалось: $($_.Exception.Message)"
    Write-Host "Если база пустая или повреждена, это ожидаемо. Без этой копии отменить восстановление будет нельзя."
    if ((Read-Host "Продолжить без сохранения текущих данных? Введите ДА") -ne "ДА") {
      Invoke-Docker compose -f $ComposeFile up -d | Out-Null
      Write-Host "Отменено, сайт запущен."
      return
    }
  }

  $run = Restore-Snapshot $Source
  if ($run.Code -ne 0 -or $run.Output -notmatch "(?m)^ok\r?$") {
    if (-not $haveSafe) { throw "Восстановление не удалось, сайт остановлен. Причина: $($run.Output)" }
    Write-Log "Восстановление не удалось: $($run.Output). Возвращаю прежние данные из $safe"
    $back = Restore-Snapshot $safe
    Invoke-Docker compose -f $ComposeFile up -d | Out-Null
    if ($back.Code -ne 0) { throw "Восстановление не удалось, и вернуть прежние данные тоже ($($back.Output)). Копия прежних данных: $safe" }
    throw "Восстановление не удалось, прежние данные возвращены, сайт запущен. Причина: $($run.Output)"
  }

  Invoke-Checked "Запуск сайта" compose -f $ComposeFile up -d | Out-Null
  if (Wait-Healthy) {
    Write-Log "Восстановлено из $Source ($(Format-Counts $manifest)); сайт работает. Прежние данные: $safe"
  } else {
    throw "Данные восстановлены, но сайт не запустился. Прежние данные: $safe"
  }
}

switch ($Action) {
  "install" {
    $targets = if ($Target) { Split-Targets $Target } else { Get-DefaultTargets }
    foreach ($dir in $targets) {
      New-Item -ItemType Directory -Force $dir | Out-Null
      $probe = Join-Path $dir ".write-test"
      [IO.File]::WriteAllText($probe, "ok")
      Remove-Item -Force $probe
    }
    $targetArg = $targets -join ";"
    $user = "$env:USERDOMAIN\$env:USERNAME"
    # Interactive — задача работает в сеансе пользователя, как и Docker Desktop.
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
      -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    $trigger = New-ScheduledTaskTrigger -Daily -At "03:00"
    # conhost --headless: задача работает без мигающего окна консоли.
    $arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" run -Target `"$targetArg`" -Keep $Keep"
    $taskAction = New-ScheduledTaskAction -Execute "conhost.exe" -Argument $arguments -WorkingDirectory $Root
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal `
      -Description "Bazis: ежедневная копия базы, документов и картинок из Docker в папки Windows" -Force | Out-Null

    Write-Host "Задача «$TaskName» установлена: каждый день в 03:00, хранятся последние $Keep копий."
    foreach ($dir in $targets) {
      Write-Host "  Папка копий: $dir"
      $inOneDrive = $env:OneDrive -and $dir.StartsWith($env:OneDrive.TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)
      if ($inOneDrive) {
        Write-Host "  Папка в OneDrive: копии уходят в облако, пока OneDrive запущен и в нём выполнен вход."
      } elseif ($dir.Substring(0, 2).ToUpper() -eq $env:SystemDrive.ToUpper()) {
        Write-Host "  ВНИМАНИЕ: эта папка на диске $env:SystemDrive вместе с Windows и Docker — от поломки диска она не спасёт."
      }
    }
    Write-Host ""
    Write-Host "Первая копия..."
    if (-not (Invoke-Backup $targets)) { exit 1 }
  }
  "uninstall" {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "Задача «$TaskName» удалена. Сделанные копии остались на месте."
    } else {
      Write-Host "Задача «$TaskName» не установлена."
    }
  }
  "run" {
    $targets = if ($Target) { Split-Targets $Target } else { Get-InstalledTargets }
    if (-not $targets) { Write-Log "ОШИБКА: не заданы папки копий — запустите install-backup.bat"; exit 1 }
    if (-not (Invoke-Backup $targets)) { exit 1 }
  }
  "status" {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host "Задача «$TaskName»: не установлена (install-backup.bat)"; break }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Задача «$TaskName»: $($task.State), последний запуск $($info.LastRunTime), код $($info.LastTaskResult), следующий $($info.NextRunTime)"
    foreach ($dir in (Get-InstalledTargets)) {
      $backups = Get-Backups $dir
      if (-not $backups) { Write-Host "  $dir — копий нет"; continue }
      $last = $backups[-1]
      $age = (Get-Date) - (Get-BackupTime $last.Name)
      $note = if ($age.TotalHours -gt $StaleHours) { "  ВНИМАНИЕ: последней копии больше $StaleHours ч" } else { "" }
      Write-Host "  $dir — копий $($backups.Count), последняя $($last.Name)$note"
      if (Test-Path (Join-Path $dir $FailedFlag)) { Write-Host "  ВНИМАНИЕ: $((Get-Content -Raw -Encoding UTF8 (Join-Path $dir $FailedFlag)).Trim())" }
    }
  }
  "restore" {
    try {
      $source = $From.Trim().Trim('"')
      if (-not $source) {
        $latest = Get-InstalledTargets | ForEach-Object { Get-Backups $_ } | Sort-Object Name | Select-Object -Last 1
        if (-not $latest) { throw "Копий не найдено — укажите папку копии: restore-backup.bat `"D:\Bazis-backups\bazis-...`"" }
        $source = $latest.FullName
      }
      Invoke-Restore ([IO.Path]::GetFullPath($source))
    } catch {
      Write-Log "ОШИБКА восстановления: $($_.Exception.Message)"
      exit 1
    }
  }
}
