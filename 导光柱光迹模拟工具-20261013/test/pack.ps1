$src = 'c:\Users\win11\Desktop\light-guide-validator-20261012'
$tmp = Join-Path $env:TEMP 'light-guide-validator-20261013.zip'
$dst = Join-Path $src 'light-guide-validator-20261013.zip'
if (Test-Path $tmp) { Remove-Item $tmp -Force }
if (Test-Path $dst) { Remove-Item $dst -Force }
Compress-Archive -Path (Join-Path $src 'index.html'), (Join-Path $src 'css'), (Join-Path $src 'js'), (Join-Path $src 'test') -DestinationPath $tmp -CompressionLevel Optimal
Move-Item $tmp $dst -Force
$size = (Get-Item $dst).Length
Write-Host ("OK: " + $dst + "  " + [math]::Round($size/1KB, 1) + " KB")
