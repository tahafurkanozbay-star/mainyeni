using Api.User.KentRehberi;
using Microsoft.Extensions.Logging.Abstractions;
using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Platform.Security.Tests;

internal sealed class StubHttpClientFactory :
    IHttpClientFactory,
    IDisposable
{
    private readonly HttpClient client;

    public StubHttpClientFactory(
        HttpMessageHandler handler)
    {
        client =
            new HttpClient(
                handler,
                disposeHandler: true)
            {
                Timeout =
                    Timeout.InfiniteTimeSpan
            };
    }

    public HttpClient CreateClient(
        string name) =>
        client;

    public void Dispose()
    {
        client.Dispose();
    }
}

internal sealed class DelegatingStubHttpMessageHandler :
    HttpMessageHandler
{
    private readonly Func<
        HttpRequestMessage,
        CancellationToken,
        Task<HttpResponseMessage>>
        callback;

    public DelegatingStubHttpMessageHandler(
        Func<
            HttpRequestMessage,
            CancellationToken,
            Task<HttpResponseMessage>>
            callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        this.callback = callback;
    }

    protected override Task<HttpResponseMessage>
        SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
        callback(
            request,
            cancellationToken);
}

internal static class KentRehberiPlanAskiTestSupport
{
    public static HttpResponseMessage JsonResponse(
        string json,
        HttpStatusCode status =
            HttpStatusCode.OK,
        string mediaType =
            "application/json")
    {
        return new HttpResponseMessage(
            status)
        {
            Content =
                new StringContent(
                    json,
                    Encoding.UTF8,
                    mediaType)
        };
    }

    public static string ArrayPayload(
        short tur,
        params (
            int ObjectId,
            string Name,
            double X,
            double Y,
            string? District,
            string? Neighborhood)[]
            records)
    {
        var builder =
            new StringBuilder();
        builder.Append('[');

        for (var index = 0;
             index < records.Length;
             index++)
        {
            if (index > 0)
            {
                builder.Append(',');
            }

            var record =
                records[index];

            builder.Append(
                $$"""
                {
                  "objectid": {{record.ObjectId}},
                  "adi": {{System.Text.Json.JsonSerializer.Serialize(record.Name)}},
                  "adres": "Ankara",
                  "ilce": {{System.Text.Json.JsonSerializer.Serialize(record.District)}},
                  "mahalle": {{System.Text.Json.JsonSerializer.Serialize(record.Neighborhood)}},
                  "x": "{{record.X.ToString(System.Globalization.CultureInfo.InvariantCulture)}}",
                  "y": "{{record.Y.ToString(System.Globalization.CultureInfo.InvariantCulture)}}",
                  "tur": {{tur}},
                  "yapan": 1,
                  "web_sayfasi": null,
                  "durak_no": null
                }
                """);
        }

        builder.Append(']');
        return builder.ToString();
    }

    public static PlanAskiFixture CreateFixture(
        Func<
            HttpRequestMessage,
            CancellationToken,
            Task<HttpResponseMessage>>
            callback,
        Action<KentRehberiOptions>? configure = null)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                {
                    value.Source =
                        KentRehberiOptions
                            .PlanAskiSource;
                    value.PlanAskiBaseUri =
                        KentRehberiOptions
                            .OfficialPlanAskiBaseUri;
                    value.PlanAskiMinTur = 0;
                    value.PlanAskiMaxTur = 42;
                    value.PlanAskiRequestTimeoutSeconds = 5;
                    value.PlanAskiCacheTtlSeconds = 60;
                    value.PlanAskiMaxConcurrentRequests = 4;
                    value.PlanAskiMaxRecordsPerType = 1_000;
                    value.PlanAskiMaxResponseBytesPerType =
                        1024 * 1024;
                    configure?.Invoke(value);
                });

        var clock =
            new ManualKentRehberiTimeProvider(
                new DateTimeOffset(
                    2026,
                    9,
                    22,
                    12,
                    0,
                    0,
                    TimeSpan.Zero));

        var handler =
            new DelegatingStubHttpMessageHandler(
                callback);
        var factory =
            new StubHttpClientFactory(
                handler);
        var source =
            new KentRehberiPlanAskiSource(
                factory,
                options,
                clock,
                NullLogger<
                    KentRehberiPlanAskiSource>
                    .Instance);

        return new PlanAskiFixture(
            options,
            clock,
            factory,
            source);
    }
}

internal sealed class PlanAskiFixture :
    IDisposable
{
    public PlanAskiFixture(
        KentRehberiOptions options,
        ManualKentRehberiTimeProvider clock,
        StubHttpClientFactory factory,
        KentRehberiPlanAskiSource source)
    {
        Options = options;
        Clock = clock;
        Factory = factory;
        Source = source;
    }

    public KentRehberiOptions Options { get; }

    public ManualKentRehberiTimeProvider Clock { get; }

    public StubHttpClientFactory Factory { get; }

    public KentRehberiPlanAskiSource Source { get; }

    public void Dispose()
    {
        Source.Dispose();
        Factory.Dispose();
    }
}

internal sealed class ConcurrencyProbe
{
    private int active;
    private int maximum;

    public int Maximum =>
        Volatile.Read(
            ref maximum);

    public IDisposable Enter()
    {
        var current =
            Interlocked.Increment(
                ref active);

        while (true)
        {
            var observed =
                Volatile.Read(
                    ref maximum);

            if (observed >= current)
            {
                break;
            }

            if (Interlocked.CompareExchange(
                    ref maximum,
                    current,
                    observed) ==
                observed)
            {
                break;
            }
        }

        return new Releaser(this);
    }

    private sealed class Releaser :
        IDisposable
    {
        private readonly ConcurrencyProbe owner;
        private int disposed;

        public Releaser(
            ConcurrencyProbe owner)
        {
            this.owner = owner;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(
                    ref disposed,
                    1) != 0)
            {
                return;
            }

            Interlocked.Decrement(
                ref owner.active);
        }
    }
}
