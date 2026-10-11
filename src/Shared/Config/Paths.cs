namespace CoinQuest.Shared.Config;

public static class Paths
{
    /// <summary>C:\ProgramData\CoinQuest — ACL'd by the installer: SYSTEM + Administrators full, Users read.</summary>
    public static string DataRoot =>
        Environment.GetEnvironmentVariable("COINQUEST_DATA")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "CoinQuest");

    public static string HouseholdFile => Path.Combine(DataRoot, "household.json");
    public static string LedgerDb => Path.Combine(DataRoot, "ledger.db");
    public static string UnlocksFile => Path.Combine(DataRoot, "unlocks.json");
    public static string LogDir => Path.Combine(DataRoot, "logs");
    public static string ArcadeDropFolder => Path.Combine(DataRoot, "arcade");
    public static string UpdateStaging => Path.Combine(DataRoot, "update");

    /// <summary>Install directory of the running executable.</summary>
    public static string InstallRoot => AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    public static string WebRoot => Path.Combine(InstallRoot, "web");
    public static string ContentRoot => Path.Combine(InstallRoot, "content");

    public const string PipeName = "CoinQuest.Guardian";
    public const string ServiceName = "CoinQuestGuardian";
    public const string GitHubOwner = "drs-vision";
    public const string GitHubRepo = "Windows-Learning";

    public static void EnsureDirectories()
    {
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(LogDir);
        Directory.CreateDirectory(ArcadeDropFolder);
    }
}
