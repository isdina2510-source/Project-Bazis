# Где работает сайт и лежат его файлы (выпущенные документы, печать и подпись, копии базы, загруженные картинки):
# в папке data или в Docker (тома project_bazis-*). Рабочая копия файлов всегда одна: у неактивной в папке данных лежит
# DATA-MOVED.txt, и server.js на ней не запускается.
#
# База данных при переключении не переносится: она одна — PostgreSQL в Docker (сервис postgres в docker-compose.yml).
# Сайт в Docker подключается к ней внутри Docker, сайт без Docker — по DATABASE_URL из .env (127.0.0.1:POSTGRES_HOST_PORT).
# Поэтому и для запуска без Docker нужен работающий Docker Desktop (включите в нём «Start when you sign in»).
#
#   to-docker  — перенести data и images\uploads в Docker, включить автозапуск (switch-to-docker.bat);
#   to-windows — вернуть файлы из Docker в папку data, выключить автозапуск сайта в Docker (switch-to-windows.bat);
#   mark       — файлы уже перенесены в Docker вручную: только пометить папку data устаревшей;
#   status     — где сейчас рабочая копия.
# Перенос засчитывается, только если отпечаток файлов (scripts/files-check.js) до и после копирования совпал.
param(
  [ValidateSet("to-docker", "to-windows", "mark", "status")]
  [string]$Action = "status",
  [switch]$Force
)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $Root "docker-compose.yml"
$HostData = Join-Path $Root "data"
$HostUploads = Join-Path $Root "images\uploads"
$MarkerName = "DATA-MOVED.txt"
$HostMarker = Join-Path $HostData $MarkerName
$Autostart = Join-Path $PSScriptRoot "docker-autostart.ps1"
$Stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"

function Invoke-Docker {
  $ErrorActionPreference = "Continue"
  $out = & docker @args 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($out | Out-String).Trim() }
}

function Invoke-Checked([string]$What) {
  $result = Invoke-Docker @args
  if ($result.Code -ne 0) { throw "$What не удалось (код $($result.Code)):`n$($result.Output)" }
  $result.Output
}

# Разовый контейнер из образа сайта с подключёнными папками компьютера (сервер в нём не запускается, база не нужна).
function Invoke-InImage([string[]]$Mounts, [string[]]$Command, [string]$What) {
  $volumeArgs = @("-v", "${PSScriptRoot}:/scripts:ro")
  foreach ($mount in $Mounts) { $volumeArgs += @("-v", $mount) }
  $runArgs = @("compose", "-f", $ComposeFile, "run", "--rm", "--no-deps", "-T") + $volumeArgs + @("bazis") + $Command
  Invoke-Checked $What @runArgs
}

function Assert-Engine {
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw "Docker не установлен (docker.exe не найден)." }
  if ((Invoke-Docker info --format "{{.ServerVersion}}").Code -ne 0) {
    throw "Docker не запущен: откройте Docker Desktop, дождитесь зелёного статуса и запустите снова."
  }
}

function Get-HostNode {
  $bundled = Join-Path $Root ".tools\node-v22.20.0-win-x64\node.exe"
  if (Test-Path $bundled) { return $bundled }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js не найден — нужен для проверки данных." }
  $node.Source
}

function Invoke-HostNode([string[]]$NodeArgs) {
  $ErrorActionPreference = "Continue"
  $out = & (Get-HostNode) --no-warnings @NodeArgs 2>&1
  [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($out | Out-String).Trim() }
}

# Строка files=… из files-check.js; при ошибке — исключение.
function Get-FilesLine([string]$Output, [string]$Where) {
  $line = $Output -split "`r?`n" | Where-Object { $_ -like "files=*" } | Select-Object -First 1
  if (-not $line) { throw "Не удалось проверить файлы ${Where}:`n$Output" }
  $line
}

function Test-HostFiles([string]$DataDir, [string]$UploadsDir, [string]$Where) {
  $result = Invoke-HostNode @((Join-Path $PSScriptRoot "files-check.js"), $DataDir, $UploadsDir)
  Get-FilesLine $result.Output $Where
}

function Test-VolumeFiles([string]$Where) {
  $out = Invoke-InImage @() @("node", "--no-warnings", "/scripts/files-check.js", "/app/data", "/app/images/uploads") "Проверка файлов в Docker"
  Get-FilesLine $out $Where
}

# Рабочая ли копия в Docker: в томе есть файлы и нет отметки о переносе.
function Test-VolumeActive {
  $state = Invoke-InImage @() @("sh", "-c", "if [ ! -f /app/data/$MarkerName ] && ls -A /app/data | grep -q .; then echo active; else echo inactive; fi") "Проверка данных в Docker"
  $state -match "(?m)^active" -and $state -notmatch "inactive"
}

