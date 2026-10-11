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
        "msedge_proxy.exe", "microsoftedgeupdate.exe", "googleupdate.exe"
    };

    public ProcessEnforcer(SessionMonitor session, UnlockManager unlocks, ILogger<ProcessEnforcer> log)
    { _session = session; _unlocks = unlocks; _log = log; }

    public void Sweep()
    {
        var s = _session.Current;
        if (s is null) return;

        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var a in s.Child.Allowlist.Apps) allowed.Add(Path.GetFileName(a));
        foreach (var u in _unlocks.ActiveFor(s.Child.Id)) if (u.Kind == PrizeKind.AppUnlock) foreach (var t in u.Targets) allowed.Add(Path.GetFileName(t));

        var fullPaths = new HashSet<string>(s.Child.Allowlist.Apps.Where(a => a.Contains('\\')), StringComparer.OrdinalIgnoreCase);

        foreach (var p in Process.GetProcesses())
        {
            try
            {
                if (p.SessionId != s.SessionId) continue;
                var exe = p.ProcessName + ".exe";
                if (SystemSafe.Contains(exe) || allowed.Contains(exe)) continue;

                string? path = null;
                try { path = p.MainModule?.FileName; } catch { /* access denied for some protected processes */ }
                if (path is not null && fullPaths.Contains(path)) continue;
                // Anything living under Windows\SystemApps or Windows\System32 that we didn't list is treated as safe.
                if (path is not null && (path.StartsWith(@"C:\Windows\SystemApps", StringComparison.OrdinalIgnoreCase) ||
                                         path.StartsWith(@"C:\Windows\ImmersiveControlPanel", StringComparison.OrdinalIgnoreCase))) continue;

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
