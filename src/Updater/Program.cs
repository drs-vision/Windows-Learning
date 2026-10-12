using System.Diagnostics;

// CoinQuest.Updater — swaps the install directory with a staged release and restarts the service.
// Launched by the Guardian (as SYSTEM) from a copy OUTSIDE the install dir so every file can be replaced.
// Deliberately depends on nothing but the base .NET runtime (it runs from a folder holding only its own files):
// services are controlled with sc.exe, not System.ServiceProcess.
//   --source <stagedDir> --target <installDir> --service <name> --log <file>

var a = ParseArgs(args);
var source = a["source"]; var target = a["target"]; var service = a["service"]; var logFile = a.GetValueOrDefault("log") ?? Path.Combine(Path.GetTempPath(), "coinquest-updater.log");
void Log(string s) { try { File.AppendAllText(logFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {s}{Environment.NewLine}"); } catch { } }

try
{
    Log($"Updating {target} from {source}");

    // 1. Stop the service (which also stops the heartbeat that would relaunch Scholar).
    //    If it won't stop within 45 s, end its process — the files must be released either way.
    Sc($"stop {service}");
    var deadline = DateTime.UtcNow.AddSeconds(45);
    while (ServiceState(service) != "STOPPED" && DateTime.UtcNow < deadline) Thread.Sleep(1000);
    if (ServiceState(service) != "STOPPED")
    {
        Log("Service did not stop in time; ending CoinQuest.Guardian");
        foreach (var p in Process.GetProcessesByName("CoinQuest.Guardian")) { try { p.Kill(true); p.WaitForExit(10000); } catch { } }
        Thread.Sleep(2000);
    }
    Log("Service stopped");

    // 2. Close the user-facing apps so their files can be replaced. Guardian restarts Scholar on its own.
    foreach (var name in new[] { "CoinQuest.Scholar", "CoinQuest.ParentConsole" })
        foreach (var p in Process.GetProcessesByName(name)) { try { p.Kill(true); p.WaitForExit(5000); } catch { } }

    // 3. Copy, with retries for files Windows is slow to release.
    var backup = target.TrimEnd('\\') + ".previous";
    if (Directory.Exists(backup)) Directory.Delete(backup, true);
    CopyTree(target, backup, Log);
    Log("Backup written");

    var failed = new List<string>();
    foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
    {
        var rel = Path.GetRelativePath(source, file);
        var dest = Path.Combine(target, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        var ok = false;
        for (var i = 0; i < 20 && !ok; i++)
        {
            try { File.Copy(file, dest, true); ok = true; }
            catch (IOException) { Thread.Sleep(500); }
            catch (UnauthorizedAccessException) { Thread.Sleep(500); }
        }
        if (!ok) failed.Add(rel);
    }

    if (failed.Count > 0)
    {
        Log("FAILED to replace: " + string.Join(", ", failed) + " — rolling back");
        CopyTree(backup, target, Log);
    }
    else Log("Files replaced");
}
catch (Exception ex)
{
    Log("ERROR " + ex);
}
finally
{
    Sc($"start {service}");
    var deadline = DateTime.UtcNow.AddSeconds(60);
    while (ServiceState(service) != "RUNNING" && DateTime.UtcNow < deadline) Thread.Sleep(1000);
    Log("Service state after start: " + ServiceState(service));
}

string Sc(string arguments)
{
    try
    {
        var psi = new ProcessStartInfo("sc.exe", arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        using var p = Process.Start(psi)!;
        var output = p.StandardOutput.ReadToEnd();
        p.WaitForExit(30000);
        return output;
    }
    catch (Exception ex) { Log($"sc {arguments}: {ex.Message}"); return ""; }
}

string ServiceState(string name)
{
    var output = Sc($"query {name}");
    foreach (var st in new[] { "STOPPED", "START_PENDING", "STOP_PENDING", "RUNNING" }) if (output.Contains(st)) return st;
    return "UNKNOWN";
}

static void CopyTree(string from, string to, Action<string> log)
{
    foreach (var file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
    {
        var dest = Path.Combine(to, Path.GetRelativePath(from, file));
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        try { File.Copy(file, dest, true); } catch (Exception ex) { log($"copy {file}: {ex.Message}"); }
    }
}

static Dictionary<string, string> ParseArgs(string[] args)
{
    var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var i = 0; i + 1 < args.Length; i += 2) if (args[i].StartsWith("--")) d[args[i][2..]] = args[i + 1];
    foreach (var k in new[] { "source", "target", "service" }) if (!d.ContainsKey(k)) throw new ArgumentException($"--{k} required");
    return d;
}