function Read-EnvValue([string]$Name) {
  $file = Join-Path $Root ".env"
  if (-not (Test-Path $file)) { return "" }
  $line = Get-Content -Encoding UTF8 $file | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -Last 1
  if (-not $line) { return "" }
  ($line -replace "^\s*$Name\s*=\s*", "").Trim().Trim('"').Trim("'")
}

# Сайт без Docker должен работать с той же базой, что и в Docker (сервис postgres, опубликованный на 127.0.0.1).
function Assert-SharedDatabase {
  $url = Read-EnvValue "DATABASE_URL"
  $port = Read-EnvValue "POSTGRES_HOST_PORT"
  if (-not $port) { $port = "5432" }
  $expected = "127.0.0.1:$port/bazis или localhost:$port/bazis"
  if (-not $url) { throw "В .env не задан DATABASE_URL. Для запуска без Docker укажите базу из Docker: postgres://bazis:<POSTGRES_PASSWORD>@127.0.0.1:$port/bazis" }
  try { $uri = [Uri]$url } catch { throw "DATABASE_URL в .env — не адрес PostgreSQL." }
  $hostOk = @("127.0.0.1", "localhost") -contains $uri.Host
  $uriPort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
  if (-not ($hostOk -and "$uriPort" -eq $port -and $uri.AbsolutePath.TrimStart("/") -eq "bazis")) {
    throw "DATABASE_URL в .env указывает не на базу из Docker ($expected), а на $($uri.Host):$uriPort$($uri.AbsolutePath). " +
      "Переключение перенесло бы только файлы, а заказы остались бы в другой базе. Перенесите базу вручную: " +
      "npm run db:dump (копия из базы по DATABASE_URL), затем восстановите её в базу Docker (README, раздел «База данных»)."
  }
}

function Assert-NativeStopped {
  if (Get-ScheduledTask -TaskName "Bazis Site" -ErrorAction SilentlyContinue) {
    throw "Установлена служба «Bazis Site» — сначала запустите uninstall-service.bat от имени администратора."
  }
  $node = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq 8787 } |
    ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
    Where-Object { $_.ProcessName -eq "node" }
  if ($node) { throw "Сайт запущен без Docker (окно start-site.bat) — закройте это окно и запустите снова." }
}

function Write-Marker([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text + "`r`n", (New-Object Text.UTF8Encoding($false)))
}

$DockerNote = "Файлы сайта перенесены в Docker ($Stamp). Сайт запускается через start-site.bat (он запустит Docker), " +
  "обновление — update-site.bat. Вернуться к запуску без Docker: switch-to-windows.bat."
$WindowsNote = "Файлы сайта перенесены из Docker обратно в папку data ($Stamp). Вернуться в Docker: switch-to-docker.bat."

