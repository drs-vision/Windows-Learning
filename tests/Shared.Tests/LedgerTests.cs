using CoinQuest.Shared.Ledgers;
using CoinQuest.Shared.Models;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class LedgerTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "cq-test-" + Guid.NewGuid().ToString("N") + ".db");
    private readonly Ledger _ledger;
    public LedgerTests() => _ledger = new Ledger(_path);

    [Fact]
    public void Balance_sums_deltas()
    {
        _ledger.Append("c1", LedgerKind.Earn, 10, "typing-quest", "drill");
        _ledger.Append("c1", LedgerKind.Earn, 15, "bible-typing", "Psalm 23");
        _ledger.Append("c1", LedgerKind.Spend, -20, "p-yt", "YouTube");
        _ledger.Append("c2", LedgerKind.Earn, 99, "typing-quest", "other child");
        Assert.Equal(5, _ledger.Balance("c1"));
        Assert.Equal(99, _ledger.Balance("c2"));
    }

    [Fact]
    public void Hash_chain_is_intact_and_detects_tampering()
    {
        _ledger.Append("c1", LedgerKind.Earn, 10, "m", "a");
        _ledger.Append("c1", LedgerKind.Earn, 10, "m", "b");
        Assert.Null(_ledger.Verify());

        using (var db = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={_path}"))
        {
            db.Open();
            using var cmd = db.CreateCommand();
            cmd.CommandText = "UPDATE ledger SET delta = 1000 WHERE seq = 1";
            cmd.ExecuteNonQuery();
        }
        Assert.Equal(1, _ledger.Verify());
    }

    [Fact]
    public void Claims_credit_only_on_approval()
    {
        var claim = _ledger.FileClaim("c1", "khan-academy", 35, "Lesson: Fractions", "sam");
        Assert.Equal(0, _ledger.Balance("c1"));
        Assert.Single(_ledger.PendingClaims("c1"));

        var entry = _ledger.ResolveClaim(claim.LedgerSeq, approve: true, actor: "dad", overrideCoins: 30);
        Assert.NotNull(entry);
        Assert.Equal(30, _ledger.Balance("c1"));
        Assert.Empty(_ledger.PendingClaims("c1"));
        Assert.Null(_ledger.ResolveClaim(claim.LedgerSeq, true, "dad")); // already resolved
    }

    [Fact]
    public void Daily_cap_queries_count_only_today()
    {
        _ledger.Append("c1", LedgerKind.Earn, 10, "typing-quest", "x");
        _ledger.Append("c1", LedgerKind.Spend, -5, "p1", "prize");
        Assert.Equal(10, _ledger.EarnedToday("c1", "typing-quest"));
        Assert.Equal(1, _ledger.PurchasesToday("c1", "p1"));
        Assert.Equal(0, _ledger.EarnedToday("c1", "typing-quest", DateTimeOffset.Now.AddDays(1)));
    }

    public void Dispose() { _ledger.Dispose(); try { File.Delete(_path); } catch { } }
}
