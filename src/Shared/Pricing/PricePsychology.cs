using CoinQuest.Shared.Models;

namespace CoinQuest.Shared.Pricing;

/// <summary>
/// How a parent's price changes reach the kid, the way shops do it:
/// <list type="bullet">
/// <item>A price that goes <b>up</b> creeps up instead of jumping: about 10% a day (at least 1 coin), starting the day
/// it's changed, until it reaches the parent's price. Small steps sit under what people notice; nothing announces them.</item>
/// <item>A price that goes <b>down</b> drops at once and is shown as a deal for a few days: the old price crossed out.</item>
/// </list>
/// The parent always sets the real price; this only decides how fast a rise arrives and how a drop is shown.
/// </summary>
public static class PricePsychology
{
    public const double DailyRise = 0.10;
    public static readonly TimeSpan ShowDropFor = TimeSpan.FromDays(3);

    /// <summary>What the kid pays today for something whose parent price is <paramref name="target"/>.</summary>
    public static int Effective(PriceMemory m, string key, int target, DateTimeOffset now)
    {
        if (!m.Rising.TryGetValue(key, out var r) || target <= r.From) return target;
        var days = Math.Max(0, (now.LocalDateTime.Date - r.Since.LocalDateTime.Date).Days);
        var p = r.From;
        for (var d = 0; d <= days && p < target; d++) p = Math.Min(target, p + Math.Max(1, (int)Math.Round(p * DailyRise)));
        return p;
    }

    /// <summary>The crossed-out "was" price while a recent drop is being shown, else null.</summary>
    public static int? Was(PriceMemory m, string key, int current, DateTimeOffset now) =>
        m.Dropped.TryGetValue(key, out var d) && now - d.At < ShowDropFor && d.Was > current ? d.Was : null;

    /// <summary>
    /// After a parent saves: <paramref name="before"/> is each item's (parent price, price the kid saw), <paramref name="after"/>
    /// the new parent prices. A higher price starts creeping up from what the kid was paying; a lower one drops now and is shown
    /// as a deal (keeping the highest "was" if it drops again). Unchanged prices keep whatever was in progress.
    /// </summary>
    public static PriceMemory Remember(PriceMemory m, IReadOnlyDictionary<string, (int Target, int Shown)> before, IReadOnlyDictionary<string, int> after, DateTimeOffset now)
    {
        var rising = new Dictionary<string, PriceRise>(m.Rising);
        var dropped = new Dictionary<string, PriceDrop>(m.Dropped);
        foreach (var (key, target) in after)
        {
            if (!before.TryGetValue(key, out var b) || b.Target == target) continue; // new item, or not changed
            if (target > b.Shown) { rising[key] = new PriceRise { From = b.Shown, Since = now }; dropped.Remove(key); }
            else
            {
                rising.Remove(key);
                if (target < b.Shown)
                {
                    var was = dropped.TryGetValue(key, out var d) && now - d.At < ShowDropFor ? Math.Max(d.Was, b.Shown) : b.Shown;
                    dropped[key] = new PriceDrop { Was = was, At = now };
                }
            }
        }
        // Tidy: rises that have arrived, drops no longer shown, items that are gone.
        foreach (var k in rising.Keys.ToList())
            if (!after.TryGetValue(k, out var t) || Effective(new PriceMemory { Rising = rising }, k, t, now) >= t) rising.Remove(k);
        foreach (var k in dropped.Keys.ToList())
            if (!after.ContainsKey(k) || now - dropped[k].At >= ShowDropFor) dropped.Remove(k);
        return new PriceMemory { Rising = rising, Dropped = dropped };
    }
}
