using Business.Extensions.Gis.Operations;
using System;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class TkgmTransportBoundaryTests
{
    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("parsel/1/2/3")]
    [InlineData("/")]
    [InlineData("//evil.example/path")]
    [InlineData("/\\evil.example\\path")]
    [InlineData("/parsel/1/../2")]
    [InlineData("/parsel/1?redirect=http://evil.example")]
    [InlineData("/parsel/1#fragment")]
    [InlineData("/parsel/1 2")]
    [InlineData("/parsel/1\t2")]
    [InlineData("/parsel/1%2f%2fevil.example")]
    [InlineData("/parsel/1:2")]
    public async Task GetAsync_RejectsNonCanonicalPathsBeforeNetworkDispatch(string path)
    {
        using var transport = new RestSharpTkgmTransport();
        await Assert.ThrowsAsync<ArgumentException>(() => transport.GetAsync(path, CancellationToken.None));
    }

    [Fact]
    public async Task GetAsync_RejectsOversizedInputBeforeNetworkDispatch()
    {
        using var transport = new RestSharpTkgmTransport();
        var oversized = "/parsel/" + new string('1', 600);
        var error = await Assert.ThrowsAsync<ArgumentException>(() => transport.GetAsync(oversized, CancellationToken.None));
        Assert.Contains("length", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetAsync_HonoursPreCancelledTokenBeforeNetworkDispatch()
    {
        using var transport = new RestSharpTkgmTransport();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => transport.GetAsync("/parsel/1/2/3", cancellation.Token));
    }
}
