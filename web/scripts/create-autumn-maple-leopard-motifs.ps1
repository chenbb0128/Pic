# Recolor verified 4x caramel leopard artwork using the autumn maple reference.
# Preserve rosettes, fine fibers, transparent silhouettes and letter pixels.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class AutumnMapleLeopardRaster {
  public static void Create(string input, string output, bool combo) {
    using (var image = new Bitmap(input)) {
      int w = image.Width, h = image.Height;
      // Same heart-only bounds used by the other letter-pattern generators.
      int left = combo ? (int)Math.Floor(w/4.0*.4)*4 : 0;
      int bottom = combo ? (int)Math.Floor(h/4.0*.52)*4 : h;
      var bits = image.LockBits(new Rectangle(0,0,w,h),ImageLockMode.ReadWrite,PixelFormat.Format32bppArgb);
      try {
        var pixels = new byte[bits.Stride*h];
        Marshal.Copy(bits.Scan0,pixels,0,pixels.Length);
        for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
          int p = y*bits.Stride+x*4;
          if (pixels[p+3] == 0) continue;
          double red = pixels[p+2];
          // Tan #E1AE82, maple #AE6434 and dark brown #4B2A18.
          // Interpolate existing shading and fine antialiased fibers.
          if (red <= 159) {
            double mix = Math.Max(0,Math.Min(1,(red-48)/111));
            pixels[p+2] = (byte)Math.Round(75+(174-75)*mix);
            pixels[p+1] = (byte)Math.Round(42+(100-42)*mix);
            pixels[p] = (byte)Math.Round(24+(52-24)*mix);
          } else {
            double mix = Math.Max(0,Math.Min(1,(red-159)/83));
            pixels[p+2] = (byte)Math.Round(174+(225-174)*mix);
            pixels[p+1] = (byte)Math.Round(100+(174-100)*mix);
            pixels[p] = (byte)Math.Round(52+(130-52)*mix);
          }
        }
        Marshal.Copy(pixels,0,bits.Scan0,pixels.Length);
      } finally { image.UnlockBits(bits); }
      image.Save(output,ImageFormat.Png);
    }
  }
}
'@
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
foreach ($shape in @('heart', 'star')) {
  foreach ($suffix in @('-small', '')) {
    $outputPath = Join-Path $assetDirectory "autumn-maple-leopard-$shape$suffix.png"
    [AutumnMapleLeopardRaster]::Create((Join-Path $assetDirectory "caramel-leopard-$shape$suffix.png"), $outputPath, $false)
    Write-Output "Generated autumn-maple-leopard-$shape$suffix.png"
  }
}
foreach ($letters in @('ime', 'ive')) {
  $outputPath = Join-Path $assetDirectory "$letters-autumn-maple-leopard.png"
  [AutumnMapleLeopardRaster]::Create((Join-Path $assetDirectory "$letters-caramel-leopard.png"), $outputPath, $true)
  Write-Output "Generated $letters-autumn-maple-leopard.png"
}
