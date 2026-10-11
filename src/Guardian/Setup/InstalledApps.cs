namespace CoinQuest.Guardian.Setup;

/// <summary>
/// "Apps on this computer" for the Allowed screen: Start Menu shortcuts resolved to their .exe.
/// Uses the WScript.Shell COM object (always present on Windows) via late binding — no interop assembly needed.
/// </summary>
public static class InstalledApps
{
    public sealed record App(string Name, string Exe, string Path);

    public static List<App> Scan()
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
        };
        var results = new Dictionary<string, App>(StringComparer.OrdinalIgnoreCase);
        dynamic? shell = null;
        try
        {
            var t = Type.GetTypeFromProgID("WScript.Shell");
            if (t is not null) shell = Activator.CreateInstance(t);
        }
        catch { }

        foreach (var root in roots.Where(Directory.Exists))
        {
            foreach (var lnk in Directory.EnumerateFiles(root, "*.lnk", SearchOption.AllDirectories))
            {
                try
                {
                    string? target = null;
                    if (shell is not null)
                    {
                        dynamic sc = shell.CreateShortcut(lnk);
                        target = (string?)sc.TargetPath;
                    }
                    if (string.IsNullOrEmpty(target) || !target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                    if (target.Contains("uninstall", StringComparison.OrdinalIgnoreCase)) continue;
                    var exe = System.IO.Path.GetFileName(target);
                    if (!results.ContainsKey(target))
                        results[target] = new App(System.IO.Path.GetFileNameWithoutExtension(lnk), exe, target);
                }
                catch { }
            }
        }
        return results.Values.OrderBy(a => a.Name).ToList();
    }
}
