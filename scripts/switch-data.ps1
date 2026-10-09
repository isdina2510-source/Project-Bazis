# Где живут данные сайта (база, документы, загруженные картинки): в папке data или в Docker (тома project_bazis-*).
# Рабочая копия всегда одна: у неактивной в папке данных лежит DATA-MOVED.txt, и server.js на ней не запускается,
# чтобы заказы не разошлись по двум базам.
#   to-docker  — перенести data и images\uploads в Docker, включить автозапуск (switch-to-docker.bat);
#   to-windows — вернуть данные из Docker в папку data, выключить автозапуск Docker (switch-to-windows.bat);
#   mark       — данные уже перенесены в Docker вручную: только пометить папку data устаревшей;
#   status     — где сейчас рабочая копия.
# Перенос засчитывается, только если база цела и число записей до и после копирования совпало (scripts/db-check.js).
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

# Разовый контейнер из образа сайта с подключёнными папками компьютера (сервер в нём не запускается).
function Invoke-InImage([string[]]$Mounts, [string[]]$Command, [string]$What) {
  $volumeArgs = @()
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
  if (-not $node) { throw "Node.js не найден — нужен для проверки базы." }
  $node.Source
}

# Строка counts из db-check.js; при повреждении базы — исключение.
function Get-CountsLine([string]$Output, [string]$Where) {
  if ($Output -notmatch "integrity=ok") { throw "База $Where повреждена или не открылась:`n$Output" }
  ($Output -split "`r?`n" | Where-Object { $_ -like "counts *" } | Select-Object -First 1)
}

function Test-HostDb([string]$DataDir, [string]$Where) {
  $db = Join-Path $DataDir "bazis.db"
  if (-not (Test-Path $db)) { return "" }
  $ErrorActionPreference = "Continue"
  $out = (& (Get-HostNode) --no-warnings (Join-Path $PSScriptRoot "db-check.js") $db 2>&1 | Out-String).Trim()
  Get-CountsLine $out $Where
}

function Test-VolumeDb([string]$Where) {
  $scripts = "${PSScriptRoot}:/scripts:ro"
  $exists = Invoke-InImage @() @("sh", "-c", "test -f /app/data/bazis.db && echo yes || echo no") "Проверка базы в Docker"
  if ($exists -notmatch "yes") { return "" }
  $ErrorActionPreference = "Continue"
  $result = Invoke-Docker compose -f $ComposeFile run --rm --no-deps -T -v $scripts bazis node --no-warnings /scripts/db-check.js /app/data/bazis.db
  Get-CountsLine $result.Output $Where
}

