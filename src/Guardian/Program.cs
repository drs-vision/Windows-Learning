using CoinQuest.Guardian;
using CoinQuest.Guardian.Economy;
using CoinQuest.Guardian.Enforcement;
using CoinQuest.Guardian.Ipc;
using CoinQuest.Guardian.Updates;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Ledgers;
using CoinQuest.Shared.Scoring;

Paths.EnsureDirectories();

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = Paths.ServiceName);
builder.Logging.AddProvider(new FileLoggerProvider(Path.Combine(Paths.LogDir, "guardian.log")));

builder.Services.AddSingleton(new HouseholdStore());
builder.Services.AddSingleton(sp => new Ledger());
builder.Services.AddSingleton(sp => new ScoreEngine());
builder.Services.AddSingleton<SessionMonitor>();
builder.Services.AddSingleton<BrowserPolicy>();
builder.Services.AddSingleton<UnlockManager>();
builder.Services.AddSingleton<ProcessEnforcer>();
builder.Services.AddSingleton<UpdateChecker>();
builder.Services.AddSingleton<RequestRouter>();
builder.Services.AddSingleton<PipeServer>();
builder.Services.AddHostedService<GuardianWorker>();

builder.Build().Run();
