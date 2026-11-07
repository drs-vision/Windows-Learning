using CoinQuest.Shared.Models;

namespace CoinQuest.Shared.Pricing;

/// <summary>
/// How a parent's price changes reach the kid, the way shops do it:
/// <list type="bullet">
/// <item>A price that goes <b>up</b> creeps up instead of jumping, in equal-percentage steps over about 3 days (first step
/// the day it's changed). People notice a price change at roughly 8-10% (the "just-noticeable difference"), so a bigger
/// rise takes more days, keeping each step at most 10%, up to a week. A rise of 1 coin, or 8% or less, applies at once.</item>
/// <item>While a rise is on its way, the coming price is shown crossed out and today's price as a limited-time deal.</item>
/// <item>A price that goes <b>down</b> drops at once and is shown as a deal for a few days: the old price crossed out.</item>
/// </list>
/// The parent always sets the real price; this only decides how fast a rise arrives and how a drop is shown.
/// </summary>
public static class PricePsychology
{
    /// <summary>Most a price goes up in one day while easing in.</summary>
    public const double MaxStep = 0.10;
    /// <summary>A rise this small (or 1 coin) isn't eased in: it's under what anyone notices.</summary>
    public const double Unnoticed = 0.08;
    public const int TypicalDays = 3, MaxDays = 7;

    /// <summary>How many days a rise from <paramref name="from"/> to <paramref name="to"/> takes (1 = at once).</summary>
    public static int Days(int from, int to)
    {
        if (to <= from || to - from <= 1 || from <= 0 || to <= from * (1 + Unnoticed)) return 1;
        var needed = (int)Math.Ceiling(Math.Log(to / (double)from) / Math.Log(1 + MaxStep));
        return Math.Clamp(Math.Max(TypicalDays, needed), 1, MaxDays);
    }
    public static readonly TimeSpan ShowDropFor = TimeSpan.FromDays(3);

    /// <summary>What the kid pays today for something whose parent price is <paramref name="target"/>.</summary>
    public static int Effective(PriceMemory m, string key, int target, DateTimeOffset now)
    {
        if (!m.Rising.TryGetValue(key, out var r) || target <= r.From) return target;
        var n = Days(r.From, target);
        var step = Math.Min(n, Math.Max(0, (now.LocalDateTime.Date - r.Since.LocalDateTime.Date).Days) + 1); // day 0 = step 1
        if (step >= n) return target;
        // Equal percentage steps (48 → 60: 52, 56, 60), each at least a coin more than the one before.
        var p = (int)Math.Round(r.From * Math.Pow(target / (double)r.From, step / (double)n));
        return Math.Min(target, Math.Max(p, r.From + step));
    }

    /// <summary>
    /// The crossed-out price the kid sees next to today's price, and why: "drop" (recently cheaper: the old price) or
    /// "limited" (a rise is on its way: the price it's going to be, so today's is a limited-time deal). Null: plain price.
    /// </summary>
    public static (int Was, string Deal)? Tag(PriceMemory m, string key, int target, DateTimeOffset now)
    {
        var shown = Effective(m, key, target, now);
        if (shown < target) return (target, "limited");
        return Was(m, key, shown, now) is { } w ? (w, "drop") : null;
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
