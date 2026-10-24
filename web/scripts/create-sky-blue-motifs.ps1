# Recolor the verified 4x brown patterns to sky blue #72C7F5 and white.
# Preserve the original alpha, vertical stripes, staggered dots and black lettering.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class SkyBlueHeartRaster {
  public static void Create(string input, string output, bool stripes, bool combo) {
    using (var image = new Bitmap(input)) {
      int w = image.Width, h = image.Height;
      // Use the same native-coordinate boundaries as create-pattern-combos.ps1.
      int left = combo ? (int)Math.Floor(w / 4.0 * .4) * 4 : 0;
      int bottom = combo ? (int)Math.Floor(h / 4.0 * .52) * 4 : h;
      var locked = image.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      try {
        var pixels = new byte[locked.Stride * h];
        Marshal.Copy(locked.Scan0, pixels, 0, pixels.Length);
        for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
          int p = y * locked.Stride + x * 4;
          if (pixels[p + 3] == 0) continue;
          // Recover existing pattern coverage, including antialiased polka-dot edges.
          double mix = Math.Max(0, Math.Min(1, (pixels[p + 2] - 102.0) / (stripes ? 64 : 153)));
          pixels[p] = (byte)Math.Round(245 + (255 - 245) * mix);
          pixels[p + 1] = (byte)Math.Round(199 + (255 - 199) * mix);
          pixels[p + 2] = (byte)Math.Round(114 + (255 - 114) * mix);
        }
        Marshal.Copy(pixels, 0, locked.Scan0, pixels.Length);
      } finally { image.UnlockBits(locked); }
      image.Save(output, ImageFormat.Png);
    }
  }
}
'@
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
foreach ($pattern in @('polka', 'stripe')) {
  foreach ($suffix in @('-small', '')) {
    $sourcePath = Join-Path $assetDirectory "brown-$pattern-heart$suffix.png"
    $outputPath = Join-Path $assetDirectory "sky-blue-$pattern-heart$suffix.png"
    [SkyBlueHeartRaster]::Create($sourcePath, $outputPath, $pattern -eq 'stripe', $false)
    Write-Output "Generated sky-blue-$pattern-heart$suffix.png"
  }
  foreach ($letters in @('ime', 'ive')) {
    $sourcePath = Join-Path $assetDirectory "$letters-brown-$pattern.png"
    $outputPath = Join-Path $assetDirectory "$letters-sky-blue-$pattern.png"
    [SkyBlueHeartRaster]::Create($sourcePath, $outputPath, $pattern -eq 'stripe', $true)
    Write-Output "Generated $letters-sky-blue-$pattern.png"
  }
}
