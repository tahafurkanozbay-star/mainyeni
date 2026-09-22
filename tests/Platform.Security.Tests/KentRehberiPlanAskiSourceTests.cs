using Api.User.KentRehberi;
using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiPlanAskiSourceTests
{
    [Fact]
    public async Task GetType_UsesOnlyOfficialHttpsEndpointAndRequestedTur()
    {
        Uri? requested = null;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (request, _) =>
                    {
                        requested =
                            request.RequestUri;

                        return Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]"));
                    });

        var result =
            await fixture.Source.GetTypeAsync(
                0,
                CancellationToken.None);

        Assert.Empty(result);
        Assert.NotNull(requested);
        Assert.Equal(
            Uri.UriSchemeHttps,
            requested!.Scheme);
        Assert.Equal(
            "planaski.ankara.bel.tr",
            requested.Host);
        Assert.Equal(
            "/kentrehberiapi/api/kentrehberi",
            requested.AbsolutePath);
        Assert.Equal(
            "?tur=0",
            requested.Query);
    }

    [Fact]
    public async Task GetType_ParsesFlatArrayAndSnakeCaseFields()
    {
        var payload =
            """
            [
              {
                "objectid": 101,
                "adi": "Kadın Danışma Merkezi",
                "adres": "Kızılay / Ankara",
                "ilce": "Çankaya",
                "mahalle": "Kızılay",
                "x": "32.8541",
                "y": "39.9208",
                "tur": 12,
                "yapan": 1,
                "web_sayfasi": "https://example.invalid/kadin",
                "durak_no": "14501"
              }
            ]
            """;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        var records =
            await fixture.Source.GetTypeAsync(
                12,
                CancellationToken.None);

        var feature =
            Assert.Single(records);

        Assert.Equal(101, feature.Id);
        Assert.Equal(
            "Kadın Danışma Merkezi",
            feature.Properties.Adi);
        Assert.Equal(
            "Çankaya",
            feature.Properties.Ilce);
        Assert.Equal(
            32.8541,
            feature.Properties.X);
        Assert.Equal(
            39.9208,
            feature.Properties.Y);
        Assert.Equal(
            (short)12,
            feature.Properties.Tur);
        Assert.Equal(
            "14501",
            feature.Properties.DurakNo);
        Assert.NotNull(feature.Geometry);
        Assert.Equal(
            "Point",
            feature.Geometry!["type"]!
                .GetValue<string>());
    }

    [Theory]
    [InlineData("""{"isSuccess":true,"data":null}""")]
    [InlineData("""{"success":true,"results":null}""")]
    public async Task GetType_TreatsExplicitSuccessfulNullEnvelopeAsEmpty(
        string payload)
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        var records =
            await fixture.Source.GetTypeAsync(
                7,
                CancellationToken.None);

        Assert.Empty(records);
    }

    [Theory]
    [InlineData("""{"isSuccess":false,"data":null}""")]
    [InlineData("""{"success":false,"results":[]}""")]
    public async Task GetType_RejectsExplicitUnsuccessfulEnvelope(
        string payload)
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        await Assert.ThrowsAsync<
            KentRehberiPlanAskiProtocolException>(
            () =>
                fixture.Source.GetTypeAsync(
                    7,
                    CancellationToken.None));
    }

    [Fact]
    public async Task GetType_ParsesDataEnvelope()
    {
        var payload =
            """
            {
              "isSuccess": true,
              "data": [
                {
                  "OBJECTID": "9",
                  "ADI": "Kuğulu Park",
                  "ADRES": "Çankaya",
                  "ILCE": "Çankaya",
                  "MAHALLE": "Kavaklıdere",
                  "X": 32.8598,
                  "Y": 39.9019,
                  "TUR": "7"
                }
              ]
            }
            """;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        var feature =
            Assert.Single(
                await fixture.Source.GetTypeAsync(
                    7,
                    CancellationToken.None));

        Assert.Equal(9, feature.Id);
        Assert.Equal(
            "Kuğulu Park",
            feature.Properties.Adi);
        Assert.Equal(
            (short)7,
            feature.Properties.Tur);
    }

    [Fact]
    public async Task GetType_ParsesNestedResultEnvelope()
    {
        var payload =
            """
            {
              "result": {
                "records": [
                  {
                    "id": 44,
                    "name": "Teknoloji Merkezi",
                    "address": "Ankara",
                    "district": "Çankaya",
                    "neighborhood": "Mustafa Kemal",
                    "longitude": 32.805,
                    "latitude": 39.91,
                    "typeId": 21
                  }
                ]
              }
            }
            """;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        var feature =
            Assert.Single(
                await fixture.Source.GetTypeAsync(
                    21,
                    CancellationToken.None));

        Assert.Equal(44, feature.Id);
        Assert.Equal(
            "Teknoloji Merkezi",
            feature.Properties.Adi);
        Assert.Equal(
            "Mustafa Kemal",
            feature.Properties.Mahalle);
    }

    [Fact]
    public async Task GetType_ParsesGeoJsonFeatureCollection()
    {
        var payload =
            """
            {
              "type": "FeatureCollection",
              "features": [
                {
                  "type": "Feature",
                  "id": 55,
                  "geometry": {
                    "type": "Point",
                    "coordinates": [32.75, 39.95]
                  },
                  "properties": {
                    "objectid": 55,
                    "adi": "Örnek Tesis",
                    "tur": 6
                  }
                }
              ]
            }
            """;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(
                                    payload,
                                    mediaType:
                                        "application/geo+json")));

        var feature =
            Assert.Single(
                await fixture.Source.GetTypeAsync(
                    6,
                    CancellationToken.None));

        Assert.Equal(32.75, feature.Properties.X);
        Assert.Equal(39.95, feature.Properties.Y);
        Assert.NotNull(feature.Geometry);
    }

    [Fact]
    public async Task GetType_RejectsRecordFromDifferentTur()
    {
        var payload =
            KentRehberiPlanAskiTestSupport
                .ArrayPayload(
                    8,
                    (
                        1,
                        "Wrong",
                        32.85,
                        39.92,
                        "Çankaya",
                        null));

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        var exception =
            await Assert.ThrowsAsync<
                KentRehberiPlanAskiProtocolException>(
                () =>
                    fixture.Source.GetTypeAsync(
                        7,
                        CancellationToken.None));

        Assert.Contains(
            "different type",
            exception.Message,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetType_RejectsDuplicateObjectIdsWithinOneTur()
    {
        var payload =
            KentRehberiPlanAskiTestSupport
                .ArrayPayload(
                    7,
                    (
                        1,
                        "Park A",
                        32.85,
                        39.92,
                        "Çankaya",
                        null),
                    (
                        1,
                        "Park B",
                        32.86,
                        39.93,
                        "Çankaya",
                        null));

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        await Assert.ThrowsAsync<
            KentRehberiPlanAskiProtocolException>(
            () =>
                fixture.Source.GetTypeAsync(
                    7,
                    CancellationToken.None));
    }

    [Theory]
    [InlineData("""[{"adi":"Missing id","x":32.8,"y":39.9,"tur":7}]""")]
    [InlineData("""[{"objectid":0,"adi":"Zero id","x":32.8,"y":39.9,"tur":7}]""")]
    [InlineData("""[{"objectid":"abc","adi":"Text id","x":32.8,"y":39.9,"tur":7}]""")]
    public async Task GetType_RejectsInvalidIdentity(
        string payload)
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        await Assert.ThrowsAsync<
            KentRehberiPlanAskiProtocolException>(
            () =>
                fixture.Source.GetTypeAsync(
                    7,
                    CancellationToken.None));
    }

    [Theory]
    [InlineData("""[{"objectid":1,"x":32.8,"tur":7}]""")]
    [InlineData("""[{"objectid":1,"x":181,"y":39.9,"tur":7}]""")]
    [InlineData("""[{"objectid":1,"x":32.8,"y":91,"tur":7}]""")]
    public async Task GetType_RejectsInvalidCoordinatePairs(
        string payload)
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)));

        await Assert.ThrowsAsync<
            KentRehberiPlanAskiProtocolException>(
            () =>
                fixture.Source.GetTypeAsync(
                    7,
                    CancellationToken.None));
    }

    [Fact]
    public async Task GetType_RejectsUnsupportedContentType()
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(
                                    "[]",
                                    mediaType:
                                        "text/html")));

        var exception =
            await Assert.ThrowsAsync<
                KentRehberiPlanAskiProtocolException>(
                () =>
                    fixture.Source.GetTypeAsync(
                        7,
                        CancellationToken.None));

        Assert.DoesNotContain(
            "text/html",
            exception.Message,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetType_DoesNotReflectUpstreamErrorBody()
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            new HttpResponseMessage(
                                HttpStatusCode
                                    .ServiceUnavailable)
                            {
                                Content =
                                    new StringContent(
                                        "Password=secret;Host=internal-db")
                            }));

        var exception =
            await Assert.ThrowsAsync<
                KentRehberiPlanAskiUnavailableException>(
                () =>
                    fixture.Source.GetTypeAsync(
                        7,
                        CancellationToken.None));

        Assert.Contains(
            "HTTP 503",
            exception.Message,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "secret",
            exception.Message,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "internal-db",
            exception.Message,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetType_RejectsRedirectsWithoutFollowingThem()
    {
        var calls = 0;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                    {
                        Interlocked.Increment(
                            ref calls);

                        var response =
                            new HttpResponseMessage(
                                HttpStatusCode
                                    .Found);
                        response.Headers.Location =
                            new Uri(
                                "https://example.invalid/escape");

                        return Task.FromResult(
                            response);
                    });

        await Assert.ThrowsAsync<
            KentRehberiPlanAskiUnavailableException>(
            () =>
                fixture.Source.GetTypeAsync(
                    7,
                    CancellationToken.None));

        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task GetType_RejectsDeclaredPayloadBeyondBudget()
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                    {
                        var response =
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]");
                        response.Content.Headers.ContentLength =
                            2 * 1024 * 1024;

                        return Task.FromResult(
                            response);
                    },
                    options =>
                        options.PlanAskiMaxResponseBytesPerType =
                            1024 * 1024);

        await Assert.ThrowsAsync<
            KentRehberiPlanAskiProtocolException>(
            () =>
                fixture.Source.GetTypeAsync(
                    7,
                    CancellationToken.None));
    }

    [Fact]
    public async Task GetType_RejectsRecordCountBeyondBudget()
    {
        var payload =
            """
            [
              {"objectid":1,"x":32.8,"y":39.9,"tur":7},
              {"objectid":2,"x":32.8,"y":39.9,"tur":7}
            ]
            """;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(payload)),
                    options =>
                        options.PlanAskiMaxRecordsPerType =
                            1);

        await Assert.ThrowsAsync<
            KentRehberiPlanAskiProtocolException>(
            () =>
                fixture.Source.GetTypeAsync(
                    7,
                    CancellationToken.None));
    }

    [Fact]
    public async Task GetType_CachesSuccessfulTurResponses()
    {
        var calls = 0;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                    {
                        Interlocked.Increment(
                            ref calls);
                        return Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(
                                    KentRehberiPlanAskiTestSupport
                                        .ArrayPayload(
                                            7,
                                            (
                                                1,
                                                "Park",
                                                32.85,
                                                39.92,
                                                null,
                                                null))));
                    });

        var first =
            await fixture.Source.GetTypeAsync(
                7,
                CancellationToken.None);
        var second =
            await fixture.Source.GetTypeAsync(
                7,
                CancellationToken.None);

        Assert.Same(first, second);
        Assert.Equal(1, calls);

        var snapshot =
            fixture.Source.GetSnapshot();

        Assert.Equal(1, snapshot.CachedTypes);
        Assert.Equal(1, snapshot.CacheHits);
        Assert.Equal(1, snapshot.CacheMisses);
        Assert.Equal(1, snapshot.FetchCompleted);
    }

    [Fact]
    public async Task GetType_RefreshesAfterCacheExpiry()
    {
        var calls = 0;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                    {
                        var id =
                            Interlocked.Increment(
                                ref calls);

                        return Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(
                                    KentRehberiPlanAskiTestSupport
                                        .ArrayPayload(
                                            7,
                                            (
                                                id,
                                                "Park",
                                                32.85,
                                                39.92,
                                                null,
                                                null))));
                    },
                    options =>
                        options.PlanAskiCacheTtlSeconds =
                            15);

        var first =
            await fixture.Source.GetTypeAsync(
                7,
                CancellationToken.None);

        fixture.Clock.Advance(
            TimeSpan.FromSeconds(16));

        var second =
            await fixture.Source.GetTypeAsync(
                7,
                CancellationToken.None);

        Assert.Equal(1, first[0].Id);
        Assert.Equal(2, second[0].Id);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task GetType_DeduplicatesConcurrentFetchesForSameTur()
    {
        var calls = 0;
        var entered =
            new TaskCompletionSource<bool>(
                TaskCreationOptions
                    .RunContinuationsAsynchronously);
        var release =
            new TaskCompletionSource<bool>(
                TaskCreationOptions
                    .RunContinuationsAsynchronously);

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    async (_, token) =>
                    {
                        Interlocked.Increment(
                            ref calls);
                        entered.TrySetResult(true);

                        await release.Task.WaitAsync(
                            token);

                        return KentRehberiPlanAskiTestSupport
                            .JsonResponse(
                                KentRehberiPlanAskiTestSupport
                                    .ArrayPayload(
                                        7,
                                        (
                                            1,
                                            "Park",
                                            32.85,
                                            39.92,
                                            null,
                                            null)));
                    });

        var first =
            fixture.Source.GetTypeAsync(
                7,
                CancellationToken.None);

        await entered.Task;

        var second =
            fixture.Source.GetTypeAsync(
                7,
                CancellationToken.None);

        release.SetResult(true);

        var results =
            await Task.WhenAll(
                first,
                second);

        Assert.Equal(1, calls);
        Assert.Same(
            results[0],
            results[1]);
        Assert.Equal(
            0,
            fixture.Source
                .GetSnapshot()
                .InFlightTypes);
    }

    [Fact]
    public async Task CancelledSubscriber_DoesNotCancelSharedFetch()
    {
        var entered =
            new TaskCompletionSource<bool>(
                TaskCreationOptions
                    .RunContinuationsAsynchronously);
        var release =
            new TaskCompletionSource<bool>(
                TaskCreationOptions
                    .RunContinuationsAsynchronously);

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    async (_, token) =>
                    {
                        entered.TrySetResult(true);
                        await release.Task.WaitAsync(
                            token);

                        return KentRehberiPlanAskiTestSupport
                            .JsonResponse(
                                KentRehberiPlanAskiTestSupport
                                    .ArrayPayload(
                                        7,
                                        (
                                            1,
                                            "Park",
                                            32.85,
                                            39.92,
                                            null,
                                            null)));
                    });

        using var cancellation =
            new CancellationTokenSource();

        var cancelled =
            fixture.Source.GetTypeAsync(
                7,
                cancellation.Token);

        await entered.Task;

        var survivor =
            fixture.Source.GetTypeAsync(
                7,
                CancellationToken.None);

        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<
            OperationCanceledException>(
            () => cancelled);

        release.SetResult(true);

        var result =
            await survivor;

        Assert.Single(result);
        Assert.Equal(
            1,
            fixture.Source
                .GetSnapshot()
                .FetchCompleted);
    }

    [Fact]
    public async Task GetAllTypes_CoversConfiguredInclusiveTurRange()
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (request, _) =>
                    {
                        var query =
                            request.RequestUri!
                                .Query
                                .TrimStart('?')
                                .Split('=')[1];
                        var tur =
                            short.Parse(
                                query,
                                System.Globalization
                                    .CultureInfo
                                    .InvariantCulture);

                        return Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse(
                                    KentRehberiPlanAskiTestSupport
                                        .ArrayPayload(
                                            tur,
                                            (
                                                100 + tur,
                                                $"Tür {tur}",
                                                32.85,
                                                39.92,
                                                null,
                                                null))));
                    },
                    options =>
                    {
                        options.PlanAskiMinTur = 0;
                        options.PlanAskiMaxTur = 4;
                    });

        var all =
            await fixture.Source.GetAllTypesAsync(
                CancellationToken.None);

        Assert.Equal(
            new short[]
            {
                0,
                1,
                2,
                3,
                4
            },
            all.Keys
                .OrderBy(value => value)
                .ToArray());

        Assert.All(
            all,
            pair =>
                Assert.Equal(
                    (short?)pair.Key,
                    pair.Value[0]
                        .Properties.Tur));
    }

    [Fact]
    public async Task GetAllTypes_RespectsConfiguredNetworkConcurrency()
    {
        var probe =
            new ConcurrencyProbe();

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    async (request, token) =>
                    {
                        using var lease =
                            probe.Enter();

                        await Task.Delay(
                            25,
                            token);

                        var query =
                            request.RequestUri!
                                .Query
                                .TrimStart('?')
                                .Split('=')[1];
                        var tur =
                            short.Parse(
                                query,
                                System.Globalization
                                    .CultureInfo
                                    .InvariantCulture);

                        return KentRehberiPlanAskiTestSupport
                            .JsonResponse(
                                KentRehberiPlanAskiTestSupport
                                    .ArrayPayload(
                                        tur,
                                        (
                                            100 + tur,
                                            $"Tür {tur}",
                                            32.85,
                                            39.92,
                                            null,
                                            null)));
                    },
                    options =>
                    {
                        options.PlanAskiMinTur = 0;
                        options.PlanAskiMaxTur = 12;
                        options.PlanAskiMaxConcurrentRequests = 3;
                    });

        var all =
            await fixture.Source.GetAllTypesAsync(
                CancellationToken.None);

        Assert.Equal(13, all.Count);
        Assert.InRange(
            probe.Maximum,
            1,
            3);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(43)]
    public async Task GetType_RejectsTurOutsideConfiguredRange(
        short tur)
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]")));

        await Assert.ThrowsAsync<
            ArgumentOutOfRangeException>(
            () =>
                fixture.Source.GetTypeAsync(
                    tur,
                    CancellationToken.None));
    }

    [Fact]
    public async Task Clear_ForcesNextRequestToRefetch()
    {
        var calls = 0;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                    {
                        Interlocked.Increment(
                            ref calls);

                        return Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]"));
                    });

        await fixture.Source.GetTypeAsync(
            0,
            CancellationToken.None);

        fixture.Source.Clear();

        await fixture.Source.GetTypeAsync(
            0,
            CancellationToken.None);

        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task Probe_BypassesWarmCacheAndExercisesUpstream()
    {
        var calls = 0;

        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                    {
                        Interlocked.Increment(
                            ref calls);

                        return Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]"));
                    });

        await fixture.Source.GetTypeAsync(
            0,
            CancellationToken.None);

        await fixture.Source.ProbeAsync(
            CancellationToken.None);

        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task SourceRejectsNonOfficialConfiguredHost()
    {
        using var fixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    (_, _) =>
                        Task.FromResult(
                            KentRehberiPlanAskiTestSupport
                                .JsonResponse("[]")),
                    options =>
                        options.PlanAskiBaseUri =
                            "https://example.invalid/kentrehberiapi/api/kentrehberi");

        Assert.False(
            fixture.Source.IsConfigured);

        await Assert.ThrowsAsync<
            KentRehberiPlanAskiUnavailableException>(
            () =>
                fixture.Source.GetTypeAsync(
                    0,
                    CancellationToken.None));
    }
}
