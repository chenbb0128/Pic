# Recolor the existing white/mint stars using the pink ink from the matching heart.
# Preserve original alpha, white background, dimensions and pattern geometry.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$toolDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star'))
$toolHtml = Get-Content -Raw -LiteralPath (Join-Path $toolDirectory 'index.html')
$motifAssets = [regex]::Match($toolHtml, 'const customAssets=(\{[^\r\n]+\});').Groups[1].Value | ConvertFrom-Json -AsHashtable

function Get-PatternInk([Drawing.Bitmap]$bitmap) {
  $counts = @{}
  for ($y = 0; $y -lt $bitmap.Height; $y++) { for ($x = 0; $x -lt $bitmap.Width; $x++) {
    $color = $bitmap.GetPixel($x, $y)
    if ($color.A -ne 255 -or ([Math]::Max($color.R, [Math]::Max($color.G, $color.B)) - [Math]::Min($color.R, [Math]::Min($color.G, $color.B))) -lt 20) { continue }
    $key = $color.ToArgb()
    $counts[$key] = 1 + $counts[$key]
  } }
  if (!$counts.Count) { throw 'No pattern ink found in the source image.' }
  $mostCommon = $counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
  return [Drawing.Color]::FromArgb([int]$mostCommon.Key)
}

$pinkHeart = [Drawing.Bitmap]::new((Join-Path $toolDirectory $motifAssets['pink-star-heart'].src))
try { $pinkInk = Get-PatternInk $pinkHeart } finally { $pinkHeart.Dispose() }
foreach ($suffix in @('-small', '')) {
  $image = [Drawing.Bitmap]::new((Join-Path $toolDirectory $motifAssets["white-mint-star$suffix"].src))
  try {
    $mintInk = Get-PatternInk $image
    for ($y = 0; $y -lt $image.Height; $y++) { for ($x = 0; $x -lt $image.Width; $x++) {
      $color = $image.GetPixel($x, $y)
      if (!$color.A) { continue }
      $amount = [Math]::Max(0, [Math]::Min(1, (255 - $color.R) / (255 - $mintInk.R)))
      $red = [int][Math]::Round(255 + ($pinkInk.R - 255) * $amount)
      $green = [int][Math]::Round(255 + ($pinkInk.G - 255) * $amount)
      $blue = [int][Math]::Round(255 + ($pinkInk.B - 255) * $amount)
      $image.SetPixel($x, $y, [Drawing.Color]::FromArgb($color.A, $red, $green, $blue))
    } }
    $image.Save((Join-Path $toolDirectory "assets/white-pink-star$suffix.png"), [Drawing.Imaging.ImageFormat]::Png)
    Write-Output "Generated white-pink-star$suffix.png ($($image.Width) x $($image.Height))"
  } finally { $image.Dispose() }
}
