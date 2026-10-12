using CoinQuest.Guardian.Economy;
using CoinQuest.Shared.Models;
using Microsoft.Win32;

namespace CoinQuest.Guardian.Enforcement;

/// <summary>
/// Writes Edge and Chrome *per-user* policies into the child's HKEY_USERS\{SID} hive.
/// The browser enforces the allowlist itself; the child can't change policies; the parent's own
/// browser profile is untouched because we never write to HKLM or to any other user's hive.
/// </summary>
public sealed class BrowserPolicy
{
    private readonly UnlockManager _unlocks;
    private readonly ILogger<BrowserPolicy> _log;
    private string? _lastWritten;

    /// <summary>What the Parent Console shows under "Browser lock".</summary>
    public sealed record PolicyStatus(DateTimeOffset? AppliedAt, int Entries, string? Error, string? Sid);
    public PolicyStatus Status { get; private set; } = new(null, 0, null, null);

    private static readonly string[] Browsers = { @"Software\Policies\Microsoft\Edge", @"Software\Policies\Google\Chrome" };

    /// <summary>Always allowed: internal pages the browser needs, and the services Khan/YouTube embed depends on.</summary>
    private static readonly string[] AlwaysAllow =
    {
        "edge://newtab", "chrome://newtab", "chrome://new-tab-page", "edge://new-tab-page",
        "file:///*coinquest*", "http://coinquest.local", "https://coinquest.local",
    };

    public BrowserPolicy(UnlockManager unlocks, ILogger<BrowserPolicy> log) { _unlocks = unlocks; _log = log; }

    /// <summary>Recompute and write the allowlist for this child. Idempotent and cheap to call often.</summary>
    public void Apply(Child child)
    {
        if (string.IsNullOrEmpty(child.WindowsSid)) return;

        var allow = new List<string>(AlwaysAllow);
        allow.AddRange(child.Allowlist.Sites.Select(Normalize));
        foreach (var u in _unlocks.ActiveFor(child.Id))
            if (u.Kind == PrizeKind.SiteUnlock) allow.AddRange(u.Targets.Select(Normalize));
        allow = allow.Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        var signature = child.WindowsSid + "|" + string.Join(",", allow);
        if (signature == _lastWritten) return;

        using var hku = RegistryKey.OpenBaseKey(RegistryHive.Users, RegistryView.Default);
        using var userRoot = hku.OpenSubKey(child.WindowsSid, writable: true);
        if (userRoot is null)
        {
            // Hive isn't loaded (child not logged in yet). We'll be called again on the next poll.
            Status = Status with { Error = "Waiting for the child to log in", Sid = child.WindowsSid };
            return;
        }
        string? error = null;

        foreach (var basePath in Browsers)
        {
            try
            {
                using var policy = userRoot.CreateSubKey(basePath, writable: true)!;
                WriteList(policy, "URLBlocklist", new[] { "*" });
                WriteList(policy, "URLAllowlist", allow);
                WriteList(policy, "ExtensionInstallBlocklist", new[] { "*" });

                policy.SetValue("DeveloperToolsAvailability", 2, RegistryValueKind.DWord);
                policy.SetValue("IncognitoModeAvailability", 1, RegistryValueKind.DWord);
                policy.SetValue("BrowserGuestModeEnabled", 0, RegistryValueKind.DWord);
                policy.SetValue("BrowserAddProfileEnabled", 0, RegistryValueKind.DWord);
                policy.SetValue("ForceGoogleSafeSearch", 1, RegistryValueKind.DWord);
                policy.SetValue("ForceYouTubeRestrict", 1, RegistryValueKind.DWord); // moderate
                policy.SetValue("DownloadRestrictions", 3, RegistryValueKind.DWord);  // block all downloads
                policy.SetValue("PasswordManagerEnabled", 0, RegistryValueKind.DWord);
                policy.SetValue("SyncDisabled", 1, RegistryValueKind.DWord);
                policy.SetValue("AllowFileSelectionDialogs", 0, RegistryValueKind.DWord);
                policy.SetValue("TaskManagerEndProcessEnabled", 0, RegistryValueKind.DWord);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not write policy under {Path}", basePath);
                error = $"{basePath}: {ex.Message}";
            }
        }

        // Point every proxy-aware program on this account at the gatekeeper. (Programs that ignore it just get no
        // internet — the WFP rule blocks direct connections — so changing this setting can't open anything up.)
        try
        {
            using var inet = userRoot.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings", writable: true)!;
            inet.SetValue("ProxyEnable", 1, RegistryValueKind.DWord);
            inet.SetValue("ProxyServer", $"127.0.0.1:{NetGate.Port}", RegistryValueKind.String);
            inet.SetValue("ProxyOverride", "<local>", RegistryValueKind.String);
            using var conns = inet.OpenSubKey("Connections", writable: true);
            conns?.DeleteValue("DefaultConnectionSettings", throwOnMissingValue: false);
            conns?.DeleteValue("SavedLegacySettings", throwOnMissingValue: false);
        }
        catch (Exception ex) { error ??= "proxy: " + ex.Message; }

        _lastWritten = error is null ? signature : null;
        Status = new PolicyStatus(DateTimeOffset.UtcNow, allow.Count, error, child.WindowsSid);
        _log.LogInformation("Browser allowlist for {Child}: {N} entries", child.DisplayName, allow.Count);
    }

    /// <summary>Remove our policies from a user hive (when a child is un-managed, or on uninstall).</summary>
    public void Clear(string sid) { ClearStatic(sid); _lastWritten = null; }

    public static void ClearStatic(string sid)
    {
        using var hku = RegistryKey.OpenBaseKey(RegistryHive.Users, RegistryView.Default);
        using var userRoot = hku.OpenSubKey(sid, writable: true);
        if (userRoot is null) return;
        foreach (var basePath in Browsers)
        {
            try { userRoot.DeleteSubKeyTree(basePath, throwOnMissingSubKey: false); } catch { }
        }
        try
        {
            using var inet = userRoot.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings", writable: true);
            if (inet?.GetValue("ProxyServer") is string ps && ps.StartsWith("127.0.0.1:"))
            {
                inet.SetValue("ProxyEnable", 0, RegistryValueKind.DWord);
                inet.DeleteValue("ProxyServer", false);
            }
        }
        catch { }
    }

    public void Invalidate() => _lastWritten = null;

    private static void WriteList(RegistryKey policy, string name, IEnumerable<string> items)
    {
        policy.DeleteSubKeyTree(name, throwOnMissingSubKey: false);
        using var k = policy.CreateSubKey(name, writable: true)!;
        var i = 1;
        foreach (var item in items) k.SetValue((i++).ToString(), item, RegistryValueKind.String);
    }

    private static string Normalize(string site)
    {
        var s = site.Trim().ToLowerInvariant();
        if (s.StartsWith("http://")) s = s[7..];
        if (s.StartsWith("https://")) s = s[8..];
        if (s.StartsWith("www.")) s = s[4..];
        return s.TrimEnd('/');
    }
}
