using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using CoinQuest.Shared.Ipc;
using Xunit;

namespace CoinQuest.Shared.Tests;

public class WireTests
{
    [Fact]
    public void Wire_format_is_one_line_per_message()
    {
        var req = new Request { Op = "hello", Payload = JsonSerializer.SerializeToNode(new { a = 1, nested = new { b = new[] { 1, 2, 3 } } }) };
        var line = JsonSerializer.Serialize(req, Wire.Json);
        Assert.DoesNotContain('\n', line);
        Assert.DoesNotContain('\r', line);

        var resp = Response.Success("x", new { big = new string('z', 10_000), list = Enumerable.Range(0, 100) });
        Assert.DoesNotContain('\n', JsonSerializer.Serialize(resp, Wire.Json));

        var ev = new Event { Name = "state", Payload = JsonSerializer.SerializeToNode(new { x = 1 }) };
        Assert.DoesNotContain('\n', JsonSerializer.Serialize(ev, Wire.Json));
    }

    [Fact]
    public async Task Client_round_trips_through_a_real_named_pipe()
    {
        if (!OperatingSystem.IsWindows()) return;
        var name = "CoinQuest.Test." + Guid.NewGuid().ToString("N");

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var server = Task.Run(async () =>
        {
            using var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            await pipe.WaitForConnectionAsync(cts.Token);
            using var reader = new StreamReader(pipe, Encoding.UTF8);
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
            // Echo two requests, then push an event.
            for (var i = 0; i < 2; i++)
            {
                var line = await reader.ReadLineAsync(cts.Token);
                var req = JsonSerializer.Deserialize<Request>(line!, Wire.Json)!;
                await writer.WriteLineAsync(JsonSerializer.Serialize(Response.Success(req.Id, new { echo = req.Op }), Wire.Json));
            }
            await writer.WriteLineAsync(JsonSerializer.Serialize(new Event { Name = "ping" }, Wire.Json));
            await Task.Delay(200, cts.Token);
        }, cts.Token);

        await using var client = new PipeClient(name);
        await client.ConnectAsync(5000);
        var got = new TaskCompletionSource<string>();
        client.OnEvent += ev => got.TrySetResult(ev.Name);

        var r1 = await client.SendAsync("hello");
        Assert.True(r1.Ok);
        Assert.Equal("hello", r1.Payload!["echo"]!.GetValue<string>());

        var raw = await client.ForwardRawAsync("{\"id\":\"abc\",\"op\":\"state\"}");
        Assert.Contains("\"id\":\"abc\"", raw);
        Assert.Contains("\"ok\":true", raw);

        Assert.Equal("ping", await got.Task.WaitAsync(cts.Token));
        await server;
    }
}
