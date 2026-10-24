# Match the existing yellow star: #F6EAA0 background with #A45F29 dots.
# Preserve verified silhouettes, lettering and photo geometry; output at 4x resolution.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class YellowPolkaRaster {
  public static void Create(string input, string output, int scale, bool combo) {
    using (var original = new Bitmap(input))
    using (var image = new Bitmap(original.Width*scale, original.Height*scale, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(image)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(original, new Rectangle(0, 0, image.Width, image.Height));
      }
      int w = image.Width, h = image.Height;
      // In letter combinations only the isolated upper-right heart is recolored.
      int left = combo ? (int)(original.Width*.4)*scale : 0;
      int bottom = combo ? (int)(original.Height*.52)*scale : h;
      var locked = image.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      try {
        var pixels = new byte[locked.Stride*h];
        Marshal.Copy(locked.Scan0, pixels, 0, pixels.Length);
        int minX = w, maxX = -1, minY = h;
        for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
          if (pixels[y*locked.Stride+x*4+3] == 0) continue;
          minX = Math.Min(minX,x); maxX = Math.Max(maxX,x); minY = Math.Min(minY,y);
        }
        if (maxX < minX) throw new InvalidOperationException("Heart silhouette not found");
        for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
          int p = y*locked.Stride+x*4;
          if (pixels[p+3] == 0) continue;
          double ux = (x+.5-minX)*191/(maxX-minX+1), uy = (y+.5-minY)*191/(maxX-minX+1);
          double row = Math.Floor(uy/18), offset = ((int)row%2)*9;
          double cx = Math.Floor((ux-offset)/18)*18+offset+9, cy = row*18+9;
          double distance = Math.Sqrt((ux-cx)*(ux-cx)+(uy-cy)*(uy-cy));
          double mix = Math.Max(0,Math.Min(1,(2.3-distance)*4+.5));
          pixels[p] = (byte)Math.Round(160+(41-160)*mix);
          pixels[p+1] = (byte)Math.Round(234+(95-234)*mix);
          pixels[p+2] = (byte)Math.Round(246+(164-246)*mix);
        }
        Marshal.Copy(pixels, 0, locked.Scan0, pixels.Length);
      } finally { image.UnlockBits(locked); }
      image.Save(output, ImageFormat.Png);
    }
  }
}
'@
$toolDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star'))
$toolHtml = Get-Content -Raw -LiteralPath (Join-Path $toolDirectory 'index.html')
$motifAssets = [regex]::Match($toolHtml, 'const customAssets=(\{[^\r\n]+\});').Groups[1].Value | ConvertFrom-Json -AsHashtable
foreach ($suffix in @('-small', '')) {
  $maskPath = Join-Path $toolDirectory "assets/red-polka-heart$suffix.png"
  $outputPath = Join-Path $toolDirectory "assets/yellow-polka-heart$suffix.png"
  [YellowPolkaRaster]::Create($maskPath, $outputPath, 1, $false)
  Write-Output "Generated yellow-polka-heart$suffix.png"
}
foreach ($letters in @('ime', 'ive')) {
  $source = if ($letters -eq 'ime') { $motifAssets['ime-yellow-glow'].src } else { './assets/ive-yellow-glow.png' }
  $inputPath = Join-Path $toolDirectory $source
  $outputPath = Join-Path $toolDirectory "assets/$letters-yellow-polka.png"
  [YellowPolkaRaster]::Create($inputPath, $outputPath, 4, $true)
  Write-Output "Generated $letters-yellow-polka.png"
}
