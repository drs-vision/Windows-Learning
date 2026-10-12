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
    /// <summary>Bumped when stored data needs upgrading; see HouseholdStore.Migrate.</summary>
    public int SchemaVersion { get; init; }
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
    /// <summary>YouTube channels the child may watch inside CoinQuest (in-app player, never the browser).</summary>
    public List<YouTubeChannel> YouTubeChannels { get; init; } = new();
    public ArcadeSettings Arcade { get; init; } = new();
    /// <summary>Optional hard daily screen-time cap in minutes. Null = coins-only.</summary>
    public int? DailyScreenTimeCapMinutes { get; init; }
}

public sealed record Allowlist
{
    /// <summary>Executable names (case-insensitive) or full paths. "msedge.exe", "C:\\Program Files\\Foo\\foo.exe".</summary>
    public List<string> Apps { get; init; } = new();
    /// <summary>Domains, e.g. "khanacademy.org". Subdomains are implied.</summary>
    public List<string> Sites { get; init; } = new();

    /// <summary>Real web browsers are never allowed on a managed account — their own lockdown settings can't be trusted on a home PC.</summary>
    public static readonly string[] Browsers = { "msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe", "opera_gx.exe", "vivaldi.exe", "iexplore.exe", "waterfox.exe", "librewolf.exe", "tor.exe", "duckduckgo.exe", "arc.exe" };

    public static Allowlist SchoolBasics() => new()
    {
        // No real browsers: websites open in CoinQuest's own locked browser, which can only reach Sites.
        Apps = new() { "CoinQuest.Scholar.exe", "CoinQuest.ParentConsole.exe", "calc.exe", "notepad.exe", "mspaint.exe" },
        Sites = new() { "khanacademy.org", "kastatic.org", "kasandbox.org", "merriam-webster.com", "wikipedia.org", "wikimedia.org" }
    };
}

public enum PrizeKind { SiteUnlock, ArcadeUnlock, AppUnlock, ScreenTimeExtension, RealWorld, YouTube }

public sealed record YouTubeChannel
{
    public string Id { get; init; } = "";     // UC… channel id
    public string Title { get; init; } = "";
    public string Url { get; init; } = "";
}

/// <summary>
/// Pay-per-play arcade. Each game costs coins per play; one play = MinutesPerPlay minutes of that game.
/// Default price comes from the game's strategy rating (more thinking = cheaper); parents override per game.
/// </summary>
public sealed record ArcadeSettings
{
    /// <summary>Old pay-per-play cap; unused since arcade time is bought in 5-minute blocks.</summary>
    public int MinutesPerPlay { get; init; } = 15;
    /// <summary>Sampler pass: any game, for this many minutes.</summary>
    public int SamplerMinutes { get; init; } = 10;
    /// <summary>Sampler pass price; 0 = automatic (a little more than 10 minutes of the priciest game).</summary>
    public int SamplerPrice { get; init; }
    public Dictionary<string, int> PriceOverrides { get; init; } = new();
    public List<string> Hidden { get; init; } = new();
    /// <summary>Games hosted on the web by their makers/publishers, played in a locked window.</summary>
    public List<WebGame> WebGames { get; init; } = new();
    /// <summary>Classic games from the local Flashpoint Archive install that the parent approved.</summary>
    public List<FlashpointGame> Flashpoint { get; init; } = new();
    /// <summary>Where Flashpoint is installed, if the parent picked it; otherwise it's found automatically.</summary>
    public string? FlashpointRoot { get; init; }
    /// <summary>When Flashpoint is found, add CoinQuest's curated kid-safe classics automatically (parents can still remove any).</summary>
    public bool AutoClassics { get; init; } = true;
    /// <summary>Curated picks already added once — so a game a parent removed is never re-added.</summary>
    public List<string> StockedPicks { get; init; } = new();

    /// <summary>Arcade time is bought in blocks of this many minutes ("+" adds one block).</summary>
    public const int BlockMinutes = 5;
    public const int MaxBlocks = 12;

    /// <summary>Coins per 5-minute block. More thinking = cheaper.</summary>
    public static int DefaultPrice(int strategy) => Math.Clamp(strategy, 1, 5) switch { 5 => 2, 4 => 3, 3 => 4, 2 => 5, _ => 6 };

    /// <summary>
    /// YouTube costs more than the arcade (games beat videos). Per 5 minutes: the prize's own rate, but always at
    /// least 2 coins above the priciest arcade game.
    /// </summary>
    public static int YouTubeBlockPrice(Prize prize, IEnumerable<int> arcadePrices)
    {
        var own = prize.Minutes > 0 ? (int)Math.Ceiling(prize.Cost / (prize.Minutes / (double)BlockMinutes)) : prize.Cost;
        var floor = arcadePrices.DefaultIfEmpty(DefaultPrice(1)).Max() + 2;
        return Math.Max(own, floor);
    }

    /// <summary>Automatic sampler price: a bit more than the same time on the most expensive single game.</summary>
    public static int AutoSamplerPrice(IEnumerable<int> prices, int samplerMinutes)
    {
        var max = prices.DefaultIfEmpty(DefaultPrice(1)).Max();
        var blocks = Math.Max(1, (int)Math.Ceiling(samplerMinutes / (double)BlockMinutes));
        return max * blocks + Math.Max(2, max * blocks / 5);
    }
}

public sealed record FlashpointGame
{
    public string Id { get; init; } = "";      // Flashpoint's game UUID
    public string Title { get; init; } = "";
    public string Developer { get; init; } = "";
    public string Genre { get; init; } = "";
    public int Strategy { get; init; } = 2;
}

public sealed record WebGame
{
    public string Id { get; init; } = "web-" + Guid.NewGuid().ToString("N")[..8];
    public string Title { get; init; } = "";
    public string Url { get; init; } = "";
    /// <summary>1 (pure reflex) … 5 (heavy strategy/puzzle).</summary>
    public int Strategy { get; init; } = 3;
}

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
        new() { Name = "20 minutes of YouTube", Cost = 40, Kind = PrizeKind.YouTube, Minutes = 20, DailyCap = 3 },
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
    /// <summary>Module-specific parent settings (e.g. Sound Keys calm mode). Opaque to the Guardian.</summary>
    public Dictionary<string, string> Options { get; init; } = new();

    public static Dictionary<string, ModuleSettings> Defaults() => new()
    {
        ["sound-keys"] = new() { CoinsPerActivity = 12, DailyCap = 100 },
        ["typing-quest"] = new() { Enabled = false, CoinsPerActivity = 10, DailyCap = 80 },
        ["bible-typing"] = new() { CoinsPerActivity = 15, DailyCap = 60 },
        ["khan-academy"] = new() { CoinsPerActivity = 35, DailyCap = 150 },
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
