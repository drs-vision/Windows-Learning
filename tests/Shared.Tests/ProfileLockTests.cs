using CoinQuest.Shared.Locks;
using CoinQuest.Shared.Models;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class ProfileLockTests
{
    private static readonly TimeSpan Off = TimeSpan.FromHours(-5);
    // Wednesday, Nov 4 2026
    private static DateTimeOffset At(int day, int h, int m = 0) => new(2026, 11, day, h, m, 0, Off);
    private static readonly ProfileLock Weekdays4to5 = new() { Schedule = new() { new LockTime { Days = new() { 1, 2, 3, 4, 5 }, From = "16:00", To = "17:00" } } };

    [Fact]
    public void Scheduled_lock_covers_its_window_only()
    {
        Assert.False(ProfileLockRules.Now(Weekdays4to5, At(4, 15, 59)).Locked);
        var s = ProfileLockRules.Now(Weekdays4to5, At(4, 16, 30));
        Assert.True(s.Locked); Assert.True(s.Scheduled); Assert.Equal(At(4, 17), s.Until);
        Assert.False(ProfileLockRules.Now(Weekdays4to5, At(4, 17)).Locked);
        Assert.False(ProfileLockRules.Now(Weekdays4to5, At(7, 16, 30)).Locked); // Saturday
    }

    [Fact]
    public void Overnight_lock_belongs_to_the_evening_it_starts()
    {
        var bed = new ProfileLock { Schedule = new() { new LockTime { Days = new() { 0, 1, 2, 3, 4 }, From = "21:00", To = "07:00" } } };
        Assert.True(ProfileLockRules.Now(bed, At(4, 23)).Locked);
        Assert.Equal(At(5, 7), ProfileLockRules.Now(bed, At(5, 6)).Until);     // Wednesday night → Thursday 7:00
        Assert.False(ProfileLockRules.Now(bed, At(6, 22)).Locked);              // Friday evening isn't on the list
        Assert.True(ProfileLockRules.Now(bed, At(6, 6)).Locked);                // but Thursday night runs into Friday morning
    }

    [Fact]
    public void Lock_now_and_open_now()
    {
        var l = ProfileLockRules.LockFor(new ProfileLock(), At(4, 10), 60);
        Assert.Equal(At(4, 11), ProfileLockRules.Now(l, At(4, 10, 30)).Until);
        Assert.False(ProfileLockRules.Now(l, At(4, 11, 1)).Locked);
        var forever = ProfileLockRules.LockFor(new ProfileLock(), At(4, 10), null);
        var st = ProfileLockRules.Now(forever, At(9, 10));
        Assert.True(st.Locked); Assert.Null(st.Until);
        Assert.False(ProfileLockRules.Now(ProfileLockRules.Open(forever, At(9, 10)), At(9, 10, 1)).Locked);
    }

    [Fact]
    public void Opening_a_scheduled_lock_skips_the_rest_of_it_but_not_the_next_one()
    {
        var opened = ProfileLockRules.Open(Weekdays4to5, At(4, 16, 20));
        Assert.False(ProfileLockRules.Now(opened, At(4, 16, 40)).Locked);
        Assert.True(ProfileLockRules.Now(opened, At(5, 16, 10)).Locked);
        // Locking again cancels the open.
        Assert.True(ProfileLockRules.Now(ProfileLockRules.LockFor(opened, At(4, 16, 30), 15), At(4, 16, 35)).Locked);
    }

    [Fact]
    public void Back_to_back_windows_join_and_bad_times_are_ignored()
    {
        var l = new ProfileLock { Schedule = new() {
            new LockTime { Days = new() { 3 }, From = "16:00", To = "17:00" },
            new LockTime { Days = new() { 3 }, From = "17:00", To = "18:30" },
            new LockTime { Days = new() { 3 }, From = "nope", To = "9" } } };
        Assert.Equal(At(4, 18, 30), ProfileLockRules.Now(l, At(4, 16, 5)).Until);
        Assert.False(ProfileLockRules.Now(new ProfileLock { Schedule = new() { new LockTime { From = "12:00", To = "12:00" } } }, At(4, 12)).Locked);
    }
}
