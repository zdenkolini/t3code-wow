// The outbound channel (game -> bridge): screen-capture the top-left corner of the
// game window and decode the addon's pixel strip.
//
// Hyprland (and other wlroots compositors) allow screencopy, so `grim` can read the
// game's pixels on Wayland. X11 sessions use ImageMagick's `import`. macOS uses its
// own `screencapture`, which needs the Screen Recording permission. Windows uses GDI
// through a long-lived PowerShell helper.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decodeImage, parsePPM, parseBMP, CELLS_PER_ROW, MAX_ROWS } from './codec.js';

// A service may start before the session exports WAYLAND_DISPLAY; find the socket.
function captureEnv() {
  if (process.env.WAYLAND_DISPLAY) return process.env;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  try {
    const sock = fs.readdirSync(runtime).find((f) => /^wayland-\d+$/.test(f));
    if (sock) return { ...process.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: sock };
  } catch {}
  return process.env;
}

function run(cmd, args, { maxBuffer = 32 * 1024 * 1024, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer, timeout, env: captureEnv() }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr?.toString();
        reject(err);
      } else resolve(stdout);
    });
  });
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hyprland IPC (no hyprctl spawn needed)

function hyprSocket() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const base = path.join(runtime, 'hypr');
  const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (sig && fs.existsSync(path.join(base, sig, '.socket.sock'))) return path.join(base, sig, '.socket.sock');
  // Running as a systemd service the variable may be missing: use the newest instance.
  try {
    const dirs = fs
      .readdirSync(base)
      .map((d) => path.join(base, d, '.socket.sock'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs[0] || null;
  } catch {
    return null;
  }
}

function hyprRequest(sock, cmd) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    const chunks = [];
    c.on('connect', () => c.write(cmd));
    c.on('data', (d) => chunks.push(d));
    c.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    c.on('error', reject);
    c.setTimeout(2000, () => {
      c.destroy();
      reject(new Error('hyprland ipc timeout'));
    });
  });
}

async function hyprWindow(pid) {
  const sock = hyprSocket();
  if (!sock) return null;
  const [clients, monitors] = await Promise.all([
    hyprRequest(sock, 'j/clients').then(JSON.parse),
    hyprRequest(sock, 'j/monitors').then(JSON.parse),
  ]);
  const win =
    clients.find((c) => pid && c.pid === pid) ||
    clients.find((c) => c.title === 'World of Warcraft') ||
    clients.find((c) => /^World of Warcraft/.test(c.title || ''));
  if (!win) return { found: false };
  const mon = monitors.find((m) => m.id === win.monitor) || monitors[0];
  const visible =
    !win.hidden &&
    mon &&
    (mon.activeWorkspace?.id === win.workspace?.id || mon.specialWorkspace?.id === win.workspace?.id);
  return {
    found: true,
    visible,
    x: win.at[0],
    y: win.at[1],
    width: win.size[0],
    height: win.size[1],
    scale: mon?.scale || 1,
    focused: undefined,
  };
}

// ---------------------------------------------------------------------------
// macOS: CoreGraphics' window list through JXA (osascript ships with the system, so
// there's nothing to compile), then `screencapture` for the pixels.

