$root = Split-Path -Parent $PSScriptRoot   # 项目根目录（test/ 的上一级）
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://localhost:8123/')
$listener.Start()
Write-Host "Serving $root on http://localhost:8123/"
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.LocalPath
    if ($path -eq '/') { $path = '/index.html' }
    $file = Join-Path $root ($path.TrimStart('/') -replace '/', '\')
    if (Test-Path $file -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $mime = switch ($ext) {
        '.html' { 'text/html; charset=utf-8' }
        '.js'   { 'application/javascript; charset=utf-8' }
        '.css'  { 'text/css; charset=utf-8' }
        '.json' { 'application/json' }
        default { 'application/octet-stream' }
      }
      $ctx.Response.ContentType = $mime
      $ctx.Response.AddHeader('Cache-Control', 'no-cache')
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
  } catch {
    Write-Host "ERR: $_"
  }
}
