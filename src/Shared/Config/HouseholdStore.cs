using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CoinQuest.Shared.Models;
using Konscious.Security.Cryptography;

namespace CoinQuest.Shared.Config;

/// <summary>Loads/saves household.json atomically. Thread-safe. Single writer (the Guardian).</summary>
public sealed class HouseholdStore
{
    public static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly string _path;
    private readonly object _gate = new();
    private Household _current;

    public HouseholdStore(string? path = null)
    {
        _path = path ?? Paths.HouseholdFile;
        if (Directory.Exists(Path.GetDirectoryName(_path))) SafeFile.CleanTemps(Path.GetDirectoryName(_path)!);
        _current = Load();
    }

    public Household Current { get { lock (_gate) return _current; } }

    public event Action<Household>? Changed;

    private Household Load()
    {
        if (!File.Exists(_path)) return new Household();
        try
        {
            return Migrate(JsonSerializer.Deserialize<Household>(File.ReadAllText(_path), Json) ?? new Household());
        }
        catch
        {
            // Corrupt file: keep a copy for diagnosis and fail safe (empty household = everything locked).
            File.Copy(_path, _path + ".corrupt." + DateTime.UtcNow.Ticks, overwrite: true);
            return new Household();
        }
    }

    public const int CurrentSchema = 4;

    /// <summary>Upgrade data written by older versions. Runs on every load; must be idempotent.</summary>
    public static Household Migrate(Household h)
    {
        var children = h.Children.Select(c =>
        {
            // New modules appear for existing children with their defaults.
            var modules = new Dictionary<string, ModuleSettings>(c.Modules);
            foreach (var (id, d) in ModuleSettings.Defaults()) modules.TryAdd(id, d);
            var prizes = c.Prizes;
            if (h.SchemaVersion < 2)
            {
                // v2: YouTube moves from "unlock youtube.com in the browser" to the in-app channel allowlist,
                // and the arcade becomes pay-per-play (no blanket arcade-time prize).
                prizes = c.Prizes
                    .Where(p => p.Kind != PrizeKind.ArcadeUnlock)
                    .Select(p => p.Kind == PrizeKind.SiteUnlock && p.Targets.Any(t => t.Contains("youtube", StringComparison.OrdinalIgnoreCase))
                        ? p with { Kind = PrizeKind.YouTube, Targets = new() } : p)
                    .ToList();
                // A child who has never started typing should begin with Sound Keys, not the fluency course.
                if (modules.TryGetValue("typing-quest", out var tq)) modules["typing-quest"] = tq with { Enabled = false };
            }
            // v4: Khan Academy pays automatically for observed work; hand claims still always need approval (enforced by the scorer).
            if (h.SchemaVersion < 4 && modules.TryGetValue("khan-academy", out var ka)) modules["khan-academy"] = ka with { RequireApproval = false };
            var allow = c.Allowlist;
            if (h.SchemaVersion < 3)
                allow = allow with { Apps = allow.Apps.Where(a => !Allowlist.Browsers.Contains(Path.GetFileName(a), StringComparer.OrdinalIgnoreCase)).ToList() };
            return c with { Modules = modules, Prizes = prizes, Allowlist = allow };
        }).ToList();
        return h with { Children = children, SchemaVersion = CurrentSchema };
    }

    public void Update(Func<Household, Household> mutate)
    {
        Household next;
        lock (_gate)
        {
            next = mutate(_current);
            SafeFile.WriteAllText(_path, JsonSerializer.Serialize(next, Json));
            _current = next;
        }
        Changed?.Invoke(next);
    }

    public Child? FindChildByAccount(string account)
    {
        var h = Current;
        var bare = account.Contains('\\') ? account[(account.IndexOf('\\') + 1)..] : account;
        return h.Children.FirstOrDefault(c =>
            string.Equals(c.WindowsAccount, account, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(c.WindowsAccount, bare, StringComparison.OrdinalIgnoreCase));
    }

    public Child? FindChild(string childId) => Current.Children.FirstOrDefault(c => c.Id == childId);

    // ---- PIN -------------------------------------------------------------

    public void SetPin(string pin)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = HashPin(pin, salt);
        Update(h => h with { PinHash = Convert.ToBase64String(hash), PinSalt = Convert.ToBase64String(salt), PinFailures = 0, PinLockedUntil = null });
    }

    public bool HasPin => Current.PinHash is not null;

    /// <summary>Returns true on success. Three failures lock for five minutes.</summary>
    public bool VerifyPin(string pin)
    {
        var h = Current;
        if (h.PinHash is null || h.PinSalt is null) return false;
        if (h.PinLockedUntil is { } until && until > DateTimeOffset.UtcNow) return false;

        var ok = CryptographicOperations.FixedTimeEquals(
            HashPin(pin, Convert.FromBase64String(h.PinSalt)),
            Convert.FromBase64String(h.PinHash));

        if (ok)
        {
            if (h.PinFailures != 0) Update(x => x with { PinFailures = 0, PinLockedUntil = null });
            return true;
        }
        Update(x =>
        {
            var f = x.PinFailures + 1;
            return x with { PinFailures = f, PinLockedUntil = f >= 3 ? DateTimeOffset.UtcNow.AddMinutes(5) : null };
        });
        return false;
    }

    public static byte[] HashPin(string pin, byte[] salt)
    {
        using var argon = new Argon2id(Encoding.UTF8.GetBytes(pin))
        {
            Salt = salt,
            DegreeOfParallelism = 2,
            MemorySize = 32 * 1024,
            Iterations = 3
        };
        return argon.GetBytes(32);
    }
}
