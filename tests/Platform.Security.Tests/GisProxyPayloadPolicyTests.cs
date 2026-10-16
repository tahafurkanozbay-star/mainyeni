using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using CityWorks.UserApi.Gis;
using Xunit;

namespace Platform.Security.Tests;

public sealed class GisProxyPayloadPolicyTests
{
    [Theory]
    [InlineData("text/html")]
    [InlineData("text/html; charset=utf-8")]
    [InlineData("TEXT/HTML; CHARSET=UTF-8")]
    [InlineData("application/xhtml+xml")]
    [InlineData("image/svg+xml")]
    [InlineData("image/svg+xml; charset=utf-8")]
    [InlineData("text/javascript")]
    [InlineData("application/javascript")]
    [InlineData("text/ecmascript")]
    [InlineData("application/ecmascript")]
    [InlineData("text/css")]
    [InlineData("application/xml")]
    [InlineData("text/xml")]
    public void ActiveUpstreamDocuments_AreDisallowed(string mimeType)
    {
        Assert.True(GisProxyPayloadPolicy.IsActiveContentType(mimeType));
    }

    [Theory]
    [InlineData("application/json")]
    [InlineData("application/json; charset=utf-8")]
    [InlineData("application/geo+json")]
    [InlineData("text/plain; charset=utf-8")]
    [InlineData("image/png")]
    [InlineData("image/jpeg")]
    [InlineData("image/webp")]
    [InlineData("image/gif")]
    [InlineData("application/octet-stream")]
    [InlineData("")]
    public void JsonRasterAndInertData_RemainAllowed(string mimeType)
    {
        Assert.False(GisProxyPayloadPolicy.IsActiveContentType(mimeType));
    }

    [Fact]
    public async Task BoundedReader_PreservesUnicodeAcrossSingleByteChunks()
    {
        const string content = "Çankaya Kadın Danışma, Şırnak, İğdır";
        var source = new CountingChunkedStream(Encoding.UTF8.GetBytes(content), 1);
        var output = await GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(
            source, Encoding.UTF8.GetByteCount(content), CancellationToken.None);

        Assert.Equal(content, output);
        Assert.Equal(source.TotalLength, source.TotalBytesRead);
    }

    [Fact]
    public async Task RequestAtExactByteLimit_IsAccepted()
    {
        using var input = new MemoryStream(Encoding.UTF8.GetBytes("{\"tur\":13}"));
        var output = await GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(
            input, input.Length, CancellationToken.None);
        Assert.Equal("{\"tur\":13}", output);
    }

    [Fact]
    public async Task ChunkedRequest_StopsBeforeUnboundedBodyIsBuffered()
    {
        var bytes = new byte[128 * 1024];
        var input = new CountingChunkedStream(bytes, 256);
        var output = await GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(
            input, 1024, CancellationToken.None);

        Assert.Null(output);
        Assert.True(input.TotalBytesRead <= 1024 + 256);
        Assert.True(input.TotalBytesRead < input.TotalLength);
    }

    [Fact]
    public async Task ByteBudgetCountsUtf8Bytes_NotNumberOfCharacters()
    {
        const string content = "ığüş";
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(content));
        var output = await GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(
            stream, content.Length, CancellationToken.None);
        Assert.Null(output);
    }

    [Fact]
    public async Task ZeroBudget_RejectsNonemptyPostBody()
    {
        using var stream = new MemoryStream(new byte[] { 1 });
        Assert.Null(await GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(
            stream, 0, CancellationToken.None));
    }

    [Fact]
    public async Task ZeroBudget_AllowsEmptyPostBody()
    {
        using var stream = new MemoryStream(Array.Empty<byte>());
        Assert.Equal(string.Empty, await GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(
            stream, 0, CancellationToken.None));
    }

    [Fact]
    public async Task AlreadyCancelledRequest_DoesNotReadBody()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var input = new CountingChunkedStream(new byte[1024], 64);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(input, 1024, cancellation.Token));
        Assert.Equal(0, input.TotalBytesRead);
    }

    [Fact]
    public async Task InvalidByteLimit_FailsClosed()
    {
        using var stream = new MemoryStream();
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(stream, -1, CancellationToken.None));
    }

    [Fact]
    public void ControllerEnforcesMediaPolicyAndStreamingLimitBeforeForwarding()
    {
        var root = FindRepositoryRoot();
        var controller = File.ReadAllText(
            Path.Combine(root, "Api.User", "Controllers", "Extensions", "Gis", "GisProxyController.cs"));
        Assert.Contains("GisProxyPayloadPolicy.IsActiveContentType(response.ContentType)", controller);
        Assert.Contains("GisProxyPayloadPolicy.ReadBoundedUtf8BodyAsync(", controller);
        Assert.DoesNotContain("ReadToEndAsync()", controller);
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "CityWorks.NetCore.sln")) &&
                File.Exists(Path.Combine(directory.FullName, "KENT_REHBERI_AGENT_RULES.md")))
            {
                return directory.FullName;
            }
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("Kent Rehberi source root was not found.");
    }

    private sealed class CountingChunkedStream : Stream
    {
        private readonly byte[] _payload;
        private readonly int _maximumChunk;
        private int _position;

        public CountingChunkedStream(byte[] payload, int maximumChunk)
        {
            _payload = payload;
            _maximumChunk = maximumChunk;
        }

        public int TotalBytesRead { get; private set; }
        public int TotalLength => _payload.Length;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var amount = Math.Min(
                Math.Min(count, _maximumChunk),
                _payload.Length - _position);
            if (amount <= 0) return 0;
            Array.Copy(_payload, _position, buffer, offset, amount);
            _position += amount;
            TotalBytesRead += amount;
            return amount;
        }

        public override Task<int> ReadAsync(
            byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(Read(buffer, offset, count));
        }

        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();
    }
}
