using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace CoinQuest.Shared.Native;

/// <summary>
/// Windows Filtering Platform: a kernel-level rule that blocks every outbound connection made by ONE Windows
/// account, except to this computer itself (127.0.0.1 / ::1), where CoinQuest's filtering gatekeeper listens.
/// Applies to every program the account runs — any browser, portable apps, games — and is invisible to other
/// accounts. Persistent: survives reboots and keeps blocking even if CoinQuest stops (fails closed).
/// </summary>
public static class Wfp
{
    // ---------------------------------------------------------------- well-known GUIDs (fwpmu.h)
    static readonly Guid LayerAleAuthConnectV4 = new("c38d57d1-05a7-4c33-904f-7fbceee60e82");
    static readonly Guid LayerAleAuthConnectV6 = new("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
    static readonly Guid ConditionAleUserId = new("af043a0a-b34d-4f86-979c-c90371af6e66");
    static readonly Guid ConditionFlags = new("632ce23b-5167-435c-86d7-e903684aa80c");

    /// <summary>CoinQuest's own sublayer, so our block can't be overridden by ordinary "allow" rules.</summary>
    public static readonly Guid SubLayerKey = new("6c0f2e7a-3c1e-4c1b-9a77-c01a9e57a001");

    const uint RPC_C_AUTHN_WINNT = 10;
    const uint FWPM_FILTER_FLAG_PERSISTENT = 0x1;
    const ushort FWPM_SUBLAYER_FLAG_PERSISTENT = 0x1;
    const uint FWP_ACTION_BLOCK = 0x1001;
    const uint FWP_UINT32 = 3, FWP_SECURITY_DESCRIPTOR_TYPE = 14, FWP_EMPTY = 0;
    const int FWP_MATCH_EQUAL = 0, FWP_MATCH_FLAGS_NONE_SET = 8;
    const uint FWP_CONDITION_FLAG_IS_LOOPBACK = 0x1;
    const uint FWP_E_ALREADY_EXISTS = 0x80320009, FWP_E_FILTER_NOT_FOUND = 0x80320003, FWP_E_SUBLAYER_NOT_FOUND = 0x80320007, FWP_E_IN_USE = 0x80320006;

    // ---------------------------------------------------------------- structs (x64 layout, see fwpmtypes.h)
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DisplayData { public string? name; public string? description; }

    [StructLayout(LayoutKind.Sequential)]
    struct ByteBlob { public uint size; public IntPtr data; }

    [StructLayout(LayoutKind.Sequential)]
    struct Value { public uint type; public IntPtr value; } // FWP_VALUE0 / FWP_CONDITION_VALUE0: type + 8-byte union

    [StructLayout(LayoutKind.Sequential)]
    struct FilterCondition { public Guid fieldKey; public int matchType; public Value conditionValue; }

    [StructLayout(LayoutKind.Sequential)]
    struct Action { public uint type; public Guid filterType; }

    [StructLayout(LayoutKind.Sequential)]
    struct Context16 { public ulong a; public ulong b; }

    [StructLayout(LayoutKind.Sequential)]
    struct Filter
    {
        public Guid filterKey;
        public DisplayData displayData;
        public uint flags;
        public IntPtr providerKey;
        public ByteBlob providerData;
        public Guid layerKey;
        public Guid subLayerKey;
        public Value weight;
        public uint numFilterConditions;
        public IntPtr filterCondition;
        public Action action;
        public Context16 providerContext;
        public IntPtr reserved;
        public ulong filterId;
        public Value effectiveWeight;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SubLayer
    {
        public Guid subLayerKey;
        public DisplayData displayData;
        public ushort flags;
        public IntPtr providerKey;
        public ByteBlob providerData;
        public ushort weight;
    }

    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)] static extern uint FwpmEngineOpen0(string? serverName, uint authnService, IntPtr authIdentity, IntPtr session, out IntPtr engine);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engine, ref SubLayer subLayer, IntPtr sd);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine, ref Guid key);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine, ref Filter filter, IntPtr sd, out ulong id);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteByKey0(IntPtr engine, ref Guid key);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr sd, out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

    /// <summary>Deterministic filter keys per (account, layer) so re-applying is idempotent and removal needs no bookkeeping.</summary>
    public static Guid FilterKey(string sid, int layer)
    {
        var h = MD5.HashData(Encoding.UTF8.GetBytes($"coinquest-wfp|{sid}|{layer}"));
        return new Guid(h);
    }

    /// <summary>Block all non-loopback outbound traffic for this account. Safe to call repeatedly.</summary>
    public static void BlockAccount(string sid)
    {
        Check(FwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, IntPtr.Zero, IntPtr.Zero, out var engine), "open WFP engine");
        try
        {
            Check(FwpmTransactionBegin0(engine, 0), "begin transaction");
            try
            {
                var sub = new SubLayer
                {
                    subLayerKey = SubLayerKey,
                    displayData = new DisplayData { name = "CoinQuest", description = "Per-account internet lock for managed child accounts" },
                    flags = FWPM_SUBLAYER_FLAG_PERSISTENT,
                    weight = 0xFFFF,
                };
                var r = FwpmSubLayerAdd0(engine, ref sub, IntPtr.Zero);
                if (r != 0 && r != FWP_E_ALREADY_EXISTS) Check(r, "add sublayer");

                if (!ConvertStringSecurityDescriptorToSecurityDescriptorW($"O:LSD:(A;;CC;;;{sid})", 1, out var sd, out var sdSize))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "build security descriptor");
                var blob = Marshal.AllocHGlobal(Marshal.SizeOf<ByteBlob>());
                var conds = Marshal.AllocHGlobal(Marshal.SizeOf<FilterCondition>() * 2);
                try
                {
                    Marshal.StructureToPtr(new ByteBlob { size = sdSize, data = sd }, blob, false);
                    var userCond = new FilterCondition { fieldKey = ConditionAleUserId, matchType = FWP_MATCH_EQUAL, conditionValue = new Value { type = FWP_SECURITY_DESCRIPTOR_TYPE, value = blob } };
                    var notLoopback = new FilterCondition { fieldKey = ConditionFlags, matchType = FWP_MATCH_FLAGS_NONE_SET, conditionValue = new Value { type = FWP_UINT32, value = (IntPtr)FWP_CONDITION_FLAG_IS_LOOPBACK } };
                    Marshal.StructureToPtr(userCond, conds, false);
                    Marshal.StructureToPtr(notLoopback, conds + Marshal.SizeOf<FilterCondition>(), false);

                    var layers = new[] { LayerAleAuthConnectV4, LayerAleAuthConnectV6 };
                    for (var i = 0; i < layers.Length; i++)
                    {
                        var key = FilterKey(sid, i);
                        var del = FwpmFilterDeleteByKey0(engine, ref key);
                        if (del != 0 && del != FWP_E_FILTER_NOT_FOUND) Check(del, "replace filter");
                        var f = new Filter
                        {
                            filterKey = key,
                            displayData = new DisplayData { name = "CoinQuest internet lock", description = $"Blocks direct internet for {sid}; only CoinQuest's gatekeeper on this computer is reachable." },
                            flags = FWPM_FILTER_FLAG_PERSISTENT,
                            layerKey = layers[i],
                            subLayerKey = SubLayerKey,
                            weight = new Value { type = FWP_EMPTY },
                            numFilterConditions = 2,
                            filterCondition = conds,
                            action = new Action { type = FWP_ACTION_BLOCK },
                        };
                        Check(FwpmFilterAdd0(engine, ref f, IntPtr.Zero, out _), "add filter");
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(conds);
                    Marshal.FreeHGlobal(blob);
                    LocalFree(sd);
                }
                Check(FwpmTransactionCommit0(engine), "commit");
            }
            catch { FwpmTransactionAbort0(engine); throw; }
        }
        finally { FwpmEngineClose0(engine); }
    }

    /// <summary>Remove the lock for an account (and the sublayer once nothing uses it).</summary>
    public static void Unblock(string sid)
    {
        if (FwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, IntPtr.Zero, IntPtr.Zero, out var engine) != 0) return;
        try
        {
            for (var i = 0; i < 2; i++) { var key = FilterKey(sid, i); FwpmFilterDeleteByKey0(engine, ref key); }
            var sub = SubLayerKey;
            var r = FwpmSubLayerDeleteByKey0(engine, ref sub);
            _ = r == 0 || r == FWP_E_SUBLAYER_NOT_FOUND || r == FWP_E_IN_USE; // in use = another child still locked
        }
        finally { FwpmEngineClose0(engine); }
    }

    static void Check(uint hr, string what)
    {
        if (hr != 0) throw new InvalidOperationException($"Windows Filtering Platform: could not {what} (0x{hr:X8})");
    }
}
