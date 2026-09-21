using Api.User.KentRehberi;
using System;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiAdmissionAndSingleFlightTests
{
    [Fact]
    public async Task Admission_GrantsImmediateCapacity()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var admission =
            new KentRehberiAdmissionController(
                KentRehberiRuntimeTestData.Options(),
                telemetry);

        using var lease =
            await admission.AcquireAsync(
                "search",
                CancellationToken.None);

        var snapshot = admission.GetSnapshot();
        Assert.Equal(1, snapshot.Active);
        Assert.Equal(0, snapshot.Queued);
        Assert.Equal(1, snapshot.Accepted);
        Assert.Equal(0, snapshot.Rejected);
    }

    [Fact]
    public async Task Admission_ReleaseReturnsCapacity()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var admission =
            new KentRehberiAdmissionController(
                KentRehberiRuntimeTestData.Options(
                    options =>
                        options.MaxConcurrentQueries = 1),
                telemetry);

        var lease =
            await admission.AcquireAsync(
                "search",
                CancellationToken.None);

        Assert.Equal(
            1,
            admission.GetSnapshot().Active);

        lease.Dispose();

        Assert.Equal(
            0,
            admission.GetSnapshot().Active);
    }

    [Fact]
    public async Task Admission_LeaseDisposeIsIdempotent()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var admission =
            new KentRehberiAdmissionController(
                KentRehberiRuntimeTestData.Options(
                    options =>
                        options.MaxConcurrentQueries = 1),
                telemetry);

        var lease =
            await admission.AcquireAsync(
                "search",
                CancellationToken.None);

        lease.Dispose();
        lease.Dispose();

        var second =
            await admission.AcquireAsync(
                "search",
                CancellationToken.None);

        Assert.Equal(
            1,
            admission.GetSnapshot().Active);

        second.Dispose();
    }

    [Fact]
    public async Task Admission_QueuesUntilCapacityIsReleased()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var admission =
            new KentRehberiAdmissionController(
                KentRehberiRuntimeTestData.Options(
                    options =>
                    {
                        options.MaxConcurrentQueries = 1;
                        options.MaxQueuedQueries = 1;
                    }),
                telemetry);

        var first =
            await admission.AcquireAsync(
                "search",
                CancellationToken.None);

        var waiting =
            admission.AcquireAsync(
                "nearby",
                CancellationToken.None)
                .AsTask();

        await WaitUntilAsync(
            () =>
                admission.GetSnapshot().Queued == 1);

        Assert.False(waiting.IsCompleted);

        first.Dispose();

        using var second =
            await waiting;

        var snapshot = admission.GetSnapshot();
        Assert.Equal(1, snapshot.Active);
        Assert.Equal(0, snapshot.Queued);
        Assert.Equal(2, snapshot.Accepted);
    }

    [Fact]
    public async Task Admission_RejectsBeyondQueueBudget()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var admission =
            new KentRehberiAdmissionController(
                KentRehberiRuntimeTestData.Options(
                    options =>
                    {
                        options.MaxConcurrentQueries = 1;
                        options.MaxQueuedQueries = 0;
                    }),
                telemetry);

        using var first =
            await admission.AcquireAsync(
                "search",
                CancellationToken.None);

        await Assert.ThrowsAsync<
            KentRehberiOverloadedException>(
            () =>
                admission.AcquireAsync(
                    "search",
                    CancellationToken.None)
                    .AsTask());

        Assert.Equal(
            1,
            admission.GetSnapshot().Rejected);
        Assert.Equal(
            1,
            telemetry.GetSnapshot().AdmissionRejected);
    }

    [Fact]
    public async Task Admission_CancelledQueueWaitLeavesNoLeak()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var admission =
            new KentRehberiAdmissionController(
                KentRehberiRuntimeTestData.Options(
                    options =>
                    {
                        options.MaxConcurrentQueries = 1;
                        options.MaxQueuedQueries = 1;
                    }),
                telemetry);

        using var first =
            await admission.AcquireAsync(
                "search",
                CancellationToken.None);
        using var cts =
            new CancellationTokenSource();

        var waiting =
            admission.AcquireAsync(
                "nearby",
                cts.Token)
                .AsTask();

        await WaitUntilAsync(
            () =>
                admission.GetSnapshot().Queued == 1);

        cts.Cancel();

        await Assert.ThrowsAnyAsync<
            OperationCanceledException>(
            () => waiting);

        Assert.Equal(
            0,
            admission.GetSnapshot().Queued);
        Assert.Equal(
            0,
            telemetry.GetSnapshot().QueuedQueries);
    }

    [Fact]
    public async Task SingleFlight_DeduplicatesConcurrentWork()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);

        var gate =
            new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;

        Task<int> Factory(
            CancellationToken token)
        {
            Interlocked.Increment(ref calls);
            return CompleteAsync(token);
        }

        async Task<int> CompleteAsync(
            CancellationToken token)
        {
            await gate.Task.WaitAsync(token);
            return 42;
        }

        var first = singleFlight.RunAsync(
            "search",
            "same",
            TimeSpan.FromSeconds(5),
            Factory,
            CancellationToken.None);
        var second = singleFlight.RunAsync(
            "search",
            "same",
            TimeSpan.FromSeconds(5),
            Factory,
            CancellationToken.None);

        await WaitUntilAsync(
            () => Volatile.Read(ref calls) == 1);

        gate.SetResult(true);

        Assert.Equal(42, await first);
        Assert.Equal(42, await second);
        Assert.Equal(1, calls);
        Assert.Equal(
            1,
            singleFlight.GetSnapshot().Joined);
        Assert.Equal(
            1,
            telemetry.GetSnapshot().SingleFlightJoins);
    }

    [Fact]
    public async Task SingleFlight_DifferentKeysRunIndependently()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);

        var calls = 0;

        var first = singleFlight.RunAsync(
            "search",
            "a",
            TimeSpan.FromSeconds(5),
            _ =>
                Task.FromResult(
                    Interlocked.Increment(ref calls)),
            CancellationToken.None);

        var second = singleFlight.RunAsync(
            "search",
            "b",
            TimeSpan.FromSeconds(5),
            _ =>
                Task.FromResult(
                    Interlocked.Increment(ref calls)),
            CancellationToken.None);

        await Task.WhenAll(first, second);

        Assert.Equal(2, calls);
        Assert.Equal(
            2,
            singleFlight.GetSnapshot().Created);
    }

    [Fact]
    public async Task SingleFlight_SubscriberCancellationDoesNotCancelOtherSubscriber()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);

        var gate =
            new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        using var firstCts =
            new CancellationTokenSource();

        async Task<int> Factory(
            CancellationToken token)
        {
            Interlocked.Increment(ref calls);
            await gate.Task.WaitAsync(token);
            return 7;
        }

        var first = singleFlight.RunAsync(
            "search",
            "same",
            TimeSpan.FromSeconds(5),
            Factory,
            firstCts.Token);
        var second = singleFlight.RunAsync(
            "search",
            "same",
            TimeSpan.FromSeconds(5),
            Factory,
            CancellationToken.None);

        await WaitUntilAsync(
            () => Volatile.Read(ref calls) == 1);

        firstCts.Cancel();

        await Assert.ThrowsAnyAsync<
            OperationCanceledException>(
            () => first);

        gate.SetResult(true);

        Assert.Equal(7, await second);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task SingleFlight_LastSubscriberCancellationCancelsWork()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);
        using var cts =
            new CancellationTokenSource();

        var workCancelled =
            new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<int> Factory(
            CancellationToken token)
        {
            try
            {
                await Task.Delay(
                    TimeSpan.FromSeconds(30),
                    token);
                return 1;
            }
            catch (OperationCanceledException)
            {
                workCancelled.TrySetResult(true);
                throw;
            }
        }

        var task = singleFlight.RunAsync(
            "search",
            "same",
            TimeSpan.FromSeconds(30),
            Factory,
            cts.Token);

        cts.Cancel();

        await Assert.ThrowsAnyAsync<
            OperationCanceledException>(
            () => task);

        await workCancelled.Task.WaitAsync(
            TimeSpan.FromSeconds(2));

        Assert.True(
            singleFlight
                .GetSnapshot()
                .CancelledWhenUnused >= 1);
    }

    [Fact]
    public async Task SingleFlight_DeadlineCancelsUnderlyingWork()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);

        await Assert.ThrowsAnyAsync<
            OperationCanceledException>(
            () =>
                singleFlight.RunAsync(
                    "search",
                    "deadline",
                    TimeSpan.FromMilliseconds(50),
                    async token =>
                    {
                        await Task.Delay(
                            TimeSpan.FromSeconds(10),
                            token);
                        return 1;
                    },
                    CancellationToken.None));
    }

    [Fact]
    public async Task SingleFlight_CompletedEntryIsRemoved()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);

        var value =
            await singleFlight.RunAsync(
                "search",
                "key",
                TimeSpan.FromSeconds(1),
                _ => Task.FromResult(5),
                CancellationToken.None);

        Assert.Equal(5, value);

        await WaitUntilAsync(
            () =>
                singleFlight
                    .GetSnapshot()
                    .InFlight == 0);

        Assert.Equal(
            1,
            singleFlight.GetSnapshot().Completed);
    }

    [Fact]
    public async Task SingleFlight_NewCallAfterCompletionRunsAgain()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);

        var calls = 0;

        for (var index = 0; index < 2; index++)
        {
            await singleFlight.RunAsync(
                "search",
                "key",
                TimeSpan.FromSeconds(1),
                _ =>
                    Task.FromResult(
                        Interlocked.Increment(ref calls)),
                CancellationToken.None);

            await WaitUntilAsync(
                () =>
                    singleFlight
                        .GetSnapshot()
                        .InFlight == 0);
        }

        Assert.Equal(2, calls);
        Assert.Equal(
            2,
            singleFlight.GetSnapshot().Created);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    public async Task SingleFlight_RejectsBlankKey(
        string key)
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);

        await Assert.ThrowsAsync<ArgumentException>(
            () =>
                singleFlight.RunAsync(
                    "search",
                    key,
                    TimeSpan.FromSeconds(1),
                    _ => Task.FromResult(1),
                    CancellationToken.None));
    }

    [Fact]
    public async Task SingleFlight_RejectsNonPositiveDeadline()
    {
        using var telemetry =
            new KentRehberiTelemetry();
        using var singleFlight =
            new KentRehberiSingleFlight<int>(
                telemetry);

        await Assert.ThrowsAsync<
            ArgumentOutOfRangeException>(
            () =>
                singleFlight.RunAsync(
                    "search",
                    "key",
                    TimeSpan.Zero,
                    _ => Task.FromResult(1),
                    CancellationToken.None));
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
}