switch ($Action) {
  "status" {
    if (Test-Path $HostMarker) { Write-Host "Сайт работает в Docker. Папка data устарела." }
    else { Write-Host "Сайт работает без Docker (папка data)." }
    Write-Host "База данных — PostgreSQL в Docker (сервис postgres), общая для обоих режимов."
  }

  "mark" {
    if (Test-Path $HostMarker) { Write-Host "Папка data уже помечена как устаревшая."; break }
    Assert-Engine
    if (-not (Test-VolumeActive)) { throw "В Docker нет рабочих данных сайта — помечать папку data устаревшей нельзя." }
    Write-Marker $HostMarker $DockerNote
    Write-Host "Папка data помечена как устаревшая: сервер без Docker на ней больше не запустится."
  }

  "to-docker" {
    if (Test-Path $HostMarker) { Write-Host "Данные уже в Docker."; break }
    Assert-NativeStopped
    Assert-Engine
    Assert-SharedDatabase
    Write-Host "Сборка образа сайта (несколько минут)..."
    Invoke-Checked "Сборка образа" compose -f $ComposeFile build | Out-Null
    foreach ($dir in @($HostData, $HostUploads)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    $source = Test-HostFiles $HostData $HostUploads "в папке data"
    Write-Host "Папка data и картинки: $source"
    if (Test-Path (Join-Path $HostData "bazis.db")) {
      Write-Host "В папке data есть старая база SQLite (bazis.db): сайт в Docker перенесёт её в PostgreSQL при первом запуске."
    }

    $volumeActive = Test-VolumeActive
    if ($volumeActive -and -not $Force) {
      throw "В Docker уже есть рабочие файлы сайта — перенос перезаписал бы их. Если они точно не нужны, запустите с -Force " +
        "(их копия сохранится в папке data-docker-backup-<дата>)."
    }
    Invoke-Checked "Остановка сайта в Docker" compose -f $ComposeFile stop bazis | Out-Null
    Invoke-Checked "Удаление контейнера сайта" compose -f $ComposeFile rm -f bazis | Out-Null
    if ($volumeActive) {
      $backup = Join-Path $Root "data-docker-backup-$Stamp"
      New-Item -ItemType Directory $backup | Out-Null
      Invoke-InImage @("${backup}:/backup") @("sh", "-c", "cp -r /app/data/. /backup/") "Копия файлов из Docker" | Out-Null
      Write-Host "Прежние файлы из Docker сохранены в $backup"
    }

    Invoke-InImage @("${HostData}:/import/data:ro", "${HostUploads}:/import/uploads:ro") @("sh", "-c",
      "find /app/data /app/images/uploads -mindepth 1 -delete && cp -r /import/data/. /app/data/ && rm -f /app/data/$MarkerName && cp -r /import/uploads/. /app/images/uploads/"
    ) "Копирование данных в Docker" | Out-Null

    $copied = Test-VolumeFiles "в Docker"
    if ($copied -ne $source) { throw "Файлы после копирования не совпали (было: $source; стало: $copied). Папка data не тронута." }
    Write-Marker $HostMarker $DockerNote
    Write-Host "Файлы перенесены и проверены: $copied"

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Autostart install
    if ($LASTEXITCODE -ne 0) { throw "Не удалось установить автозапуск (install-docker-autostart.bat)." }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Autostart logon
    if ($LASTEXITCODE -ne 0) { throw "Сайт в Docker не запустился — подробности в logs\docker-autostart.log и docker compose logs." }
    Write-Host "Готово: сайт работает в Docker, папка data помечена как устаревшая."
  }

  "to-windows" {
    if (-not (Test-Path $HostMarker)) { Write-Host "Данные уже в папке data (запуск без Docker)."; break }
    Assert-Engine
    Assert-SharedDatabase
    if (-not (Test-VolumeActive)) { throw "В Docker нет рабочих данных сайта — переносить нечего. Папка data не тронута." }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Autostart uninstall | Out-Null
    # Останавливается только сайт: база остаётся работать в Docker — к ней подключится сайт без Docker.
    Invoke-Checked "Остановка сайта в Docker" compose -f $ComposeFile stop bazis | Out-Null
    $source = Test-VolumeFiles "в Docker"

    $stage = Join-Path $Root "data-from-docker-$Stamp"
    New-Item -ItemType Directory -Force (Join-Path $stage "data"), (Join-Path $stage "uploads") | Out-Null
    Invoke-InImage @("${stage}:/stage") @("sh", "-c", "cp -r /app/data/. /stage/data/ && cp -r /app/images/uploads/. /stage/uploads/") `
      "Копирование данных из Docker" | Out-Null
    $copied = Test-HostFiles (Join-Path $stage "data") (Join-Path $stage "uploads") "скопированные из Docker"
    if ($copied -ne $source) {
      throw "Файлы после копирования не совпали (было: $source; стало: $copied). Данные в Docker не тронуты; " +
        "запустить сайт снова: start-site.bat."
    }

    $old = Join-Path $Root "data-old-$Stamp"
    Rename-Item $HostData $old
    Move-Item (Join-Path $stage "data") $HostData
    Copy-Item (Join-Path $stage "uploads\*") $HostUploads -Recurse -Force -ErrorAction SilentlyContinue
    Write-Marker (Join-Path $stage $MarkerName) $WindowsNote
    Invoke-InImage @("${stage}:/stage:ro") @("cp", "/stage/$MarkerName", "/app/data/$MarkerName") "Отметка в Docker" | Out-Null
    Invoke-Checked "Удаление контейнера сайта" compose -f $ComposeFile rm -f bazis | Out-Null
    Invoke-Checked "Запуск базы" compose -f $ComposeFile up -d postgres | Out-Null
    Remove-Item -Recurse -Force $stage

    $db = Invoke-HostNode @((Join-Path $PSScriptRoot "db.js"), "counts")
    if ($db.Code -ne 0) { Write-Host "ВНИМАНИЕ: база по DATABASE_URL из .env не отвечает:`n$($db.Output)" }
    else { Write-Host $db.Output }
    Write-Host "Файлы перенесены из Docker в папку data и проверены: $copied"
    Write-Host "Прежняя папка data сохранена как $old (её можно удалить)."
    Write-Host "База осталась в Docker: Docker Desktop должен запускаться при входе в Windows (настройка «Start when you sign in»)."
    Write-Host "Запуск сайта: start-site.bat или install-service.bat (служба)."
  }
}