// Prints { windows, screens } for windows owned by the pid, or by an app called Wow
// (the client's process name) or World of Warcraft. Window bounds are in points with
// the origin at the top-left of the main display; screens come from NSScreen, whose
// origin is bottom-left.
const MAC_WINDOWS_JXA = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
function run(argv) {
  const pid = Number(argv[0]) || 0;
  const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16, 0));
  const windows = [];
  for (let i = 0; i < arr.count; i++) {
    const w = arr.objectAtIndex(i);
    const v = (k) => { const x = w.objectForKey(k); return x.isNil() ? null : x.js; };
    const owner = v('kCGWindowOwnerName');
    const wpid = v('kCGWindowOwnerPID');
    if (wpid !== pid && owner !== 'Wow' && owner !== 'World of Warcraft') continue;
    windows.push({ pid: wpid, layer: v('kCGWindowLayer'), onscreen: !!v('kCGWindowIsOnscreen'), bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) });
  }
  const screens = $.NSScreen.screens.js.map((s) => ({ x: s.frame.origin.x, y: s.frame.origin.y, width: s.frame.size.width, height: s.frame.size.height, scale: s.backingScaleFactor }));
  return JSON.stringify({ windows, screens });
}`;

// The game window from MAC_WINDOWS_JXA's output: its bounds and the scale of the screen
// it's on.
export function pickMacWindow(info, pid) {
  const normal = info.windows.filter((w) => w.layer === 0 && w.bounds.Width > 100 && w.bounds.Height > 100);
  const mine = normal.filter((w) => w.pid === pid);
  const pool = mine.length ? mine : normal;
  const area = (w) => w.bounds.Width * w.bounds.Height;
  const win = pool.sort((a, b) => Number(b.onscreen) - Number(a.onscreen) || area(b) - area(a))[0];
  if (!win) return { found: false };
  const b = win.bounds;
  const primary = info.screens[0];
  // NSScreen frames are bottom-left based; flip them into window-list coordinates.
  const screens = info.screens.map((s) => ({ ...s, y: primary.height - (s.y + s.height) }));
  const cx = b.X + b.Width / 2;
  const cy = b.Y + b.Height / 2;
  const screen = screens.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height) || screens[0];
  return { found: true, visible: win.onscreen, x: b.X, y: b.Y, width: b.Width, height: b.Height, scale: screen?.scale || 1 };
}

// ---------------------------------------------------------------------------
// Windows: a long-lived PowerShell process hosting inline C# (GDI), see WinHelper below.

// The class of Forever's game window, which finds it when the pid isn't known.
const WOW_WINDOW_CLASS = 'waApplication Window';

// The game window from the helper's window list. Client areas are in physical pixels
// (the helper is per-monitor DPI aware), so the strip needs no scaling.
export function pickWindowsWindow(info, pid) {
  // A minimized window has no client area, so only drop small windows that aren't minimized.
  const big = (w) => w.iconic || (w.client.width > 100 && w.client.height > 100);
  const game = info.windows.filter((w) => !w.tool && big(w) && (w.pid === pid || w.cls === WOW_WINDOW_CLASS));
  const mine = game.filter((w) => w.pid === pid);
  const pool = mine.length ? mine : game;
  const shown = (w) => w.visible && !w.iconic && !w.cloaked;
  const area = (w) => w.client.width * w.client.height;
  const win = pool.sort((a, b) => Number(shown(b)) - Number(shown(a)) || area(b) - area(a))[0];
  if (!win) return { found: false };
  const c = win.client;
  const m = win.monitor;
  const fullscreen = !!m && c.x === m.x && c.y === m.y && c.width === m.width && c.height === m.height;
  return { found: true, visible: shown(win), x: c.x, y: c.y, width: c.width, height: c.height, scale: (win.dpi || 96) / 96, fullscreen };
}

// Compiled by PowerShell's Add-Type when the helper starts (the C# compiler ships with
// Windows' .NET Framework), so there's nothing to build or install. It answers one
// request per stdin line with one stdout line, "ok <data>" or "err <message>":
//   windows <pid>           JSON window list for pickWindowsWindow
//   grab <x> <y> <w> <h>    base64 BMP of that screen rectangle (physical pixels)
//   shot <x> <y> <w> <h> <outW> <outH>   base64 JPEG, scaled to outW x outH
// The thread is per-monitor DPI aware, so every coordinate is in physical pixels, across
// all monitors and scale factors.
const WIN_HELPER_CS = String.raw`
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
      if (pid != wanted && cls.ToString() != "${WOW_WINDOW_CLASS}") return true;
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
      string reply;
      try {
        var a = line.Trim().Split(' ');
        Func<int, int> n = i => int.Parse(a[i]);
        if (a[0] == "windows") reply = Windows(uint.Parse(a[1]));
        else if (a[0] == "grab") reply = Grab(n(1), n(2), n(3), n(4));
        else if (a[0] == "shot") reply = Shot(n(1), n(2), n(3), n(4), n(5), n(6));
        else throw new Exception("unknown request " + a[0]);
        reply = "ok " + reply;
      } catch (Exception e) {
        reply = "err " + e.Message.Replace('\r', ' ').Replace('\n', ' ');
      }
      output.WriteLine(reply);
    }
  }
}`;

const WIN_HELPER_PS = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${WIN_HELPER_CS}
'@
[T3Strip]::Serve()`;

// The helper process, started on first use and kept for the bridge's lifetime: starting
// PowerShell and compiling the C# takes about half a second, far too slow per frame. Its
// window is hidden, and it exits when its stdin closes (that is, with the bridge).
class WinHelper {
  constructor() {
    this.proc = null;
    this.pending = []; // { resolve, reject } in request order
    this.out = '';
    this.err = '';
    this.warm = false; // answered once: PowerShell has started and compiled the helper
    this.failures = 0; // in a row, for the restart backoff
    this.retryAt = 0;
    this.lastError = null;
  }

