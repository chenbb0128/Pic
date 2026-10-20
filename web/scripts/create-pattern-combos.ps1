# Preserve the source lettering and heart alpha; recolor the heart region only.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
foreach ($letters in @('ime', 'ive')) {
  $sourceName = if ($letters -eq 'ime') { 'ac8f6f1f5522e3e73469.png' } else { 'ive-rose.png' }
  $original = [Drawing.Bitmap]::new((Join-Path $assetDirectory $sourceName))
  try {
    # The upper-right isolated component is the heart; I / ME / VE stay outside this region.
    $left = [int][Math]::Floor($original.Width * .4)
    $bottom = [int][Math]::Floor($original.Height * .52)
    $minX = $original.Width; $maxX = -1; $minY = $original.Height; $maxY = -1
    for ($y=0; $y -lt $bottom; $y++) { for ($x=$left; $x -lt $original.Width; $x++) {
      if ($original.GetPixel($x,$y).A) {
        $minX=[Math]::Min($minX,$x);$maxX=[Math]::Max($maxX,$x)
        $minY=[Math]::Min($minY,$y);$maxY=[Math]::Max($maxY,$y)
      }
    } }
    foreach ($pattern in @('brown-polka','brown-stripe','pink-stripe')) {
      $image = [Drawing.Bitmap]::new($original.Width*4,$original.Height*4)
      $graphics = [Drawing.Graphics]::FromImage($image)
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($original,[Drawing.Rectangle]::new(0,0,$image.Width,$image.Height))
      $graphics.Dispose()
      try {
        $base = if ($pattern -eq 'pink-stripe') { @(232,139,173) } else { @(102,56,40) }
        $accent = if ($pattern -eq 'pink-stripe') { @(249,220,231) } elseif ($pattern -eq 'brown-stripe') { @(166,101,75) } else { @(255,255,255) }
        for ($y=0; $y -lt $bottom*4; $y++) { for ($x=$left*4; $x -lt $image.Width; $x++) {
          $alpha = $image.GetPixel($x,$y).A
          if (!$alpha) { continue }
          $ux = ($x+.5-$minX*4)*191/(($maxX-$minX+1)*4)
          $uy = ($y+.5-$minY*4)*191/(($maxX-$minX+1)*4)
          if ($pattern -eq 'brown-polka') {
            $row = [Math]::Floor($uy/18);$offset = ([int]$row%2)*9
            $cx = [Math]::Floor(($ux-$offset)/18)*18+$offset+9;$cy=$row*18+9
            $distance = [Math]::Sqrt(($ux-$cx)*($ux-$cx)+($uy-$cy)*($uy-$cy))
            $mix = [Math]::Max(0,[Math]::Min(1,(2.3-$distance)*4+.5))
          } else { $mix = if ($ux%22 -lt 11) { 0 } else { 1 } }
          $rgb = 0..2 | ForEach-Object { [int][Math]::Round($base[$_]+($accent[$_]-$base[$_])*$mix) }
          $image.SetPixel($x,$y,[Drawing.Color]::FromArgb($alpha,$rgb[0],$rgb[1],$rgb[2]))
        } }
        $image.Save((Join-Path $assetDirectory "$letters-$pattern.png"),[Drawing.Imaging.ImageFormat]::Png)
        Write-Output "Generated $letters-$pattern.png"
      } finally { $image.Dispose() }
    }
  } finally { $original.Dispose() }
}
