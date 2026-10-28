# Recolor the verified 4x caramel leopard artwork into the black/pink series.
# Preserve rosettes, fine fibers, transparent silhouettes and letter pixels.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class BlackPinkLeopardRaster {
  static bool Center(byte[] pixels, int stride, int x, int y) {
    int p = y*stride+x*4;
    return pixels[p+3] > 0 && pixels[p+2] > 95 && pixels[p+2] < 210 &&
      pixels[p+2]-pixels[p+1] > 40 && pixels[p+1]-pixels[p] > 22;
  }
  static Rectangle[] AccentBounds(byte[] pixels, int stride, int w, int h, int left, int bottom) {
    var bounds = new Rectangle[3];
    var anchors = new[] { new[] { .03, .18 }, new[] { .90, .40 }, new[] { .39, .83 } };
    var distances = new[] { double.PositiveInfinity, double.PositiveInfinity, double.PositiveInfinity };
    var queue = new int[w*h]; var seen = new bool[w*h];
    for (int seedY = 0; seedY < bottom; seedY++) for (int seedX = left; seedX < w; seedX++) {
      if (seen[seedY*w+seedX] || !Center(pixels,stride,seedX,seedY)) continue;
      int head = 0, tail = 0, minX = w, minY = bottom, maxX = left, maxY = 0;
      Action<int,int> visit = (x,y) => {
        if (x < left || x >= w || y < 0 || y >= bottom || seen[y*w+x] || !Center(pixels,stride,x,y)) return;
        seen[y*w+x] = true; queue[tail++] = y*w+x;
        minX = Math.Min(minX,x); minY = Math.Min(minY,y); maxX = Math.Max(maxX,x); maxY = Math.Max(maxY,y);
      };
      visit(seedX,seedY);
      while (head < tail) {
        int i = queue[head++], x = i%w, y = i/w;
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) visit(x+dx,y+dy);
      }
      // Ignore isolated antialias pixels at the silhouette edge; select real spot centers.
      if (tail < (w-left)*bottom*.0005) continue;
      var rectangle = Rectangle.FromLTRB(minX,minY,maxX+1,maxY+1);
      int edge = (int)Math.Ceiling(Math.Min(w-left,bottom)*.006);
      rectangle.Inflate(edge,edge);
      for (int a = 0; a < anchors.Length; a++) {
        double cx = left+(w-left)*anchors[a][0], cy = bottom*anchors[a][1];
        double dx = cx-Math.Max(minX,Math.Min(maxX,cx)), dy = cy-Math.Max(minY,Math.Min(maxY,cy));
        double distance = dx*dx+dy*dy;
        if (distance < distances[a]) { distances[a] = distance; bounds[a] = rectangle; }
      }
    }
    return bounds;
  }
  static void BreakLowerHeart(byte[] pixels, int p, int x, int y, Rectangle center, double rimMask) {
    if (center.IsEmpty || rimMask >= 145) return;
    double dx = x-(center.Left+center.Width/2.0), dy = y-(center.Top+center.Height/2.0);
    if (Math.Abs(dx) > center.Width*.95 || Math.Abs(dy) > center.Height*.95) return;
    double radius = Math.Sqrt(dx*dx+dy*dy), angle = Math.Atan2(dy,dx);
    // Keep the existing three openings independent of the updated rim color.
    double gap = double.PositiveInfinity;
    foreach (double direction in new[] { -2.8, -.2, 1.4 }) {
      double difference = angle-direction+.025*Math.Sin(radius*.31);
      gap = Math.Min(gap,Math.Abs(Math.Atan2(Math.Sin(difference),Math.Cos(difference))));
    }
    uint grain = unchecked((uint)(x*374761393 ^ y*668265263));
    double coverage = Math.Max(0,Math.Min(1,(.12+(grain%11)*.002-gap)*radius+.5));
    pixels[p+2] = (byte)Math.Round(pixels[p+2]+(241-pixels[p+2])*coverage);
    pixels[p+1] = (byte)Math.Round(pixels[p+1]+(149-pixels[p+1])*coverage);
    pixels[p] = (byte)Math.Round(pixels[p]+(165-pixels[p])*coverage);
  }
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
        var accents = AccentBounds(pixels,bits.Stride,w,h,left,bottom);
        for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
          int p = y*bits.Stride+x*4;
          if (pixels[p+3] == 0) continue;
          double red = pixels[p+2];
          // Three edge rosettes, including the lower-left one, get deep-pink centers.
          bool accent = accents[0].Contains(x,y) || accents[1].Contains(x,y) || accents[2].Contains(x,y);
          int centerR = accent ? 174 : 116, centerG = accent ? 52 : 70, centerB = accent ? 92 : 90;
          if (accents[2].Contains(x,y)) { centerR = 155; centerG = 88; centerB = 112; }
          // Keep the blush base, deepen the pink centers, and restore near-black rims.
          // Use the previous colors for the approved three-opening gap mask.
          int originalCenterR = accents[2].Contains(x,y) ? 173 : accent ? 190 : 70;
          double rimMask;
          if (red <= 159) {
            double mix = Math.Max(0,Math.Min(1,(red-48)/111));
            rimMask = Math.Round(32+(originalCenterR-32)*mix);
            pixels[p+2] = (byte)Math.Round(32+(centerR-32)*mix);
            pixels[p+1] = (byte)Math.Round(27+(centerG-27)*mix);
            pixels[p] = (byte)Math.Round(28+(centerB-28)*mix);
          } else {
            double mix = Math.Max(0,Math.Min(1,(red-159)/83));
            pixels[p+2] = (byte)Math.Round(centerR+(241-centerR)*mix);
            pixels[p+1] = (byte)Math.Round(centerG+(149-centerG)*mix);
            pixels[p] = (byte)Math.Round(centerB+(165-centerB)*mix);
            rimMask = Math.Round(originalCenterR+(241-originalCenterR)*mix);
          }
          BreakLowerHeart(pixels,p,x,y,accents[2],rimMask);
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
    $outputPath = Join-Path $assetDirectory "black-pink-leopard-$shape$suffix.png"
    [BlackPinkLeopardRaster]::Create((Join-Path $assetDirectory "caramel-leopard-$shape$suffix.png"), $outputPath, $false)
    Write-Output "Generated black-pink-leopard-$shape$suffix.png"
  }
}
foreach ($letters in @('ime', 'ive')) {
  $outputPath = Join-Path $assetDirectory "$letters-black-pink-leopard.png"
  [BlackPinkLeopardRaster]::Create((Join-Path $assetDirectory "$letters-caramel-leopard.png"), $outputPath, $true)
  Write-Output "Generated $letters-black-pink-leopard.png"
}
