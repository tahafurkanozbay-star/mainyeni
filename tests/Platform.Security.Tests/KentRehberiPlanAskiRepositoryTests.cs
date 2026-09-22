using Api.User.KentRehberi;
using System;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiPlanAskiRepositoryTests
{
    [Fact]
    public async Task Search_WithTurLoadsOnlyRequestedOfficialCategory()
    {
        var requested =
            new System.Collections.Concurrent
                .ConcurrentBag<short>();

        using var fixture =
            CreateRepositoryFixture(
                (request, _) =>
                {
                    var tur =
                        ReadTur(request);
                    requested.Add(tur);

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
                                            "Çankaya",
                                            "Kızılay"))));
                });

        var result =
            await fixture.Repository.SearchAsync(
                new KentRehberiSearchCriteria(
                    Ilce: null,
                    Mahalle: null,
                    Tur: 12,
                    Query: null,
                    Bounds: null,
                    AfterObjectId: null,
                    Limit: 50),
                CancellationToken.None);

        var feature =
            Assert.Single(result.Features);

        Assert.Equal(
            (short)12,
            feature.Properties.Tur);
        Assert.Equal(
            new short[]
            {
                12
            },
            requested
                .OrderBy(value => value)
                .ToArray());
    }

    [Fact]
    public async Task Search_AcceptsBoundaryTypesZeroAndFortyTwo()
    {
        using var fixture =
            CreateRepositoryFixture(
                TypePayload);

        var zero =
            await fixture.Repository.SearchAsync(
                Search(
                    tur: 0),
                CancellationToken.None);
        var fortyTwo =
            await fixture.Repository.SearchAsync(
                Search(
                    tur: 42),
                CancellationToken.None);

        Assert.Equal(
            (short)0,
            Assert.Single(
                    zero.Features)
                .Properties.Tur);
        Assert.Equal(
            (short)42,
            Assert.Single(
                    fortyTwo.Features)
                .Properties.Tur);
    }

    [Fact]
    public async Task Search_OutOfRangeTurReturnsEmptyWithoutNetwork()
    {
        var calls = 0;

        using var fixture =
            CreateRepositoryFixture(
                (_, _) =>
                {
                    Interlocked.Increment(
                        ref calls);
                    return Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse("[]"));
                });

        var result =
            await fixture.Repository.SearchAsync(
                Search(
                    tur: 43),
                CancellationToken.None);

        Assert.Empty(result.Features);
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task Search_AppliesTurkishDistrictNeighborhoodAndTextFilters()
    {
        var payload =
            KentRehberiPlanAskiTestSupport
                .ArrayPayload(
                    7,
                    (
                        1,
                        "ÇİĞDEM PARKI",
                        32.80,
                        39.90,
                        "ÇANKAYA",
                        "Çiğdem"),
                    (
                        2,
                        "GENÇLİK PARKI",
                        32.85,
                        39.94,
                        "ALTINDAĞ",
                        "Doğanbey"),
                    (
                        3,
                        "Kuğulu Park",
                        32.86,
                        39.90,
                        "Çankaya",
                        "Kavaklıdere"));

        using var fixture =
            CreateRepositoryFixture(
                (_, _) =>
                    Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(payload)));

        var result =
            await fixture.Repository.SearchAsync(
                new KentRehberiSearchCriteria(
                    Ilce: "cankaya",
                    Mahalle: "cigdem",
                    Tur: 7,
                    Query: "CIGDEM",
                    Bounds: null,
                    AfterObjectId: null,
                    Limit: 50),
                CancellationToken.None);

        var feature =
            Assert.Single(result.Features);

        Assert.Equal(1, feature.Id);
        Assert.Equal(
            "ÇİĞDEM PARKI",
            feature.Properties.Adi);
    }

    [Fact]
    public async Task Search_AppliesBoundingBoxToPointCoordinates()
    {
        var payload =
            KentRehberiPlanAskiTestSupport
                .ArrayPayload(
                    7,
                    (
                        1,
                        "Inside",
                        32.85,
                        39.92,
                        null,
                        null),
                    (
                        2,
                        "Outside",
                        33.25,
                        40.20,
                        null,
                        null));

        using var fixture =
            CreateRepositoryFixture(
                (_, _) =>
                    Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(payload)));

        var result =
            await fixture.Repository.SearchAsync(
                new KentRehberiSearchCriteria(
                    Ilce: null,
                    Mahalle: null,
                    Tur: 7,
                    Query: null,
                    Bounds:
                        new KentRehberiBounds(
                            32.7,
                            39.8,
                            33.0,
                            40.0),
                    AfterObjectId: null,
                    Limit: 50),
                CancellationToken.None);

        var feature =
            Assert.Single(result.Features);

        Assert.Equal(1, feature.Id);
    }

    [Fact]
    public async Task Search_PaginatesByStableObjectId()
    {
        var payload =
            KentRehberiPlanAskiTestSupport
                .ArrayPayload(
                    7,
                    (
                        1,
                        "One",
                        32.81,
                        39.91,
                        null,
                        null),
                    (
                        2,
                        "Two",
                        32.82,
                        39.92,
                        null,
                        null),
                    (
                        3,
                        "Three",
                        32.83,
                        39.93,
                        null,
                        null),
                    (
                        4,
                        "Four",
                        32.84,
                        39.94,
                        null,
                        null));

        using var fixture =
            CreateRepositoryFixture(
                (_, _) =>
                    Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(payload)),
                options =>
                    options.ObjectIdCursorEnabled =
                        true);

        var first =
            await fixture.Repository.SearchAsync(
                new KentRehberiSearchCriteria(
                    null,
                    null,
                    7,
                    null,
                    null,
                    null,
                    2),
                CancellationToken.None);

        Assert.Equal(
            new[]
            {
                1,
                2
            },
            first.Features
                .Select(feature => feature.Id)
                .ToArray());
        Assert.True(first.Meta.HasMore);
        Assert.Equal(
            2,
            first.Meta.NextAfterObjectId);

        var second =
            await fixture.Repository.SearchAsync(
                new KentRehberiSearchCriteria(
                    null,
                    null,
                    7,
                    null,
                    null,
                    first.Meta.NextAfterObjectId,
                    2),
                CancellationToken.None);

        Assert.Equal(
            new[]
            {
                3,
                4
            },
            second.Features
                .Select(feature => feature.Id)
                .ToArray());
        Assert.False(second.Meta.HasMore);
    }

    [Fact]
    public async Task Search_WithoutTurLoadsAllConfiguredCategories()
    {
        using var fixture =
            CreateRepositoryFixture(
                TypePayload,
                options =>
                {
                    options.PlanAskiMinTur = 0;
                    options.PlanAskiMaxTur = 3;
                });

        var result =
            await fixture.Repository.SearchAsync(
                new KentRehberiSearchCriteria(
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    50),
                CancellationToken.None);

        Assert.Equal(4, result.Features.Count);
        Assert.Equal(
            new short[]
            {
                0,
                1,
                2,
                3
            },
            result.Features
                .Select(
                    feature =>
                        feature.Properties.Tur!.Value)
                .OrderBy(value => value)
                .ToArray());
    }

    [Fact]
    public async Task Search_WithoutTurRejectsDuplicateObjectIdAcrossTypes()
    {
        using var fixture =
            CreateRepositoryFixture(
                (request, _) =>
                {
                    var tur =
                        ReadTur(request);

                    return Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(
                                KentRehberiPlanAskiTestSupport
                                    .ArrayPayload(
                                        tur,
                                        (
                                            1,
                                            $"Tür {tur}",
                                            32.85,
                                            39.92,
                                            null,
                                            null))));
                },
                options =>
                {
                    options.PlanAskiMinTur = 0;
                    options.PlanAskiMaxTur = 1;
                });

        await Assert.ThrowsAsync<
            KentRehberiDataIntegrityException>(
            () =>
                fixture.Repository.SearchAsync(
                    new KentRehberiSearchCriteria(
                        null,
                        null,
                        null,
                        null,
                        null,
                        null,
                        50),
                    CancellationToken.None));
    }

    [Fact]
    public async Task Nearby_ComputesDistanceAndSortsNearestFirst()
    {
        var payload =
            KentRehberiPlanAskiTestSupport
                .ArrayPayload(
                    7,
                    (
                        1,
                        "Nearest",
                        32.8501,
                        39.9201,
                        null,
                        null),
                    (
                        2,
                        "Farther",
                        32.86,
                        39.93,
                        null,
                        null),
                    (
                        3,
                        "Outside",
                        33.5,
                        40.5,
                        null,
                        null));

        using var fixture =
            CreateRepositoryFixture(
                (_, _) =>
                    Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(payload)));

        var result =
            await fixture.Repository.FindNearbyAsync(
                new KentRehberiNearbyCriteria(
                    Longitude: 32.85,
                    Latitude: 39.92,
                    RadiusMeters: 5_000,
                    Ilce: null,
                    Mahalle: null,
                    Tur: 7,
                    Query: null,
                    Limit: 10),
                CancellationToken.None);

        Assert.Equal(
            new[]
            {
                1,
                2
            },
            result.Features
                .Select(feature => feature.Id)
                .ToArray());
        Assert.True(
            result.Features[0]
                .Properties.DistanceMeters <
            result.Features[1]
                .Properties.DistanceMeters);
        Assert.All(
            result.Features,
            feature =>
                Assert.InRange(
                    feature.Properties
                        .DistanceMeters!.Value,
                    0,
                    5_000));
    }

    [Fact]
    public async Task Nearby_IgnoresRecordsWithoutCoordinates()
    {
        var payload =
            """
            [
              {
                "objectid": 1,
                "adi": "No coordinate",
                "tur": 7
              },
              {
                "objectid": 2,
                "adi": "Point",
                "tur": 7,
                "x": 32.85,
                "y": 39.92
              }
            ]
            """;

        using var fixture =
            CreateRepositoryFixture(
                (_, _) =>
                    Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(payload)));

        var result =
            await fixture.Repository.FindNearbyAsync(
                new KentRehberiNearbyCriteria(
                    32.85,
                    39.92,
                    500,
                    null,
                    null,
                    7,
                    null,
                    10),
                CancellationToken.None);

        Assert.Equal(
            2,
            Assert.Single(
                    result.Features)
                .Id);
    }

    [Fact]
    public async Task GetByObjectId_SearchesAllTypesAndReturnsUniqueRecord()
    {
        using var fixture =
            CreateRepositoryFixture(
                TypePayload,
                options =>
                {
                    options.PlanAskiMinTur = 0;
                    options.PlanAskiMaxTur = 4;
                });

        var result =
            await fixture.Repository.GetByObjectIdAsync(
                103,
                CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(103, result!.Id);
        Assert.Equal(
            (short)3,
            result.Properties.Tur);
    }

    [Fact]
    public async Task GetByObjectId_ReturnsNullWhenRecordDoesNotExist()
    {
        using var fixture =
            CreateRepositoryFixture(
                TypePayload,
                options =>
                {
                    options.PlanAskiMinTur = 0;
                    options.PlanAskiMaxTur = 2;
                });

        var result =
            await fixture.Repository.GetByObjectIdAsync(
                9999,
                CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task GetByObjectId_RejectsDuplicateIdentityAcrossTypes()
    {
        using var fixture =
            CreateRepositoryFixture(
                (request, _) =>
                {
                    var tur =
                        ReadTur(request);

                    return Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(
                                KentRehberiPlanAskiTestSupport
                                    .ArrayPayload(
                                        tur,
                                        (
                                            500,
                                            $"Tür {tur}",
                                            32.85,
                                            39.92,
                                            null,
                                            null))));
                },
                options =>
                {
                    options.PlanAskiMinTur = 0;
                    options.PlanAskiMaxTur = 1;
                });

        await Assert.ThrowsAsync<
            KentRehberiDataIntegrityException>(
            () =>
                fixture.Repository.GetByObjectIdAsync(
                    500,
                    CancellationToken.None));
    }

    [Fact]
    public async Task TypeCatalog_ContainsEveryTurIncludingEmptyCategories()
    {
        using var fixture =
            CreateRepositoryFixture(
                (request, _) =>
                {
                    var tur =
                        ReadTur(request);

                    var payload =
                        tur == 1
                            ? KentRehberiPlanAskiTestSupport
                                .ArrayPayload(
                                    tur,
                                    (
                                        101,
                                        "Only record",
                                        32.85,
                                        39.92,
                                        null,
                                        null))
                            : "[]";

                    return Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(payload));
                },
                options =>
                {
                    options.PlanAskiMinTur = 0;
                    options.PlanAskiMaxTur = 2;
                });

        var catalog =
            await fixture.Repository.GetTypeCatalogAsync(
                CancellationToken.None);

        Assert.Equal(3, catalog.Types.Count);
        Assert.Equal(
            new short[]
            {
                0,
                1,
                2
            },
            catalog.Types
                .Select(type => type.Tur)
                .ToArray());
        Assert.Equal(0, catalog.Types[0].Count);
        Assert.Equal(1, catalog.Types[1].Count);
        Assert.Empty(catalog.Types[2].Samples);
    }

    [Fact]
    public async Task TypeCatalog_SelectsDistributedSamplesAcrossLargeCategory()
    {
        var records =
            Enumerable.Range(1, 20)
                .Select(
                    index =>
                        (
                            ObjectId: index,
                            Name: $"Park {index}",
                            X: 32.8 + index / 1000d,
                            Y: 39.9 + index / 1000d,
                            District: (string?)"Çankaya",
                            Neighborhood: (string?)null))
                .ToArray();

        using var fixture =
            CreateRepositoryFixture(
                (_, _) =>
                    Task.FromResult(
                        KentRehberiPlanAskiTestSupport
                            .JsonResponse(
                                KentRehberiPlanAskiTestSupport
                                    .ArrayPayload(
                                        7,
                                        records))),
                options =>
                {
                    options.PlanAskiMinTur = 7;
                    options.PlanAskiMaxTur = 7;
                    options.TypeCatalogSamplesPerType = 4;
                });

        var descriptor =
            Assert.Single(
                (await fixture.Repository
                    .GetTypeCatalogAsync(
                        CancellationToken.None))
                .Types);

        Assert.Equal(20, descriptor.Count);
        Assert.Equal(4, descriptor.Samples.Count);
        Assert.Equal(1, descriptor.Samples[0].ObjectId);
        Assert.Equal(
            20,
            descriptor.Samples[^1].ObjectId);
        Assert.Contains(
            descriptor.Samples,
            sample =>
                sample.ObjectId is >= 6 and <= 8);
        Assert.Contains(
            descriptor.Samples,
            sample =>
                sample.ObjectId is >= 13 and <= 15);
    }

    [Fact]
    public async Task TypeCatalog_ReusesWarmSourceCache()
    {
        var calls = 0;

        using var fixture =
            CreateRepositoryFixture(
                (request, _) =>
                {
                    Interlocked.Increment(
                        ref calls);
                    return TypePayload(
                        request,
                        CancellationToken.None);
                },
                options =>
                {
                    options.PlanAskiMinTur = 0;
                    options.PlanAskiMaxTur = 2;
                });

        await fixture.Repository.GetTypeCatalogAsync(
            CancellationToken.None);
        await fixture.Repository.GetTypeCatalogAsync(
            CancellationToken.None);

        Assert.Equal(3, calls);
    }

    [Fact]
    public async Task SearchAfterCatalog_UsesAlreadyCachedTurPayload()
    {
        var calls = 0;

        using var fixture =
            CreateRepositoryFixture(
                (request, _) =>
                {
                    Interlocked.Increment(
                        ref calls);
                    return TypePayload(
                        request,
                        CancellationToken.None);
                },
                options =>
                {
                    options.PlanAskiMinTur = 0;
                    options.PlanAskiMaxTur = 3;
                });

        await fixture.Repository.GetTypeCatalogAsync(
            CancellationToken.None);

        var result =
            await fixture.Repository.SearchAsync(
                Search(
                    tur: 2),
                CancellationToken.None);

        Assert.Single(result.Features);
        Assert.Equal(4, calls);
    }

    [Fact]
    public void RepositoryConfigurationTracksOfficialSource()
    {
        using var configured =
            CreateRepositoryFixture(
                TypePayload);

        Assert.True(
            configured.Repository.IsConfigured);

        using var invalid =
            CreateRepositoryFixture(
                TypePayload,
                options =>
                    options.PlanAskiBaseUri =
                        "https://example.invalid/kentrehberi");

        Assert.False(
            invalid.Repository.IsConfigured);
    }

    private static KentRehberiSearchCriteria Search(
        short? tur) =>
        new(
            Ilce: null,
            Mahalle: null,
            Tur: tur,
            Query: null,
            Bounds: null,
            AfterObjectId: null,
            Limit: 50);

    private static Task<HttpResponseMessage> TypePayload(
        HttpRequestMessage request,
        CancellationToken _)
    {
        var tur =
            ReadTur(request);

        return Task.FromResult(
            KentRehberiPlanAskiTestSupport
                .JsonResponse(
                    KentRehberiPlanAskiTestSupport
                        .ArrayPayload(
                            tur,
                            (
                                100 + tur,
                                $"Tür {tur}",
                                32.85 + tur / 1000d,
                                39.92 + tur / 1000d,
                                "Çankaya",
                                null))));
    }

    private static short ReadTur(
        HttpRequestMessage request)
    {
        var query =
            request.RequestUri!
                .Query
                .TrimStart('?');

        var parts =
            query.Split(
                '=',
                StringSplitOptions
                    .RemoveEmptyEntries);

        Assert.Equal(
            "tur",
            parts[0]);

        return short.Parse(
            parts[1],
            CultureInfo.InvariantCulture);
    }

    private static RepositoryFixture
        CreateRepositoryFixture(
            Func<
                HttpRequestMessage,
                CancellationToken,
                Task<HttpResponseMessage>>
                callback,
            Action<KentRehberiOptions>?
                configure = null)
    {
        var sourceFixture =
            KentRehberiPlanAskiTestSupport
                .CreateFixture(
                    callback,
                    configure);

        return new RepositoryFixture(
            sourceFixture,
            new KentRehberiPlanAskiRepository(
                sourceFixture.Source,
                sourceFixture.Options));
    }

    private sealed class RepositoryFixture :
        IDisposable
    {
        public RepositoryFixture(
            PlanAskiFixture sourceFixture,
            KentRehberiPlanAskiRepository repository)
        {
            SourceFixture =
                sourceFixture;
            Repository =
                repository;
        }

        public PlanAskiFixture SourceFixture { get; }

        public KentRehberiPlanAskiRepository Repository { get; }

        public void Dispose()
        {
            SourceFixture.Dispose();
        }
    }
}
