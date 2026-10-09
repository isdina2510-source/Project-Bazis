# Сквозная проверка образа bazis-site во временном контейнере (порт 8799, отдельный том, свой пароль; рабочие данные не трогает).
# Запуск: powershell -ExecutionPolicy Bypass -File scripts\docker-e2e.ps1 (после docker compose build).
# Continue: в PowerShell 5.1 при Stop любой вывод docker в stderr стал бы ошибкой; сбои HTTP ловятся через -ErrorAction Stop.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$name = "bazis-e2e"; $vol = "bazis-e2e-data"; $base = "http://127.0.0.1:8799"
$pass = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 24 | % { [char]$_ })
$H = @{ "X-Admin-Password" = $pass }
$ok = 0; $fail = 0
function Check([string]$what, [bool]$cond, [string]$info = "") {
  if ($cond) { $script:ok++; Write-Host "  OK   $what $info" } else { $script:fail++; Write-Host "  FAIL $what $info" }
}
function Api([string]$method, [string]$path, $body = $null) {
  $p = @{ Method = $method; Uri = "$base$path"; Headers = $H; UseBasicParsing = $true }
  if ($body -ne $null) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5)); $p.ContentType = "application/json; charset=utf-8" }
  $r = Invoke-WebRequest @p -ErrorAction Stop
  if ($r.Headers["Content-Type"] -like "application/json*") { return ([Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json) }
  return $r
}
function Wait-Healthy {
  for ($i = 0; $i -lt 60; $i++) {
    $s = docker inspect $name --format "{{.State.Health.Status}}" 2>$null
    if ($s -eq "healthy") { return $true }
    Start-Sleep 2
  }
  return $false
}

docker rm -f $name 2>$null | Out-Null; docker volume rm $vol 2>$null | Out-Null
try {
  docker run -d --name $name --init -p 127.0.0.1:8799:8787 -e ADMIN_PASSWORD=$pass -v "${vol}:/app/data" bazis-site | Out-Null
  Check "контейнер стал healthy" (Wait-Healthy)

  $products = Api GET "/api/products"
  $list = @($products.products) + @($products) | ? { $_.id } | Select-Object -First 50
  $discussOnly = @((Get-Content (Join-Path $PSScriptRoot "..\shared\catalog.json") -Raw -Encoding UTF8 | ConvertFrom-Json).CART_RULES.discussOnlyCategories)
  $prod = $list | ? { $discussOnly -notcontains $_.category -and ($_.stock -eq $null -or $_.stock -gt 0) } | Select-Object -First 1
  Check "каталог товаров" ($prod -ne $null) "(товаров: $($list.Count))"

  $order = Api POST "/api/orders" @{ customerName = "Тест Докер"; customerPhone = "+7 701 000 00 00"; channel = "whatsapp"; items = @(@{ id = $prod.id; qty = 1 }) }
  Check "заказ создан" ([bool]$order.id) "($($order.id))"
  $got = Api GET "/api/orders/$($order.id)"
  Check "заказ читается, кириллица цела" ($got.customerName -eq "Тест Докер")
  $upd = Api PATCH "/api/orders/$($order.id)" @{ status = "in_progress" }
  Check "статус «в работе»" ($upd.status -eq "in_progress")

  $lead = Api POST "/api/orders" @{ customerName = "Тест Заявка"; customerPhone = "+7 701 000 00 01"; channel = "site"; lead = @{ direction = $prod.category; comment = "Проверка Docker" } }
  Check "заявка с сайта создана" ([bool]$lead.id)
  $pdf = Api GET "/api/orders/$($lead.id)/lead.pdf"
  $sig = [Text.Encoding]::ASCII.GetString($pdf.RawContentStream.ToArray()[0..3])
  Check "PDF карточки заявки" ($sig -eq "%PDF") "($($pdf.RawContentLength) байт)"
  $pdf2 = Api GET "/api/products/$($prod.id)/pdf"
  Check "PDF карточки товара" ([Text.Encoding]::ASCII.GetString($pdf2.RawContentStream.ToArray()[0..3]) -eq "%PDF")

  $t = Measure-Command { docker restart $name | Out-Null }
  Check "перезапуск быстрый (SIGTERM обработан)" ($t.TotalSeconds -lt 20) ("({0:N1} с)" -f $t.TotalSeconds)
  $logs = docker logs $name 2>&1 | Out-String
  Check "сервер корректно остановился" ($logs -match "SIGTERM")
  Check "после перезапуска healthy" (Wait-Healthy)
  $again = Api GET "/api/orders/$($order.id)"
  Check "заказ сохранился после перезапуска" ($again.status -eq "in_progress")

  docker rm -f $name | Out-Null
  docker run -d --name $name --init -p 127.0.0.1:8799:8787 -e ADMIN_PASSWORD=$pass -v "${vol}:/app/data" bazis-site | Out-Null
  Check "новый контейнер на том же томе healthy" (Wait-Healthy)
  $again = Api GET "/api/orders/$($order.id)"
  Check "заказ сохранился после пересоздания контейнера" ($again.customerName -eq "Тест Докер")

  $code = curl.exe -s -o NUL -w "%{http_code}" -H "X-Admin-Password: wrong-password-123" "$base/api/orders"
  Check "неверный пароль отклонён" ($code -eq "401" -or $code -eq "403") "($code)"
  $code = curl.exe -s -o NUL -w "%{http_code}" -H "X-Forwarded-For: 1.2.3.4" -H "X-Forwarded-Proto: http" "$base/admin.html"
  Check "запрос не через прокси не считается проксированным" ($code -eq "200") "($code)"
} finally {
  docker rm -f $name 2>$null | Out-Null; docker volume rm $vol 2>$null | Out-Null
  Write-Host "ИТОГО: успешно $ok, ошибок $fail"
}
if ($fail -gt 0) { exit 1 }
