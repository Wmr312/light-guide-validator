# Light Guide Simulator - local static server
# Run:  powershell -ExecutionPolicy Bypass -File .\serve.ps1
#   or double-click  start-server.bat
# Listens on ports 8765 and 8080, both localhost and 127.0.0.1.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://localhost:8765/')
$listener.Prefixes.Add('http://127.0.0.1:8765/')
$listener.Prefixes.Add('http://localhost:8080/')
$listener.Prefixes.Add('http://127.0.0.1:8080/')
$listener.Start()

Write-Host "Serving $root"
Write-Host "  http://localhost:8765/"
Write-Host "  http://localhost:8080/"
Write-Host "Press Ctrl+C to stop."

$mime = @{
    '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8';
    '.js'='application/javascript; charset=utf-8'; '.json'='application/json; charset=utf-8';
    '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg';
    '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.wav'='audio/wav';
    '.glb'='model/gltf-binary'; '.gltf'='model/gltf+json';
    '.stl'='application/octet-stream'; '.obj'='text/plain; charset=utf-8'
}

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
        $url = $ctx.Request.Url.AbsolutePath.TrimStart('/')
        if ($url -eq '') { $url = 'index.html' }
        $path = Join-Path $root $url.Replace('/', '\')
        if (Test-Path $path -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($url).ToLower()
            $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($path)
            $ctx.Response.ContentType = $ct
            $ctx.Response.ContentLength64 = $bytes.Length
            $ctx.Response.Headers.Add('Cache-Control', 'no-store, must-revalidate')
            $ctx.Response.Headers.Add('Pragma', 'no-cache')
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $ctx.Response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes('Not found')
            $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
        }
    } catch {
        try { $ctx.Response.StatusCode = 500 } catch { }
    }
    $ctx.Response.OutputStream.Close()
}
