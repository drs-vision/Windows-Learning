using System.Security.Principal;
using CoinQuest.Shared.Native;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class WfpTests
{
    /// <summary>
    /// Adds and removes the real kernel filter for a SID nobody uses. Proves the structs, GUIDs and calls are right
    /// on real Windows (GitHub's Windows runners are elevated). Skipped elsewhere.
    /// </summary>
    [Fact]
    public void Can_add_and_remove_the_per_account_lock()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var id = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator)) return;

        const string fakeSid = "S-1-5-21-111111111-222222222-333333333-4242";
        Wfp.BlockAccount(fakeSid);
        Wfp.BlockAccount(fakeSid); // idempotent
        Wfp.Unblock(fakeSid);
        Wfp.Unblock(fakeSid);      // removing twice is fine
        Assert.NotEqual(Wfp.FilterKey(fakeSid, 0), Wfp.FilterKey(fakeSid, 1));
    }
}
