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
    public void ValidateRelativePath_RejectsAuthorityTraversalAndComponentSmuggling(string path)
    {
        Assert.Throws<ArgumentException>(() => RestSharpTkgmTransport.ValidateRelativePath(path));
    }

    [Theory]
    [InlineData("/parsel/1/2/3")]
    [InlineData("/idariYapi/ilceListe/34")]
    [InlineData("/idariYapi/mahalleListe/12345")]
    [InlineData("/route_with-dash/123")]
    public void ValidateRelativePath_AllowsCanonicalApiRoutes(string path)
    {
        RestSharpTkgmTransport.ValidateRelativePath(path);
    }

    [Fact]
    public void ValidateRelativePath_RejectsOversizedInputBeforeNetworkDispatch()
    {
        var oversized = "/parsel/" + new string('1', 600);
        var error = Assert.Throws<ArgumentException>(() => RestSharpTkgmTransport.ValidateRelativePath(oversized));
        Assert.Contains("length", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetAsync_RejectsNetworkPathReferenceBeforeCancellationOrNetworkDispatch()
    {
        using var transport = new RestSharpTkgmTransport();
        var task = transport.GetAsync("//evil.example/escape", CancellationToken.None);
        await Assert.ThrowsAsync<ArgumentException>(() => task);
    }

    [Fact]
    public async Task GetAsync_RejectsQuerySmugglingBeforeNetworkDispatch()
    {
        using var transport = new RestSharpTkgmTransport();
        var task = transport.GetAsync("/parsel/1?next=http://evil.example", CancellationToken.None);
        await Assert.ThrowsAsync<ArgumentException>(() => task);
    }

    [Fact]
    public async Task GetAsync_HonoursPreCancelledTokenWithoutNetworkDispatch()
    {
        using var transport = new RestSharpTkgmTransport();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => transport.GetAsync("/parsel/1/2/3", cancellation.Token));
    }
}
