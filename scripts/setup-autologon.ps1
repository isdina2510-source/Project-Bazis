# Автоматический вход в Windows — чтобы после перезагрузки (в т.ч. ночного обновления) запустились Docker Desktop
# и сайт: Docker Desktop без вошедшего пользователя не работает. Сразу после автовхода задача «Bazis Docker»
# блокирует экран (scripts/docker-autostart.ps1), так что компьютер не остаётся открытым.
#
# Пароль вводится в окне официальной утилиты Microsoft Sysinternals Autologon: она хранит его зашифрованным
# (секрет LSA), а не открытым текстом в реестре. Сам скрипт пароль не видит.
# Вызывается из setup-autologon.bat (от имени администратора).
param(
  [ValidateSet("enable", "status")]
  [string]$Action = "enable"
)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ToolDir = Join-Path $Root ".tools\autologon"
$ToolExe = Join-Path $ToolDir "Autologon64.exe"
$DownloadUrl = "https://download.sysinternals.com/files/AutoLogon.zip"
$Winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
$PasswordLess = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device"

function Test-AutoLogon {
  (Get-ItemProperty $Winlogon -ErrorAction SilentlyContinue).AutoAdminLogon -eq "1"
}

# Утилиту запускаем только с действующей подписью Microsoft — подменённый файл не выполнится.
function Assert-MicrosoftSigned([string]$Path) {
  $sig = Get-AuthenticodeSignature $Path
  if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch "O=Microsoft Corporation") {
    Remove-Item -Force $Path -ErrorAction SilentlyContinue
    throw "У $Path нет действующей подписи Microsoft ($($sig.Status)) — файл удалён, автовход не настроен."
  }
}

function Get-AutologonTool {
  if (-not (Test-Path $ToolExe)) {
    New-Item -ItemType Directory -Force $ToolDir | Out-Null
    $zip = Join-Path $ToolDir "AutoLogon.zip"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "Скачиваю Autologon с сайта Microsoft..."
    Invoke-WebRequest $DownloadUrl -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $ToolDir -Force
    Remove-Item -Force $zip
  }
  Assert-MicrosoftSigned $ToolExe
  $ToolExe
}

switch ($Action) {
  "status" {
    $state = if (Test-AutoLogon) { "включён (пользователь $((Get-ItemProperty $Winlogon).DefaultUserName))" } else { "выключен" }
    Write-Host "Автовход в Windows: $state"
  }
  "enable" {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw "Нужны права администратора: запустите setup-autologon.bat через «Запуск от имени администратора»."
    }
    if (-not (Get-ScheduledTask -TaskName "Bazis Docker" -ErrorAction SilentlyContinue)) {
      throw "Сначала установите автозапуск сайта: install-docker-autostart.bat — без него автовход бесполезен, а экран не заблокируется."
    }
    $tool = Get-AutologonTool

    # «Вход только через Windows Hello» не даёт войти по сохранённому паролю — автовход с ним не работает.
    if ((Get-ItemProperty $PasswordLess -ErrorAction SilentlyContinue).DevicePasswordLessBuildVersion -ne 0) {
      Set-ItemProperty $PasswordLess -Name DevicePasswordLessBuildVersion -Value 0 -Type DWord
      Write-Host "Отключён режим «вход только через Windows Hello» (PIN и отпечаток продолжают работать)."
    }

    Write-Host ""
    Write-Host "Откроется окно Autologon. Проверьте имя пользователя ($env:USERNAME) и компьютер ($env:USERDOMAIN),"
    Write-Host "введите пароль от Windows (не PIN) и нажмите Enable. Отключить автовход — там же, кнопка Disable."
    Start-Process -FilePath $tool -ArgumentList "/accepteula" -Wait

    if (Test-AutoLogon) {
      Write-Host ""
      Write-Host "Автовход включён. После перезагрузки Windows войдёт сама, экран сразу заблокируется, сайт запустится."
    } else {
      Write-Host ""
      Write-Host "Автовход не включён (окно закрыто без Enable или пароль не принят)."
      exit 1
    }
  }
}
