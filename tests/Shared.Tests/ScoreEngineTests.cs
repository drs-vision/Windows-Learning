using System.Text.Json.Nodes;
using CoinQuest.Shared.Scoring;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class ScoreEngineTests
{
    private static string? BundlePath()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "scorers.js");
        return File.Exists(local) ? local : null;
    }

    [Fact]
    public void Runs_the_shipped_scorers_bundle()
    {
        var path = BundlePath();
        if (path is null) return; // web not built in this environment; CI builds it first
        var engine = new ScoreEngine(path);
        var activity = JsonNode.Parse("""{"moduleId":"khan-academy","kind":"claim","data":{},"issuedAt":0}""");
        var result = JsonNode.Parse("""{"startedAt":0,"finishedAt":1000,"data":{"topic":"Fractions","kind":"quiz"}}""");
        var settings = JsonNode.Parse("""{"enabled":true,"coinsPerActivity":35,"dailyCap":140,"requireApproval":true}""");
        var out_ = engine.Score("khan-academy", activity, result, settings);
        Assert.True(out_.Valid);
        Assert.Equal(53, out_.Coins);
        Assert.True(out_.NeedsApproval);
        Assert.Contains("Fractions", out_.Detail);
    }

    [Fact]
    public void Unknown_module_is_invalid()
    {
        var engine = ScoreEngine.FromSource("globalThis.CoinQuestScorers={score:function(m){return {valid:false,reason:'unknown '+m,coins:0,needsApproval:false,detail:''}}};");
        var o = engine.Score("nope", null, null, null);
        Assert.False(o.Valid);
        Assert.Equal(0, o.Coins);
    }

    [Fact]
    public void Runaway_script_is_cut_off()
    {
        var engine = ScoreEngine.FromSource("globalThis.CoinQuestScorers={score:function(){while(true){}}};");
        Assert.ThrowsAny<Exception>(() => engine.Score("x", null, null, null));
    }
}
