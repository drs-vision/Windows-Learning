using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Input;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Ipc;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace CoinQuest.Shell;

/// <summary>
/// One window, one WebView2, one bridge. Scholar and Parent Console are the same shell pointed at a
/// different page. JS talks to the Guardian by posting request JSON; we relay it over the pipe and post
/// the response (and any Guardian events) back. A few "shell.*" ops are handled locally.
/// </summary>
public class WebShellWindow : Window
{
    private readonly WebView2 _web = new();
    private readonly PipeClient _pipe = new();
    private readonly string _app;        // "scholar" | "parent"
    private readonly bool _kiosk;
    private GameWindow? _game;

    /// <summary>True when this window belongs to a managed child account (all traffic goes through the gatekeeper).</summary>
    public static bool ManagedChild { get; private set; }
    public const int GatePort = 47123;
    /// <param name="portOffset">The site/game window runs its own browser process, so it gets the next debug port.</param>
    public static CoreWebView2EnvironmentOptions? ProxyOptions(int portOffset = 0)
    {
        var args = new List<string>();
        if (ManagedChild) args.Add($"--proxy-server=http://127.0.0.1:{GatePort}");
        // CI end-to-end tests drive the real UI over the DevTools protocol. Only on machines marked as test machines.
        if (Paths.E2ETestMode && int.TryParse(Environment.GetEnvironmentVariable("COINQUEST_DEBUG_PORT"), out var port))
            args.Add($"--remote-debugging-port={port + portOffset}");
        return args.Count > 0 ? new CoreWebView2EnvironmentOptions(string.Join(' ', args)) : null;
    }
    private Process? _fpProcess;

    public WebShellWindow(string app, bool kiosk)
    {
        _app = app; _kiosk = kiosk;
        Title = app == "scholar" ? "CoinQuest" : "CoinQuest Parent Console";
        Content = _web;
        // Fit the screen: 90% of the usable area, never bigger than 1280×860 (small laptops are 1366×768).
        var area = SystemParameters.WorkArea;
        Width = Math.Min(1280, area.Width * 0.9);
        Height = Math.Min(860, area.Height * 0.9);
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        if (kiosk)
        {
            WindowStyle = WindowStyle.None;
            WindowState = WindowState.Maximized;
            ResizeMode = ResizeMode.NoResize;
        }
        Loaded += async (_, _) => await InitAsync();
        PreviewKeyDown += OnKey;
    }

    private async Task InitAsync()
    {
        var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CoinQuest", "WebView2");
        // A managed child's account has no direct internet; WebView2 must go through the Guardian's gatekeeper.
        await TryConnectAsync();
        try
        {
            var hello = await _pipe.SendAsync(Ops.Hello);
            ManagedChild = hello.Ok && hello.Payload?["childId"] is not null;
        }
        catch { ManagedChild = _kiosk; }
        var env = await CoreWebView2Environment.CreateAsync(null, userData, ProxyOptions());
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;

        // After an update, drop WebView2's cached copy of the old screens (otherwise an account can keep showing the
        // previous version until its cache happens to expire).
        var ver = typeof(WebShellWindow).Assembly.GetName().Version?.ToString(3) ?? "0";
        try
        {
            var marker = Path.Combine(userData, "coinquest-version.txt");
            if (!File.Exists(marker) || File.ReadAllText(marker).Trim() != ver)
            {
                await core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache | CoreWebView2BrowsingDataKinds.CacheStorage | CoreWebView2BrowsingDataKinds.ServiceWorkers);
                File.WriteAllText(marker, ver);
                Log($"New version {ver}: cleared the web cache");
            }
        }
        catch (Exception ex) { Log("Couldn't clear the web cache: " + ex.Message); }

        core.SetVirtualHostNameToFolderMapping("coinquest.local", Paths.InstallRoot, CoreWebView2HostResourceAccessKind.Allow);
        if (Directory.Exists(Paths.ArcadeDropFolder))
            core.SetVirtualHostNameToFolderMapping("coinquest-arcade.local", Paths.ArcadeDropFolder, CoreWebView2HostResourceAccessKind.Allow);
        var thumbs = Path.Combine(Paths.DataRoot, "thumbs");
        if (Directory.Exists(thumbs))
            core.SetVirtualHostNameToFolderMapping("coinquest-thumbs.local", thumbs, CoreWebView2HostResourceAccessKind.Allow);

