using System.Diagnostics;
using System.Management;

namespace CoinQuest.Guardian.Setup;

/// <summary>Local Windows accounts, for the setup wizard's "which one is your child's?" list.</summary>
public static class LocalAccounts
{
    public sealed record Account(string Name, string FullName, bool IsAdmin, bool Disabled, string Sid);

    public static List<Account> List()
    {
        var admins = AdminMembers();
        var list = new List<Account>();
        using var searcher = new ManagementObjectSearcher("SELECT Name, FullName, Disabled, SID FROM Win32_UserAccount WHERE LocalAccount = TRUE");
        foreach (var o in searcher.Get())
        {
            var name = (string)o["Name"];
            if (name is "DefaultAccount" or "WDAGUtilityAccount" or "Guest") continue;
            var disabled = (bool)o["Disabled"];
            if (disabled && name == "Administrator") continue;
            list.Add(new Account(name, (string?)o["FullName"] ?? "", admins.Contains(name), disabled, (string)o["SID"]));
        }
        return list.OrderBy(a => a.IsAdmin).ThenBy(a => a.Name).ToList();
    }

    private static HashSet<string>? _adminCache;
    private static DateTime _adminCacheAt;

    /// <summary>Is this account (bare or DOMAIN\name) a member of the local Administrators group? Cached for 30 s.</summary>
    public static bool IsLocalAdmin(string account)
    {
        var bare = account.Contains('\\') ? account[(account.IndexOf('\\') + 1)..] : account;
        if (_adminCache is null || (DateTime.UtcNow - _adminCacheAt).TotalSeconds > 30)
        {
            _adminCache = AdminMembers();
            _adminCacheAt = DateTime.UtcNow;
        }
        return _adminCache.Contains(bare);
    }

    private static HashSet<string> AdminMembers()
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var output = Run("net", "localgroup Administrators");
            var inList = false;
            foreach (var raw in output.Split('\n'))
            {
                var line = raw.Trim();
                if (line.StartsWith("---")) { inList = true; continue; }
                if (!inList || line.Length == 0 || line.StartsWith("The command")) continue;
                set.Add(line.Contains('\\') ? line[(line.IndexOf('\\') + 1)..] : line);
            }
        }
        catch { }
        return set;
    }

    /// <summary>
    /// Create a local Standard account for a child (CoinQuest setup / "Add a kid"). The Guardian runs as SYSTEM, so it
    /// can. Sign-in name: letters, digits, spaces, '.', '-', '_' (20 at most, Windows' limit). An empty password means
    /// the child signs in without one. Windows creates the profile folder on the first sign-in. Returns the name.
    /// </summary>
    public static string CreateStandardUser(string userName, string fullName, string? password)
    {
        userName = userName.Trim();
        if (userName.Length is 0 or > 20 || !userName.All(c => char.IsLetterOrDigit(c) || c is ' ' or '.' or '-' or '_') || userName.Trim('.', ' ').Length == 0)
            throw new ArgumentException("Pick a sign-in name of up to 20 letters or numbers");
        if (List().Any(a => a.Name.Equals(userName, StringComparison.OrdinalIgnoreCase)))
            throw new ArgumentException($"There's already an account called “{userName}” — pick it under “Use an existing account”, or choose another name");
        var args = new List<string> { "user", userName, password ?? "", "/add", $"/fullname:{fullName.Trim()}", "/comment:Child account managed by CoinQuest", "/passwordchg:yes" };
        if (string.IsNullOrEmpty(password)) args.Add("/passwordreq:no");
        var (code, output) = RunArgs("net", args);
        if (code != 0) throw new InvalidOperationException("Windows couldn't create the account: " + output.Trim());
        EnsureStandardUser(userName);
        _adminCache = null;
        return userName;
    }

    private static (int Code, string Output) RunArgs(string file, IEnumerable<string> args)
    {
        var psi = new ProcessStartInfo(file) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit(20000);
        return (p.HasExited ? p.ExitCode : -1, output);
    }

    /// <summary>A managed child must be a Standard user. Removes them from Administrators if present.</summary>
    public static void EnsureStandardUser(string account)
    {
        if (CoinQuest.Shared.Config.Paths.E2ETestMode) return; // CI machine: the test account must stay an administrator
        var bare = account.Contains('\\') ? account[(account.IndexOf('\\') + 1)..] : account;
        if (AdminMembers().Contains(bare)) Run("net", $"localgroup Administrators \"{bare}\" /delete");
        Run("net", $"localgroup Users \"{bare}\" /add");
    }

    private static string Run(string file, string args)
    {
        var psi = new ProcessStartInfo(file, args) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        using var p = Process.Start(psi)!;
        var output = p.StandardOutput.ReadToEnd();
        p.WaitForExit(10000);
        return output;
    }
}
