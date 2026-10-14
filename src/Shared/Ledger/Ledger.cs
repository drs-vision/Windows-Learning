using System.Security.Cryptography;
using System.Text;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;
using Microsoft.Data.Sqlite;

namespace CoinQuest.Shared.Ledgers;

/// <summary>
/// Append-only coin ledger in SQLite with a SHA-256 hash chain. Only the Guardian (SYSTEM) writes;
/// the file's ACL stops the child account from touching it, and the chain detects tampering anyway.
/// </summary>
public sealed class Ledger : IDisposable
{
    private readonly SqliteConnection _db;
    private readonly object _gate = new();

    public Ledger(string? path = null)
    {
        path ??= Paths.LedgerDb;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        _db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadWriteCreate }.ToString());
        _db.Open();
        Exec("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS ledger (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              at TEXT NOT NULL,
              household TEXT NOT NULL,
              child TEXT NOT NULL,
              kind TEXT NOT NULL,
              delta INTEGER NOT NULL,
              source TEXT NOT NULL,
              detail TEXT NOT NULL,
              actor TEXT,
              prev_hash TEXT NOT NULL,
              hash TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_ledger_child_at ON ledger(child, at);
            CREATE TABLE IF NOT EXISTS claims (
              seq INTEGER PRIMARY KEY,           -- ledger seq of the Claim row
              child TEXT NOT NULL,
              module TEXT NOT NULL,
              coins INTEGER NOT NULL,
              detail TEXT NOT NULL,
              at TEXT NOT NULL,
              resolved INTEGER NOT NULL DEFAULT 0
            );
            """);
    }

    public LedgerEntry Append(string childId, LedgerKind kind, int delta, string source, string detail, string? actor = null, string householdId = "local")
    {
        lock (_gate)
        {
            var prev = LastHash();
            var at = DateTimeOffset.UtcNow;
            var hash = ComputeHash(prev, at, householdId, childId, kind, delta, source, detail);
            using var cmd = _db.CreateCommand();
            cmd.CommandText = """
                INSERT INTO ledger(at, household, child, kind, delta, source, detail, actor, prev_hash, hash)
                VALUES ($at,$h,$c,$k,$d,$s,$t,$a,$p,$x);
                SELECT last_insert_rowid();
                """;
            cmd.Parameters.AddWithValue("$at", at.ToString("O"));
            cmd.Parameters.AddWithValue("$h", householdId);
            cmd.Parameters.AddWithValue("$c", childId);
            cmd.Parameters.AddWithValue("$k", kind.ToString());
            cmd.Parameters.AddWithValue("$d", delta);
            cmd.Parameters.AddWithValue("$s", source);
            cmd.Parameters.AddWithValue("$t", detail);
            cmd.Parameters.AddWithValue("$a", (object?)actor ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$p", prev);
            cmd.Parameters.AddWithValue("$x", hash);
            var seq = (long)cmd.ExecuteScalar()!;
            return new LedgerEntry { Seq = seq, At = at, HouseholdId = householdId, ChildId = childId, Kind = kind, Delta = delta, Source = source, Detail = detail, ActorAccount = actor, PrevHash = prev, Hash = hash };
        }
    }

    public int Balance(string childId)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE child=$c";
        cmd.Parameters.AddWithValue("$c", childId);
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    /// <summary>Coins earned from a source today (local day), for daily caps.</summary>
    public int EarnedToday(string childId, string source, DateTimeOffset? now = null)
    {
        var start = (now ?? DateTimeOffset.Now).Date;
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END),0) FROM ledger WHERE child=$c AND source=$s AND kind IN ('Earn','ClaimApproved') AND at>=$a";
        cmd.Parameters.AddWithValue("$c", childId);
        cmd.Parameters.AddWithValue("$s", source);
        cmd.Parameters.AddWithValue("$a", new DateTimeOffset(start).ToUniversalTime().ToString("O"));
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    public int PurchasesToday(string childId, string prizeId, DateTimeOffset? now = null)
    {
        var start = (now ?? DateTimeOffset.Now).Date;
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM ledger WHERE child=$c AND source=$s AND kind='Spend' AND at>=$a";
        cmd.Parameters.AddWithValue("$c", childId);
        cmd.Parameters.AddWithValue("$s", prizeId);
        cmd.Parameters.AddWithValue("$a", new DateTimeOffset(start).ToUniversalTime().ToString("O"));
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    /// <summary>How many times each arcade game was bought ("arcade:&lt;gameId&gt;" → count), for "Most played".</summary>
    public Dictionary<string, int> ArcadePlays(string childId)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT source, COUNT(*) FROM ledger WHERE child=$c AND kind='Spend' AND source LIKE 'arcade:%' GROUP BY source";
        cmd.Parameters.AddWithValue("$c", childId);
        var d = new Dictionary<string, int>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) d[r.GetString(0)[7..]] = r.GetInt32(1);
        return d;
    }

    /// <summary>One page of a child's history, newest first, older than <paramref name="beforeSeq"/> (null: from the newest).</summary>
    public List<LedgerEntry> Page(string childId, long? beforeSeq, int limit)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT seq,at,household,child,kind,delta,source,detail,actor,prev_hash,hash FROM ledger WHERE child=$c AND seq<$b ORDER BY seq DESC LIMIT $l";
        cmd.Parameters.AddWithValue("$c", childId);
        cmd.Parameters.AddWithValue("$b", beforeSeq ?? long.MaxValue);
        cmd.Parameters.AddWithValue("$l", limit);
        var list = new List<LedgerEntry>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(Read(r));
        return list;
    }

    public List<LedgerEntry> Recent(string childId, int limit = 50, DateTimeOffset? since = null)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT seq,at,household,child,kind,delta,source,detail,actor,prev_hash,hash FROM ledger WHERE child=$c AND at>=$a ORDER BY seq DESC LIMIT $l";
        cmd.Parameters.AddWithValue("$c", childId);
        cmd.Parameters.AddWithValue("$a", (since ?? DateTimeOffset.MinValue).ToUniversalTime().ToString("O"));
        cmd.Parameters.AddWithValue("$l", limit);
        var list = new List<LedgerEntry>();
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(Read(r));
        return list;
    }

    // ---- claims (parent_approved earnings) ---------------------------------

    public PendingClaim FileClaim(string childId, string moduleId, int coins, string detail, string? actor)
    {
        lock (_gate)
        {
            var e = Append(childId, LedgerKind.Claim, 0, moduleId, detail, actor);
            using var cmd = _db.CreateCommand();
            cmd.CommandText = "INSERT INTO claims(seq,child,module,coins,detail,at) VALUES ($q,$c,$m,$k,$d,$a)";
            cmd.Parameters.AddWithValue("$q", e.Seq);
            cmd.Parameters.AddWithValue("$c", childId);
            cmd.Parameters.AddWithValue("$m", moduleId);
            cmd.Parameters.AddWithValue("$k", coins);
            cmd.Parameters.AddWithValue("$d", detail);
            cmd.Parameters.AddWithValue("$a", e.At.ToString("O"));
            cmd.ExecuteNonQuery();
            return new PendingClaim { LedgerSeq = e.Seq, ChildId = childId, ModuleId = moduleId, Coins = coins, Detail = detail, At = e.At };
        }
    }

    public List<PendingClaim> PendingClaims(string? childId = null)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT seq,child,module,coins,detail,at FROM claims WHERE resolved=0" + (childId is null ? "" : " AND child=$c") + " ORDER BY seq";
        if (childId is not null) cmd.Parameters.AddWithValue("$c", childId);
        var list = new List<PendingClaim>();
        using var r = cmd.ExecuteReader();
        while (r.Read())
            list.Add(new PendingClaim { LedgerSeq = r.GetInt64(0), ChildId = r.GetString(1), ModuleId = r.GetString(2), Coins = r.GetInt32(3), Detail = r.GetString(4), At = DateTimeOffset.Parse(r.GetString(5)) });
        return list;
    }

    /// <summary>Resolve a claim. Returns the resulting ledger entry, or null if already resolved.</summary>
    public LedgerEntry? ResolveClaim(long seq, bool approve, string actor, int? overrideCoins = null)
    {
        lock (_gate)
        {
            var claim = PendingClaims().FirstOrDefault(c => c.LedgerSeq == seq);
            if (claim is null) return null;
            using (var cmd = _db.CreateCommand())
            {
                cmd.CommandText = "UPDATE claims SET resolved=1 WHERE seq=$q";
                cmd.Parameters.AddWithValue("$q", seq);
                cmd.ExecuteNonQuery();
            }
            var coins = approve ? (overrideCoins ?? claim.Coins) : 0;
            return Append(claim.ChildId, approve ? LedgerKind.ClaimApproved : LedgerKind.ClaimDenied, coins, claim.ModuleId, claim.Detail, actor);
        }
    }

    // ---- integrity ----------------------------------------------------------

    /// <summary>Walks the chain. Returns the seq of the first bad row, or null if intact.</summary>
    public long? Verify()
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT seq,at,household,child,kind,delta,source,detail,actor,prev_hash,hash FROM ledger ORDER BY seq";
        using var r = cmd.ExecuteReader();
        var prev = "";
        while (r.Read())
        {
            var e = Read(r);
            if (e.PrevHash != prev) return e.Seq;
            if (ComputeHash(e.PrevHash, e.At, e.HouseholdId, e.ChildId, e.Kind, e.Delta, e.Source, e.Detail) != e.Hash) return e.Seq;
            prev = e.Hash;
        }
        return null;
    }

    private string LastHash()
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = "SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1";
        return cmd.ExecuteScalar() as string ?? "";
    }

    public static string ComputeHash(string prev, DateTimeOffset at, string household, string child, LedgerKind kind, int delta, string source, string detail)
    {
        var s = string.Join("\u001f", prev, at.ToString("O"), household, child, kind.ToString(), delta.ToString(), source, detail);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    }

    private static LedgerEntry Read(SqliteDataReader r) => new()
    {
        Seq = r.GetInt64(0),
        At = DateTimeOffset.Parse(r.GetString(1)),
        HouseholdId = r.GetString(2),
        ChildId = r.GetString(3),
        Kind = Enum.Parse<LedgerKind>(r.GetString(4)),
        Delta = r.GetInt32(5),
        Source = r.GetString(6),
        Detail = r.GetString(7),
        ActorAccount = r.IsDBNull(8) ? null : r.GetString(8),
        PrevHash = r.GetString(9),
        Hash = r.GetString(10)
    };

    private void Exec(string sql)
    {
        using var cmd = _db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    public void Dispose() => _db.Dispose();
}
