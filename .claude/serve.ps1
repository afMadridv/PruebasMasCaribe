# Servidor estático mínimo para previsualizar el sitio (no hay Node/Python en esta máquina)
param([int]$Puerto = 8421)
$raiz = Split-Path -Parent $PSScriptRoot
$mime = @{
    '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'
    '.js'='text/javascript; charset=utf-8'; '.json'='application/json'
    '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.svg'='image/svg+xml'
    '.ico'='image/x-icon'; '.pdf'='application/pdf'; '.woff2'='font/woff2'
}
$oyente = New-Object System.Net.HttpListener
$oyente.Prefixes.Add("http://localhost:$Puerto/")
$oyente.Start()
Write-Host "Sirviendo $raiz en http://localhost:$Puerto/"
while ($oyente.IsListening) {
    $ctx = $oyente.GetContext()
    $ruta = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrEmpty($ruta)) { $ruta = 'index.html' }
    $archivo = Join-Path $raiz $ruta
    if ((Test-Path $archivo -PathType Container)) { $archivo = Join-Path $archivo 'index.html' }
    try {
        if (Test-Path $archivo -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($archivo)
            $ext = [System.IO.Path]::GetExtension($archivo).ToLower()
            $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $ctx.Response.StatusCode = 404
        }
    } catch { $ctx.Response.StatusCode = 500 }
    $ctx.Response.Close()
}
