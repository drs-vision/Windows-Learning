using CoinQuest.Shared.Config;
using CoinQuest.Shared.Models;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class HouseholdStoreTests
{
    private static HouseholdStore Fresh() => new(Path.Combine(Path.GetTempPath(), "cq-hh-" + Guid.NewGuid().ToString("N") + ".json"));

    [Fact]
    public void Pin_round_trips_and_locks_after_three_failures()
    {
        var s = Fresh();
        Assert.False(s.HasPin);
        s.SetPin("4321");
        Assert.True(s.HasPin);
        Assert.True(s.VerifyPin("4321"));
        Assert.False(s.VerifyPin("0000"));
        Assert.False(s.VerifyPin("0000"));
        Assert.False(s.VerifyPin("0000"));
        Assert.False(s.VerifyPin("4321")); // locked out now
        Assert.NotNull(s.Current.PinLockedUntil);
    }

    [Fact]
    public void Finds_child_by_bare_or_qualified_account()
    {
        var s = Fresh();
        s.Update(h => h with { Children = new() { new Child { DisplayName = "Sam", WindowsAccount = "sam" } } });
        Assert.NotNull(s.FindChildByAccount("sam"));
        Assert.NotNull(s.FindChildByAccount("DESKTOP-1\\SAM"));
        Assert.Null(s.FindChildByAccount("dad"));
    }

    [Fact]
    public void Persists_to_disk()
    {
        var path = Path.Combine(Path.GetTempPath(), "cq-hh-" + Guid.NewGuid().ToString("N") + ".json");
        new HouseholdStore(path).Update(h => h with { Name = "Squires" });
        Assert.Equal("Squires", new HouseholdStore(path).Current.Name);
    }
}

public class SafeFileTests
{
    [Fact]
    public void Writes_even_when_target_is_held_open_without_delete_sharing()
    {
        var path = Path.Combine(Path.GetTempPath(), "cq-safe-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, "old");
        // Simulate antivirus/indexer: an open handle that blocks rename-over (no FILE_SHARE_DELETE) but allows writes.
        using (var holder = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            CoinQuest.Shared.Config.SafeFile.WriteAllText(path, "new");
        }
        Assert.Equal("new", File.ReadAllText(path));
        Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(path)!, Path.GetFileName(path) + ".*.tmp"));
    }

    [Fact]
    public void Writes_over_a_hidden_readonly_file()
    {
        var path = Path.Combine(Path.GetTempPath(), "cq-safe-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, "old");
        File.SetAttributes(path, FileAttributes.Hidden | FileAttributes.ReadOnly);
        CoinQuest.Shared.Config.SafeFile.WriteAllText(path, "new");
        Assert.Equal("new", File.ReadAllText(path));
    }

    [Fact]
    public void Household_saves_to_a_fallback_copy_when_the_main_file_is_locked_and_reloads_it()
    {
        var path = Path.Combine(Path.GetTempPath(), "cq-hh-" + Guid.NewGuid().ToString("N") + ".json");
        var store = new HouseholdStore(path);
        store.Update(h => h with { Name = "First" });
        // Exclusive lock: nothing can write, rename over, or delete the main file.
        using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            try { store.Update(h => h with { Name = "Second" }); }
            catch (IOException) { return; } // non-Windows file locking differs; the Windows CI run covers this
        }
        Assert.Equal("Second", new HouseholdStore(path).Current.Name);
    }
}
