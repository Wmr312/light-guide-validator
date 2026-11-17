$ErrorActionPreference = 'SilentlyContinue'
$listen = Get-NetTCPConnection -LocalPort 8123 -State Listen
Write-Host ("Port8123 listening: " + [bool]$listen)
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:8123/index.html' -UseBasicParsing -TimeoutSec 3
  Write-Host ("index.html status: " + $r.StatusCode)
  Write-Host ("index has v=5: " + $r.Content.Contains('?v=5'))
  $c = Invoke-WebRequest -Uri 'http://localhost:8123/css/style.css?v=5' -UseBasicParsing -TimeoutSec 3
  Write-Host ("css has minmax fix: " + $c.Content.Contains('minmax(0, 1fr)'))
  $v = Invoke-WebRequest -Uri 'http://localhost:8123/js/viewer.js?v=5' -UseBasicParsing -TimeoutSec 3
  Write-Host ("viewer has light blue bg: " + $v.Content.Contains('0xE7F0F9'))
} catch {
  Write-Host ("fetch failed: " + $_.Exception.Message)
}
Write-Host ("disk viewer.js has bg: " + (Select-String -Path 'c:\Users\win11\Desktop\light-guide-validator-20261012\js\viewer.js' -Pattern '0xE7F0F9' -Quiet))
Write-Host ("disk style.css has fix: " + (Select-String -Path 'c:\Users\win11\Desktop\light-guide-validator-20261012\css\style.css' -Pattern 'minmax\(0, 1fr\)' -Quiet))
