using System.Diagnostics;
using CoinQuest.Guardian.Economy;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian.Enforcement;

/// <summary>
/// Closes any process in the managed child's session that isn't on the allowlist, the built-in
/// system safe list, or an active AppUnlock. Polls once a second; a process list is cheap.
/// </summary>
public sealed class ProcessEnforcer
{
    private readonly SessionMonitor _session;
    private readonly UnlockManager _unlocks;
    private readonly ILogger<ProcessEnforcer> _log;
    private readonly Dictionary<int, DateTime> _recentlyKilled = new();

    public event Action<string>? Blocked;

    /// <summary>
    /// Processes Windows needs to run a desktop session. Lower-case exe names.
    /// Deliberately NOT here: cmd.exe, powershell.exe, taskmgr.exe, regedit.exe, mmc.exe, control.exe —
    /// a parent can add them in Allowed if they want to.
    /// </summary>
    public static readonly HashSet<string> SystemSafe = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer.exe", "dwm.exe", "sihost.exe", "taskhostw.exe", "ctfmon.exe", "runtimebroker.exe",
        "startmenuexperiencehost.exe", "shellexperiencehost.exe", "searchhost.exe", "searchapp.exe", "searchui.exe",
        "textinputhost.exe", "applicationframehost.exe", "systemsettings.exe", "userinit.exe", "winlogon.exe",
        "fontdrvhost.exe", "conhost.exe", "dllhost.exe", "smartscreen.exe", "securityhealthsystray.exe",
        "lockapp.exe", "logonui.exe", "rundll32.exe", "backgroundtaskhost.exe", "wudfhost.exe",
        "msedgewebview2.exe", "widgets.exe", "phoneexperiencehost.exe", "onedrive.exe", "audiodg.exe",
        "svchost.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe", "spoolsv.exe", "msiexec.exe",
        "coinquest.scholar.exe", "coinquest.parentconsole.exe", "coinquest.updater.exe",
        "crashpadhandler.exe", "chrome_crashpad_handler.exe", "nvcontainer.exe", "igfxem.exe",
        "microsoftedgeupdate.exe", "googleupdate.exe",
        // Windows sign-in helpers a website can call up: passkeys / security keys (Windows Hello), Microsoft account.
        "credentialuibroker.exe", "credentialenrollmentmanager.exe", "wwahost.exe", "pickerhost.exe", "useroobebroker.exe"
    };

    /// <summary>Windows tools that are never let through by the "background helper in System32" rule.</summary>
    private static readonly HashSet<string> NeverAllow = new(StringComparer.OrdinalIgnoreCase)
    {
        "cmd.exe", "powershell.exe", "pwsh.exe", "powershell_ise.exe", "wscript.exe", "cscript.exe", "mshta.exe",
        "taskmgr.exe", "regedit.exe", "regedt32.exe", "mmc.exe", "control.exe", "msconfig.exe", "wsl.exe", "bash.exe",
        "net.exe", "net1.exe", "sc.exe", "taskkill.exe", "schtasks.exe", "reg.exe", "runas.exe", "shutdown.exe",
    };

    private static bool IsWindowsFolder(string path)
    {
        var win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        return path.StartsWith(Path.Combine(win, "System32") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || path.StartsWith(Path.Combine(win, "SysWOW64") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private readonly FlashpointService _fp;

    public ProcessEnforcer(SessionMonitor session, UnlockManager unlocks, FlashpointService fp, ILogger<ProcessEnforcer> log)
    { _session = session; _unlocks = unlocks; _fp = fp; _log = log; }

    /// <summary>Flashpoint folder, if a Flashpoint game play is running right now (its launcher, server and player must be allowed).</summary>
    private string? ActiveFlashpointRoot(SessionMonitor.ActiveSession s) =>
        _unlocks.ActiveFor(s.Child.Id).Any(u => u.Kind == PrizeKind.ArcadeUnlock && u.Targets.Any(t => t.StartsWith("fp-") || t == "*"))
            ? _fp.Root(s.Child.Arcade.FlashpointRoot) : null;

    /// <summary>Close everything running from a folder in a session (used when a Flashpoint play ends).</summary>
    public void KillUnder(uint sessionId, string root)
    {
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                if (p.SessionId != sessionId) continue;
                var path = p.MainModule?.FileName;
                if (path is not null && path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) { p.Kill(true); _log.LogInformation("Play over: closed {Exe}", path); }
            }
            catch { }
            finally { p.Dispose(); }
        }
    }

    public void Sweep()
    {
        if (CoinQuest.Shared.Config.Paths.E2ETestMode) return; // CI machine: the test driver runs as the "child"
        var s = _session.Current;
        if (s is null) return;

        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var a in s.Child.Allowlist.Apps) allowed.Add(Path.GetFileName(a));
        foreach (var u in _unlocks.ActiveFor(s.Child.Id)) if (u.Kind == PrizeKind.AppUnlock) foreach (var t in u.Targets) allowed.Add(Path.GetFileName(t));

        var fullPaths = new HashSet<string>(s.Child.Allowlist.Apps.Where(a => a.Contains('\\')), StringComparer.OrdinalIgnoreCase);
        var fpRoot = ActiveFlashpointRoot(s);

        foreach (var p in Process.GetProcesses())
        {
            try
            {
                if (p.SessionId != s.SessionId) continue;
                var exe = p.ProcessName + ".exe";
                var isBrowser = Allowlist.Browsers.Contains(exe, StringComparer.OrdinalIgnoreCase);
                if (!isBrowser && (SystemSafe.Contains(exe) || allowed.Contains(exe))) continue;

                string? path = null;
                try { path = p.MainModule?.FileName; } catch { /* access denied for some protected processes */ }
                if (!isBrowser && path is not null && fullPaths.Contains(path)) continue;
                if (path is not null && fpRoot is not null && path.StartsWith(fpRoot, StringComparison.OrdinalIgnoreCase)) continue;
                // otvdm: the 16-bit helper that runs Read, Write & Type! (only CoinQuest's own copy).
                if (path is not null && path.StartsWith(CoinQuest.Guardian.Rwt.RwtService.OtvdmDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
                // The family's classic CD games (CoinQuest's own copies).
                if (path is not null && path.StartsWith(CoinQuest.Guardian.DiscGames.DiscGameService.Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
                if (path is not null && CoinQuest.Guardian.DiscGames.DiscGameService.InstalledDirs().Any(d => path.StartsWith(d, StringComparison.OrdinalIgnoreCase))) continue;
                // Anything living under Windows\SystemApps is treated as safe.
                if (path is not null && (path.StartsWith(@"C:\Windows\SystemApps", StringComparison.OrdinalIgnoreCase) ||
                                         path.StartsWith(@"C:\Windows\ImmersiveControlPanel", StringComparison.OrdinalIgnoreCase))) continue;
                // Background helpers that come with Windows or the computer's drivers (audio, touchpad, graphics…) live in
                // System32 / SysWOW64 / DriverStore and have no window. Allow those — but never the tools a child could
                // use to get around CoinQuest, and nothing from there that opens a window (apps stay on the allow list).
                if (path is not null && !NeverAllow.Contains(exe) && IsWindowsFolder(path) && p.MainWindowHandle == IntPtr.Zero) continue;

                if (_recentlyKilled.TryGetValue(p.Id, out var when) && (DateTime.UtcNow - when).TotalSeconds < 10) continue;
                _log.LogInformation("Blocking {Exe} ({Path}) in session {Sid}", exe, path ?? "?", s.SessionId);
                p.Kill(entireProcessTree: true);
                _recentlyKilled[p.Id] = DateTime.UtcNow;
                Blocked?.Invoke(exe);
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // process exited or is protected — fine
            }
            finally { p.Dispose(); }
        }

        if (_recentlyKilled.Count > 200) _recentlyKilled.Clear();
    }

    /// <summary>Close browsers that still have a YouTube (or other just-expired) window open after the grace period.</summary>
    public void CloseBrowserWindowsFor(uint sessionId, IEnumerable<string> keywords)
    {
        var words = keywords.ToList();
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                if (p.SessionId != sessionId) continue;
                if (p.ProcessName is not ("msedge" or "chrome")) continue;
                var title = p.MainWindowTitle;
                if (string.IsNullOrEmpty(title)) continue;
                if (words.Any(w => title.Contains(w, StringComparison.OrdinalIgnoreCase)))
                {
                    _log.LogInformation("Closing browser window '{Title}' after unlock expired", title);
                    p.CloseMainWindow();
                }
            }
            catch { }
            finally { p.Dispose(); }
        }
    }
}
