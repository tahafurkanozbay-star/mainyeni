using Api.User.KentRehberi;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiQueryServiceTests
{
    [Fact]
    public async Task Search_ExecutesRepositoryAndReturnsResult()
    {
        using var fixture = new QueryServiceFixture();
        var expected =
            KentRehberiRuntimeTestData.Collection();

        fixture.Repository.SearchHandler =
            (_, _) => Task.FromResult(expected);

        var actual =
            await fixture.Service.SearchAsync(
                KentRehberiRuntimeTestData.Search(),
                CancellationToken.None);

        Assert.Same(expected, actual);
        Assert.Equal(
            1,
            fixture.Repository.SearchCalls);
    }

    [Fact]
    public async Task Search_SecondIdenticalRequestUsesCache()
    {
        using var fixture = new QueryServiceFixture();

        var criteria =
            KentRehberiRuntimeTestData.Search();

        var first =
            await fixture.Service.SearchAsync(
                criteria,
                CancellationToken.None);
        var second =
            await fixture.Service.SearchAsync(
                criteria,
                CancellationToken.None);

        Assert.Same(first, second);
        Assert.Equal(
            1,
            fixture.Repository.SearchCalls);

        var telemetry =
            fixture.Telemetry.GetSnapshot();

        Assert.Equal(1, telemetry.CacheHits);
        Assert.Equal(1, telemetry.CacheMisses);
    }

    [Fact]
    public async Task Search_DifferentCriteriaDoNotCollide()
    {
        using var fixture = new QueryServiceFixture();

        await fixture.Service.SearchAsync(
            KentRehberiRuntimeTestData.Search(
                query: "park"),
            CancellationToken.None);

        await fixture.Service.SearchAsync(
            KentRehberiRuntimeTestData.Search(
                query: "metro"),
            CancellationToken.None);

        Assert.Equal(
            2,
            fixture.Repository.SearchCalls);
    }

    [Fact]
    public async Task Search_CacheCanBeDisabled()
    {
        using var fixture =
            new QueryServiceFixture(
                options =>
                    options.ResultCacheEnabled = false);

        var criteria =
            KentRehberiRuntimeTestData.Search();

        await fixture.Service.SearchAsync(
            criteria,
            CancellationToken.None);
        await fixture.Service.SearchAsync(
            criteria,
            CancellationToken.None);

        Assert.Equal(
            2,
            fixture.Repository.SearchCalls);
    }

    [Fact]
    public async Task Nearby_SecondIdenticalRequestUsesCache()
    {
        using var fixture = new QueryServiceFixture();

        var criteria =
            KentRehberiRuntimeTestData.Nearby();

        await fixture.Service.FindNearbyAsync(
            criteria,
            CancellationToken.None);
        await fixture.Service.FindNearbyAsync(
            criteria,
            CancellationToken.None);

        Assert.Equal(
            1,
            fixture.Repository.NearbyCalls);
        Assert.Equal(
            1,
            fixture.Telemetry.GetSnapshot().CacheHits);
    }

    [Fact]
    public async Task ObjectLookup_IsNotCachedAcrossCompletedCalls()
    {
        using var fixture = new QueryServiceFixture();

        await fixture.Service.GetByObjectIdAsync(
            10,
            CancellationToken.None);
        await fixture.Service.GetByObjectIdAsync(
            10,
            CancellationToken.None);

        Assert.Equal(
            2,
            fixture.Repository.ObjectCalls);
    }

    [Fact]
    public async Task ConcurrentIdenticalSearch_IsSingleFlighted()
    {
        using var fixture = new QueryServiceFixture();

        var gate =
            new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);

        fixture.Repository.SearchHandler =
            async (criteria, token) =>
            {
                await gate.Task.WaitAsync(token);
                return KentRehberiRuntimeTestData.Collection(
                    limit: criteria.Limit);
            };

        var criteria =
            KentRehberiRuntimeTestData.Search();

        var first =
            fixture.Service.SearchAsync(
                criteria,
                CancellationToken.None);
        var second =
            fixture.Service.SearchAsync(
                criteria,
                CancellationToken.None);

        await WaitUntilAsync(
            () =>
                fixture.Repository.SearchCalls == 1);

        gate.SetResult(true);

        await Task.WhenAll(first, second);

        Assert.Equal(
            1,
            fixture.Repository.SearchCalls);
        Assert.True(
            fixture.Telemetry
                .GetSnapshot()
                .SingleFlightJoins >= 1);
    }

    [Fact]
    public async Task ConcurrentDifferentSearches_RespectBulkhead()
    {
        using var fixture =
            new QueryServiceFixture(
                options =>
                {
                    options.MaxConcurrentQueries = 1;
                    options.MaxQueuedQueries = 1;
                });

        var gate =
            new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);

        fixture.Repository.SearchHandler =
            async (criteria, token) =>
            {
                await gate.Task.WaitAsync(token);
                return KentRehberiRuntimeTestData.Collection(
                    limit: criteria.Limit);
            };

        var first =
            fixture.Service.SearchAsync(
                KentRehberiRuntimeTestData.Search(
                    query: "first"),
                CancellationToken.None);

        await WaitUntilAsync(
            () =>
                fixture.Admission
                    .GetSnapshot()
                    .Active == 1);

        var second =
            fixture.Service.SearchAsync(
                KentRehberiRuntimeTestData.Search(
                    query: "second"),
                CancellationToken.None);

        await WaitUntilAsync(
            () =>
                fixture.Admission
                    .GetSnapshot()
                    .Queued == 1);

        Assert.False(second.IsCompleted);

        gate.SetResult(true);

        await Task.WhenAll(first, second);

        Assert.Equal(
            2,
            fixture.Repository.SearchCalls);
        Assert.Equal(
            0,
            fixture.Admission
                .GetSnapshot()
                .Queued);
    }

    [Fact]
    public async Task QueryBeyondQueueBudget_IsRejected()
    {
        using var fixture =
            new QueryServiceFixture(
                options =>
                {
                    options.MaxConcurrentQueries = 1;
                    options.MaxQueuedQueries = 0;
                    options.ResultCacheEnabled = false;
                });

        var gate =
            new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);

        fixture.Repository.SearchHandler =
            async (criteria, token) =>
            {
                await gate.Task.WaitAsync(token);
                return KentRehberiRuntimeTestData.Collection(
                    limit: criteria.Limit);
            };

        var first =
            fixture.Service.SearchAsync(
                KentRehberiRuntimeTestData.Search(
                    query: "first"),
                CancellationToken.None);

        await WaitUntilAsync(
            () =>
                fixture.Admission
                    .GetSnapshot()
                    .Active == 1);

        await Assert.ThrowsAsync<
            KentRehberiOverloadedException>(
            () =>
                fixture.Service.SearchAsync(
                    KentRehberiRuntimeTestData.Search(
                        query: "second"),
                    CancellationToken.None));

        gate.SetResult(true);
        await first;

        Assert.Equal(
            1,
            fixture.Telemetry
                .GetSnapshot()
                .AdmissionRejected);
    }

    [Fact]
    public async Task InvalidRepositoryPayload_IsRejectedBeforeCache()
    {
        using var fixture = new QueryServiceFixture();

        var valid =
            KentRehberiRuntimeTestData.Feature(1);
        var invalid =
            valid with
            {
                Type = "Wrong"
            };

        fixture.Repository.SearchHandler =
            (criteria, _) =>
                Task.FromResult(
                    KentRehberiFeatureCollection.Create(
                        new[] { invalid },
                        criteria.Limit,
                        false));

        await Assert.ThrowsAsync<
            KentRehberiDataIntegrityException>(
            () =>
                fixture.Service.SearchAsync(
                    KentRehberiRuntimeTestData.Search(),
                    CancellationToken.None));

        Assert.Equal(
            0,
            fixture.Cache
                .GetSnapshot()
                .Entries);
        Assert.Equal(
            1,
            fixture.Telemetry
                .GetSnapshot()
                .IntegrityRejected);
    }

    [Fact]
    public async Task InvalidObjectPayload_IsRejected()
    {
        using var fixture = new QueryServiceFixture();

        fixture.Repository.ObjectHandler =
            (objectId, _) =>
            {
                var valid =
                    KentRehberiRuntimeTestData.Feature(
                        objectId);

                return Task.FromResult<
                    KentRehberiFeature?>(
                    valid with
                    {
                        Properties =
                            valid.Properties with
                            {
                                ObjectId =
                                    objectId + 1
                            }
                    });
            };

        await Assert.ThrowsAsync<
            KentRehberiDataIntegrityException>(
            () =>
                fixture.Service.GetByObjectIdAsync(
                    10,
                    CancellationToken.None));
    }

    [Fact]
    public async Task MissingObject_IsValidAndDoesNotFailIntegrity()
    {
        using var fixture = new QueryServiceFixture();

        fixture.Repository.ObjectHandler =
            (_, _) =>
                Task.FromResult<
                    KentRehberiFeature?>(null);

        var result =
            await fixture.Service.GetByObjectIdAsync(
                10,
                CancellationToken.None);

        Assert.Null(result);
        Assert.Equal(
            1,
            fixture.Telemetry
                .GetSnapshot()
                .RequestsCompleted);
    }

    [Fact]
    public async Task SubscriberCancellation_IsPropagated()
    {
        using var fixture = new QueryServiceFixture();
        using var cts =
            new CancellationTokenSource();

        fixture.Repository.SearchHandler =
            async (_, token) =>
            {
                await Task.Delay(
                    TimeSpan.FromSeconds(30),
                    token);
                return KentRehberiRuntimeTestData.Collection();
            };

        var task =
            fixture.Service.SearchAsync(
                KentRehberiRuntimeTestData.Search(),
                cts.Token);

        cts.Cancel();

        await Assert.ThrowsAnyAsync<
            OperationCanceledException>(
            () => task);
    }

    [Fact]
    public async Task InternalDeadline_IsTranslatedToTimeout()
    {
        using var fixture =
            new QueryServiceFixture(
                options =>
                    options.QueryDeadlineMilliseconds = 250);

        fixture.Repository.SearchHandler =
            async (_, token) =>
            {
                await Task.Delay(
                    TimeSpan.FromSeconds(30),
                    token);
                return KentRehberiRuntimeTestData.Collection();
            };

        await Assert.ThrowsAsync<
            KentRehberiQueryDeadlineException>(
            () =>
                fixture.Service.SearchAsync(
                    KentRehberiRuntimeTestData.Search(),
                    CancellationToken.None));

        Assert.True(
            fixture.Telemetry
                .GetSnapshot()
                .DeadlineExceeded >= 1);
    }

    [Fact]
    public async Task RepositoryFailure_IsPropagatedAndCounted()
    {
        using var fixture = new QueryServiceFixture();

        fixture.Repository.SearchHandler =
            (_, _) =>
                Task.FromException<
                    KentRehberiFeatureCollection>(
                    new InvalidOperationException(
                        "synthetic"));

        await Assert.ThrowsAsync<
            InvalidOperationException>(
            () =>
                fixture.Service.SearchAsync(
                    KentRehberiRuntimeTestData.Search(),
                    CancellationToken.None));

        var snapshot =
            fixture.Telemetry.GetSnapshot();

        Assert.Equal(1, snapshot.RequestsFailed);
        Assert.Equal(0, snapshot.RequestsCompleted);
    }

    [Fact]
    public async Task SuccessfulSearch_RecordsBoundedMetrics()
    {
        using var fixture = new QueryServiceFixture();

        await fixture.Service.SearchAsync(
            KentRehberiRuntimeTestData.Search(),
            CancellationToken.None);

        var snapshot =
            fixture.Telemetry.GetSnapshot();

        Assert.Equal(1, snapshot.RequestsStarted);
        Assert.Equal(1, snapshot.RequestsCompleted);
        Assert.Equal(0, snapshot.RequestsFailed);
        Assert.Equal(0, snapshot.ActiveQueries);
        Assert.Equal(0, snapshot.QueuedQueries);
    }

    [Fact]
    public void ServiceConfigurationState_ComesFromRepository()
    {
        using var fixture = new QueryServiceFixture();

        Assert.True(fixture.Service.IsConfigured);

        fixture.Repository.IsConfigured = false;

        Assert.False(fixture.Service.IsConfigured);
    }

    [Fact]
    public async Task CacheEntryIsBoundedByIntegrityByteMeasurement()
    {
        using var fixture = new QueryServiceFixture();

        var result =
            await fixture.Service.SearchAsync(
                KentRehberiRuntimeTestData.Search(),
                CancellationToken.None);

        var cache =
            fixture.Cache.GetSnapshot();

        Assert.Equal(1, cache.Entries);
        Assert.True(cache.Bytes > 0);

        var guard =
            new KentRehberiResultIntegrityGuard(
                fixture.Options);
        var report =
            guard.ValidateCollection(result);

        Assert.Equal(
            report.SerializedBytes,
            cache.Bytes);
    }

    private static async Task WaitUntilAsync(
        Func<bool> predicate)
    {
        var timeout =
            DateTimeOffset.UtcNow.AddSeconds(2);

        while (!predicate())
        {
            if (DateTimeOffset.UtcNow >= timeout)
            {
                throw new TimeoutException(
                    "Test condition was not reached.");
            }

            await Task.Delay(10);
        }
    }

    private sealed class QueryServiceFixture :
        IDisposable
    {
        public QueryServiceFixture(
            Action<KentRehberiOptions>? configure = null)
        {
            Options =
                KentRehberiRuntimeTestData.Options(
                    configure);
            Telemetry =
                new KentRehberiTelemetry();
            Repository =
                new FakeKentRehberiRepository();
            Clock =
                new ManualKentRehberiTimeProvider(
                    DateTimeOffset.UtcNow);
            Cache =
                new KentRehberiBoundedResultCache(
                    Options,
                    Telemetry,
                    Clock);
            Admission =
                new KentRehberiAdmissionController(
                    Options,
                    Telemetry);
            CollectionSingleFlight =
                new KentRehberiSingleFlight<
                    KentRehberiFeatureCollection>(
                    Telemetry);
            FeatureSingleFlight =
                new KentRehberiSingleFlight<
                    KentRehberiFeature?>(
                    Telemetry);
            Integrity =
                new KentRehberiResultIntegrityGuard(
                    Options);
            Service =
                new KentRehberiQueryService(
                    Repository,
                    Options,
                    Cache,
                    Admission,
                    CollectionSingleFlight,
                    FeatureSingleFlight,
                    Integrity,
                    Telemetry);
        }

        public KentRehberiOptions Options { get; }
        public FakeKentRehberiRepository Repository { get; }
        public ManualKentRehberiTimeProvider Clock { get; }
        public KentRehberiTelemetry Telemetry { get; }
        public KentRehberiBoundedResultCache Cache { get; }
        public KentRehberiAdmissionController Admission { get; }
        public KentRehberiSingleFlight<
            KentRehberiFeatureCollection>
            CollectionSingleFlight { get; }
        public KentRehberiSingleFlight<
            KentRehberiFeature?>
            FeatureSingleFlight { get; }
        public KentRehberiResultIntegrityGuard Integrity { get; }
        public KentRehberiQueryService Service { get; }

        public void Dispose()
        {
            FeatureSingleFlight.Dispose();
            CollectionSingleFlight.Dispose();
            Admission.Dispose();
            Telemetry.Dispose();
        }
    }
}
