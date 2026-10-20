# Reuse the verified vertical stripe geometry and alpha without modifying brown PNGs.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
$pink = [Drawing.ColorTranslator]::FromHtml('#e88bad')
$lightPink = [Drawing.ColorTranslator]::FromHtml('#f9dce7')
foreach ($suffix in @('-small', '')) {
  $image = [Drawing.Bitmap]::new((Join-Path $assetDirectory "brown-stripe-heart$suffix.png"))
  try {
    for ($x = 0; $x -lt $image.Width; $x++) {
      $ink = if ((($x + .5) * 191 / $image.Width) % 22 -lt 11) { $pink } else { $lightPink }
      for ($y = 0; $y -lt $image.Height; $y++) {
        $alpha = $image.GetPixel($x, $y).A
        if ($alpha) { $image.SetPixel($x, $y, [Drawing.Color]::FromArgb($alpha, $ink.R, $ink.G, $ink.B)) }
      }
    }
    $image.Save((Join-Path $assetDirectory "pink-stripe-heart$suffix.png"), [Drawing.Imaging.ImageFormat]::Png)
    Write-Output "Generated pink-stripe-heart$suffix.png"
  } finally { $image.Dispose() }
}
