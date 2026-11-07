using CoinQuest.Shared.Models;
using CoinQuest.Shared.Pricing;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class PricePsychologyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 7, 15, 0, 0, TimeSpan.Zero);
    private static Dictionary<string, (int, int)> Was(int target, int shown) => new() { ["prize:yt"] = (target, shown) };
    private static Dictionary<string, int> Now(int target) => new() { ["prize:yt"] = target };

    [Fact]
    public void A_rise_creeps_up_about_ten_percent_a_day()
    {
        var m = PricePsychology.Remember(new PriceMemory(), Was(48, 48), Now(60), T0);
        Assert.Equal(53, PricePsychology.Effective(m, "prize:yt", 60, T0));               // today: +5
        Assert.Equal(58, PricePsychology.Effective(m, "prize:yt", 60, T0.AddDays(1)));
        Assert.Equal(60, PricePsychology.Effective(m, "prize:yt", 60, T0.AddDays(2)));
        Assert.Null(PricePsychology.Was(m, "prize:yt", 53, T0));                          // never announced
        // A one-coin bump arrives at once.
        var one = PricePsychology.Remember(new PriceMemory(), Was(4, 4), Now(5), T0);
        Assert.Equal(5, PricePsychology.Effective(one, "prize:yt", 5, T0));
    }

    [Fact]
    public void A_drop_is_immediate_and_shown_as_a_deal_for_a_few_days()
    {
        var m = PricePsychology.Remember(new PriceMemory(), Was(60, 60), Now(48), T0);
        Assert.Equal(48, PricePsychology.Effective(m, "prize:yt", 48, T0));
        Assert.Equal(60, PricePsychology.Was(m, "prize:yt", 48, T0.AddDays(2)));
        Assert.Null(PricePsychology.Was(m, "prize:yt", 48, T0.AddDays(4)));
        // Dropping again keeps the highest "was".
        var again = PricePsychology.Remember(m, Was(48, 48), Now(40), T0.AddDays(1));
        Assert.Equal(60, PricePsychology.Was(again, "prize:yt", 40, T0.AddDays(1)));
    }

    [Fact]
    public void A_drop_during_a_rise_starts_from_what_the_kid_was_paying_and_unrelated_saves_change_nothing()
    {
        var m = PricePsychology.Remember(new PriceMemory(), Was(48, 48), Now(60), T0);
        var same = PricePsychology.Remember(m, Was(60, 53), Now(60), T0.AddHours(1));       // saved something else
        Assert.Equal(58, PricePsychology.Effective(same, "prize:yt", 60, T0.AddDays(1)));
        var down = PricePsychology.Remember(m, Was(60, 53), Now(50), T0.AddHours(2));
        Assert.Equal(50, PricePsychology.Effective(down, "prize:yt", 50, T0.AddHours(2)));
        Assert.Equal(53, PricePsychology.Was(down, "prize:yt", 50, T0.AddHours(2)));
        Assert.Empty(PricePsychology.Remember(m, Was(60, 53), new Dictionary<string, int>(), T0).Rising); // item removed
    }
}
