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
    /// <summary>
    /// Automated end-to-end test machines only (CI). The data folder is writable by administrators alone, so a child
    /// can't create it. Turns off self-updating and lets the shells open a debugging port for the test driver.
    /// </summary>
    public static bool E2ETestMode => File.Exists(Path.Combine(DataRoot, "e2e-test-mode"));

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
        Directory.CreateDirectory(Path.Combine(DataRoot, "thumbs"));
    }
}
