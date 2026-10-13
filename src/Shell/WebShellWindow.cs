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

        core.SetVirtualHostNameToFolderMapping("coinquest.local", Paths.InstallRoot, CoreWebView2HostResourceAccessKind.Allow);
        if (Directory.Exists(Paths.ArcadeDropFolder))
            core.SetVirtualHostNameToFolderMapping("coinquest-arcade.local", Paths.ArcadeDropFolder, CoreWebView2HostResourceAccessKind.Allow);
        var thumbs = Path.Combine(Paths.DataRoot, "thumbs");
        if (Directory.Exists(thumbs))
            core.SetVirtualHostNameToFolderMapping("coinquest-thumbs.local", thumbs, CoreWebView2HostResourceAccessKind.Allow);

        // Classic Flash games, unpacked by the Guardian and played in CoinQuest's own Ruffle player.
        var classics = Path.Combine(Paths.DataRoot, "classics");
        try { Directory.CreateDirectory(classics); } catch { /* the child can't create it; the Guardian does */ }
        if (Directory.Exists(classics))
            core.SetVirtualHostNameToFolderMapping("coinquest-classics.local", classics, CoreWebView2HostResourceAccessKind.Allow);

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
        core.Navigate(dev is not null ? $"{dev}/?app={_app}" : $"https://coinquest.local/web/index.html?app={_app}");
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
                if (seg.Length < 4 || seg[1] != "content") return;
                if (File.Exists(LocalPath(seg[0], seg[2], seg[3]) ?? "")) return; // the folder mapping serves it
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
