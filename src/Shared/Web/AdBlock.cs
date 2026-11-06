using System.Text;

namespace CoinQuest.Shared.Web;

/// <summary>
/// Ad and tracker blocking for CoinQuest's site window, done quietly: an ad request never leaves the PC, and the page
/// gets a normal-looking "success" reply instead of an error (an empty script, a 1x1 picture, an empty frame), with
/// stand-in versions of the common ad and analytics scripts (Google Publisher Tag, AdSense, Google Analytics, Tag
/// Manager) that report themselves as loaded. Ad-blocker detectors mostly look for failed requests or missing ad
/// scripts, so they find nothing. The host list (content/adblock/hosts.txt) comes from permissively licensed lists;
/// see its README.
/// </summary>
public sealed class AdBlock
{
    private readonly HashSet<string> _hosts;
    public int Count => _hosts.Count;

    /// <summary>Never blocked: cookie-consent services (some sites wait for them before showing anything).</summary>
    private static readonly string[] Keep = { "cookielaw.org", "onetrust.com", "cookiebot.com", "usercentrics.eu", "consensu.org", "trustarc.com", "didomi.io" };
    /// <summary>Needed by embedded YouTube players (e.g. Khan Academy videos) to start; kept only for the player's own requests.</summary>
    private static readonly string[] YouTubeNeeds = { "static.doubleclick.net", "googleads.g.doubleclick.net" };

    public AdBlock(IEnumerable<string> hosts) => _hosts = new HashSet<string>(hosts.Select(h => h.Trim().ToLowerInvariant().TrimEnd('.')).Where(h => h.Length > 0 && !h.StartsWith('#')), StringComparer.OrdinalIgnoreCase);

    public static AdBlock Load(string path)
    {
        try { return new AdBlock(File.ReadLines(path)); }
        catch { return new AdBlock(Array.Empty<string>()); }
    }

    private static bool Under(string host, string domain) => host == domain || host.EndsWith("." + domain, StringComparison.Ordinal);

    /// <summary>Is this request for an ad or tracker? <paramref name="referer"/>: the requesting page's address, if known.</summary>
    public bool IsAd(string host, string? referer = null)
    {
        host = host.Trim().TrimEnd('.').ToLowerInvariant();
        if (Keep.Any(k => Under(host, k))) return false;
        if (YouTubeNeeds.Contains(host) && Uri.TryCreate(referer ?? "", UriKind.Absolute, out var r)
            && (Under(r.Host.ToLowerInvariant(), "youtube.com") || Under(r.Host.ToLowerInvariant(), "youtube-nocookie.com"))) return false;
        // The host or any parent domain on the list (but never a bare top-level domain).
        for (var h = host; h.Contains('.'); h = h[(h.IndexOf('.') + 1)..])
            if (_hosts.Contains(h)) return true;
        return false;
    }

    private static readonly HashSet<string> AdSegments = new(StringComparer.OrdinalIgnoreCase)
        { "ads", "adserver", "adservers", "advert", "adverts", "advertising", "adframe", "pagead", "gampad", "prebid", "adunit", "adunits" };
    private static readonly string[] AdFiles = { "adsbygoogle.js", "prebid.js", "ads.js", "advert.js", "adframe.js", "gpt.js" };

