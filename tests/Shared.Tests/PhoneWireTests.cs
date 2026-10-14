using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Phone;
using Xunit;
using Xunit.Abstractions;

namespace CoinQuest.Shared.Tests;

public class PhoneWireTests(ITestOutputHelper output)
{
    [Fact]
    public void Round_trip_and_wrong_key()
    {
        var key = PhoneWire.NewKey();
        var big = new JsonArray(); for (int i = 0; i < 600; i++) big.Add($"entry {i} {Guid.NewGuid()}");
        var parts = PhoneWire.Split(PhoneWire.Seal(key, new JsonObject { ["op"] = "state", ["big"] = big }));
        Assert.True(parts.Count > 1);
        Assert.All(parts, p => Assert.True(Encoding.UTF8.GetByteCount(p) < 4096)); // the relay's message limit
        var asm = new PhoneWire.Assembler(); string? whole = null;
        foreach (var p in parts.AsEnumerable().Reverse()) whole = asm.Add(p) ?? whole; // order doesn't matter
        Assert.Equal(600, PhoneWire.Open(key, whole!)!["big"]!.AsArray().Count);
        Assert.Null(PhoneWire.Open(PhoneWire.NewKey(), whole!));
    }

    /// <summary>Sealed by the phone app's wire.js (WebCrypto + CompressionStream) — the two must agree.</summary>
    [Fact]
    public void Opens_what_the_phone_app_sealed()
    {
        var key = PhoneWire.FromB64Url("AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw");
        var msg = PhoneWire.Open(key, "BE71TbzYui1NZx-wllISqACe9sOMDgLndNGif1p2Y3tqKIBPDzce1XyGwGPRGLIyBcNUV4ioOY1JiVOnRuB89-l-Ez4s8iNPjt1BIHWd8eDuxhBShjgOKMSDoK0KE4zyRpVz0-WQD7O7SgaNXZjKN6iNYfyi");
        Assert.NotNull(msg);
        Assert.Equal("adjust", msg!["op"]!.GetValue<string>());
        Assert.Equal(-5, msg["a"]!["delta"]!.GetValue<int>());
        Assert.Equal("Café ☕", msg["a"]!["reason"]!.GetValue<string>());
    }

    /// <summary>
    /// The public relay behaves as PhoneLinkService expects: listening on several topics at once (as the PC does for
    /// all linked phones), a message posted to one of them arrives, unchanged. (The relay writes its history a moment
    /// after delivering live, so — like the PC — listen first, then post.) Skipped when the relay can't be reached.
    /// </summary>
    [Fact, Trait("Category", "Live")]
    public async Task Relay_publish_and_stream()
    {
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("CoinQuest-tests");
        var a = PhoneWire.NewTopic(); var b = PhoneWire.NewTopic();
        var key = PhoneWire.NewKey();
        var part = PhoneWire.Split(PhoneWire.Seal(key, new JsonObject { ["hi"] = "relay" }))[0];
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        HttpResponseMessage resp;
        try { resp = await http.GetAsync($"https://ntfy.sh/{a},{b}/json?since=1m", HttpCompletionOption.ResponseHeadersRead, cts.Token); resp.EnsureSuccessStatusCode(); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { output.WriteLine("relay unreachable, skipped: " + ex.Message); return; }
        using (resp)
        {
            using var reader = new StreamReader(await resp.Content.ReadAsStreamAsync(cts.Token));
            var first = JsonNode.Parse((await reader.ReadLineAsync(cts.Token))!)!;
            Assert.Equal("open", first["event"]!.GetValue<string>());
            using (var post = await http.PostAsync($"https://ntfy.sh/{b}", new StringContent(part, Encoding.UTF8, "text/plain"), cts.Token)) post.EnsureSuccessStatusCode();
            while (await reader.ReadLineAsync(cts.Token) is { } line)
            {
                var ev = JsonNode.Parse(line)!;
                if (ev["event"]?.GetValue<string>() != "message") continue;
                Assert.Equal(b, ev["topic"]!.GetValue<string>());
                Assert.False(string.IsNullOrEmpty(ev["id"]?.GetValue<string>()));
                var whole = new PhoneWire.Assembler().Add(ev["message"]!.GetValue<string>());
                Assert.Equal("relay", PhoneWire.Open(key, whole!)!["hi"]!.GetValue<string>());
                output.WriteLine("relay round trip OK");
                return;
            }
        }
        Assert.Fail("the relay never delivered the message");
    }
}
