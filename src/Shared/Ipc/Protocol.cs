using System.Text.Json;
using System.Text.Json.Nodes;
using CoinQuest.Shared.Config;

namespace CoinQuest.Shared.Ipc;

/// <summary>
/// Wire format: one JSON object per line, UTF-8, over a named pipe.
/// Client → server: Request. Server → client: Response (same id) or Event (no id).
/// The server learns WHO is calling from pipe impersonation — the Windows account on the
/// other end — not from anything in the message. Parent operations additionally need a
/// short-lived token obtained with a PIN.
/// </summary>
/// <summary>One JSON object per LINE — so the wire format must never be indented. (Config files use HouseholdStore.Json, which is.)</summary>
public static class Wire
{
    public static readonly JsonSerializerOptions Json = new(HouseholdStore.Json) { WriteIndented = false };
}

public sealed class Request
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Op { get; set; } = "";
    public string? Token { get; set; }
    public JsonNode? Payload { get; set; }
}

public sealed record Response
{
    public string Id { get; set; } = "";
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public JsonNode? Payload { get; set; }

    public static Response Success(string id, object? payload = null) =>
        new() { Id = id, Ok = true, Payload = payload is null ? null : JsonSerializer.SerializeToNode(payload, Wire.Json) };
    public static Response Fail(string id, string error) => new() { Id = id, Ok = false, Error = error };
}

public sealed class Event
{
    public string Name { get; set; } = "";
    public JsonNode? Payload { get; set; }
}

public static class Ops
{
    // anyone in a session
    public const string Hello = "hello";
    public const string State = "state";               // child's current state (balance, unlocks, quests, shop)
    public const string Submit = "submit";             // { moduleId, activity, result }
    public const string Buy = "buy";                   // { prizeId }
    public const string Progress = "progress";         // { moduleId, progress } save module progress
    public const string ArcadeList = "arcade.list";    // games available

    // parent — needs token from parent.login
    public const string ParentLogin = "parent.login";  // { pin } -> { token }
    public const string ParentState = "parent.state";  // household + pending claims + today's ledger per child
    public const string ParentUpdateChild = "parent.updateChild";   // { child }
    public const string ParentResolveClaim = "parent.resolveClaim"; // { seq, approve, coins? }
    public const string ParentAdjust = "parent.adjust";             // { childId, delta, reason }
    public const string ParentSetPin = "parent.setPin";             // { pin }
    public const string ParentInstalledApps = "parent.installedApps";
    public const string ParentCheckUpdate = "parent.checkUpdate";
    public const string ParentEndUnlock = "parent.endUnlock";       // { unlockId }
    public const string ParentVersion = "parent.version";

    // first-run setup — only honoured while no PIN exists AND caller is a local Administrator
    public const string SetupAccounts = "setup.accounts";
    public const string SetupComplete = "setup.complete";           // { pin, child: { displayName, windowsAccount } }

    // events (server → client)
    public const string EvState = "state";             // full child state refresh
    public const string EvUnlockEnded = "unlockEnded"; // { unlockId, prizeName }
    public const string EvBlocked = "blocked";         // { exe } — an app was closed
    public const string EvApprovals = "approvals";     // pending claims changed
}