    /// <summary>
    /// Ad addresses on servers no list knows yet: a request to another company's server (not the page's own site)
    /// whose path has an ad folder ("/ads/", "/pagead/", "/gampad/", "/prebid/"...) or an ad script ("adsbygoogle.js",
    /// "prebid.js"...). A site's own files are never matched, so its own "/ads/" pages and images are left alone.
    /// </summary>
    public static bool IsAdUrl(Uri u, string? pageHost)
    {
        if (pageHost is null || SameSite(u.Host, pageHost)) return false;
        var segments = u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) return false;
        if (segments.Take(segments.Length - 1).Any(AdSegments.Contains)) return true;
        return AdFiles.Contains(segments[^1], StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Same site, roughly: the last two labels match ("cdn.example.com" and "www.example.com").</summary>
    private static bool SameSite(string a, string b)
    {
        static string Root(string h) { var p = h.ToLowerInvariant().TrimEnd('.').Split('.'); return p.Length <= 2 ? string.Join('.', p) : string.Join('.', p[^2..]); }
        return Root(a) == Root(b);
    }

    public sealed record Reply(int Status, string Reason, string ContentType, byte[] Body);

    /// <summary>The quiet reply for a blocked request. kind: script, image, document, style, xhr (XHR/fetch/beacon), other.</summary>
    public static Reply ReplyFor(string kind, string url)
    {
        Reply Ok(string type, string body) => new(200, "OK", type, Encoding.UTF8.GetBytes(body));
        switch (kind)
        {
            case "script": return Ok("application/javascript", Surrogate(url));
            case "image": return new(200, "OK", "image/gif", Gif1x1);
            case "document": return Ok("text/html; charset=utf-8", "<!doctype html><html><head></head><body></body></html>");
            case "style": return Ok("text/css", "");
            case "xhr": return Ok("text/plain", "");
            default: return new(204, "No Content", "text/plain", Array.Empty<byte>());
        }
    }

    private static readonly byte[] Gif1x1 = Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");

    /// <summary>A stand-in for well-known ad/analytics scripts (so pages that call them keep working), else empty.</summary>
    public static string Surrogate(string url)
    {
        var u = url.ToLowerInvariant();
        if (u.Contains("/gpt.js") || u.Contains("/pubads_impl") || u.Contains("googletagservices.com/tag/js")) return Gpt;
        if (u.Contains("adsbygoogle.js")) return AdSense;
        if (u.Contains("google-analytics.com/analytics.js") || u.Contains("google-analytics.com/ga.js")) return Analytics;
        if (u.Contains("googletagmanager.com/gtag/js") || u.Contains("googletagmanager.com/gtm.js")) return TagManager;
        return "";
    }

    private const string Gpt = """
(function(){var w=window,n=function(){},me=function(){return this};
var slot={addService:me,clearCategoryExclusions:me,clearTargeting:me,defineSizeMapping:me,get:function(){return null},getAdUnitPath:function(){return''},getAttributeKeys:function(){return[]},getCategoryExclusions:function(){return[]},getDomId:function(){return''},getSlotElementId:function(){return''},getSlotId:function(){return{getId:function(){return''}}},getTargeting:function(){return[]},getTargetingKeys:function(){return[]},set:me,setCategoryExclusion:me,setClickUrl:me,setCollapseEmptyDiv:me,setTargeting:me,updateTargetingFromMap:me,setConfig:me};
var pub={addEventListener:me,removeEventListener:me,clear:n,clearCategoryExclusions:me,clearTagForChildDirectedTreatment:me,clearTargeting:me,collapseEmptyDivs:me,defineOutOfPagePassback:function(){return slot},definePassback:function(){return slot},disableInitialLoad:n,display:n,enableAsyncRendering:n,enableLazyLoad:n,enableSingleRequest:n,enableSyncRendering:n,enableVideoAds:n,get:function(){return null},getAttributeKeys:function(){return[]},getTargeting:function(){return[]},getTargetingKeys:function(){return[]},getSlots:function(){return[]},isInitialLoadDisabled:function(){return true},refresh:n,set:me,setCategoryExclusion:me,setCentering:n,setCookieOptions:me,setForceSafeFrame:me,setLocation:me,setPrivacySettings:me,setPublisherProvidedId:me,setRequestNonPersonalizedAds:me,setSafeFrameConfig:me,setTagForChildDirectedTreatment:me,setTargeting:me,setVideoContent:me,updateCorrelator:n,setConfig:me};
var g=w.googletag=w.googletag||{},q=Array.isArray(g.cmd)?g.cmd.slice():[];
g.apiReady=true;g.pubadsReady=true;g.defineSlot=function(){return slot};g.defineOutOfPageSlot=function(){return slot};g.destroySlots=function(){return true};g.display=n;g.enableServices=n;g.getVersion=function(){return''};g.pubads=function(){return pub};
g.companionAds=function(){return{addEventListener:me,enableSyncLoading:n,setRefreshUnfilledSlots:n}};g.content=function(){return{addEventListener:me,setContent:n}};g.sizeMapping=function(){var m={addSize:function(){return m},build:function(){return[]}};return m};g.setAdIframeTitle=n;g.openConsole=n;g.disablePublisherConsole=n;g.setConfig=n;
g.cmd={push:function(f){try{f()}catch(e){}return 1}};for(var i=0;i<q.length;i++){try{q[i]()}catch(e){}}})();
""";

    private const string AdSense = """
(function(){var w=window;var q=Array.isArray(w.adsbygoogle)?w.adsbygoogle:[];w.adsbygoogle={loaded:true,push:function(){}};for(var i=0;i<q.length;i++){try{w.adsbygoogle.push(q[i])}catch(e){}}})();
""";

    private const string Analytics = """
(function(){var n=function(){},name=window.GoogleAnalyticsObject||'ga',old=window[name],q=old&&old.q||[];
var tracker={get:n,set:n,send:n};
var ga=function(){var a=arguments,l=a[a.length-1];if(l&&typeof l==='object'&&typeof l.hitCallback==='function'){try{setTimeout(l.hitCallback,1)}catch(e){}}if(typeof a[0]==='function'){try{a[0](tracker)}catch(e){}}};
ga.create=function(){return tracker};ga.getByName=function(){return tracker};ga.getAll=function(){return[tracker]};ga.remove=n;ga.loaded=true;window[name]=ga;
for(var i=0;i<q.length;i++){try{ga.apply(null,q[i])}catch(e){}}})();
""";

    private const string TagManager = """
(function(){var d=window.dataLayer=window.dataLayer||[];var cb=function(o){if(o&&typeof o.eventCallback==='function'){try{setTimeout(o.eventCallback,1)}catch(e){}}};
for(var i=0;i<d.length;i++)cb(d[i]);d.push=function(){for(var i=0;i<arguments.length;i++)cb(arguments[i]);return Array.prototype.push.apply(this,arguments)};
window.google_tag_manager=window.google_tag_manager||{};})();
""";
}
