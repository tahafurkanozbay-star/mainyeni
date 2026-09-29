using Api.Core.Platform;
using Api.Core.Platform.Middleware;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class CorrelationIdSecurityTests
{
    [Theory]
    [InlineData(16)]
    [InlineData(20)]
    [InlineData(31)]
    [InlineData(32)]
    [InlineData(96)]
    public async Task GeneratedCorrelationId_NeverExceedsConfiguredCeiling(int maxLength)
    {
        var options = CreateOptions(maxLength);
        var context = CreateContext();
        context.TraceIdentifier = new string('t', maxLength + 1);
        var logger = new RecordingLogger<CorrelationIdMiddleware>();
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options,
            logger);

        await middleware.Invoke(context);

        var generated = context.Response.Headers[options.Requests.CorrelationHeaderName].ToString();
        Assert.NotEmpty(generated);
        Assert.True(generated.Length <= maxLength);
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(generated, maxLength));
        Assert.All(generated, character => Assert.True(IsLowerHex(character)));
    }

    [Theory]
    [InlineData(16)]
    [InlineData(20)]
    [InlineData(31)]
    public async Task GeneratedCorrelationId_UsesConfiguredCeilingBelowDefaultTokenLength(int maxLength)
    {
        var options = CreateOptions(maxLength);
        var context = CreateContext();
        context.TraceIdentifier = "unsafe trace identifier";
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options,
            new RecordingLogger<CorrelationIdMiddleware>());

        await middleware.Invoke(context);

        var generated = context.Response.Headers[options.Requests.CorrelationHeaderName].ToString();
        Assert.Equal(maxLength, generated.Length);
    }

    [Fact]
    public async Task SafeTraceIdentifier_AtConfiguredBoundary_IsPreserved()
    {
        var options = CreateOptions(maxLength: 20);
        var context = CreateContext();
        context.TraceIdentifier = "trace-12345678901234";
        Assert.Equal(20, context.TraceIdentifier.Length);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options,
            new RecordingLogger<CorrelationIdMiddleware>());

        await middleware.Invoke(context);

        Assert.Equal(
            context.TraceIdentifier,
            context.Response.Headers[options.Requests.CorrelationHeaderName].ToString());
    }

    [Fact]
    public async Task SafeTraceIdentifier_AboveConfiguredBoundary_IsReplaced()
    {
        var options = CreateOptions(maxLength: 20);
        var context = CreateContext();
        context.TraceIdentifier = new string('a', 21);
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options,
            new RecordingLogger<CorrelationIdMiddleware>());

        await middleware.Invoke(context);

        var generated = context.Response.Headers[options.Requests.CorrelationHeaderName].ToString();
        Assert.NotEqual(context.TraceIdentifier, generated);
        Assert.Equal(20, generated.Length);
    }

    [Fact]
    public async Task InvalidInboundHeader_StrictMode_DoesNotLogRawPathOrHeaderValue()
    {
        const string secretPath = "/api/accounts/customer-12345/private-search-term";
        const string malformedHeader = "malformed correlation value with spaces";
        var options = CreateOptions();
        var context = CreateContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = secretPath;
        context.Request.Headers[options.Requests.CorrelationHeaderName] = malformedHeader;
        var logger = new RecordingLogger<CorrelationIdMiddleware>();
        var nextCalled = false;
        var middleware = CreateMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            options,
            logger);

        await middleware.Invoke(context);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        var log = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Warning, log.Level);
        Assert.Contains("Rejected malformed correlation id on GET.", log.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(secretPath, log.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("customer-12345", log.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("private-search-term", log.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(malformedHeader, log.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InvalidInboundHeader_CustomMethod_IsLoggedAsBoundedOtherToken()
    {
        var options = CreateOptions();
        var context = CreateContext();
        context.Request.Method = "CUSTOM-UNBOUNDED-METHOD-NAME";
        context.Request.Path = "/sensitive/path/value";
        context.Request.Headers[options.Requests.CorrelationHeaderName] = "bad value";
        var logger = new RecordingLogger<CorrelationIdMiddleware>();
        var middleware = CreateMiddleware(_ => Task.CompletedTask, options, logger);

        await middleware.Invoke(context);

        var log = Assert.Single(logger.Entries);
        Assert.Contains("OTHER", log.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("CUSTOM-UNBOUNDED-METHOD-NAME", log.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("/sensitive/path/value", log.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InvalidInboundHeader_NonStrictMode_UsesBoundedServerIdentifier()
    {
        var options = CreateOptions(maxLength: 16);
        options.Requests.RejectTraceHeaderWithInvalidCharacters = false;
        var context = CreateContext();
        context.TraceIdentifier = new string('t', 64);
        context.Request.Headers[options.Requests.CorrelationHeaderName] = "invalid inbound value";
        var logger = new RecordingLogger<CorrelationIdMiddleware>();
        var middleware = CreateMiddleware(
            httpContext => httpContext.Response.WriteAsync("ok"),
            options,
            logger);

        await middleware.Invoke(context);

        var generated = context.Response.Headers[options.Requests.CorrelationHeaderName].ToString();
        Assert.Equal(16, generated.Length);
        Assert.True(ApiPlatformDefaults.IsValidCorrelationId(generated, 16));
        Assert.Empty(logger.Entries);
    }

    [Fact]
    public async Task RejectionBody_DoesNotReflectRawPathOrMalformedHeader()
    {
        var options = CreateOptions();
        var context = CreateContext();
        context.Request.Path = "/tenants/secret-tenant-42";
        context.Request.Headers[options.Requests.CorrelationHeaderName] = "bad header value";
        var middleware = CreateMiddleware(
            _ => Task.CompletedTask,
            options,
            new RecordingLogger<CorrelationIdMiddleware>());

        await middleware.Invoke(context);

        var body = await ReadBody(context);
        Assert.DoesNotContain("secret-tenant-42", body, StringComparison.Ordinal);
        Assert.DoesNotContain("bad header value", body, StringComparison.Ordinal);
        Assert.Contains("Invalid request metadata", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DownstreamCannotPermanentlyReplaceServerOwnedCorrelationHeader()
    {
        var options = CreateOptions();
        var context = CreateContext();
        context.TraceIdentifier = "server-trace-owned";
        var middleware = CreateMiddleware(
            httpContext =>
            {
                httpContext.Response.Headers[options.Requests.CorrelationHeaderName] = "downstream-value";
                return httpContext.Response.StartAsync();
            },
            options,
            new RecordingLogger<CorrelationIdMiddleware>());

        await middleware.Invoke(context);

        Assert.Equal(
            "server-trace-owned",
            context.Response.Headers[options.Requests.CorrelationHeaderName].ToString());
    }

    private static bool IsLowerHex(char value)
    {
        return (value >= '0' && value <= '9') ||
               (value >= 'a' && value <= 'f');
    }

    private static CorrelationIdMiddleware CreateMiddleware(
        RequestDelegate next,
        ApiPlatformOptions options,
        ILogger<CorrelationIdMiddleware> logger)
    {
        return new CorrelationIdMiddleware(next, Options.Create(options), logger);
    }

    private static ApiPlatformOptions CreateOptions(int maxLength = 96)
    {
        var options = new ApiPlatformOptions();
        options.Requests.MaxCorrelationIdLength = maxLength;
        return options;
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static async Task<string> ReadBody(HttpContext context)
    {
        context.Response.Body.Position = 0;
        using var reader = new StreamReader(
            context.Response.Body,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: false,
            leaveOpen: true);
        return await reader.ReadToEndAsync();
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        public List<LogEntry> Entries { get; } = new List<LogEntry>();

        public IDisposable BeginScope<TState>(TState state)
            where TState : notnull
        {
            return NullScope.Instance;
        }

        public bool IsEnabled(LogLevel logLevel)
        {
            return true;
        }

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            Entries.Add(new LogEntry(logLevel, formatter(state, exception)));
        }
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new NullScope();

        private NullScope()
        {
        }

        public void Dispose()
        {
        }
    }

    private sealed record LogEntry(LogLevel Level, string Message);
}