# Рабочая ли копия в Docker: есть база и нет отметки о переносе.
function Test-VolumeActive {
  $state = Invoke-InImage @() @("sh", "-c", "test -f /app/data/bazis.db && test ! -f /app/data/$MarkerName && echo active || echo inactive") "Проверка данных в Docker"
  $state -match "active" -and $state -notmatch "inactive"
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

$DockerNote = "Данные перенесены в Docker ($Stamp). Сайт запускается через start-site.bat (он запустит Docker), " +
  "обновление — update-site.bat. Вернуться к запуску без Docker: switch-to-windows.bat."
$WindowsNote = "Данные перенесены из Docker обратно в папку data ($Stamp). Вернуться в Docker: switch-to-docker.bat."

switch ($Action) {
  "status" {
    if (Test-Path $HostMarker) { Write-Host "Рабочие данные — в Docker. Папка data устарела." }
    else { Write-Host "Рабочие данные — в папке data (запуск без Docker)." }
  }

  "mark" {
    if (Test-Path $HostMarker) { Write-Host "Папка data уже помечена как устаревшая."; break }
    Assert-Engine
    if (-not (Test-VolumeActive)) { throw "В Docker нет рабочей базы — помечать папку data устаревшей нельзя." }
    Write-Marker $HostMarker $DockerNote
    Write-Host "Папка data помечена как устаревшая: сервер без Docker на ней больше не запустится."
  }

  "to-docker" {
    if (Test-Path $HostMarker) { Write-Host "Данные уже в Docker."; break }
    Assert-NativeStopped
    Assert-Engine
    Write-Host "Сборка образа сайта (несколько минут)..."
    Invoke-Checked "Сборка образа" compose -f $ComposeFile build | Out-Null
    foreach ($dir in @($HostData, $HostUploads)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    $source = Test-HostDb $HostData "в папке data"
    Write-Host "Папка data: $(if ($source) { $source } else { 'базы нет — сайт в Docker начнёт с пустой' })"

    $volumeActive = Test-VolumeActive
    if ($volumeActive -and -not $Force) {
      throw "В Docker уже есть рабочая база — перенос перезаписал бы её. Если она точно не нужна, запустите с -Force " +
        "(её копия сохранится в папке data-docker-backup-<дата>)."
    }
    Invoke-Checked "Остановка контейнера" compose -f $ComposeFile down | Out-Null
    if ($volumeActive) {
      $backup = Join-Path $Root "data-docker-backup-$Stamp"
      New-Item -ItemType Directory $backup | Out-Null
      Invoke-InImage @("${backup}:/backup") @("sh", "-c", "cp -r /app/data/. /backup/") "Копия базы из Docker" | Out-Null
      Write-Host "Прежняя база из Docker сохранена в $backup"
    }

    Invoke-InImage @("${HostData}:/import/data:ro", "${HostUploads}:/import/uploads:ro") @("sh", "-c",
      "find /app/data /app/images/uploads -mindepth 1 -delete && cp -r /import/data/. /app/data/ && rm -f /app/data/$MarkerName && cp -r /import/uploads/. /app/images/uploads/"
    ) "Копирование данных в Docker" | Out-Null

    $copied = Test-VolumeDb "в Docker"
    if ($copied -ne $source) { throw "Число записей после копирования не совпало (было: $source; стало: $copied). Папка data не тронута." }
    Write-Marker $HostMarker $DockerNote
    Write-Host "Данные перенесены и проверены: $copied"

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Autostart install
    if ($LASTEXITCODE -ne 0) { throw "Не удалось установить автозапуск (install-docker-autostart.bat)." }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Autostart logon
    if ($LASTEXITCODE -ne 0) { throw "Сайт в Docker не запустился — подробности в logs\docker-autostart.log и docker compose logs." }
    Write-Host "Готово: сайт работает в Docker, папка data помечена как устаревшая."
  }

  "to-windows" {
    if (-not (Test-Path $HostMarker)) { Write-Host "Данные уже в папке data (запуск без Docker)."; break }
    Assert-Engine
    if (-not (Test-VolumeActive)) { throw "В Docker нет рабочей базы — переносить нечего. Папка data не тронута." }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Autostart uninstall | Out-Null
    # stop, а не down: контейнер завершается штатно, база закрывается, тома остаются.
    Invoke-Checked "Остановка сайта в Docker" compose -f $ComposeFile stop | Out-Null
    $source = Test-VolumeDb "в Docker"

    $stage = Join-Path $Root "data-from-docker-$Stamp"
    New-Item -ItemType Directory -Force (Join-Path $stage "data"), (Join-Path $stage "uploads") | Out-Null
    Invoke-InImage @("${stage}:/stage") @("sh", "-c", "cp -r /app/data/. /stage/data/ && cp -r /app/images/uploads/. /stage/uploads/") `
      "Копирование данных из Docker" | Out-Null
    $copied = Test-HostDb (Join-Path $stage "data") "скопированная из Docker"
    if ($copied -ne $source) {
      throw "Число записей после копирования не совпало (было: $source; стало: $copied). Данные в Docker не тронуты; " +
        "запустить сайт снова: start-site.bat."
    }

    $old = Join-Path $Root "data-old-$Stamp"
    Rename-Item $HostData $old
    Move-Item (Join-Path $stage "data") $HostData
    Copy-Item (Join-Path $stage "uploads\*") $HostUploads -Recurse -Force -ErrorAction SilentlyContinue
    Write-Marker (Join-Path $stage $MarkerName) $WindowsNote
    Invoke-InImage @("${stage}:/stage:ro") @("cp", "/stage/$MarkerName", "/app/data/$MarkerName") "Отметка в Docker" | Out-Null
    Invoke-Checked "Удаление контейнера" compose -f $ComposeFile down | Out-Null
    Remove-Item -Recurse -Force $stage
    Write-Host "Данные перенесены из Docker в папку data и проверены: $copied"
    Write-Host "Прежняя папка data сохранена как $old (её можно удалить)."
    Write-Host "Запуск сайта: start-site.bat или install-service.bat (служба)."
  }
}
