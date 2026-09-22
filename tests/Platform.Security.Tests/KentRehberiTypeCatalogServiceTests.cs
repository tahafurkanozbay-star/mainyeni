using Api.User.KentRehberi;
using System;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiTypeCatalogServiceTests
{
    [Fact]
    public async Task Get_ExecutesRepositoryAndCachesResult()
    {
        using var fixture = new TypeCatalogServiceFixture();
        var expected =
            KentRehberiRuntimeTestData.TypeCatalog();

        fixture.Repository.TypeCatalogHandler =
            _ => Task.FromResult(expected);

        var first =
            await fixture.Service.GetAsync(
                CancellationToken.None);
        var second =
            await fixture.Service.GetAsync(
                CancellationToken.None);

        Assert.Same(expected, first);
        Assert.Same(first, second);
        Assert.Equal(
            1,
            fixture.Repository.TypeCatalogCalls);

        var cache =
            fixture.Cache.GetSnapshot();
        Assert.True(cache.HasValue);
        Assert.True(cache.Hits >= 1);
        Assert.Equal(1, cache.Writes);
    }

    [Fact]
    public async Task CacheExpiry_RefreshesFromRepository()
    {
        using var fixture =
            new TypeCatalogServiceFixture(
                options =>
                    options.TypeCatalogCacheTtlSeconds = 1);

        var calls = 0;
        fixture.Repository.TypeCatalogHandler =
            _ =>
            {
                calls++;
                return Task.FromResult(
                    KentRehberiRuntimeTestData.TypeCatalog(
                        firstType: (short)(calls * 10)));
            };

        var first =
            await fixture.Service.GetAsync(
                CancellationToken.None);

        fixture.Clock.Advance(
            TimeSpan.FromSeconds(2));

        var second =
            await fixture.Service.GetAsync(
                CancellationToken.None);

        Assert.NotSame(first, second);
        Assert.Equal(2, calls);
        Assert.Equal(2, fixture.Repository.TypeCatalogCalls);
    }

    [Fact]
    public async Task ConcurrentIdenticalCalls_AreSingleFlighted()
    {
        using var fixture = new TypeCatalogServiceFixture();

        var gate =
            new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);

        fixture.Repository.TypeCatalogHandler =
            async token =>
            {
                await gate.Task.WaitAsync(token);
                return KentRehberiRuntimeTestData.TypeCatalog();
            };

        var first =
            fixture.Service.GetAsync(
                CancellationToken.None);
        var second =
            fixture.Service.GetAsync(
                CancellationToken.None);

        await WaitUntilAsync(
            () =>
                fixture.Repository.TypeCatalogCalls == 1);

        gate.SetResult(true);

        var results =
            await Task.WhenAll(first, second);

        Assert.Same(
            results[0],
            results[1]);
        Assert.Equal(
            1,
            fixture.Repository.TypeCatalogCalls);
        Assert.True(
            fixture.Telemetry
                .GetSnapshot()
                .SingleFlightJoins >= 1);
    }

    [Fact]
    public async Task InvalidCatalog_IsRejectedBeforeCache()
    {
        using var fixture = new TypeCatalogServiceFixture();

        fixture.Repository.TypeCatalogHandler =
            _ => Task.FromResult(
                KentRehberiTypeCatalog.Create(
                    new[]
                    {
                        new KentRehberiTypeDescriptor(
                            7,
                            1,
                            new[]
                            {
                                new KentRehberiTypeSample(
                                    0,
                                    "invalid",
                                    "Ankara",
                                    null)
                            })
                    }));

        await Assert.ThrowsAsync<
            KentRehberiDataIntegrityException>(
            () =>
                fixture.Service.GetAsync(
                    CancellationToken.None));

        Assert.False(
            fixture.Cache
                .GetSnapshot()
                .HasValue);
        Assert.Equal(
            1,
            fixture.Telemetry
                .GetSnapshot()
                .IntegrityRejected);
    }

    [Fact]
    public async Task RepositoryFailure_IsPropagatedAndCounted()
    {
        using var fixture = new TypeCatalogServiceFixture();

        fixture.Repository.TypeCatalogHandler =
            _ => Task.FromException<KentRehberiTypeCatalog>(
                new InvalidOperationException(
                    "synthetic"));

        await Assert.ThrowsAsync<
            InvalidOperationException>(
            () =>
                fixture.Service.GetAsync(
                    CancellationToken.None));

        var telemetry =
            fixture.Telemetry.GetSnapshot();

        Assert.Equal(1, telemetry.RequestsFailed);
        Assert.Equal(0, telemetry.RequestsCompleted);
    }

    [Fact]
    public async Task SubscriberCancellation_IsPropagated()
    {
        using var fixture = new TypeCatalogServiceFixture();
        using var cts =
            new CancellationTokenSource();

        fixture.Repository.TypeCatalogHandler =
            async token =>
            {
                await Task.Delay(
                    TimeSpan.FromSeconds(30),
                    token);
                return KentRehberiRuntimeTestData.TypeCatalog();
            };

        var task =
            fixture.Service.GetAsync(
                cts.Token);

        cts.Cancel();

        await Assert.ThrowsAnyAsync<
            OperationCanceledException>(
            () => task);
    }

    [Fact]
    public async Task InternalDeadline_IsTranslated()
    {
        using var fixture =
            new TypeCatalogServiceFixture(
                options =>
                    options.QueryDeadlineMilliseconds = 250);

        fixture.Repository.TypeCatalogHandler =
            async token =>
            {
                await Task.Delay(
                    TimeSpan.FromSeconds(30),
                    token);
                return KentRehberiRuntimeTestData.TypeCatalog();
            };

        await Assert.ThrowsAsync<
            KentRehberiQueryDeadlineException>(
            () =>
                fixture.Service.GetAsync(
                    CancellationToken.None));

        Assert.True(
            fixture.Telemetry
                .GetSnapshot()
                .DeadlineExceeded >= 1);
    }

    [Fact]
    public async Task BulkheadRejectsWhenNoQueueBudgetRemains()
    {
        using var fixture =
            new TypeCatalogServiceFixture(
                options =>
                {
                    options.MaxConcurrentQueries = 1;
                    options.MaxQueuedQueries = 0;
                });

        using var occupied =
            await fixture.Admission.AcquireAsync(
                "synthetic-existing-work",
                CancellationToken.None);

        await Assert.ThrowsAsync<
            KentRehberiOverloadedException>(
            () =>
                fixture.Service.GetAsync(
                    CancellationToken.None));

        Assert.Equal(
            1,
            fixture.Telemetry
                .GetSnapshot()
                .AdmissionRejected);
    }

    [Fact]
    public async Task SuccessfulCatalog_RecordsMetrics()
    {
        using var fixture = new TypeCatalogServiceFixture();

        var result =
            await fixture.Service.GetAsync(
                CancellationToken.None);

        Assert.NotEmpty(result.Types);

        var telemetry =
            fixture.Telemetry.GetSnapshot();

        Assert.Equal(1, telemetry.RequestsStarted);
        Assert.Equal(1, telemetry.RequestsCompleted);
        Assert.Equal(0, telemetry.RequestsFailed);
        Assert.Equal(0, telemetry.ActiveQueries);
    }

    [Fact]
    public void ConfigurationState_ComesFromRepository()
    {
        using var fixture = new TypeCatalogServiceFixture();

        Assert.True(fixture.Service.IsConfigured);

        fixture.Repository.IsConfigured = false;

        Assert.False(fixture.Service.IsConfigured);
    }

    [Fact]
    public async Task EmptyCatalog_IsValidAndCached()
    {
        using var fixture = new TypeCatalogServiceFixture();

        var empty =
            KentRehberiTypeCatalog.Create(
                Array.Empty<KentRehberiTypeDescriptor>());

        fixture.Repository.TypeCatalogHandler =
            _ => Task.FromResult(empty);

        var result =
            await fixture.Service.GetAsync(
                CancellationToken.None);

        Assert.Empty(result.Types);
        Assert.True(
            fixture.Cache
                .GetSnapshot()
                .HasValue);
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

    private sealed class TypeCatalogServiceFixture :
        IDisposable
    {
        public TypeCatalogServiceFixture(
            Action<KentRehberiOptions>? configure = null)
        {
            Options =
                KentRehberiRuntimeTestData.Options(
                    configure);
            Clock =
                new ManualKentRehberiTimeProvider(
                    DateTimeOffset.UtcNow);
            Telemetry =
                new KentRehberiTelemetry();
            Repository =
                new FakeKentRehberiRepository();
            Cache =
                new KentRehberiTypeCatalogCache(
                    Options,
                    Clock);
            Admission =
                new KentRehberiAdmissionController(
                    Options,
                    Telemetry);
            SingleFlight =
                new KentRehberiSingleFlight<
                    KentRehberiTypeCatalog>(
                    Telemetry);
            Integrity =
                new KentRehberiTypeCatalogIntegrityGuard(
                    Options);
            Service =
                new KentRehberiTypeCatalogService(
                    Repository,
                    Options,
                    Cache,
                    Admission,
                    SingleFlight,
                    Integrity,
                    Telemetry);
        }

        public KentRehberiOptions Options { get; }
        public ManualKentRehberiTimeProvider Clock { get; }
        public KentRehberiTelemetry Telemetry { get; }
        public FakeKentRehberiRepository Repository { get; }
        public KentRehberiTypeCatalogCache Cache { get; }
        public KentRehberiAdmissionController Admission { get; }
        public KentRehberiSingleFlight<
            KentRehberiTypeCatalog>
            SingleFlight { get; }
        public KentRehberiTypeCatalogIntegrityGuard Integrity { get; }
        public KentRehberiTypeCatalogService Service { get; }

        public void Dispose()
        {
            SingleFlight.Dispose();
            Admission.Dispose();
            Telemetry.Dispose();
        }
    }
}
