$procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*serve.ps1*' }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force
  Write-Host ("stopped PID " + $p.ProcessId)
}
if (-not $procs) { Write-Host "no serve.ps1 process found" }
