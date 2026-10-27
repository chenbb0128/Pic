# Recolor only the heart in the verified 4x letter combinations.
# Match the existing red motifs: #E53935 with #FFF2D8 polka dots.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class RedPatternComboRaster {
  public static void Create(string input, string output) {
    using (var image = new Bitmap(input)) {
      int w = image.Width, h = image.Height;
      // Match the native-coordinate heart boundaries in create-pattern-combos.ps1.
      int left = (int)Math.Floor(w / 4.0 * .4) * 4;
      int bottom = (int)Math.Floor(h / 4.0 * .52) * 4;
      var locked = image.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      try {
        var pixels = new byte[locked.Stride * h];
        Marshal.Copy(locked.Scan0, pixels, 0, pixels.Length);
        for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
          int p = y * locked.Stride + x * 4;
          if (pixels[p + 3] == 0) continue;
          double mix = Math.Max(0, Math.Min(1, (pixels[p + 2] - 102.0) / 153));
          pixels[p] = (byte)Math.Round(53 + (216 - 53) * mix);
          pixels[p + 1] = (byte)Math.Round(57 + (242 - 57) * mix);
          pixels[p + 2] = (byte)Math.Round(229 + (255 - 229) * mix);
        }
        Marshal.Copy(pixels, 0, locked.Scan0, pixels.Length);
      } finally { image.UnlockBits(locked); }
      image.Save(output, ImageFormat.Png);
    }
  }
}
'@
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
foreach ($letters in @('ime', 'ive')) {
  $sourcePath = Join-Path $assetDirectory "$letters-brown-polka.png"
  $outputPath = Join-Path $assetDirectory "$letters-red-polka.png"
  [RedPatternComboRaster]::Create($sourcePath, $outputPath)
  Write-Output "Generated $letters-red-polka.png"
}
