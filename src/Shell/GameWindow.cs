using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace CoinQuest.Shell;

/// <summary>
/// A full-screen window that shows ONE web-hosted game (e.g. a Flash game on its publisher's site, run by Ruffle).
/// Top-level navigation is pinned to the game's own site, pop-ups are blocked, and the window closes when the
/// paid play time ends (Scholar sends shell.closeGame). Esc returns to CoinQuest.
/// </summary>
public sealed class GameWindow : Window
{
    private readonly WebView2 _web = new();
    private readonly Uri _start;
    private readonly HashSet<string> _sites;

    /// <summary>Sign-in pages the allowed sites need (Khan Academy uses Google/Microsoft/Apple sign-in).</summary>
    /// Includes the pages Google's sign-in passes through after the password: 2-step verification, the "is this you?"
    /// interstitials, and accounts.youtube.com (Google sets its sign-in cookie there before returning to the site).
    private static readonly string[] AuthSites =
    {
        "accounts.google.com", "accounts.youtube.com", "myaccount.google.com", "gds.google.com", "ogs.google.com",
        "login.microsoftonline.com", "login.live.com", "account.live.com", "appleid.apple.com", "idmsa.apple.com",
    };
    private CoreWebView2Environment? _env;

    /// <param name="allowed">Domains this window may navigate to. Null = only the start URL's own site (a game).</param>
    public GameWindow(string url, string title, bool kiosk, IEnumerable<string>? allowed = null)
    {
        _start = new Uri(url);
        _sites = new HashSet<string>((allowed ?? new[] { RegistrableDomain(_start.Host) }).Select(d => d.ToLowerInvariant().TrimStart('.')), StringComparer.OrdinalIgnoreCase);
        Title = title;
        // A slim bar with a big, obvious way back (Esc works too).
        var back = new System.Windows.Controls.Button
        {
            Content = "◀  Back to CoinQuest", FontSize = 18, FontWeight = FontWeights.Bold, Padding = new Thickness(18, 6, 18, 6),
            Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xFF, 0xD2, 0x3F)), BorderThickness = new Thickness(0),
        };
        back.Click += (_, _) => Close();
        var label = new System.Windows.Controls.TextBlock { Text = title, FontSize = 18, Foreground = System.Windows.Media.Brushes.White, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(16, 0, 0, 0) };
        var bar = new System.Windows.Controls.DockPanel { Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x0F, 0x1B, 0x3D)), LastChildFill = true };
        bar.Children.Add(back); bar.Children.Add(label);
        var root = new System.Windows.Controls.DockPanel();
        System.Windows.Controls.DockPanel.SetDock(bar, System.Windows.Controls.Dock.Top);
        root.Children.Add(bar); root.Children.Add(_web);
        Content = root;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        var area = SystemParameters.WorkArea;
        Width = Math.Min(1280, area.Width * 0.95); Height = Math.Min(900, area.Height * 0.95);
        if (kiosk) { WindowStyle = WindowStyle.None; WindowState = WindowState.Maximized; Topmost = true; }
        KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Escape) Close(); };
        Loaded += async (_, _) =>
        {
            var userData = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CoinQuest", "WebView2-games");
            var env = _env = await CoreWebView2Environment.CreateAsync(null, userData, WebShellWindow.ProxyOptions(portOffset: 1));
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            // Pop-ups never open a second window; an allowed one (e.g. a sign-in page) loads here instead.
            // Sign-in pop-ups ("Continue with Google") open as a real small window that stays linked to the site, so
            // the site hears back when sign-in (including 2-step verification) finishes and the pop-up closes itself.
            core.NewWindowRequested += async (_, e) =>
            {
                e.Handled = true;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var nu) || !Allowed(nu)) { WebShellWindow.Log($"pop-up blocked: {e.Uri}"); return; }
                var deferral = e.GetDeferral();
                try
                {
                    var popup = new PopupWindow(Allowed, kiosk) { Owner = this };
                    popup.Show();
                    e.NewWindow = await popup.InitAsync(_env!);
                }
                catch (Exception ex) { WebShellWindow.Log("pop-up failed: " + ex.Message); core.Navigate(e.Uri); }
                finally { deferral.Complete(); }
            };
            // A page calling window.close() must not take CoinQuest's window with it.
            core.WindowCloseRequested += (_, _) => WebShellWindow.Log("site asked to close the window; ignored");
            if (_sites.Any(d => d.EndsWith("khanacademy.org") || d.EndsWith("duolingo.com"))) LearningObserver.Attach(core, OnLearn);
            core.NavigationStarting += (_, e) =>
            {
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var u)) { e.Cancel = true; return; }
                if (u.Scheme is "about" or "data" or "blob") return;
                if (!Allowed(u)) { e.Cancel = true; WebShellWindow.Log($"locked window blocked navigation to {u.Host}"); }
            };
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.Navigate(_start.ToString());
        };
    }

    /// <summary>Raised for learning progress seen in this window ("khan:correct", "khan:video", "khan:done", "duolingo:lesson", "duolingo:story").</summary>
    public event Action<string>? OnLearnEvent;
    private void OnLearn(string kind) => Dispatcher.Invoke(() => OnLearnEvent?.Invoke(kind));

    internal bool Allowed(Uri u)
    {
        var host = u.Host.ToLowerInvariant();
        return _sites.Any(d => host == d || host.EndsWith("." + d)) || AuthSites.Contains(host);
    }

    /// <summary>"cache.armorgames.com" → "armorgames.com". Good enough for the sites parents will paste.</summary>
    private static string RegistrableDomain(string host)
    {
        var parts = host.ToLowerInvariant().Split('.');
        if (parts.Length <= 2) return host.ToLowerInvariant();
        var twoLevelTlds = new[] { "co.uk", "com.au", "co.nz", "co.jp" };
        var last2 = string.Join('.', parts[^2..]);
        return twoLevelTlds.Contains(last2) && parts.Length >= 3 ? string.Join('.', parts[^3..]) : last2;
    }
}

/// <summary>A sign-in pop-up opened by an allowed site. Same rules as its parent window; closes when the page says so.</summary>
public sealed class PopupWindow : Window
{
    private readonly WebView2 _web = new();
    private readonly Func<Uri, bool> _allowed;

    public PopupWindow(Func<Uri, bool> allowed, bool kiosk)
    {
        _allowed = allowed;
        Title = "Sign in";
        Width = 520; Height = 680;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        if (kiosk) Topmost = true;
        Content = _web;
    }

    public async Task<CoreWebView2> InitAsync(CoreWebView2Environment env)
    {
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.NavigationStarting += (_, e) =>
        {
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var u)) { e.Cancel = true; return; }
            if (u.Scheme is "about" or "data" or "blob") return;
            if (!_allowed(u)) { e.Cancel = true; WebShellWindow.Log($"sign-in window blocked navigation to {u.Host}"); }
        };
        core.NewWindowRequested += (_, e) => { e.Handled = true; if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) && _allowed(u)) core.Navigate(e.Uri); };
        core.WindowCloseRequested += (_, _) => Dispatcher.BeginInvoke(Close);
        core.DownloadStarting += (_, e) => e.Cancel = true;
        return core;
    }
}
