# Recolor the verified 4x leopard artwork using the cream-pink reference palette.
# Preserve fine fibers, transparent silhouettes, dimensions and letter pixels.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class CreamPinkLeopardRaster {
  static bool Center(byte[] pixels, int stride, int x, int y) {
    int p = y*stride+x*4;
    return pixels[p+3] > 0 && pixels[p+2] > 95 && pixels[p+2] < 210 &&
      pixels[p+2]-pixels[p+1] > 40 && pixels[p+1]-pixels[p] > 22;
  }
  static Rectangle LowerLeftBounds(byte[] pixels, int stride, int w, int h, int left, int bottom) {
    var bounds = Rectangle.Empty;
    double distance = double.PositiveInfinity, cx = left+(w-left)*.39, cy = bottom*.83;
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
      // Ignore isolated antialias pixels, then choose the full lower-left rosette.
      if (tail < (w-left)*bottom*.0005) continue;
      double dx0 = cx-Math.Max(minX,Math.Min(maxX,cx)), dy0 = cy-Math.Max(minY,Math.Min(maxY,cy));
      double candidate = dx0*dx0+dy0*dy0;
      if (candidate >= distance) continue;
      distance = candidate;
      bounds = Rectangle.FromLTRB(minX,minY,maxX+1,maxY+1);
      int edge = (int)Math.Ceiling(Math.Min(w-left,bottom)*.006);
      bounds.Inflate(edge,edge);
    }
    return bounds;
  }
  static void BreakLowerHeart(byte[] pixels, int p, int x, int y, Rectangle center, double red) {
    // Limit openings to the dark rim, preserving the berry-pink center.
    if (center.IsEmpty || red >= 137) return;
    double dx = x-(center.Left+center.Width/2.0), dy = y-(center.Top+center.Height/2.0);
    if (Math.Abs(dx) > center.Width*.95 || Math.Abs(dy) > center.Height*.95) return;
    double radius = Math.Sqrt(dx*dx+dy*dy), angle = Math.Atan2(dy,dx);
    double gap = double.PositiveInfinity;
    foreach (double direction in new[] { -2.8, -.2, 1.4 }) {
      double difference = angle-direction+.025*Math.Sin(radius*.31);
      gap = Math.Min(gap,Math.Abs(Math.Atan2(Math.Sin(difference),Math.Cos(difference))));
    }
    uint grain = unchecked((uint)(x*374761393 ^ y*668265263));
    double coverage = Math.Max(0,Math.Min(1,(.12+(grain%11)*.002-gap)*radius+.5));
    pixels[p+2] = (byte)Math.Round(pixels[p+2]+(244-pixels[p+2])*coverage);
    pixels[p+1] = (byte)Math.Round(pixels[p+1]+(184-pixels[p+1])*coverage);
    pixels[p] = (byte)Math.Round(pixels[p]+(192-pixels[p])*coverage);
  }
  public static void Create(string input, string output, bool combo) {
    using (var image = new Bitmap(input)) {
      int w = image.Width, h = image.Height;
      int left = combo ? (int)Math.Floor(w/4.0*.4)*4 : 0;
      int bottom = combo ? (int)Math.Floor(h/4.0*.52)*4 : h;
      var bits = image.LockBits(new Rectangle(0,0,w,h),ImageLockMode.ReadWrite,PixelFormat.Format32bppArgb);
      try {
        var pixels = new byte[bits.Stride*h];
        Marshal.Copy(bits.Scan0,pixels,0,pixels.Length);
        var lowerLeft = LowerLeftBounds(pixels,bits.Stride,w,h,left,bottom);
        for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
          int p = y*bits.Stride+x*4;
          if (pixels[p+3] == 0) continue;
          double red = pixels[p+2];
          // Cream pink #F4B8C0, berry-pink centers #D45F79, cocoa rims #45312F.
          if (red <= 159) {
            double mix = Math.Max(0,Math.Min(1,(red-48)/111));
            pixels[p+2] = (byte)Math.Round(69+(212-69)*mix);
            pixels[p+1] = (byte)Math.Round(49+(95-49)*mix);
            pixels[p] = (byte)Math.Round(47+(121-47)*mix);
          } else {
            double mix = Math.Max(0,Math.Min(1,(red-159)/83));
            pixels[p+2] = (byte)Math.Round(212+(244-212)*mix);
            pixels[p+1] = (byte)Math.Round(95+(184-95)*mix);
            pixels[p] = (byte)Math.Round(121+(192-121)*mix);
          }
          BreakLowerHeart(pixels,p,x,y,lowerLeft,red);
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
    $outputPath = Join-Path $assetDirectory "cream-pink-leopard-$shape$suffix.png"
    [CreamPinkLeopardRaster]::Create((Join-Path $assetDirectory "caramel-leopard-$shape$suffix.png"), $outputPath, $false)
    Write-Output "Generated cream-pink-leopard-$shape$suffix.png"
  }
}
foreach ($letters in @('ime', 'ive')) {
  $outputPath = Join-Path $assetDirectory "$letters-cream-pink-leopard.png"
  [CreamPinkLeopardRaster]::Create((Join-Path $assetDirectory "$letters-caramel-leopard.png"), $outputPath, $true)
  Write-Output "Generated $letters-cream-pink-leopard.png"
}
