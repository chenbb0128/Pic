# Extract the reference's actual caramel rosettes (including heart-shaped spots),
# arrange a deterministic texture and reuse the verified 4x artwork masks.
param([Parameter(Mandatory = $true)][string]$ReferencePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = @([AppContext]::GetData('TRUSTED_PLATFORM_ASSEMBLIES') -split [IO.Path]::PathSeparator)
Add-Type -ReferencedAssemblies $drawingReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class CaramelLeopardRaster {
  static byte[] Pixels(Bitmap image) {
    var rect = new Rectangle(0, 0, image.Width, image.Height);
    var bits = image.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      var data = new byte[image.Width * image.Height * 4];
      for (int y = 0; y < image.Height; y++) Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), data, y * image.Width * 4, image.Width * 4);
      return data;
    } finally { image.UnlockBits(bits); }
  }
  static void WritePixels(Bitmap image, byte[] data) {
    var bits = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    try {
      for (int y = 0; y < image.Height; y++) Marshal.Copy(data, y * image.Width * 4, IntPtr.Add(bits.Scan0, y * bits.Stride), image.Width * 4);
    } finally { image.UnlockBits(bits); }
  }
  static void FeatherEdges(Bitmap image) {
    var pixels = Pixels(image); int w = image.Width, h = image.Height;
    using (var g = Graphics.FromImage(image)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      for (int y = 2; y < h-2; y++) for (int x = 2; x < w-2; x++) {
        int p = (y*w+x)*4;
        if (pixels[p+2] > 195) continue;
        // Sparse, submillimeter fibers extend only across color boundaries.
        uint hash = unchecked((uint)(x*374761393 ^ y*668265263));
        hash = unchecked((hash ^ (hash >> 13))*1274126177u);
        hash ^= hash >> 16;
        if (hash%5 != 0) continue;
        double gx = pixels[p+8+2]-pixels[p-8+2], gy = pixels[p+w*8+2]-pixels[p-w*8+2];
        double length = Math.Sqrt(gx*gx+gy*gy);
        if (length < 50) continue;
        float nx = (float)(gx/length), ny = (float)(gy/length);
        float fiber = 1.7f+(hash%101)/100f*1.6f;
        using (var pen = new Pen(Color.FromArgb(235,pixels[p+2],pixels[p+1],pixels[p]),.65f+(hash%7)*.06f)) {
          g.DrawLine(pen,x+.5f-nx*.4f,y+.5f-ny*.4f,x+.5f+nx*fiber,y+.5f+ny*fiber);
        }
      }
    }
  }
  public static Bitmap Texture(string reference) {
    var rosettes = new Bitmap[256]; var spots = new Bitmap[256];
    int rosetteCount = 0, spotCount = 0;
    try {
      using (var image = new Bitmap(reference)) {
        int w = image.Width, h = image.Height;
        var data = Pixels(image); var seen = new bool[w*h]; var queue = new int[w*h];
        for (int seed = 0; seed < w*h; seed++) {
          if (seen[seed] || data[seed*4+3] < 128 || data[seed*4+1] >= 200) continue;
          int head = 0, tail = 0, left = w, top = h, right = 0, bottom = 0, caramel = 0;
          bool cutOff = false;
          Action<int> visit = i => {
            if (seen[i] || data[i*4+3] < 128 || data[i*4+1] >= 200) return;
            seen[i] = true; queue[tail++] = i;
            int x = i%w, y = i/w;
            left = Math.Min(left,x); top = Math.Min(top,y); right = Math.Max(right,x); bottom = Math.Max(bottom,y);
            if (data[i*4+2] > 125) caramel++;
          };
          visit(seed);
          while (head < tail) {
            int i = queue[head++], x = i%w, y = i/w;
            for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
              if (x+dx >= 0 && x+dx < w && y+dy >= 0 && y+dy < h) {
                int neighbor = i+dy*w+dx;
                if (data[neighbor*4+3] < 250) cutOff = true;
                visit(neighbor);
              } else cutOff = true;
            }
          }
          // Discard the reference's exterior outline and cut-off edge marks.
          int width = right-left+1, height = bottom-top+1;
          if (cutOff || tail < 650 || width > 350 || height > 320 || left < 80 || right > w-80 || top < 100 || bottom > h-100) continue;
          var stamp = new Bitmap(width+4, height+4, PixelFormat.Format32bppArgb);
          var rgba = new byte[stamp.Width*stamp.Height*4];
          for (int n = 0; n < tail; n++) {
            int i = queue[n], p = ((i/w-top+2)*stamp.Width+i%w-left+2)*4;
            Array.Copy(data,i*4,rgba,p,4);
            // Match the updated reference: warm apricot, deeper caramel and espresso.
            double mix = Math.Max(0, (data[i*4+2]-54)/145.0);
            rgba[p+2] = (byte)Math.Min(255, Math.Round(48+111*mix));
            rgba[p+1] = (byte)Math.Min(255, Math.Round(31+63*mix));
            rgba[p] = (byte)Math.Min(255, Math.Round(25+32*mix));
            // Separate the creamy paper from the softly antialiased spot edge.
            rgba[p+3] = (byte)Math.Min(255, Math.Max(0, (200-data[i*4+1])*17));
          }
          WritePixels(stamp,rgba);
          if (caramel > tail*.15 && width > 120 && height > 110 && rosetteCount < rosettes.Length) rosettes[rosetteCount++] = stamp;
          else if (width < 125 && height < 125 && spotCount < spots.Length) spots[spotCount++] = stamp;
          else stamp.Dispose();
        }
      }
      if (rosetteCount < 3 || spotCount < 3) throw new InvalidOperationException("The reference must contain complete caramel rosettes and dark spots.");
      var texture = new Bitmap(1200,1200,PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(texture))
      using (var cream = new LinearGradientBrush(new Point(0,0),new Point(1200,1200),Color.FromArgb(244,202,164),Color.FromArgb(241,194,155))) {
        g.FillRectangle(cream,0,0,1200,1200);
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        var random = new Random(663828);
        for (int row = -1; row < 6; row++) for (int col = -1; col < 6; col++) {
          var stamp = rosettes[random.Next(rosetteCount)];
          float x = (float)(col*240+(row%2)*115+random.NextDouble()*38), y = (float)(row*235+random.NextDouble()*35);
          float scale = (float)((.84+random.NextDouble()*.16)*225/Math.Max(stamp.Width,stamp.Height));
          var transform = g.Save();
          g.TranslateTransform(x,y); g.RotateTransform((float)(random.NextDouble()*150-75));
          g.ScaleTransform(random.Next(2) == 0 ? -scale : scale,scale);
          g.DrawImage(stamp,-stamp.Width/2f,-stamp.Height/2f,stamp.Width,stamp.Height);
          g.Restore(transform);
          var spot = spots[random.Next(spotCount)];
          float size = (float)(40+random.NextDouble()*35), factor = size/Math.Max(spot.Width,spot.Height);
          transform = g.Save();
          g.TranslateTransform(x+110,y+90); g.RotateTransform((float)(random.NextDouble()*360));
          g.DrawImage(spot,-spot.Width*factor/2,-spot.Height*factor/2,spot.Width*factor,spot.Height*factor);
          g.Restore(transform);
        }
      }
      FeatherEdges(texture);
      Console.WriteLine("Reference texture: {0} complete rosettes, {1} dark spots",rosetteCount,spotCount);
      return texture;
    } finally {
      for (int i = 0; i < rosetteCount; i++) rosettes[i].Dispose();
      for (int i = 0; i < spotCount; i++) spots[i].Dispose();
    }
  }
  public static void Create(string input, string output, Bitmap texture, bool combo) {
    using (var image = new Bitmap(input))
    using (var fill = new Bitmap(image.Width,image.Height,PixelFormat.Format32bppArgb)) {
      int w = image.Width, h = image.Height;
      // Same isolated heart bounds used by the existing letter-pattern generators.
      int left = combo ? (int)Math.Floor(w/4.0*.4)*4 : 0;
      int bottom = combo ? (int)Math.Floor(h/4.0*.52)*4 : h;
      using (var g = Graphics.FromImage(fill)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        // Centered 15% texture enlargement; artwork silhouettes keep their original size.
        float side = texture.Width/1.15f, inset = (texture.Width-side)/2;
        g.DrawImage(texture,new Rectangle(left,0,w-left,bottom),inset,inset,side,side,GraphicsUnit.Pixel);
      }
      var pixels = Pixels(image); var pattern = Pixels(fill);
      for (int y = 0; y < bottom; y++) for (int x = left; x < w; x++) {
        int p = (y*w+x)*4;
        // Keep the alpha mask and every pixel of the original I / ME / VE letters.
        if (pixels[p+3] > 0) Array.Copy(pattern,p,pixels,p,3);
      }
      WritePixels(image,pixels); image.Save(output,ImageFormat.Png);
    }
  }
}
'@
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../public/embedded/heart-star/assets'))
$texture = [CaramelLeopardRaster]::Texture((Resolve-Path -LiteralPath $ReferencePath).Path)
try {
  foreach ($shape in @('heart', 'star')) {
    foreach ($suffix in @('-small', '')) {
      $outputPath = Join-Path $assetDirectory "caramel-leopard-$shape$suffix.png"
      [CaramelLeopardRaster]::Create((Join-Path $assetDirectory "red-polka-$shape$suffix.png"), $outputPath, $texture, $false)
      Write-Output "Generated caramel-leopard-$shape$suffix.png"
    }
  }
  foreach ($letters in @('ime', 'ive')) {
    $outputPath = Join-Path $assetDirectory "$letters-caramel-leopard.png"
    [CaramelLeopardRaster]::Create((Join-Path $assetDirectory "$letters-brown-polka.png"), $outputPath, $texture, $true)
    Write-Output "Generated $letters-caramel-leopard.png"
  }
} finally { $texture.Dispose() }
