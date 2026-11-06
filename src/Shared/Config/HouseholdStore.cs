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

    /// <summary>
    /// Fallback copies ("household-&lt;ticks&gt;.json") written when Windows refuses the main file. The newest readable
    /// file always wins, so settings are never lost to a stuck file.
    /// </summary>
    private IEnumerable<string> Alternates()
    {
        var dir = Path.GetDirectoryName(_path)!;
        if (!Directory.Exists(dir)) return Array.Empty<string>();
        return Directory.EnumerateFiles(dir, Path.GetFileNameWithoutExtension(_path) + "-*" + Path.GetExtension(_path));
    }

    /// <summary>Set when the last save had to use a fallback copy (shown in the Parent Console's log only).</summary>
    public string? LastSaveProblem { get; private set; }

    private Household Load()
    {
        var candidates = new[] { _path }.Concat(Alternates()).Where(File.Exists)
            .OrderByDescending(f => File.GetLastWriteTimeUtc(f)).ToList();
        if (candidates.Count == 0) return new Household();
        foreach (var file in candidates)
        {
            try
            {
                var h = JsonSerializer.Deserialize<Household>(File.ReadAllText(file), Json);
                if (h is not null) return Migrate(h);
            }
            catch
            {
                // Corrupt file: keep a copy for diagnosis and try the next newest.
                try { File.Copy(file, file + ".corrupt." + DateTime.UtcNow.Ticks, overwrite: true); } catch { }
            }
        }
        return new Household(); // fail safe: empty household = everything locked
    }

    private void Save(Household h)
    {
        var json = JsonSerializer.Serialize(h, Json);
        try
        {
            SafeFile.WriteAllText(_path, json);
            LastSaveProblem = null;
            foreach (var alt in Alternates()) { try { File.Delete(alt); } catch { } }
        }
        catch (UnauthorizedAccessException ex)
        {
            // Windows won't let us touch the main file (antivirus lock, damaged permissions, pending delete…).
            // Save a fresh copy beside it instead; Load() picks the newest. Old copies are tidied as we go.
            var alt = Path.Combine(Path.GetDirectoryName(_path)!, $"{Path.GetFileNameWithoutExtension(_path)}-{DateTime.UtcNow.Ticks}{Path.GetExtension(_path)}");
            SafeFile.WriteAllText(alt, json);
            LastSaveProblem = ex.Message;
            foreach (var old in Alternates().Where(a => a != alt)) { try { File.Delete(old); } catch { } }
        }
    }

    public const int CurrentSchema = 9;

    /// <summary>Upgrade data written by older versions. Runs on every load; must be idempotent.</summary>
    public static Household Migrate(Household h)
    {
        var children = h.Children.Select(c =>
        {
            // New modules appear for existing children with their defaults.
            var modules = new Dictionary<string, ModuleSettings>(c.Modules);
            foreach (var (id, d) in ModuleSettings.Defaults()) modules.TryAdd(id, d);
            // New settings on an existing module appear with their defaults (the parent's own values are kept).
            foreach (var (id, d) in ModuleSettings.Defaults())
                if (modules.TryGetValue(id, out var have) && d.Options.Keys.Any(k => !have.Options.ContainsKey(k)))
                {
                    var o = new Dictionary<string, string>(have.Options);
                    foreach (var (k, v) in d.Options) o.TryAdd(k, v);
                    modules[id] = have with { Options = o };
                }
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
            // v5: arcade prices became "per 5 minutes"; old per-play overrides would be far too expensive.
            var arcade = h.SchemaVersion < 5 ? c.Arcade with { PriceOverrides = new() } : c.Arcade;
            // v6: one price sheet (≈1 coin per minute of real learning; 5 min of a thinking game ≈ 4 coins, 5 min of
            // YouTube = 12). Khan Academy and Duolingo pay automatically per finished piece of work, no approvals.
            if (h.SchemaVersion < 6)
            {
                if (modules.TryGetValue("khan-academy", out var k6))
                {
                    var opts = new Dictionary<string, string>(k6.Options);
                    if (!opts.TryGetValue("perAnswer", out var pa) || pa == "2") opts["perAnswer"] = "1";
                    if (!opts.TryGetValue("perVideo", out var pv) || pv == "5") opts["perVideo"] = "3";
                    modules["khan-academy"] = k6 with
                    {
                        RequireApproval = false, Options = opts,
                        CoinsPerActivity = k6.CoinsPerActivity is 35 or 0 ? 5 : k6.CoinsPerActivity,
                        DailyCap = k6.DailyCap is 140 or 150 or 0 ? 80 : k6.DailyCap,
                    };
                }
                if (modules.TryGetValue("duolingo", out var d6) && c.Allowlist.Sites.Any(s => s.EndsWith("duolingo.com", StringComparison.OrdinalIgnoreCase)))
                    modules["duolingo"] = d6 with { Enabled = true };
                prizes = prizes.Select(p => p.Kind == PrizeKind.YouTube && p.Cost == 40 && p.Minutes == 20 ? p with { Cost = 48 } : p).ToList();
            }
            // v7: Scripture typing pays per so many words (1 coin per 20 words, rounded to the nearest). Only a
            // household still on the old flat default (15 per passage) moves; a parent's own choice is kept.
            if (h.SchemaVersion < 7 && modules.TryGetValue("bible-typing", out var b7) && b7.CoinsPerActivity == 15
                && b7.Options.GetValueOrDefault("wordsPer", "0") == "0")
                modules["bible-typing"] = b7 with { CoinsPerActivity = 1, Options = new Dictionary<string, string>(b7.Options) { ["wordsPer"] = "20" } };
            // v8: passage quests have one pay setting, "1 coin per N words". "C coins per N words" becomes 1 per N/C;
            // the old "same for every passage" (N = 0) becomes 1 per 20 words.
            if (h.SchemaVersion < 8)
                foreach (var id in new[] { "bible-typing", "my-passages" })
                    if (modules.TryGetValue(id, out var m8))
                    {
                        var n = int.TryParse(m8.Options.GetValueOrDefault("wordsPer", "20"), out var w) ? w : 20;
                        n = n <= 0 ? 20 : m8.CoinsPerActivity > 1 ? Math.Max(1, (int)Math.Round(n / (double)m8.CoinsPerActivity)) : n;
                        modules[id] = m8 with { CoinsPerActivity = 1, Options = new Dictionary<string, string>(m8.Options) { ["wordsPer"] = n.ToString() } };
                    }
            // v9: Reading pays 3 coins a right answer (daily limit 120, so two long chapters still pay) and a retake
            // waits 5 minutes. Only settings still on the first defaults (1 coin, 60 a day, 10 minutes) move.
            if (h.SchemaVersion < 9 && modules.TryGetValue("books", out var r9))
            {
                var opts = new Dictionary<string, string>(r9.Options);
                if (opts.GetValueOrDefault("waitMinutes", "10") == "10") opts["waitMinutes"] = "5";
                modules["books"] = r9 with
                {
                    CoinsPerActivity = r9.CoinsPerActivity == 1 ? 3 : r9.CoinsPerActivity,
                    DailyCap = r9.DailyCap == 60 ? 120 : r9.DailyCap,
                    Options = opts,
                };
            }
            var allow = c.Allowlist;
            if (h.SchemaVersion < 3)
                allow = allow with { Apps = allow.Apps.Where(a => !Allowlist.Browsers.Contains(Path.GetFileName(a), StringComparer.OrdinalIgnoreCase)).ToList() };
            return c with { Modules = modules, Prizes = prizes, Allowlist = allow, Arcade = arcade };
        }).ToList();
        return h with { Children = children, SchemaVersion = CurrentSchema };
    }

    public void Update(Func<Household, Household> mutate)
    {
        Household next;
        lock (_gate)
        {
            next = mutate(_current);
            Save(next);
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