        // Classic games (unpacked by the Guardian) are served by OnClassicResource below — not a folder mapping —
        // so files a game's local copy is missing can be fetched on demand.

        if (_app == "scholar")
        {
            // Classic games: files missing from the local copy are fetched on demand (like Flashpoint's game server).
            // All request sources: HTML5 games run in an iframe, and the plain overload only sees the main page's requests.
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
            core.WebResourceRequested += (s, e) => OnClassicResource(core, env, e);
        }

        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = !_kiosk || Environment.GetEnvironmentVariable("COINQUEST_DEV") == "1";
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = !_kiosk;
        core.NewWindowRequested += (_, e) => { e.Handled = true; }; // no popups out of the shell
        core.WebMessageReceived += OnWebMessage;

        _pipe.OnEvent += ev => Dispatcher.Invoke(() => core.PostWebMessageAsString(JsonSerializer.Serialize(ev, Wire.Json)));
        _pipe.Disconnected += () => { Log("Guardian disconnected"); Dispatcher.Invoke(() => core.PostWebMessageAsString("{\"name\":\"disconnected\"}")); };
        await TryConnectAsync();

        // Keyboard games need the keyboard: give the page focus as soon as it loads and whenever the window comes back.
        core.NavigationCompleted += (_, _) => Dispatcher.BeginInvoke(() => _web.Focus());
        Activated += (_, _) => _web.Focus();

