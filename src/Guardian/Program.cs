using CoinQuest.Guardian;
using CoinQuest.Guardian.Economy;
using CoinQuest.Guardian.Enforcement;
using CoinQuest.Guardian.Ipc;
using CoinQuest.Guardian.Updates;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Ledgers;
using CoinQuest.Shared.Scoring;

// Use IPv4 for the service's own internet traffic. On a network whose IPv6 is broken, YouTube, the game catalogue
// (db-api.unstable.life) and other dual-stack sites failed with "A socket operation was attempted to an unreachable
// network" because .NET tried their IPv6 address and never fell back (github.com, IPv4-only, kept working).
AppContext.SetSwitch("System.Net.DisableIPv6", true);

Paths.EnsureDirectories();
// Some requests wait on the network (YouTube, updates). Plenty of ready threads keeps everything else instant meanwhile.
ThreadPool.SetMinThreads(64, 64);
// The Guardian (SYSTEM) always talks to the internet directly. CoinQuest points the CHILD account's proxy setting at
// its own gatekeeper; if Windows hands that setting to the service too (seen on a home PC: updates, YouTube lists and
// game downloads all failed with "proxy tunnel ... 403"), the Guardian would be refused by its own gate.
System.Net.Http.HttpClient.DefaultProxy = new System.Net.WebProxy();

// The gatekeeper proxy belongs on the child's account only. If it ever ended up on the service accounts, take it off.
foreach (var sysSid in new[] { "S-1-5-18", ".DEFAULT", "S-1-5-19", "S-1-5-20" })
{
    try
    {
        using var hku = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.Users, Microsoft.Win32.RegistryView.Default);
        using var inet = hku.OpenSubKey(sysSid + @"\Software\Microsoft\Windows\CurrentVersion\Internet Settings", writable: true);
        if (inet?.GetValue("ProxyServer") is string ps && ps.StartsWith("127.0.0.1:"))
        { inet.SetValue("ProxyEnable", 0, Microsoft.Win32.RegistryValueKind.DWord); inet.DeleteValue("ProxyServer", false); }
    }
    catch { }
}

// `CoinQuest.Guardian.exe --clear-policies` — run by the uninstaller so the child's browser isn't left locked down.
if (args.Contains("--clear-policies"))
{
    var store = new HouseholdStore();
    foreach (var child in store.Current.Children)
        if (!string.IsNullOrEmpty(child.WindowsSid)) BrowserPolicy.ClearStatic(child.WindowsSid);
    NetLock.RemoveAll(store.Current.Children.Select(c => c.WindowsSid).Where(s => !string.IsNullOrEmpty(s)));
    return;
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = Paths.ServiceName);
builder.Logging.AddProvider(new FileLoggerProvider(Path.Combine(Paths.LogDir, "guardian.log")));

builder.Services.AddSingleton(new HouseholdStore());
builder.Services.AddSingleton(sp => new Ledger());
builder.Services.AddSingleton(sp => new ScoreEngine());
builder.Services.AddSingleton<SessionMonitor>();
builder.Services.AddSingleton<BrowserPolicy>();
builder.Services.AddSingleton<NetGate>();
builder.Services.AddSingleton<NetLock>();
builder.Services.AddSingleton<UnlockManager>();
builder.Services.AddSingleton<YouTubeService>();
builder.Services.AddSingleton<FlashpointService>();
builder.Services.AddSingleton<ClassicLibrary>();
builder.Services.AddSingleton<ClassicsStocker>();
builder.Services.AddSingleton<CoinQuest.Guardian.Rwt.RwtService>();
builder.Services.AddSingleton<CoinQuest.Guardian.DiscGames.DiscGameService>();
builder.Services.AddSingleton<ProcessEnforcer>();
builder.Services.AddSingleton<UpdateChecker>();
builder.Services.AddSingleton<RequestRouter>();
builder.Services.AddSingleton<PipeServer>();
builder.Services.AddHostedService<GuardianWorker>();

builder.Build().Run();
