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
        _current = Load();
    }

    public Household Current { get { lock (_gate) return _current; } }

    public event Action<Household>? Changed;

    private Household Load()
    {
        if (!File.Exists(_path)) return new Household();
        try
        {
            return JsonSerializer.Deserialize<Household>(File.ReadAllText(_path), Json) ?? new Household();
        }
        catch
        {
            // Corrupt file: keep a copy for diagnosis and fail safe (empty household = everything locked).
            File.Copy(_path, _path + ".corrupt." + DateTime.UtcNow.Ticks, overwrite: true);
            return new Household();
        }
    }

    public void Update(Func<Household, Household> mutate)
    {
        Household next;
        lock (_gate)
        {
            next = mutate(_current);
            var tmp = _path + ".tmp";
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(tmp, JsonSerializer.Serialize(next, Json));
            File.Move(tmp, _path, overwrite: true);
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
