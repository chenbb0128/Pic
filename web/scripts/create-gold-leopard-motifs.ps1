# Draw classic warm leopard rosettes locally. Reuse the verified 4x PNG alpha masks.
# Run create-red-motifs.ps1 first if those source masks are missing.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class GoldLeopardRaster {
  static PointF Point(double angle, double radius, double ratio) {
    return new PointF((float)(Math.Cos(angle)*radius), (float)(Math.Sin(angle)*radius*ratio));
  }
  public static void Create(string maskPath, string output) {
    using (var mask = new Bitmap(maskPath))
    using (var image = new Bitmap(mask.Width, mask.Height, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(image))
      using (var middle = new SolidBrush(Color.FromArgb(165, 104, 48)))
      using (var dark = new SolidBrush(Color.FromArgb(52, 32, 21))) {
        g.Clear(Color.FromArgb(222, 175, 103));
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.ScaleTransform(image.Width/286f, image.Width/286f);
        var random = new Random(382876);
        double height = image.Height*286.0/image.Width;
        for (int row = -1; row*34 < height+34; row++) for (int col = -1; col < 10; col++) {
          var transform = g.Save();
          g.TranslateTransform((float)(col*34+(row%2)*17+random.NextDouble()*13-6),
            (float)(row*34+random.NextDouble()*13-6));
          g.RotateTransform((float)(random.NextDouble()*360));
          double radius = 9+random.NextDouble()*4, ratio = .7+random.NextDouble()*.6;
          const int count = 16;
          var rim = new PointF[count]; var center = new PointF[count];
          for (int i = 0; i < count; i++) {
            double angle = i*Math.PI*2/count, r = radius*(.85+random.NextDouble()*.3);
            rim[i] = Point(angle, r, ratio); center[i] = Point(angle, r*.68, ratio);
          }
          g.FillClosedCurve(middle, center);
          using (var pen = new Pen(dark, (float)(2.8+random.NextDouble()*1.5))) {
            pen.StartCap = pen.EndCap = LineCap.Round;
            // Broken, irregular rings rather than uniformly closed polka dots.
            foreach (var arc in new[] { new[] { 0, 5 }, new[] { 6, 5 }, new[] { 12, 4 } }) {
              var points = new PointF[arc[1]];
              Array.Copy(rim, arc[0], points, 0, points.Length);
              g.DrawCurve(pen, points, .7f);
            }
          }
          if (random.NextDouble() < .65) g.FillEllipse(dark, (float)(radius+3), -2, 3.5f, 4.5f);
          if (random.NextDouble() < .35) g.FillEllipse(dark, -3, (float)(radius*ratio+3), 4.5f, 3);
          g.Restore(transform);
        }
      }
      var rect = new Rectangle(0, 0, image.Width, image.Height);
      var source = mask.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        var target = image.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try {
          var alpha = new byte[source.Stride*image.Height];
          var pixels = new byte[target.Stride*image.Height];
          Marshal.Copy(source.Scan0, alpha, 0, alpha.Length); Marshal.Copy(target.Scan0, pixels, 0, pixels.Length);
          for (int y = 0; y < image.Height; y++) for (int x = 0; x < image.Width; x++) {
            pixels[y*target.Stride+x*4+3] = alpha[y*source.Stride+x*4+3];
          }
          Marshal.Copy(pixels, 0, target.Scan0, pixels.Length);
        } finally { image.UnlockBits(target); }
      } finally { mask.UnlockBits(source); }
      image.Save(output, ImageFormat.Png);
    }
  }
}
'@
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
foreach ($shape in @('heart', 'star')) {
  foreach ($suffix in @('-small', '')) {
    $maskPath = Join-Path $assetDirectory "red-polka-$shape$suffix.png"
    $outputPath = Join-Path $assetDirectory "gold-leopard-$shape$suffix.png"
    [GoldLeopardRaster]::Create($maskPath, $outputPath)
    Write-Output "Generated gold-leopard-$shape$suffix.png"
  }
}
