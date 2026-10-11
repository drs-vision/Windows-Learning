using System.Text.Json.Serialization;

namespace CoinQuest.Shared.Models;

/// <summary>
/// Every record carries HouseholdId + ChildId from day one so that cloud sync and
/// multi-family support can be added without a data migration. Locally there is
/// exactly one household.
/// </summary>
public sealed record Household
{
    public string Id { get; init; } = "local";
    public string Name { get; init; } = "My family";
    public List<Child> Children { get; init; } = new();
    /// <summary>Argon2id hash of the parent PIN, base64. Null until setup completes.</summary>
    public string? PinHash { get; init; }
    public string? PinSalt { get; init; }
    public int PinFailures { get; init; }
    public DateTimeOffset? PinLockedUntil { get; init; }
}

public sealed record Child
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public string DisplayName { get; init; } = "";
    /// <summary>Windows account name, e.g. "MACHINE\\sam" or "sam".</summary>
    public string WindowsAccount { get; init; } = "";
    /// <summary>Windows SID, resolved at setup. Used for HKU policy writes.</summary>
    public string WindowsSid { get; init; } = "";
    public Allowlist Allowlist { get; init; } = Allowlist.SchoolBasics();
    public List<Prize> Prizes { get; init; } = Prize.Starters();
    public Dictionary<string, ModuleSettings> Modules { get; init; } = ModuleSettings.Defaults();
    /// <summary>Optional hard daily screen-time cap in minutes. Null = coins-only.</summary>
    public int? DailyScreenTimeCapMinutes { get; init; }
}

public sealed record Allowlist
{
    /// <summary>Executable names (case-insensitive) or full paths. "msedge.exe", "C:\\Program Files\\Foo\\foo.exe".</summary>
    public List<string> Apps { get; init; } = new();
    /// <summary>Domains, e.g. "khanacademy.org". Subdomains are implied.</summary>
    public List<string> Sites { get; init; } = new();

    public static Allowlist SchoolBasics() => new()
    {
        Apps = new() { "msedge.exe", "chrome.exe", "CoinQuest.Scholar.exe", "CoinQuest.ParentConsole.exe", "calc.exe", "notepad.exe", "mspaint.exe" },
        Sites = new() { "khanacademy.org", "kastatic.org", "kasandbox.org", "merriam-webster.com", "wikipedia.org", "wikimedia.org" }
    };
}

public enum PrizeKind { SiteUnlock, ArcadeUnlock, AppUnlock, ScreenTimeExtension, RealWorld }

public sealed record Prize
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public string Name { get; init; } = "";
    public int Cost { get; init; }
    public PrizeKind Kind { get; init; }
    /// <summary>For SiteUnlock: domains. For AppUnlock: exe names.</summary>
    public List<string> Targets { get; init; } = new();
    public int Minutes { get; init; }
    /// <summary>Max purchases per day. 0 = unlimited.</summary>
    public int DailyCap { get; init; }
    public bool Enabled { get; init; } = true;

    public static List<Prize> Starters() => new()
    {
        new() { Name = "20 minutes of YouTube", Cost = 40, Kind = PrizeKind.SiteUnlock, Targets = new() { "youtube.com", "googlevideo.com", "ytimg.com", "ggpht.com" }, Minutes = 20, DailyCap = 3 },
        new() { Name = "30 minutes of Arcade", Cost = 50, Kind = PrizeKind.ArcadeUnlock, Minutes = 30, DailyCap = 2 },
        new() { Name = "Extra 15 minutes tonight", Cost = 30, Kind = PrizeKind.ScreenTimeExtension, Minutes = 15, DailyCap = 1 },
        new() { Name = "Pick Friday's movie", Cost = 150, Kind = PrizeKind.RealWorld, DailyCap = 1 },
    };
}

public sealed record ModuleSettings
{
    public bool Enabled { get; init; } = true;
    public int CoinsPerActivity { get; init; }
    public int DailyCap { get; init; }
    /// <summary>For observed modules: whether to require parent approval anyway.</summary>
    public bool RequireApproval { get; init; }

    public static Dictionary<string, ModuleSettings> Defaults() => new()
    {
        ["typing-quest"] = new() { CoinsPerActivity = 10, DailyCap = 80 },
        ["bible-typing"] = new() { CoinsPerActivity = 15, DailyCap = 60 },
        ["khan-academy"] = new() { CoinsPerActivity = 35, DailyCap = 140, RequireApproval = true },
    };
}

public enum LedgerKind { Earn, Spend, Adjust, Claim, ClaimApproved, ClaimDenied }

public sealed record LedgerEntry
{
    public long Seq { get; init; }
    public DateTimeOffset At { get; init; }
    public string HouseholdId { get; init; } = "local";
    public string ChildId { get; init; } = "";
    public LedgerKind Kind { get; init; }
    /// <summary>Positive for earn, negative for spend. Zero for pending claims.</summary>
    public int Delta { get; init; }
    public string Source { get; init; } = "";        // module id or prize id
    public string Detail { get; init; } = "";        // human text: "Psalm 23 · 98% · 142 words"
    public string? ActorAccount { get; init; }       // who caused it (windows account)
    public string PrevHash { get; init; } = "";
    public string Hash { get; init; } = "";
}

public sealed record Unlock
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public string ChildId { get; init; } = "";
    public PrizeKind Kind { get; init; }
    public List<string> Targets { get; init; } = new();
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
    public string PrizeName { get; init; } = "";

    [JsonIgnore] public bool IsActive => DateTimeOffset.UtcNow < ExpiresAt;
    [JsonIgnore] public int SecondsLeft => Math.Max(0, (int)(ExpiresAt - DateTimeOffset.UtcNow).TotalSeconds);
}

public sealed record PendingClaim
{
    public long LedgerSeq { get; init; }
    public string ChildId { get; init; } = "";
    public string ModuleId { get; init; } = "";
    public int Coins { get; init; }
    public string Detail { get; init; } = "";
    public DateTimeOffset At { get; init; }
}
