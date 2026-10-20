# Generate local PNG variants. Preserve the original I, heart and E pixels;
# replace only the M with a rounded, outlined vector V. No font dependency.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$toolDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star'))
$html = Get-Content -Raw -LiteralPath (Join-Path $toolDirectory 'index.html')
$original = [regex]::Match($html, 'const customAssets=(\{[^\r\n]+\});').Groups[1].Value | ConvertFrom-Json -AsHashtable
$supplement = ((Get-Content -Raw -LiteralPath (Join-Path $toolDirectory 'motif-catalog.js')) -replace '(?s)^.*?globalThis.HeartStarMotifCatalog = ', '' -replace ';\s*$', '') | ConvertFrom-Json -AsHashtable
$entries = @($original.GetEnumerator()) + @($supplement.assets.GetEnumerator())
foreach ($entry in $entries) {
  if ($entry.Value.group -ne 'I ♥ ME 组合') { continue }
  $image = [Drawing.Bitmap]::new((Join-Path $toolDirectory $entry.Value.src))
  try {
    $top = [int][Math]::Floor($image.Height * .56)
    # The transparent vertical gutter between M and E defines the edit boundary.
    $candidates = @()
    for ($x = [int]($image.Width * .48); $x -lt [int]($image.Width * .66); $x++) {
      $occupied = $false
      for ($y = $top; $y -lt $image.Height; $y++) {
        if ($image.GetPixel($x, $y).A -gt 10) { $occupied = $true; break }
      }
      if (!$occupied) { $candidates += $x }
    }
    if (!$candidates.Count) { throw "Missing M / E gutter: $($entry.Key)" }
    $cut = $candidates | Sort-Object { [Math]::Abs($_ - $image.Width * .55) } | Select-Object -First 1
    $rowGaps = @()
    for ($y = [int]($image.Height * .46); $y -lt [int]($image.Height * .6); $y++) {
      $occupied = $false
      for ($x = 0; $x -lt $cut; $x++) {
        if ($image.GetPixel($x, $y).A -gt 10) { $occupied = $true; break }
      }
      if (!$occupied) { $rowGaps += $y }
    }
    if (!$rowGaps.Count) { throw "Missing I / M gutter: $($entry.Key)" }
    $top = $rowGaps | Sort-Object { [Math]::Abs($_ - $image.Height * .535) } | Select-Object -First 1
    $minX = $image.Width; $minY = $image.Height; $maxX = -1; $maxY = -1
    for ($y = $top; $y -lt $image.Height; $y++) {
      for ($x = 0; $x -lt $cut; $x++) {
        if ($image.GetPixel($x, $y).A -gt 10) {
          $minX = [Math]::Min($minX, $x); $maxX = [Math]::Max($maxX, $x)
          $minY = [Math]::Min($minY, $y); $maxY = [Math]::Max($maxY, $y)
        }
      }
    }
    if ($maxX -lt $minX) { throw "Missing letter M: $($entry.Key)" }
    $graphics = [Drawing.Graphics]::FromImage($image)
    try {
      $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
      $transparent = [Drawing.SolidBrush]::new([Drawing.Color]::Transparent)
      $graphics.FillRectangle($transparent, 0, $top, [int]$cut, $image.Height - $top)
      $transparent.Dispose()
      $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceOver
      $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $graphics.TranslateTransform($minX + 1, $minY + 1)
      $graphics.ScaleTransform(($maxX - $minX - 2) / 156, ($maxY - $minY - 2) / 130)
      $path = [Drawing.Drawing2D.GraphicsPath]::new()
      $path.StartFigure()
      $path.AddBezier(9,3,-2,3,-2,15,7,18)
      $path.AddBezier(7,18,12,20,13,25,17,34)
      $path.AddLine(17,34,58,121)
      $path.AddBezier(58,121,62,132,82,132,87,121)
      $path.AddLine(87,121,129,32)
      $path.AddBezier(129,32,132,25,136,21,145,19)
      $path.AddBezier(145,19,156,16,158,5,146,3)
      $path.AddLine(146,3,116,3)
      $path.AddBezier(116,3,104,3,100,14,111,19)
      $path.AddBezier(111,19,118,22,118,26,114,35)
      $path.AddLine(114,35,84,99)
      $path.AddLine(84,99,55,33)
      $path.AddBezier(55,33,50,23,51,21,59,18)
      $path.AddBezier(59,18,70,14,68,3,57,3)
      $path.CloseFigure()
      $outline = [Drawing.Pen]::new([Drawing.Color]::White, 3)
      $outline.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
      $ink = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(17,17,17))
      $graphics.DrawPath($outline, $path)
      $graphics.FillPath($ink, $path)
      $ink.Dispose(); $outline.Dispose(); $path.Dispose()
    } finally { $graphics.Dispose() }
    $id = $entry.Key -replace '^ime-', 'ive-'
    $image.Save((Join-Path $toolDirectory "assets/$id.png"), [Drawing.Imaging.ImageFormat]::Png)
    Write-Output "Generated $id.png"
  } finally { $image.Dispose() }
}
