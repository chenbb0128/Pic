# Preserve existing artwork silhouettes and I/ME lettering; replace only the heart fill.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class PartyMotifRaster {
  public static void Create(string input, string output, bool combo) {
    using (var original = new Bitmap(input))
    using (var image = new Bitmap(combo ? original.Width : original.Width * 4,
                                  combo ? original.Height : original.Height * 4, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(image)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(original, new Rectangle(0, 0, image.Width, image.Height));
      }
      int w = image.Width, h = image.Height;
      int left = combo ? (int)Math.Floor(w / 4.0 * .4) * 4 : 0;
      int bottom = combo ? (int)Math.Floor(h / 4.0 * .52) * 4 : h;
      var locked = image.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      try {
        var pixels = new byte[locked.Stride * h];
        Marshal.Copy(locked.Scan0, pixels, 0, pixels.Length);
        for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
          int p = y * locked.Stride + x * 4;
          if (pixels[p + 3] == 0) continue;
          double mix = 1;
          if (!combo) {
            double ux = x * 192.0 / w, uy = y * 192.0 / w;
            int row = (int)Math.Floor(uy / 14);
            double offset = row % 2 == 0 ? 0 : 7;
            double dx = ux - (Math.Floor((ux - offset) / 14) * 14 + offset + 7);
            double dy = uy - (row * 14 + 7);
            mix = Math.Max(0, Math.Min(1, (1.25 - Math.Sqrt(dx * dx + dy * dy)) * 4 + .5));
          }
          pixels[p] = (byte)Math.Round(255 + (combo ? 116 - 255 : 183 - 255) * mix);
          pixels[p + 1] = (byte)Math.Round(255 + (combo ? 46 - 255 : 128 - 255) * mix);
          pixels[p + 2] = (byte)Math.Round(255 + (combo ? 235 - 255 : 236 - 255) * mix);
        }
        Marshal.Copy(pixels, 0, locked.Scan0, pixels.Length);
      } finally { image.UnlockBits(locked); }
      image.Save(output, ImageFormat.Png);
    }
  }
}
'@
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
[PartyMotifRaster]::Create((Join-Path $assetDirectory '7b31a75365b295b0f44b.png'), (Join-Path $assetDirectory 'white-pink-dot-heart-small.png'), $false)
[PartyMotifRaster]::Create((Join-Path $assetDirectory 'ime-brown-polka.png'), (Join-Path $assetDirectory 'ime-hot-pink.png'), $true)
Write-Output 'Generated white-pink-dot-heart-small.png and ime-hot-pink.png'