        var dev = Environment.GetEnvironmentVariable("COINQUEST_WEB_DEV"); // e.g. http://localhost:5173 during development
        core.Navigate(dev is not null ? $"{dev}/?app={_app}" : $"https://coinquest.local/web/index.html?app={_app}&v={ver}");
    }

    private const string ClassicsHost = "coinquest-classics.local";
    private static string ClassicsDir => Path.Combine(Paths.DataRoot, "classics");

    /// <summary>
    /// A classic asked for a file. If it's in the local copy, serve it; if not, ask the Guardian to fetch it from the
    /// Flashpoint Archive (then the game's original site) and serve that. Covers:
    /// Every classic asks for its files at https://coinquest-classics.local/&lt;id&gt;/content/&lt;host&gt;/&lt;path&gt;
    /// (Ruffle rewrites Flash games' addresses there; HTML5 games' pages are rewritten by the Guardian).
    /// Anything else passes through untouched.
    /// </summary>
    private async void OnClassicResource(CoreWebView2 core, CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var u)) return;
            string? id = null, host = null, path = null;
            if (u.Host.Equals(ClassicsHost, StringComparison.OrdinalIgnoreCase))
            {
                var seg = u.AbsolutePath.TrimStart('/').Split('/', 4);
                if (seg.Length < 4 || seg[1] != "content") { e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", ""); return; }
                (id, host, path) = (seg[0], seg[2], seg[3]);
            }
            if (id is null || host is null || path is null || !Guid.TryParse(id, out _)) return;

            var local = LocalPath(id, host, path);
            if (local is null) return;
            if (!File.Exists(local))
            {
                var deferral = e.GetDeferral();
                try
                {
                    var resp = await _pipe.SendAsync(Ops.ArcadeClassicFile, new { fpId = id, host, path = "/" + Uri.UnescapeDataString(path) }, timeoutMs: 40000);
                    if (resp.Ok && File.Exists(local)) e.Response = FileResponse(env, local);
                    else { e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "Access-Control-Allow-Origin: *"); Log($"classic {id}: no {host}/{path}"); }
                }
                catch (Exception ex) { Log($"classic file {host}/{path}: {ex.Message}"); }
                finally { deferral.Complete(); }
                return;
            }
            e.Response = FileResponse(env, local);
        }
        catch (Exception ex) { Log("classic resource: " + ex.Message); }
    }

    private static string? LocalPath(string id, string host, string path)
    {
        if (!Guid.TryParse(id, out _)) return null;
        var root = Path.GetFullPath(Path.Combine(ClassicsDir, id, "content")) + Path.DirectorySeparatorChar;
        string full;
        try { full = Path.GetFullPath(Path.Combine(root, host.ToLowerInvariant(), Uri.UnescapeDataString(path.Split('?', '#')[0]).Replace('/', Path.DirectorySeparatorChar))); }
        catch { return null; }
        return full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    private static CoreWebView2WebResourceResponse FileResponse(CoreWebView2Environment env, string file)
    {
        var mime = Path.GetExtension(file).ToLowerInvariant() switch
        {
            ".html" or ".htm" => "text/html", ".js" => "text/javascript", ".css" => "text/css", ".json" => "application/json",
            ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".gif" => "image/gif", ".svg" => "image/svg+xml", ".webp" => "image/webp",
            ".mp3" => "audio/mpeg", ".ogg" => "audio/ogg", ".wav" => "audio/wav", ".m4a" => "audio/mp4", ".mp4" => "video/mp4",
            ".swf" => "application/x-shockwave-flash", ".xml" => "text/xml", ".wasm" => "application/wasm", ".txt" => "text/plain",
            ".woff" => "font/woff", ".woff2" => "font/woff2", ".ttf" => "font/ttf",
            _ => "application/octet-stream",
        };
        var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return env.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {mime}\r\nAccess-Control-Allow-Origin: *");
    }

    private async Task TryConnectAsync()
    {
        for (var i = 0; i < 10 && !_pipe.IsConnected; i++)
        {
            try { await _pipe.ConnectAsync(2000); Log("connected to Guardian"); }
            catch (Exception ex) { Log($"connect attempt {i + 1} failed: {ex.Message}"); await Task.Delay(1000); }
        }
    }

    /// <summary>%LocalAppData%\CoinQuest\shell.log — the first place to look when "Guardian unavailable" shows up.</summary>
    public static void Log(string message)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CoinQuest");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "shell.log"), $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch { }
    }

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try { raw = e.TryGetWebMessageAsString(); } catch { return; }
        JsonNode? node;
        try { node = JsonNode.Parse(raw); } catch { return; }
        var op = node?["op"]?.GetValue<string>() ?? "";
        var id = node?["id"]?.GetValue<string>() ?? "";

        if (op.StartsWith("shell."))
        {
            var resp = HandleShellOp(op, node?["payload"]);
            _web.CoreWebView2.PostWebMessageAsString(JsonSerializer.Serialize(resp with { Id = id }, Wire.Json));
            return;
        }

        if (!_pipe.IsConnected) await TryConnectAsync();
        string respJson;
        try { respJson = await _pipe.ForwardRawAsync(raw); }
        catch (Exception ex)
        {
            Log($"{op} failed: {ex}");
            respJson = JsonSerializer.Serialize(Response.Fail(id, "Guardian unavailable: " + ex.Message), Wire.Json);
        }
        _web.CoreWebView2.PostWebMessageAsString(respJson);
    }

    private Response HandleShellOp(string op, JsonNode? payload)
    {
        switch (op)
        {
            case "shell.openBrowser":
            {
                // Open an allowed site in the system browser. The Guardian's policy decides what's reachable.
                var url = payload?["url"]?.GetValue<string>() ?? "about:blank";
                if (!url.StartsWith("https://") && !url.StartsWith("http://")) return Response.Fail("", "bad url");
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return Response.Success("", new { ok = true });
            }
            case "shell.launch":
            {
                var exe = payload?["exe"]?.GetValue<string>() ?? "";
                try { Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true }); return Response.Success("", new { ok = true }); }
                catch (Exception ex) { return Response.Fail("", ex.Message); }
            }
            case "shell.openGame":
            {
                var url = payload?["url"]?.GetValue<string>() ?? "";
                if (!url.StartsWith("https://") && !url.StartsWith("http://")) return Response.Fail("", "bad url");
                Dispatcher.Invoke(() =>
                {
                    _game?.Close();
                    _game = new GameWindow(url, payload?["title"]?.GetValue<string>() ?? "Game", _kiosk) { Owner = this };
                    _game.Closed += (_, _) => { _game = null; _web.CoreWebView2?.PostWebMessageAsString("{\"name\":\"gameClosed\"}"); };
                    _game.Show();
                });
                return Response.Success("", new { ok = true });
            }
            case "shell.openSite":
            {
                // CoinQuest's locked browser: the only way a managed child reaches the web.
                var url = payload?["url"]?.GetValue<string>() ?? "";
                var allow = payload?["allow"]?.AsArray().Select(n => n!.GetValue<string>()).ToList() ?? new();
                if (!url.StartsWith("https://") && !url.StartsWith("http://")) url = "https://" + url;
                Dispatcher.Invoke(() =>
                {
                    _game?.Close();
                    _game = new GameWindow(url, payload?["title"]?.GetValue<string>() ?? "Website", _kiosk, allow) { Owner = this };
                    _game.OnLearnEvent += kind => _web.CoreWebView2?.PostWebMessageAsString($"{{\"name\":\"learn\",\"payload\":{{\"kind\":\"{kind}\"}}}}");
                    _game.Closed += (_, _) => { _game = null; _web.CoreWebView2?.PostWebMessageAsString("{\"name\":\"siteClosed\"}"); };
                    _game.Show();
                });
                return Response.Success("", new { ok = true });
            }
            case "shell.closeGame":
                Dispatcher.Invoke(() => _game?.Close());
                try { if (_fpProcess is { HasExited: false }) _fpProcess.Kill(true); } catch { }
                return Response.Success("", new { ok = true });
            case "shell.flashpoint":
            {
                // CLIFp = Flashpoint's command-line launcher. "play" starts one game (downloading it if needed);
                // "prepare" just downloads it (used by the Parent Console when a game is approved).
                var root = payload?["root"]?.GetValue<string>() ?? "";
                var id = payload?["id"]?.GetValue<string>() ?? "";
                var verb = payload?["verb"]?.GetValue<string>() == "prepare" ? "prepare" : "play";
                var exe = Path.Combine(root, "CLIFp.exe");
                if (!File.Exists(exe)) return Response.Fail("", "Flashpoint's game launcher (CLIFp) isn't installed yet — ask a parent.");
                if (!Guid.TryParse(id, out _)) return Response.Fail("", "bad game id");
                var psi = new ProcessStartInfo(exe) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true };
                // Syntax: CLIFp <global options> <command> <command options>. -q (quiet) is a GLOBAL option, so it goes first.
                psi.ArgumentList.Add("-q"); psi.ArgumentList.Add(verb); psi.ArgumentList.Add("-i"); psi.ArgumentList.Add(id);
                var proc = Process.Start(psi)!;
                Log($"CLIFp {verb} {id} pid {proc.Id}");
                if (verb == "play")
                {
                    _fpProcess = proc;
                    proc.EnableRaisingEvents = true;
                    proc.Exited += (_, _) => Dispatcher.Invoke(() => { _web.CoreWebView2?.PostWebMessageAsString("{\"name\":\"gameClosed\"}"); Activate(); });
                }
                return Response.Success("", new { ok = true });
            }
            case "shell.pickFile":
            {
                string? picked = null;
                Dispatcher.Invoke(() =>
                {
                    var dlg = new Microsoft.Win32.OpenFileDialog
                    {
                        Title = payload?["title"]?.GetValue<string>() ?? "Choose a file",
                        Filter = payload?["filter"]?.GetValue<string>() ?? "All files|*.*",
                        CheckFileExists = true,
                    };
                    if (dlg.ShowDialog(this) == true) picked = dlg.FileName;
                });
                return Response.Success("", new { path = picked });
            }
            case "shell.pickFolder":
            {
                string? picked = null;
                Dispatcher.Invoke(() =>
                {
                    var dlg = new Microsoft.Win32.OpenFolderDialog { Title = payload?["title"]?.GetValue<string>() ?? "Choose a folder" };
                    if (dlg.ShowDialog(this) == true) picked = dlg.FolderName;
                });
                return Response.Success("", new { path = picked });
            }
            case "shell.launchRwt":
                return LaunchRwt(payload);
            case "shell.launchProgram":
                return LaunchProgram(payload);
            case "shell.minimize":
                Dispatcher.Invoke(() => WindowState = WindowState.Minimized);
                return Response.Success("", new { ok = true });
            case "shell.restore":
                Dispatcher.Invoke(() => { WindowState = _kiosk ? WindowState.Maximized : WindowState.Normal; Activate(); });
                return Response.Success("", new { ok = true });
            case "shell.info":
                return Response.Success("", new { app = _app, kiosk = _kiosk, version = typeof(WebShellWindow).Assembly.GetName().Version?.ToString(3), account = Environment.UserName });
            case "shell.exit":
                Dispatcher.Invoke(Close);
                return Response.Success("", new { ok = true });
            default:
                return Response.Fail("", "unknown shell op");
        }
    }

    [System.Runtime.InteropServices.DllImport("kernel32", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern bool DefineDosDevice(int flags, string device, string? target);
    private Process? _rwt;
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32")]
    private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [System.Runtime.InteropServices.DllImport("user32", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder buf, int max);
    [System.Runtime.InteropServices.DllImport("user32", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder buf, int max);
    [System.Runtime.InteropServices.DllImport("user32")]
    private static extern bool RedrawWindow(IntPtr hwnd, IntPtr rect, IntPtr rgn, uint flags);

    /// <summary>
    /// Read, Write &amp; Type! is a 1995 Windows 3.1 program: it runs through otvdm, wants short DOS-style paths and a small
    /// environment. A private drive letter (this logon only) points at CoinQuest's copy, so every path is short.
    /// </summary>
    private Response LaunchRwt(JsonNode? p)
    {
        try
        {
            if (_rwt is { HasExited: false }) return Response.Success("", new { ok = true, already = true });
            var otvdm = p?["otvdm"]?.GetValue<string>() ?? ""; var root = p?["root"]?.GetValue<string>() ?? "";
            var exe = p?["exe"]?.GetValue<string>() ?? ""; var data = p?["data"]?.GetValue<string>() ?? ""; var cwd = p?["cwd"]?.GetValue<string>() ?? "";
            if (!File.Exists(otvdm) || !Directory.Exists(root)) return Response.Fail("", "Read, Write & Type! isn't set up on this computer yet");
            var used = DriveInfo.GetDrives().Select(d => char.ToUpperInvariant(d.Name[0])).ToHashSet();
            var letter = "RWTQPONMLKJ".FirstOrDefault(c => !used.Contains(c));
            if (letter == default) return Response.Fail("", "no free drive letter for the game");
            var drive = letter + ":";
            DefineDosDevice(0, drive, root);
            var psi = new ProcessStartInfo(otvdm) { UseShellExecute = false, WorkingDirectory = $@"{drive}\{cwd}" };
            psi.ArgumentList.Add($@"{drive}\{exe}");
            psi.ArgumentList.Add($@"{drive}\{data}");
            // 16-bit programs copy the whole environment into 64 KB of memory; today's is often too big for that.
            var keep = new[] { "SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "USERNAME", "COMPUTERNAME", "APPDATA", "LOCALAPPDATA", "ProgramData", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE" };
            var envCopy = keep.Select(k => (k, Environment.GetEnvironmentVariable(k))).Where(x => x.Item2 is not null).ToList();
            psi.Environment.Clear();
            foreach (var (k, v) in envCopy) psi.Environment[k] = v;
            psi.Environment["PATH"] = Environment.GetFolderPath(Environment.SpecialFolder.System) + ";" + Path.GetDirectoryName(otvdm);
            _rwt = Process.Start(psi)!;
            _rwt.EnableRaisingEvents = true;
            var game = _rwt;
            // Ask the game to repaint a few times a second, so fades and scene changes show up straight away. The game's
            // windows are found by class or title (otvdm may run the program in a helper process with another id).
            new System.Threading.Thread(() =>
            {
                var logged = false;
                while (!game.HasExited)
                {
                    try
                    {
                        var found = 0;
                        EnumWindows((h, _) =>
                        {
                            var cls = new System.Text.StringBuilder(64); GetClassName(h, cls, cls.Capacity);
                            var title = new System.Text.StringBuilder(64); GetWindowText(h, title, title.Capacity);
                            if (cls.ToString().Contains("FingersWnd") || title.ToString().StartsWith("Read, Write"))
                            {
                                RedrawWindow(h, IntPtr.Zero, IntPtr.Zero, 0x1 /* INVALIDATE */ | 0x80 /* ALLCHILDREN */);
                                if (!logged) Log($"RWT window: class '{cls}', title '{title}'");
                                found++;
                            }
                            return true;
                        }, IntPtr.Zero);
                        if (found > 0) logged = true;
                    }
                    catch { }
                    System.Threading.Thread.Sleep(300);
                }
            }) { IsBackground = true, Name = "rwt-repaint" }.Start();
            Log($"RWT started: {otvdm} {drive}\\{exe} {drive}\\{data} (pid {_rwt.Id})");
            _rwt.Exited += (_, _) =>
            {
                var code = 0; try { code = _rwt.ExitCode; } catch { }
                Log($"RWT exited ({code})");
                try { DefineDosDevice(2 /* DDD_REMOVE_DEFINITION */, drive, root); } catch { }
                Dispatcher.Invoke(() => { _web.CoreWebView2?.PostWebMessageAsString("{\"name\":\"rwtClosed\"}"); WindowState = _kiosk ? WindowState.Maximized : WindowState.Normal; Activate(); });
            };
            if (_kiosk) Dispatcher.Invoke(() => WindowState = WindowState.Minimized);
            return Response.Success("", new { ok = true, drive });
        }
        catch (Exception ex) { Log("RWT launch failed: " + ex); return Response.Fail("", "Couldn't start Read, Write & Type!: " + ex.Message); }
    }

    private Process? _program;

    /// <summary>A classic CD game (32-bit Windows program in CoinQuest's own folder) runs in its own window.</summary>
    private Response LaunchProgram(JsonNode? p)
    {
        try
        {
            if (_program is { HasExited: false }) return Response.Success("", new { ok = true, already = true });
            var exe = p?["exe"]?.GetValue<string>() ?? ""; var cwd = p?["cwd"]?.GetValue<string>() ?? ""; var id = p?["id"]?.GetValue<string>() ?? "";
            if (!File.Exists(exe) || !exe.StartsWith(Path.Combine(Paths.DataRoot, "discgames") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return Response.Fail("", "That game isn't set up on this computer yet");
            var psi = new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = cwd };
            _program = Process.Start(psi)!;
            _program.EnableRaisingEvents = true;
            var proc = _program;
            Log($"Program started: {exe} (pid {proc.Id})");
            proc.Exited += (_, _) =>
            {
                var code = 0; try { code = proc.ExitCode; } catch { }
                Log($"Program exited ({code}): {exe}");
                Dispatcher.Invoke(() =>
                {
                    _web.CoreWebView2?.PostWebMessageAsString(JsonSerializer.Serialize(new { name = "programClosed", id }));
                    WindowState = _kiosk ? WindowState.Maximized : WindowState.Normal; Activate();
                });
            };
            if (_kiosk) Dispatcher.Invoke(() => WindowState = WindowState.Minimized);
            return Response.Success("", new { ok = true });
        }
        catch (Exception ex) { Log("Program launch failed: " + ex); return Response.Fail("", "Couldn't start the game: " + ex.Message); }
    }

    private void OnKey(object sender, KeyEventArgs e)
    {
        // Ctrl+Shift+P anywhere in the child app: open the parent console view (PIN gated by the Guardian).
        if (e.Key == Key.P && Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Shift))
        {
            _web.CoreWebView2?.PostWebMessageAsString("{\"name\":\"openParent\"}");
            e.Handled = true;
        }
        if (_kiosk && e.Key == Key.F4 && Keyboard.Modifiers == ModifierKeys.Alt) e.Handled = true;
    }

    protected override async void OnClosed(EventArgs e)
    {
        await _pipe.DisposeAsync();
        base.OnClosed(e);
    }
}
