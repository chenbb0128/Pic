# Use verified filled heart/star silhouettes at their existing 4x resolution.
# Pale blue #B9DFF5, either solid or paired with white vertical stripes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class LightBlueMotifRaster {
  public static void Create(string input, string output, bool stripes) {
    using (var image = new Bitmap(input)) {
      int w = image.Width, h = image.Height;
      var locked = image.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      try {
        var pixels = new byte[locked.Stride * h];
        Marshal.Copy(locked.Scan0, pixels, 0, pixels.Length);
        for (int x = 0; x < w; x++) {
          bool white = stripes && ((x + .5) * 191 / w) % 22 >= 11;
          for (int y = 0; y < h; y++) {
            int p = y * locked.Stride + x * 4;
            if (pixels[p + 3] == 0) continue;
            pixels[p] = (byte)(white ? 255 : 245);
            pixels[p + 1] = (byte)(white ? 255 : 223);
            pixels[p + 2] = (byte)(white ? 255 : 185);
          }
        }
        Marshal.Copy(pixels, 0, locked.Scan0, pixels.Length);
      } finally { image.UnlockBits(locked); }
      image.Save(output, ImageFormat.Png);
    }
  }
}
'@
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
foreach ($pattern in @('solid', 'stripe')) {
  foreach ($shape in @('heart', 'star')) {
    foreach ($suffix in @('-small', '')) {
      $sourcePath = Join-Path $assetDirectory "red-polka-$shape$suffix.png"
      $outputPath = Join-Path $assetDirectory "light-blue-$pattern-$shape$suffix.png"
      [LightBlueMotifRaster]::Create($sourcePath, $outputPath, $pattern -eq 'stripe')
      Write-Output "Generated light-blue-$pattern-$shape$suffix.png"
    }
  }
}
