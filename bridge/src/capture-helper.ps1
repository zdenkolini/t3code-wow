# The Windows capture helper for t3code-wow's bridge (see WinHelper in capture.js).
#
# It reads the game window's position and copies small parts of the screen, so the
# bridge can read the addon's pixel strip. It reads only: it never moves, focuses or
# sends input to any window. The bridge starts it hidden with
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File capture-helper.ps1
# and it exits when its stdin closes (that is, with the bridge).
#
# Add-Type compiles the C# below with the compiler that ships with Windows' .NET
# Framework, so there's nothing to build or install. Starting PowerShell and compiling
# takes about half a second, which is why the bridge keeps one helper running.
#
# Each stdin line is a numbered request; each stdout line answers one, with the same
# number first: "<n> ok <data>" or "<n> err <message>".
#   <n> windows <pid>                        JSON window list for pickWindowsWindow
#   <n> grab <x> <y> <w> <h>                 base64 BMP of that screen rectangle
#   <n> shot <x> <y> <w> <h> <outW> <outH>   base64 JPEG, scaled to outW x outH
# The thread is per-monitor DPI aware, so every coordinate is in physical pixels, across
# all monitors and scale factors.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class T3Strip {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  const int DWMWA_CLOAKED = 14, GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80;
  const uint MONITOR_DEFAULTTONEAREST = 2;
  // The class of Forever's game window (WOW_WINDOW_CLASS in capture.js), which finds it
  // when the pid isn't known.
  const string WOW_WINDOW_CLASS = "waApplication Window";
  static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

  static string Rect(int x, int y, int w, int h) {
    return "{\"x\":" + x + ",\"y\":" + y + ",\"width\":" + w + ",\"height\":" + h + "}";
  }

  // Top-level windows owned by pid, or with the game's window class.
  static string Windows(uint wanted) {
    var json = new StringBuilder("{\"windows\":[");
    bool first = true;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      var cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      if (pid != wanted && cls.ToString() != WOW_WINDOW_CLASS) return true;
      RECT rc; GetClientRect(h, out rc);
      var origin = new POINT(); ClientToScreen(h, ref origin);
      int cloaked; if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) != 0) cloaked = 0;
      var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
      GetMonitorInfo(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), ref mi);
      var m = mi.rcMonitor;
      if (!first) json.Append(',');
      first = false;
      json.Append("{\"pid\":" + pid + ",\"cls\":\"" + cls.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"");
      json.Append(",\"visible\":" + (IsWindowVisible(h) ? "true" : "false"));
      json.Append(",\"iconic\":" + (IsIconic(h) ? "true" : "false"));
      json.Append(",\"cloaked\":" + (cloaked != 0 ? "true" : "false"));
      json.Append(",\"tool\":" + ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0 ? "true" : "false"));
      json.Append(",\"dpi\":" + GetDpiForWindow(h));
      json.Append(",\"client\":" + Rect(origin.X, origin.Y, rc.Right - rc.Left, rc.Bottom - rc.Top));
      json.Append(",\"monitor\":" + Rect(m.Left, m.Top, m.Right - m.Left, m.Bottom - m.Top) + "}");
      return true;
    }, IntPtr.Zero);
    return json.Append("]}").ToString();
  }

  static Bitmap Copy(int x, int y, int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
    using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
    return bmp;
  }

  static string Grab(int x, int y, int w, int h) {
    using (var bmp = Copy(x, y, w, h)) using (var ms = new MemoryStream()) {
      bmp.Save(ms, ImageFormat.Bmp);
      return Convert.ToBase64String(ms.ToArray());
    }
  }

  static string Shot(int x, int y, int w, int h, int ow, int oh) {
    using (var bmp = Copy(x, y, w, h)) using (var outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) using (var ms = new MemoryStream()) {
      using (var g = Graphics.FromImage(outBmp)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(bmp, 0, 0, ow, oh);
      }
      ImageCodecInfo jpeg = null;
      foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
      using (var ps = new EncoderParameters(1)) {
        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 85L);
        outBmp.Save(ms, jpeg, ps);
      }
      return Convert.ToBase64String(ms.ToArray());
    }
  }

  public static void Serve() {
    SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2);
    var input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.NewLine = "\n";
    output.AutoFlush = true;
    string line;
    while ((line = input.ReadLine()) != null) {
      // "<n> <request> <args...>": the reply starts with the same <n>.
      var a = line.Trim().Split(' ');
      string reply;
      try {
        Func<int, int> n = i => int.Parse(a[i]);
        if (a.Length < 2) throw new Exception("empty request");
        if (a[1] == "windows") reply = Windows(uint.Parse(a[2]));
        else if (a[1] == "grab") reply = Grab(n(2), n(3), n(4), n(5));
        else if (a[1] == "shot") reply = Shot(n(2), n(3), n(4), n(5), n(6), n(7));
        else throw new Exception("unknown request " + a[1]);
        reply = "ok " + reply;
      } catch (Exception e) {
        reply = "err " + e.Message.Replace('\r', ' ').Replace('\n', ' ');
      }
      output.WriteLine(a[0] + " " + reply);
    }
  }
}
'@

[T3Strip]::Serve()
