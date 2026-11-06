using System.Globalization;
using CoinQuest.Shared.Models;

namespace CoinQuest.Shared.Locks;

/// <summary>Is a kid's profile locked right now, and until when? Pure, so it is tested without a PC.</summary>
public static class ProfileLockRules
{
    public sealed record State(bool Locked, DateTimeOffset? Until, bool Scheduled);

    public static State Now(ProfileLock? l, DateTimeOffset now)
    {
        if (l is null) return new(false, null, false);
        var opened = l.OpenUntil is { } o && o > now;
        if (l.Until is { } u && u > now && !opened) return new(true, u == DateTimeOffset.MaxValue ? null : u, false);
        if (opened) return new(false, null, false);
        if (Window(l.Schedule, now) is { } end) return new(true, end, true);
        return new(false, null, false);
    }

    /// <summary>If a scheduled lock covers <paramref name="now"/>, when it ends (back-to-back windows are joined).</summary>
    public static DateTimeOffset? Window(IEnumerable<LockTime> schedule, DateTimeOffset now)
    {
        var list = schedule.ToList();
        DateTimeOffset? end = null;
        var at = now;
        for (var guard = 0; guard < 16; guard++)
        {
            DateTimeOffset? next = null;
            foreach (var t in list)
                foreach (var (s, e) in Occurrences(t, at))
                    if (s <= at && at < e && (next is null || e > next)) next = e;
            if (next is null) break;
            end = next; at = next.Value;
        }
        return end;
    }

    /// <summary>The occurrences of a lock time that could cover <paramref name="at"/>: starting yesterday or today.</summary>
    private static IEnumerable<(DateTimeOffset Start, DateTimeOffset End)> Occurrences(LockTime t, DateTimeOffset at)
    {
        if (!TryTime(t.From, out var from) || !TryTime(t.To, out var to) || from == to) yield break;
        foreach (var dayBack in new[] { 1, 0 })
        {
            var day = at.Date.AddDays(-dayBack);
            if (!t.Days.Contains((int)day.DayOfWeek)) continue;
            var start = new DateTimeOffset(day + from, at.Offset);
            var end = new DateTimeOffset(day + to + (to <= from ? TimeSpan.FromDays(1) : TimeSpan.Zero), at.Offset);
            yield return (start, end);
        }
    }

    public static bool TryTime(string? s, out TimeSpan t) =>
        TimeSpan.TryParseExact(s ?? "", new[] { @"h\:mm", @"hh\:mm" }, CultureInfo.InvariantCulture, out t) && t < TimeSpan.FromDays(1);

    /// <summary>A parent opens it now (or approves the kid's ask): until the current lock would have ended.</summary>
    public static ProfileLock Open(ProfileLock l, DateTimeOffset now)
    {
        var st = Now(l, now);
        // A manual lock is simply lifted; inside a scheduled lock, skip the rest of it.
        var openUntil = Window(l.Schedule, now);
        return l with { Until = null, OpenUntil = openUntil ?? (st.Locked && st.Until is { } u ? u : l.OpenUntil) };
    }

    /// <summary>"Lock now" for some minutes (null = until a parent opens it). Cancels an earlier "open".</summary>
    public static ProfileLock LockFor(ProfileLock l, DateTimeOffset now, int? minutes) =>
        l with { Until = minutes is > 0 ? now.AddMinutes(minutes.Value) : DateTimeOffset.MaxValue, OpenUntil = null };
}
