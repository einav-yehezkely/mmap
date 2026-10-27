# Usage (from the repository root): powershell -File apps/desktop/scripts/make-icons.ps1 -Root .
# Builds the app icons from docs/mmap_icon.png:
#   apps/desktop/resources/icon.png          512x512 (window icon, electron-builder source)
#   apps/desktop/resources/icon.ico          16..256 px, PNG-compressed entries (Windows exe/installer)
#   apps/desktop/src/renderer/src/assets/mmap-logo.png   96x96 (sidebar)
# The source has a wide dark margin; the logo is cropped (square, centred on the drawing) and the
# corners are rounded so the icon reads well at taskbar sizes.
param([string]$Root)
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile((Join-Path $Root 'docs/mmap_icon.png'))
$cropSize = 880
$cropX = 627 - [int]($cropSize / 2)
$cropY = 600 - [int]($cropSize / 2)

function New-Icon([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $radius = [single]($size * 0.2)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $max = [single]$size
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($max - $d, 0, $d, $d, 270, 90)
  $path.AddArc($max - $d, $max - $d, $d, $d, 0, 90)
  $path.AddArc(0, $max - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $graphics.SetClip($path)
  $destination = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $graphics.DrawImage($source, $destination, $cropX, $cropY, $cropSize, $cropSize, [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Dispose()
  return $bitmap
}

function Get-PngBytes($bitmap) {
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  $stream.Dispose()
  return ,$bytes
}

$resources = Join-Path $Root 'apps/desktop/resources'
$assets = Join-Path $Root 'apps/desktop/src/renderer/src/assets'
New-Item -ItemType Directory -Force $assets | Out-Null

$large = New-Icon 512
$large.Save((Join-Path $resources 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$large.Dispose()
$logo = New-Icon 96
$logo.Save((Join-Path $assets 'mmap-logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$logo.Dispose()

# ICO: 6-byte header, 16-byte directory entry per image, then the PNG data of each image.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
  $bitmap = New-Icon $size
  $images += ,(Get-PngBytes $bitmap)
  $bitmap.Dispose()
}
$output = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $output
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dimension = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
  $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([UInt16]1); $writer.Write([UInt16]32)
  $writer.Write([UInt32]$images[$i].Length); $writer.Write([UInt32]$offset)
  $offset += $images[$i].Length
}
foreach ($image in $images) { $writer.Write($image) }
$writer.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $resources 'icon.ico'), $output.ToArray())
$writer.Dispose()
$source.Dispose()
Write-Output 'icons written'