  start() {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(WIN_HELPER_PS, 'utf16le').toString('base64');
    const proc = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.warm = false;
    this.out = '';
    this.err = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      this.out += d;
      let i;
      while ((i = this.out.indexOf('\n')) >= 0) {
        const line = this.out.slice(0, i).replace(/\r$/, '');
        this.out = this.out.slice(i + 1);
        const p = this.pending.shift();
        if (!p) continue;
        if (line.startsWith('ok ')) p.resolve(line.slice(3));
        else p.reject(new Error(line.replace(/^err /, '')));
      }
      this.idle();
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => (this.err = (this.err + d).slice(-2000)));
    const fail = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      // PowerShell may still wrap stderr in CLIXML; the error itself is at the end.
      const detail = this.err.replace(/#< CLIXML/g, '').replace(/<[^>]*>/g, ' ').replace(/_x000[DA]_/g, ' ').replace(/\s+/g, ' ').trim().slice(-300);
      this.lastError = `capture helper ${why}${detail ? `: ${detail}` : ''}`;
      // A helper that keeps failing (PowerShell blocked, Add-Type refused) isn't restarted on every poll.
      this.failures++;
      this.retryAt = Date.now() + Math.min(60000, 5000 * 2 ** (this.failures - 1));
      for (const p of this.pending.splice(0)) p.reject(new Error(this.lastError));
    };
    proc.on('error', (e) => fail(`failed to start (${e.message})`));
    proc.on('exit', (code) => fail(`exited (${code})`));
    proc.stdin.on('error', () => {});
  }

  // While nothing is pending, don't let the helper keep a short command (probe) alive.
  idle() {
    if (!this.proc) return;
    const streams = [this.proc, this.proc.stdin, this.proc.stdout, this.proc.stderr];
    for (const s of streams) this.pending.length ? s.ref?.() : s.unref?.();
  }

  request(line, timeout = 4000) {
    if (!this.proc) {
      const wait = this.retryAt - Date.now();
      if (wait > 0) return Promise.reject(new Error(`${this.lastError} (retrying in ${Math.ceil(wait / 1000)} s)`));
      this.start();
    }
    const proc = this.proc;
    // The first request also waits for PowerShell to start and compile the helper.
    if (!this.warm) timeout += 20000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('capture helper timed out'));
      }, timeout);
      this.pending.push({
        resolve: (v) => {
          clearTimeout(timer);
          this.warm = true;
          this.failures = 0;
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.idle();
      proc.stdin.write(`${line}\n`);
    });
  }

  async windows(pid) {
    return JSON.parse(await this.request(`windows ${Number(pid) || 0}`));
  }

  async grab(x, y, w, h) {
    return Buffer.from(await this.request(`grab ${x} ${y} ${w} ${h}`), 'base64');
  }

  async shot(x, y, w, h, ow, oh) {
    return Buffer.from(await this.request(`shot ${x} ${y} ${w} ${h} ${ow} ${oh}`, 8000), 'base64');
  }
}

// A capture that's black from edge to edge. Exclusive fullscreen hands GDI a black screen;
// the game itself only goes black for a moment, or in a cinematic's letterbox bars.
function isBlack(image) {
  return !image.data.some((v) => v > 8);
}

export const EXCLUSIVE_FULLSCREEN_HELP =
  "The game's screen reads as black, which happens in exclusive fullscreen. In game, open Options > Graphics and set Display Mode to Windowed (Fullscreen), or Windowed.";

// Built at import time, so getuid is optional: Windows doesn't have it, and only macOS shows this.
export const SCREEN_PERMISSION_HELP =
  `macOS hasn't let the bridge record the screen. Open System Settings > Privacy & Security > Screen & System Audio Recording, turn on ${path.basename(process.execPath)} (${process.execPath}), then restart the bridge with: launchctl kickstart -k gui/${process.getuid?.()}/t3code-wow`;

// ---------------------------------------------------------------------------

export class StripCapture {
  constructor({ log = () => {}, backend = 'auto', region = null, platform = process.platform } = {}) {
    this.log = log;
    this.platform = platform;
    this.backend = backend;
    this.manualRegion = region; // { x, y, width, height } in compositor (logical) coordinates; physical pixels on Windows
    this.hint = null;
    this.lastError = null;
    this.lastSeenAt = 0;
    this.stats = { captures: 0, decoded: 0, rejected: 0, notVisible: 0 };
    this.lastImage = null;
    this.macCache = null; // { pid, at, win }: the window list costs an osascript run
    this.macAsked = false;
    this.win = null; // WinHelper, started on first use
    this.blackSince = 0; // when a fullscreen game window started reading as black
    this.tmpDir = null;
  }

