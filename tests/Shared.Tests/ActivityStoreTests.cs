using CoinQuest.Shared.Activity;
using CoinQuest.Shared.Ledgers;
using CoinQuest.Shared.Models;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class ActivityStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "cq-act-" + Guid.NewGuid().ToString("N"));
    private readonly string _db = Path.Combine(Path.GetTempPath(), "cq-act-" + Guid.NewGuid().ToString("N") + ".db");

    [Fact]
    public void Adds_up_a_day_and_builds_its_report()
    {
        var store = new ActivityStore(_dir);
        var ledger = new Ledger(_db);
        var kid = new Child { Id = "k1", DisplayName = "Sam" };
        var now = DateTime.Now;
        Assert.True(store.AddTime("k1", now, "youtube", "UC1", "Mark Rober", 60));   // first of the day
        Assert.False(store.AddTime("k1", now, "youtube", "uc1", "Mark Rober", 60));
        store.AddTime("k1", now, "site", "khanacademy.org", "khanacademy.org", 60);
        store.AddTyping("k1", now, 1000, 120000); // 200 words in 2 minutes = 100 WPM
        store.Count("k1", now, "khan-academy:correct", 7);
        ledger.Append("k1", LedgerKind.Earn, 12, "khan-academy", "Khan Academy: 7 correct answers");
        ledger.Append("k1", LedgerKind.Spend, -48, "p-yt", "20 minutes of YouTube");

        var r = store.Report(kid, ledger, now.Date);
        Assert.Equal(now.ToString("yyyy-MM-dd"), r["day"]!.GetValue<string>());
        var time = r["time"]!.AsArray();
        Assert.Equal("Mark Rober", time[0]!["label"]!.GetValue<string>());
        Assert.Equal(120, time[0]!["sec"]!.GetValue<int>());
        Assert.Equal(100, r["typing"]!["best"]!.GetValue<int>());
        Assert.Equal(7, r["done"]!["khan-academy:correct"]!.GetValue<int>());
        Assert.Equal(12, r["earned"]!["khan-academy"]!.GetValue<int>());
        Assert.Equal(48, r["spent"]!["20 minutes of YouTube"]!.GetValue<int>());
        Assert.Contains(now.Date, store.Days("k1"));
        ledger.Dispose();
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { }
        try { File.Delete(_db); } catch { }
    }
}
