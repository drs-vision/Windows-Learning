using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;
using Microsoft.Data.Sqlite;

namespace CoinQuest.Guardian.Economy;

/// <summary>
/// Integration with a local Flashpoint Archive install (https://flashpointarchive.org) — the community
/// preservation project for 2000s Flash games. CoinQuest never ships or scrapes those games itself:
/// Flashpoint downloads them on demand; CoinQuest reads Flashpoint's catalog (read-only), shows only
/// games a parent approved, and launches them through CLIFp (Flashpoint's command-line launcher).
/// </summary>
public sealed class FlashpointService
{
    private readonly ILogger<FlashpointService> _log;
    private readonly HttpClient _http;
    private string? _root;
    private DateTime _rootCheckedAt;

    public const string InstallerUrl = "https://github.com/FlashpointProject/FlashpointComponentTools/releases/latest/download/FlashpointInstaller.exe";
    public const string ClifpUrl = "https://github.com/oblivioncth/CLIFp/releases/download/v0.9.16/CLIFp_v0.9.16_Windows_Static_x64.zip";
    private const string DefaultImagesBase = "https://infinity.flashpointarchive.org/Flashpoint/Data/Images/";

    public FlashpointService(ILogger<FlashpointService> log)
    {
        _log = log;
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("CoinQuest", "1.0"));
    }

    public static string ThumbDir => Path.Combine(Paths.DataRoot, "thumbs");

    // ---------------------------------------------------------------- finding the install

    /// <summary>Flashpoint is portable; look where people usually put it, plus a parent-chosen path.</summary>
    public string? Root(string? configured = null)
    {
        if (configured is not null && IsRoot(configured)) return _root = configured;
        if (_root is not null && IsRoot(_root) && (DateTime.UtcNow - _rootCheckedAt).TotalMinutes < 5) return _root;
        _rootCheckedAt = DateTime.UtcNow;
        var candidates = new List<string>();
        foreach (var d in DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady))
        {
            candidates.Add(Path.Combine(d.RootDirectory.FullName, "Flashpoint"));
            try { candidates.AddRange(Directory.EnumerateDirectories(d.RootDirectory.FullName, "Flashpoint*")); } catch { }
        }
        try
        {
            foreach (var home in Directory.EnumerateDirectories(@"C:\Users"))
                foreach (var sub in new[] { "", "Desktop", "Documents", "Downloads", "Games" })
                    try { candidates.AddRange(Directory.EnumerateDirectories(Path.Combine(home, sub), "Flashpoint*")); } catch { }
        }
        catch { }
        return _root = candidates.FirstOrDefault(IsRoot);
    }

    private static bool IsRoot(string p) => File.Exists(Path.Combine(p, "Data", "flashpoint.sqlite"));
    public bool HasClifp(string root) => File.Exists(Path.Combine(root, "CLIFp.exe"));

    public object Status(string? configured)
    {
        var root = Root(configured);
        return new { installed = root is not null, root, clifp = root is not null && HasClifp(root), installerUrl = InstallerUrl };
    }

    /// <summary>CLIFp lets CoinQuest start one specific game (`CLIFp play -i &lt;id&gt;`) the same way Flashpoint's own launcher would, downloading it on demand.</summary>
    public async Task InstallClifp(string root)
    {
        var zip = Path.Combine(Path.GetTempPath(), "clifp.zip");
        await using (var fs = File.Create(zip))
        await using (var s = await _http.GetStreamAsync(ClifpUrl)) await s.CopyToAsync(fs);
        using var archive = ZipFile.OpenRead(zip);
        var exe = archive.Entries.FirstOrDefault(e => e.Name.Equals("CLIFp.exe", StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException("CLIFp.exe not found in the download");
        exe.ExtractToFile(Path.Combine(root, "CLIFp.exe"), overwrite: true);
        _log.LogInformation("Installed CLIFp into {Root}", root);
    }

    // ---------------------------------------------------------------- catalog

    public sealed record FpGame(string Id, string Title, string Developer, string Publisher, string Platform, string Tags, string Series, string ReleaseDate, string Description);

    private SqliteConnection Open(string root)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(root, "Data", "flashpoint.sqlite"), Mode = SqliteOpenMode.ReadOnly, Cache = SqliteCacheMode.Shared }.ToString());
        db.Open();
        return db;
    }

    private static HashSet<string> Columns(SqliteConnection db)
    {
        var cols = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var cmd = db.CreateCommand();
        cmd.CommandText = "PRAGMA table_info(game)";
        using var r = cmd.ExecuteReader();
        while (r.Read()) cols.Add(r.GetString(1));
        return cols;
    }

    /// <summary>Search Flashpoint's catalog. Games tagged Extreme (Flashpoint's adult/violent flag) are never returned.</summary>
    public List<FpGame> Search(string root, string query, int limit = 40)
    {
        using var db = Open(root);
        var cols = Columns(db);
        string Col(string name, string fallback = "''") => cols.Contains(name) ? name : fallback;
        var platform = cols.Contains("platformName") ? "platformName" : cols.Contains("platform") ? "platform" : "''";
        var tags = cols.Contains("tagsStr") ? "tagsStr" : "''";
        using var cmd = db.CreateCommand();
        var extreme = cols.Contains("extreme") ? "AND (extreme IS NULL OR extreme = 0)" : "";
        cmd.CommandText = $"""
            SELECT id, title, {Col("developer")}, {Col("publisher")}, {platform}, {tags}, {Col("series")}, {Col("releaseDate")}, {Col("originalDescription")}
            FROM game
            WHERE ({(query.StartsWith("tag:") ? $"{tags} LIKE $q" : $"(title LIKE $q OR {Col("alternateTitles", "title")} LIKE $q OR {Col("series", "title")} LIKE $q)")})
              AND {Col("library", "'arcade'")} = 'arcade'
              AND ({tags} NOT LIKE '%Extreme%') {extreme}
              AND {platform} IN ('Flash', 'HTML5', 'Shockwave', '')
            ORDER BY CASE WHEN title LIKE $exact THEN 0 WHEN title LIKE $start THEN 1 ELSE 2 END, length(title)
            LIMIT $limit
            """;
        if (query.StartsWith("tag:")) query = query[4..];
        cmd.Parameters.AddWithValue("$q", "%" + query.Trim() + "%");
        cmd.Parameters.AddWithValue("$exact", query.Trim());
        cmd.Parameters.AddWithValue("$start", query.Trim() + "%");
        cmd.Parameters.AddWithValue("$limit", limit);
        var list = new List<FpGame>();
        using var r = cmd.ExecuteReader();
        while (r.Read())
            list.Add(new FpGame(r.GetString(0), r.GetString(1), S(r, 2), S(r, 3), S(r, 4), S(r, 5), S(r, 6), S(r, 7), Trim(S(r, 8), 300)));
        return list;
    }

    public FpGame? Get(string root, string id)
    {
        using var db = Open(root);
        var cols = Columns(db);
        string Col(string name) => cols.Contains(name) ? name : "''";
        var platform = cols.Contains("platformName") ? "platformName" : Col("platform");
        using var cmd = db.CreateCommand();
        cmd.CommandText = $"SELECT id, title, {Col("developer")}, {Col("publisher")}, {platform}, {Col("tagsStr")}, {Col("series")}, {Col("releaseDate")}, {Col("originalDescription")} FROM game WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        return r.Read() ? new FpGame(r.GetString(0), r.GetString(1), S(r, 2), S(r, 3), S(r, 4), S(r, 5), S(r, 6), S(r, 7), Trim(S(r, 8), 300)) : null;
    }

    private static string S(SqliteDataReader r, int i) => r.IsDBNull(i) ? "" : Convert.ToString(r.GetValue(i)) ?? "";
    private static string Trim(string s, int n) => s.Length <= n ? s : s[..n] + "…";

    // ---------------------------------------------------------------- thumbnails

    /// <summary>
    /// Ensure a logo for the game is cached in ProgramData\CoinQuest\thumbs (served to the UI as coinquest-thumbs.local).
    /// Uses the copy in the Flashpoint folder if present, otherwise downloads from the image server Flashpoint itself uses.
    /// </summary>
    public async Task<string?> Thumb(string root, string id)
    {
        Directory.CreateDirectory(ThumbDir);
        var dest = Path.Combine(ThumbDir, id + ".png");
        if (File.Exists(dest)) return Path.GetFileName(dest);
        var rel = Path.Combine("Logos", id[..2], id.Substring(2, 2), id + ".png");
        var local = Path.Combine(root, "Data", "Images", rel);
        if (File.Exists(local)) { File.Copy(local, dest, true); return Path.GetFileName(dest); }
        try
        {
            var url = ImagesBase(root) + rel.Replace('\\', '/');
            var bytes = await _http.GetByteArrayAsync(url);
            await File.WriteAllBytesAsync(dest, bytes);
            return Path.GetFileName(dest);
        }
        catch (Exception ex) { _log.LogInformation("No thumbnail for {Id}: {Msg}", id, ex.Message); return null; }
    }

    private static string ImagesBase(string root)
    {
        // Read Flashpoint's own setting rather than guessing, so this keeps working if their server moves.
        foreach (var file in new[] { "preferences.json", "config.json" })
        {
            try
            {
                var node = JsonNode.Parse(File.ReadAllText(Path.Combine(root, file)));
                var v = node?["onDemandBaseUrl"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(v)) return v.EndsWith('/') ? v : v + "/";
            }
            catch { }
        }
        return DefaultImagesBase;
    }
}