  resolveBackend() {
    if (this.backend !== 'auto') return this.backend;
    if (this.platform === 'darwin') return 'macos';
    if (this.platform === 'win32') return 'windows';
    if (process.env.WAYLAND_DISPLAY || hyprSocket()) {
      if (hyprSocket() && which('grim')) return 'hyprland';
      if (which('grim')) return 'grim';
    }
    if (process.env.DISPLAY && which('import')) return 'x11';
    if (which('grim')) return 'grim';
    return 'none';
  }

  // Size of the region to grab, in physical pixels: the largest strip plus slack for
  // window borders and offset search.
  static stripPixels(cell = 4) {
    return { width: CELLS_PER_ROW * cell + 32, height: MAX_ROWS * cell + 32 };
  }

  async macWindow(pid) {
    const c = this.macCache;
    if (c && c.pid === pid && Date.now() - c.at < 2000) return c.win;
    const out = await run('osascript', ['-l', 'JavaScript', '-e', MAC_WINDOWS_JXA, String(pid)]);
    const win = pickMacWindow(JSON.parse(out.toString('utf8')), pid);
    this.macCache = { pid, at: Date.now(), win };
    return win;
  }

  // Ask macOS once for Screen Recording permission. The system shows its prompt (or
  // lists the bridge, switched off, in Settings) for the process that asked.
  requestScreenAccess() {
    if (this.macAsked) return;
    this.macAsked = true;
    const js = "ObjC.import('CoreGraphics'); ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]); $.CGRequestScreenCaptureAccess()";
    run('osascript', ['-l', 'JavaScript', '-e', js], { timeout: 60000 }).catch(() => {});
  }

  // On macOS, ask for Screen Recording up front (at bridge start) so the prompt shows
  // before the game does. macOS only prompts when the permission is missing. Elsewhere
  // there's nothing to ask.
  prepare() {
    if (this.resolveBackend() === 'macos') this.requestScreenAccess();
  }

  winHelper() {
    if (!this.win) this.win = new WinHelper();
    return this.win;
  }

  // The game window on Windows, with its client area in physical pixels.
  async winWindow(pid) {
    return pickWindowsWindow(await this.winHelper().windows(pid), pid);
  }

  // A fullscreen window whose corner reads black: exclusive fullscreen if its centre is
  // black too, for longer than a fade or a loading screen lasts.
  async looksExclusive(win) {
    const size = 64;
    const centre = parseBMP(await this.winHelper().grab(win.x + ((win.width - size) >> 1), win.y + ((win.height - size) >> 1), size, size));
    if (!isBlack(centre)) {
      this.blackSince = 0;
      return false;
    }
    this.blackSince ||= Date.now();
    return Date.now() - this.blackSince > 5000;
  }

