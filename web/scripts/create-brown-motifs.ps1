# Generate two patterns from existing heart silhouettes at 4x resolution.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class BrownHeartRaster {
  public static void Create(string input, string output, bool stripes) {
    using (var original = new Bitmap(input))
    using (var image = new Bitmap(original.Width * 4, original.Height * 4, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(image)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(original, new Rectangle(0, 0, image.Width, image.Height));
      }
      int w = image.Width, h = image.Height, n = w * h;
      var locked = image.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      try {
        var pixels = new byte[locked.Stride * h]; Marshal.Copy(locked.Scan0, pixels, 0, pixels.Length);
        var alpha = new byte[n]; var outside = new bool[n]; var queue = new int[n]; int head = 0, tail = 0;
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) alpha[y*w+x] = pixels[y*locked.Stride+x*4+3];
        Action<int> visit = i => { if (!outside[i] && alpha[i] == 0) { outside[i] = true; queue[tail++] = i; } };
        for (int x = 0; x < w; x++) { visit(x); visit((h-1)*w+x); }
        for (int y = 0; y < h; y++) { visit(y*w); visit(y*w+w-1); }
        while (head < tail) {
          int i = queue[head++], x = i % w;
          if (x > 0) visit(i-1); if (x+1 < w) visit(i+1);
          if (i >= w) visit(i-w); if (i+w < n) visit(i+w);
        }
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
          int i = y*w+x, p = y*locked.Stride+x*4;
          if (outside[i]) { pixels[p+3] = 0; continue; }
          double ux = (x+.5)*191/w, uy = (y+.5)*191/w, mix;
          if (stripes) mix = (ux%22) < 11 ? 0 : 1;
          else {
            double row = Math.Floor(uy/18), offset = ((int)row%2)*9;
            double cx = Math.Floor((ux-offset)/18)*18+offset+9, cy = row*18+9;
            double distance = Math.Sqrt((ux-cx)*(ux-cx)+(uy-cy)*(uy-cy));
            mix = Math.Max(0, Math.Min(1, (2.3-distance)*4+.5));
          }
          int r = stripes ? 166 : 255, g = stripes ? 101 : 255, b = stripes ? 75 : 255;
          pixels[p] = (byte)Math.Round(40+(b-40)*mix);
          pixels[p+1] = (byte)Math.Round(56+(g-56)*mix);
          pixels[p+2] = (byte)Math.Round(102+(r-102)*mix);
          bool edge = x == 0 || x == w-1 || y == 0 || y == h-1 || outside[i-1] || outside[i+1] || outside[i-w] || outside[i+w];
          pixels[p+3] = edge ? alpha[i] : (byte)255;
        }
        Marshal.Copy(pixels, 0, locked.Scan0, pixels.Length);
      } finally { image.UnlockBits(locked); }
      image.Save(output, ImageFormat.Png);
    }
  }
}
'@
$toolDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star'))
$html = Get-Content -Raw -LiteralPath (Join-Path $toolDirectory 'index.html')
$assets = [regex]::Match($html, 'const customAssets=(\{[^\r\n]+\});').Groups[1].Value | ConvertFrom-Json -AsHashtable
foreach ($suffix in @('-small', '')) {
  $inputPath = Join-Path $toolDirectory $assets["rose-heart$suffix"].src
  foreach ($pattern in @('polka', 'stripe')) {
    $outputPath = Join-Path $toolDirectory "assets/brown-$pattern-heart$suffix.png"
    [BrownHeartRaster]::Create($inputPath, $outputPath, $pattern -eq 'stripe')
    Write-Output "Generated brown-$pattern-heart$suffix.png"
  }
}
