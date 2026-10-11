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

    public WebShellWindow(string app, bool kiosk)
    {
        _app = app; _kiosk = kiosk;
        Title = app == "scholar" ? "CoinQuest" : "CoinQuest Parent Console";
        Content = _web;
        Width = 1200; Height = 800;
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
        var env = await CoreWebView2Environment.CreateAsync(null, userData);
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;

        core.SetVirtualHostNameToFolderMapping("coinquest.local", Paths.InstallRoot, CoreWebView2HostResourceAccessKind.Allow);
        core.SetVirtualHostNameToFolderMapping("coinquest-arcade.local", Paths.ArcadeDropFolder, CoreWebView2HostResourceAccessKind.Allow);

        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = !_kiosk || Environment.GetEnvironmentVariable("COINQUEST_DEV") == "1";
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = !_kiosk;
        core.NewWindowRequested += (_, e) => { e.Handled = true; }; // no popups out of the shell
        core.WebMessageReceived += OnWebMessage;

        _pipe.OnEvent += ev => Dispatcher.Invoke(() => core.PostWebMessageAsString(JsonSerializer.Serialize(ev, HouseholdStore.Json)));
        _pipe.Disconnected += () => { Log("Guardian disconnected"); Dispatcher.Invoke(() => core.PostWebMessageAsString("{\"name\":\"disconnected\"}")); };
        await TryConnectAsync();

        var dev = Environment.GetEnvironmentVariable("COINQUEST_WEB_DEV"); // e.g. http://localhost:5173 during development
        core.Navigate(dev is not null ? $"{dev}/?app={_app}" : $"https://coinquest.local/web/index.html?app={_app}");
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
            _web.CoreWebView2.PostWebMessageAsString(JsonSerializer.Serialize(resp with { Id = id }, HouseholdStore.Json));
            return;
        }

        if (!_pipe.IsConnected) await TryConnectAsync();
        string respJson;
        try { respJson = await _pipe.ForwardRawAsync(raw); }
        catch (Exception ex)
        {
            Log($"{op} failed: {ex}");
            respJson = JsonSerializer.Serialize(Response.Fail(id, "Guardian unavailable: " + ex.Message), HouseholdStore.Json);
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
