using CoinQuest.Shared.Web;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class AdBlockTests
{
    private static readonly AdBlock Ads = new(new[] { "# comment", "doubleclick.net", "pagead2.googlesyndication.com", "www.google-analytics.com", "cdn.cookielaw.org" });

    [Fact]
    public void Blocks_listed_hosts_and_their_subdomains_only()
    {
        Assert.True(Ads.IsAd("doubleclick.net"));
        Assert.True(Ads.IsAd("securepubads.g.doubleclick.net"));
        Assert.True(Ads.IsAd("PAGEAD2.googlesyndication.com."));
        Assert.False(Ads.IsAd("googlesyndication.com"));       // only the listed host and below, not its parent
        Assert.False(Ads.IsAd("notdoubleclick.net"));
        Assert.False(Ads.IsAd("www.khanacademy.org"));
        Assert.False(Ads.IsAd("net"));
    }

    [Fact]
    public void Consent_services_and_youtube_player_needs_are_kept()
    {
        Assert.False(Ads.IsAd("cdn.cookielaw.org"));            // on the list, but sites can wait for consent
        Assert.True(Ads.IsAd("googleads.g.doubleclick.net", "https://www.example.com/page"));
        Assert.False(Ads.IsAd("googleads.g.doubleclick.net", "https://www.youtube-nocookie.com/embed/abc"));
        Assert.False(Ads.IsAd("static.doubleclick.net", "https://www.youtube.com/embed/abc"));
    }

    [Fact]
    public void Replies_look_like_success_and_ad_scripts_get_stand_ins()
    {
        Assert.Equal((200, "image/gif"), (AdBlock.ReplyFor("image", "https://x/y.gif").Status, AdBlock.ReplyFor("image", "https://x/y.gif").ContentType));
        Assert.Equal(200, AdBlock.ReplyFor("xhr", "https://x/collect").Status);
        Assert.Equal(204, AdBlock.ReplyFor("other", "https://x/font").Status);
        Assert.Contains("googletag", AdBlock.Surrogate("https://securepubads.g.doubleclick.net/tag/js/gpt.js"));
        Assert.Contains("loaded:true", AdBlock.Surrogate("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1"));
        Assert.Contains("GoogleAnalyticsObject", AdBlock.Surrogate("https://www.google-analytics.com/analytics.js"));
        Assert.Contains("dataLayer", AdBlock.Surrogate("https://www.googletagmanager.com/gtag/js?id=G-1"));
        Assert.Equal("", AdBlock.Surrogate("https://ads.example.com/x.js"));
    }

    [Fact]
    public void The_shipped_list_loads()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d is not null && !File.Exists(Path.Combine(d.FullName, "content", "adblock", "hosts.txt"))) d = d.Parent;
        Assert.NotNull(d);
        var a = AdBlock.Load(Path.Combine(d!.FullName, "content", "adblock", "hosts.txt"));
        Assert.True(a.Count > 10000);
        Assert.True(a.IsAd("pagead2.googlesyndication.com"));
        Assert.False(a.IsAd("www.khanacademy.org"));
        Assert.False(a.IsAd("www.duolingo.com"));
    }

    [Fact]
    public void Ad_addresses_on_other_servers_are_caught_but_a_sites_own_files_are_not()
    {
        var page = "www.coolmathgames.com";
        Assert.True(AdBlock.IsAdUrl(new Uri("https://cdn.newadco.io/prebid/9.1/prebid.js"), page));
        Assert.True(AdBlock.IsAdUrl(new Uri("https://x.newadco.io/ads/slot?id=3"), page));
        Assert.True(AdBlock.IsAdUrl(new Uri("https://static.newadco.io/js/adsbygoogle.js"), page));
        Assert.False(AdBlock.IsAdUrl(new Uri("https://www.coolmathgames.com/ads/policy"), page));       // the site's own
        Assert.False(AdBlock.IsAdUrl(new Uri("https://cdn.coolmathgames.com/ads/banner.png"), page));   // its own CDN
        Assert.False(AdBlock.IsAdUrl(new Uri("https://cdn.jsdelivr.net/npm/headroom.js/dist/headroom.js"), page));
        Assert.False(AdBlock.IsAdUrl(new Uri("https://uploads.example.org/img/ads.png"), page));        // a file named ads, not a script
        Assert.False(AdBlock.IsAdUrl(new Uri("https://x.newadco.io/ads/slot"), null));
    }
}
