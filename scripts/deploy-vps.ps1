# Выкладка на боевой сервер (dinarabi.com): код из последнего коммита (git HEAD) — в /opt/bazis на сервере, пересборка в Docker.
#
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-vps.ps1 -CheckOnly   — только проверить, на сервере ничего не меняется;
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-vps.ps1              — выложить.
#
# Нужен SSH-доступ без вопросов (Host dinarabi в ~/.ssh/config; ключ с паролем — заранее ssh-add в запущенный ssh-agent)
# и sudo без пароля на сервере. На сервер уходят только файлы из git: .env, help.txt, данные и тома Docker не трогаются.
# Перед заменой файлов: архив текущего кода и копия базы в /opt/bazis-backups, текущий образ — bazis-site:rollback-<время>.
# Тесты и сборка идут внутри docker compose build: если они упали, работающий контейнер не заменяется.
param(
  [string]$HostAlias = "dinarabi",
  [string]$RemoteDir = "/opt/bazis",
  [string]$BackupDir = "/opt/bazis-backups",
  [string]$SiteUrl = "https://dinarabi.com",
  [int]$HealthWaitSeconds = 240,
  [switch]$CheckOnly
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

# Имя закреплено в docker-compose.yml (name: project): по нему называются тома с базой.
$ComposeProject = "project"

function Step([string]$Text) { Write-Host ""; Write-Host "== $Text" -ForegroundColor Cyan }

# Команды для сервера — без двойных и одинарных кавычек: PowerShell 5 передаёт кавычки в ssh ненадёжно,
# а вся команда идёт в bash -c '…'. Код возврата проверяем сами: stderr внешней команды иначе стал бы исключением.
function Invoke-Remote([string]$Command, [switch]$AllowFail) {
  if ($Command -match "[`"']") { throw "Кавычки в команде для сервера не поддерживаются: $Command" }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = @(& ssh -o BatchMode=yes -o ConnectTimeout=20 $HostAlias "bash -o pipefail -c '$Command'" 2>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0 -and -not $AllowFail) { throw "Команда на сервере завершилась с кодом ${code}:`n$Command`n$($out -join "`n")" }
  return $out
}

function Invoke-Local([scriptblock]$Block, [string]$What) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = @(& $Block 2>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "$What — код ${code}:`n$($out -join "`n")" }
  return $out
}

Step "Проверка кода"
$dirty = Invoke-Local { git status --porcelain --untracked-files=no } "git status"
if ($dirty.Count) { throw "Есть незакоммиченные изменения — сначала закоммитьте их:`n$($dirty -join "`n")" }
$sha = (Invoke-Local { git rev-parse --short HEAD } "git rev-parse")[0].Trim()
$subject = (Invoke-Local { git log -1 --format=%s } "git log")[0].Trim()
$topLevel = Invoke-Local { git ls-tree --name-only HEAD } "git ls-tree"
if ($topLevel | Where-Object { $_ -notmatch '^[A-Za-z0-9._-]+$' }) { throw "Имена в корне репозитория должны быть латиницей без пробелов." }
Write-Host "Выкладываем $sha — $subject"

Step "Проверка сервера"
Invoke-Remote "sudo -n true" | Out-Null
Invoke-Remote "test -f $RemoteDir/.env && test -f $RemoteDir/docker-compose.yml" | Out-Null
$owner = (Invoke-Remote "stat -c %u:%g $RemoteDir")[0].Trim()
$containers = Invoke-Remote "sudo docker ps -a --format {{.Names}}"
if ($containers -notcontains "$ComposeProject-bazis-1") {
  throw "На сервере нет контейнера $ComposeProject-bazis-1 (есть: $($containers -join ', ')). Новый docker-compose.yml поднял бы сайт с другими томами и пустой базой — выкладка остановлена."
}
Write-Host "SSH и sudo работают; $RemoteDir на месте (владелец $owner); контейнер $ComposeProject-bazis-1 есть."

# Файлы на сервере, которых нет в git: в src/ и тестах они попали бы в сборку и в npm test.
$tracked = @{}
Invoke-Local { git ls-files } "git ls-files" | ForEach-Object { $tracked[$_] = $true }
$codeDirs = "src ai antispam auth config db documents logging notify runtime security shared scripts test public"
$remoteFiles = Invoke-Remote "cd $RemoteDir && find $codeDirs -type f 2>/dev/null | grep -v ^src/generated/ | grep -v ^public/og/ || true"
$stale = @($remoteFiles | Where-Object { $_ -and -not $tracked.ContainsKey($_) })
if ($stale.Count) {
  Write-Host "На сервере есть файлы, которых нет в git ($($stale.Count)):"
  $stale | Select-Object -First 40 | ForEach-Object { Write-Host "  $_" }
}
$risky = @($stale | Where-Object { $_ -match '^src/|(^|/)test/|\.test\.(js|jsx|mjs)$' })
if ($risky.Count) { throw "Лишние файлы в src/ или тестах на сервере попадут в сборку — разберитесь с ними перед выкладкой." }

$remoteSet = @{}
Invoke-Remote "cd $RemoteDir && find . -path ./node_modules -prune -o -path ./data -prune -o -path ./logs -prune -o -path ./dist -prune -o -path ./dist-media -prune -o -path ./images/uploads -prune -o -type f -printf %P\\n" |
  ForEach-Object { $remoteSet[$_] = $true }
$newFiles = @($tracked.Keys | Where-Object { -not $remoteSet.ContainsKey($_) } | Sort-Object)
Write-Host "Файлов в коммите: $($tracked.Count); новых для сервера: $($newFiles.Count)."
$newFiles | Select-Object -First 40 | ForEach-Object { Write-Host "  + $_" }

if ($CheckOnly) {
  Write-Host ""
  Write-Host "Проверка закончена, на сервере ничего не изменено." -ForegroundColor Green
  exit 0
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rollback = "откат: ssh $HostAlias, затем cd $RemoteDir && sudo tar xzf $BackupDir/code-$stamp.tgz -C $RemoteDir && sudo docker image tag bazis-site:rollback-$stamp bazis-site && sudo docker compose up -d --no-build bazis"

Step "Копии перед выкладкой"
Invoke-Remote "sudo mkdir -p $BackupDir && cd $RemoteDir && sudo tar czf $BackupDir/code-$stamp.tgz --exclude=./node_modules --exclude=./data --exclude=./logs --exclude=./images/uploads --exclude=./dist --exclude=./dist-media ." | Out-Null
Write-Host "Код: $BackupDir/code-$stamp.tgz"
$dumpName = "predeploy-$stamp.json.gz"
Invoke-Remote "cd $RemoteDir && sudo docker compose exec -T bazis node scripts/db.js dump /tmp/$dumpName && sudo docker compose cp bazis:/tmp/$dumpName $BackupDir/$dumpName && test -s $BackupDir/$dumpName" |
  ForEach-Object { Write-Host "  $_" }
Write-Host "База: $BackupDir/$dumpName"
Invoke-Remote "sudo docker image tag bazis-site bazis-site:rollback-$stamp" | Out-Null
Write-Host "Образ для отката: bazis-site:rollback-$stamp"

Step "Загрузка кода"
$archive = Join-Path $env:TEMP "bazis-$sha-$stamp.tar.gz"
Invoke-Local { git archive --format=tar.gz -o $archive HEAD } "git archive" | Out-Null
$remoteArchive = "/tmp/bazis-$sha-$stamp.tar.gz"
Invoke-Local { scp -q -o BatchMode=yes $archive "${HostAlias}:$remoteArchive" } "scp (на сервере ничего не изменено, кроме копий)" | Out-Null
Remove-Item $archive -ErrorAction SilentlyContinue
Invoke-Remote "sudo tar xzf $remoteArchive --no-same-owner -C $RemoteDir && cd $RemoteDir && sudo chown -R $owner $($topLevel -join ' ') && rm -f $remoteArchive" | Out-Null
Write-Host "Файлы коммита $sha разложены в $RemoteDir."

Step "Сборка и перезапуск (тесты внутри сборки, несколько минут)"
try {
  Invoke-Remote "cd $RemoteDir && sudo docker compose up -d --build 2>&1 | tail -n 25" | ForEach-Object { Write-Host "  $_" }
} catch {
  Write-Host $_.Exception.Message
  throw "Сборка не удалась — работающий контейнер не заменён, но файлы в $RemoteDir уже новые. Вернуть прежние — $rollback"
}

Step "Проверка здоровья"
$deadline = (Get-Date).AddSeconds($HealthWaitSeconds)
$status = ""
while ((Get-Date) -lt $deadline) {
  $status = (Invoke-Remote "sudo docker inspect -f {{.State.Health.Status}} $ComposeProject-bazis-1" -AllowFail) -join ""
  if ($status -eq "healthy") { break }
  Start-Sleep -Seconds 5
}
if ($status -ne "healthy") {
  Invoke-Remote "cd $RemoteDir && sudo docker compose logs --tail 40 bazis" -AllowFail | ForEach-Object { Write-Host "  $_" }
  throw "Сайт не стал healthy за $HealthWaitSeconds с (состояние: $status). $rollback"
}
$health = Invoke-RestMethod -Uri "$SiteUrl/api/health" -TimeoutSec 20
Write-Host "Контейнер healthy; $SiteUrl/api/health: ok=$($health.ok), db=$($health.db), uptime=$($health.uptime) с."
if ($health.uptime -gt 900) { throw "Сайт отвечает, но uptime $($health.uptime) с — похоже, домен обслуживает не обновлённый контейнер." }

Write-Host ""
Write-Host "Готово: $SiteUrl работает на коммите $sha." -ForegroundColor Green
Write-Host "Если что-то не так — $rollback"
