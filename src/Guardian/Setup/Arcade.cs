using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;

namespace CoinQuest.Guardian.Setup;

/// <summary>
/// The arcade catalog: bundled open-licensed games (content/games/MANIFEST.json), games a parent uploaded
/// (.swf in C:\ProgramData\CoinQuest\arcade), and games a parent linked from the maker's own website.
/// Every game has a per-play price: strategy-heavy games are cheaper, reflex games cost more, parents override.
/// </summary>
public static class Arcade
{
    public sealed record Game(string Id, string Title, string Author, string Kind, string License, string Url, string Genre,
        int Strategy, int Price, bool Hidden, bool Available, string Source)
    {
        public string Thumbnail { get; init; } = "";
        public int Plays { get; init; }
    }

    public static List<Game> Catalog(Child child)
    {
        var games = new List<Game>();
        var s = child.Arcade;
        int Price(string id, int strategy) => s.PriceOverrides.TryGetValue(id, out var p) ? p : ArcadeSettings.DefaultPrice(strategy);

        var manifest = Path.Combine(Paths.ContentRoot, "games", "MANIFEST.json");
        if (File.Exists(manifest))
        {
            try
            {
                if (JsonNode.Parse(File.ReadAllText(manifest))?["games"] is JsonArray arr)
                    foreach (var g in arr)
                    {
                        if (g is null) continue;
                        var id = g["id"]?.GetValue<string>() ?? "";
                        var path = g["path"]?.GetValue<string>() ?? "";
                        var strategy = g["strategy"]?.GetValue<int>() ?? 2;
                        var exists = File.Exists(Path.Combine(Paths.ContentRoot, "games", path.Replace('/', Path.DirectorySeparatorChar)));
                        var hiddenByDefault = g["enabled"]?.GetValue<bool>() == false && !s.PriceOverrides.ContainsKey(id);
                        games.Add(new Game(id, g["title"]?.GetValue<string>() ?? id, g["author"]?.GetValue<string>() ?? "",
                            g["kind"]?.GetValue<string>() ?? "swf", g["license"]?.GetValue<string>() ?? "",
                            $"https://coinquest.local/content/games/{path}", g["genre"]?.GetValue<string>() ?? "",
                            strategy, Price(id, strategy), s.Hidden.Contains(id) || hiddenByDefault, exists, "bundled"));
                    }
            }
            catch { }
        }

        if (Directory.Exists(Paths.ArcadeDropFolder))
            foreach (var f in Directory.EnumerateFiles(Paths.ArcadeDropFolder, "*.swf"))
            {
                var id = "my-" + Slug(Path.GetFileNameWithoutExtension(f));
                var meta = ReadMeta(f);
                var strategy = meta?.Strategy ?? 3;
                games.Add(new Game(id, meta?.Title ?? Path.GetFileNameWithoutExtension(f), "", "swf", "your copy",
                    $"https://coinquest-arcade.local/{Uri.EscapeDataString(Path.GetFileName(f))}", "", strategy,
                    Price(id, strategy), s.Hidden.Contains(id), true, "uploaded"));
            }

        foreach (var f in s.Flashpoint)
        {
            var thumb = File.Exists(Path.Combine(Paths.DataRoot, "thumbs", f.Id + ".png")) ? $"https://coinquest-thumbs.local/{f.Id}.png" : "";
            games.Add(new Game("fp-" + f.Id, f.Title, f.Developer, "flashpoint", "via Flashpoint Archive", f.Id, f.Genre, f.Strategy,
                Price("fp-" + f.Id, f.Strategy), s.Hidden.Contains("fp-" + f.Id), true, "flashpoint") { Thumbnail = thumb });
        }

        foreach (var w in s.WebGames)
            games.Add(new Game(w.Id, w.Title, new Uri(w.Url).Host, "web", "hosted by its maker", w.Url, "", w.Strategy,
                Price(w.Id, w.Strategy), s.Hidden.Contains(w.Id), true, "web"));

        return games;
    }

    /// <summary>Save a parent-uploaded .swf (base64) with its title and strategy rating.</summary>
    public static Game Upload(Child child, string fileName, string base64, string? title, int strategy)
    {
        if (!fileName.EndsWith(".swf", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Only .swf (Flash) files can be added.");
        var bytes = Convert.FromBase64String(base64);
        if (bytes.Length > 60_000_000) throw new ArgumentException("That file is too big (60 MB max).");
        // FWS / CWS / ZWS are the three SWF signatures.
        if (bytes.Length < 3 || !(bytes[1] == (byte)'W' && bytes[2] == (byte)'S')) throw new ArgumentException("That doesn't look like a Flash game file.");
        Directory.CreateDirectory(Paths.ArcadeDropFolder);
        var safe = Slug(Path.GetFileNameWithoutExtension(fileName)) + ".swf";
        var path = Path.Combine(Paths.ArcadeDropFolder, safe);
        File.WriteAllBytes(path, bytes);
        File.WriteAllText(path + ".json", JsonSerializer.Serialize(new Meta(title ?? Path.GetFileNameWithoutExtension(fileName), Math.Clamp(strategy, 1, 5))));
        return Catalog(child).First(g => g.Url.EndsWith(Uri.EscapeDataString(safe)));
    }

    public static void RemoveUpload(string gameId)
    {
        if (!Directory.Exists(Paths.ArcadeDropFolder)) return;
        foreach (var f in Directory.EnumerateFiles(Paths.ArcadeDropFolder, "*.swf"))
            if ("my-" + Slug(Path.GetFileNameWithoutExtension(f)) == gameId)
            {
                File.Delete(f);
                if (File.Exists(f + ".json")) File.Delete(f + ".json");
            }
    }

    private sealed record Meta(string Title, int Strategy);
    private static Meta? ReadMeta(string swf)
    {
        try { return File.Exists(swf + ".json") ? JsonSerializer.Deserialize<Meta>(File.ReadAllText(swf + ".json")) : null; } catch { return null; }
    }

    private static string Slug(string s) => Regex.Replace(s.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-') is { Length: > 0 } x ? x : "game";
}