  tmpFile(name) {
    if (!this.tmpDir || !fs.existsSync(this.tmpDir)) this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't3code-wow-'));
    return path.join(this.tmpDir, name);
  }

  // `screencapture` writes a file; read it back and remove it. Rect is in points.
  async macCapture(rect, type) {
    const file = this.tmpFile(`capture.${type}`);
    try {
      await run('screencapture', ['-x', '-R', rect.map(Math.round).join(','), '-t', type, file], { timeout: 8000 });
      return fs.readFileSync(file);
    } catch (err) {
      if (/could not create image/i.test(`${err.stderr || ''}${err.message}`)) {
        this.requestScreenAccess();
        throw new Error(SCREEN_PERMISSION_HELP);
      }
      throw err;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async grab(wowPid) {
    const backend = this.resolveBackend();
    this.stats.captures++;
    if (backend === 'none') throw new Error('no capture backend: install grim (Wayland/wlroots) or ImageMagick (X11)');
    const px = StripCapture.stripPixels(4);
    if (backend === 'macos') {
      let region = this.manualRegion;
      let scale = 1;
      let searchY = 0;
      if (!region) {
        const win = await this.macWindow(wowPid);
        if (!win.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        scale = win.scale;
        region = { x: win.x, y: win.y };
        // The strip can start below the window's top: under the title bar of a windowed
        // game, or in fullscreen on a MacBook display, where the game moves its UI below
        // the notch. Search 40 points down rather than guessing either height.
        searchY = 40;
      }
      const w = Math.ceil(px.width / scale);
      const h = Math.ceil(px.height / scale) + searchY;
      const buf = await this.macCapture([region.x, region.y, w, h], 'bmp');
      const image = parseBMP(buf);
      // screencapture works in physical pixels: scale the slack to match the image.
      return { status: 'ok', image, searchY: Math.ceil(searchY * (image.width / w)) };
    }
    if (backend === 'windows') {
      let region = this.manualRegion;
      let win = null;
      if (!region) {
        win = await this.winWindow(wowPid);
        if (!win.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        // The client area starts below the title bar, so the strip is at its corner.
        region = { x: win.x, y: win.y };
      }
      const image = parseBMP(await this.winHelper().grab(region.x, region.y, px.width, px.height));
      if (!win?.fullscreen || !isBlack(image)) this.blackSince = 0;
      else if (await this.looksExclusive(win)) throw new Error(EXCLUSIVE_FULLSCREEN_HELP);
      return { status: 'ok', image };
    }
    if (backend === 'hyprland' || backend === 'grim') {
      let region = this.manualRegion;
      let scale = 1;
      if (!region && backend === 'hyprland') {
        const win = await hyprWindow(wowPid);
        if (!win?.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        scale = win.scale;
        region = { x: win.x, y: win.y };
      }
      region = region || { x: 0, y: 0 };
      const w = Math.ceil(px.width / scale);
      const h = Math.ceil(px.height / scale);
      const buf = await run('grim', ['-g', `${region.x},${region.y} ${w}x${h}`, '-t', 'ppm', '-']);
      return { status: 'ok', image: parsePPM(buf) };
    }
    if (backend === 'x11') {
      const r = this.manualRegion || { x: 0, y: 0 };
      const buf = await run('import', [
        '-silent', '-window', 'root',
        '-crop', `${px.width}x${px.height}+${r.x}+${r.y}`,
        '-depth', '8', 'ppm:-',
      ]);
      return { status: 'ok', image: parsePPM(buf) };
    }
    throw new Error(`unknown capture backend ${backend}`);
  }

  // A screenshot of the game window for attaching to a message: JPEG at the
  // compositor's logical resolution (keeps it well under T3's 10 MB image limit).
  async screenshot(wowPid) {
    const backend = this.resolveBackend();
    const name = `wow-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`;
    if (backend === 'macos') {
      const win = await this.macWindow(wowPid);
      // screencapture copies a rectangle of the screen, so a hidden game would attach
      // whatever is showing there instead.
      if (!win.visible) throw new Error("the game window isn't on screen");
      let data = await this.macCapture([win.x, win.y, win.width, win.height], 'jpg');
      // Retina captures come back at twice the size; keep them at the logical size.
      if (win.scale > 1) {
        const file = this.tmpFile(name);
        fs.writeFileSync(file, data);
        try {
          await run('sips', ['-Z', String(Math.round(Math.max(win.width, win.height))), file], { timeout: 8000 });
          data = fs.readFileSync(file);
        } catch {}
        fs.rmSync(file, { force: true });
      }
      return { data, name, mime: 'image/jpeg' };
    }
    if (backend === 'windows') {
      const win = await this.winWindow(wowPid);
      if (!win.found) throw new Error("the game window isn't open");
      if (!win.visible) throw new Error("the game window isn't on screen");
      // Keep high-DPI captures at the logical size, as on macOS.
      const ow = Math.round(win.width / win.scale);
      const oh = Math.round(win.height / win.scale);
      const data = await this.winHelper().shot(win.x, win.y, win.width, win.height, ow, oh);
      return { data, name, mime: 'image/jpeg' };
    }
    if (backend === 'hyprland' || backend === 'grim') {
      const args = ['-t', 'jpeg', '-q', '85', '-s', '1'];
      if (backend === 'hyprland') {
        const win = await hyprWindow(wowPid);
        if (win?.found) args.push('-g', `${win.x},${win.y} ${win.width}x${win.height}`);
      }
      const data = await run('grim', [...args, '-'], { timeout: 8000 });
      return { data, name, mime: 'image/jpeg' };
    }
    if (backend === 'x11') {
      const data = await run('import', ['-silent', '-window', 'root', '-quality', '85', 'jpeg:-'], { timeout: 8000 });
      return { data, name, mime: 'image/jpeg' };
    }
    throw new Error('no screenshot backend (install grim)');
  }

  // One capture + decode. Returns { status, frame? }.
  async poll(wowPid) {
    let res;
    try {
      res = await this.grab(wowPid);
    } catch (err) {
      this.lastError = err.message;
      return { status: 'error', error: err.message };
    }
    if (res.status !== 'ok') return res;
    this.lastImage = res.image;
    const out = decodeImage(res.image, this.hint, { searchY: res.searchY });
    if (!out) return { status: 'empty' };
    this.hint = out.geo;
    if (out.error) {
      this.stats.rejected++;
      return { status: 'rejected', error: out.error };
    }
    this.stats.decoded++;
    this.lastSeenAt = Date.now();
    return { status: 'frame', frame: out };
  }
}
