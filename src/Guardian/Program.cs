using CoinQuest.Guardian;
using CoinQuest.Guardian.Economy;
using CoinQuest.Guardian.Enforcement;
using CoinQuest.Guardian.Ipc;
using CoinQuest.Guardian.Updates;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Ledgers;
using CoinQuest.Shared.Scoring;

Paths.EnsureDirectories();
// Some requests wait on the network (YouTube, updates). Plenty of ready threads keeps everything else instant meanwhile.
ThreadPool.SetMinThreads(64, 64);

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
builder.Services.AddSingleton<ProcessEnforcer>();
builder.Services.AddSingleton<UpdateChecker>();
builder.Services.AddSingleton<RequestRouter>();
builder.Services.AddSingleton<PipeServer>();
builder.Services.AddHostedService<GuardianWorker>();

builder.Build().Run();
