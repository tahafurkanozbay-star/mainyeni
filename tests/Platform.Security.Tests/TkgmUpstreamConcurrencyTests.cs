using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

[Collection(TkgmAdministrativeCacheCollection.Name)]
public sealed class TkgmUpstreamConcurrencyTests
{
    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase("tkgm-upstream-" + Guid.NewGuid())
            .Options;
        return new BusinessContext(options);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Gate_RejectsNonPositiveConcurrency(int maxConcurrency)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new TkgmUpstreamConcurrencyGate(maxConcurrency));
    }

    [Fact]
    public async Task Gate_BoundsConcurrentOperations()
    {
        var gate = new TkgmUpstreamConcurrencyGate(2);
        var operation = new BlockingOperation();
        var tasks = Enumerable.Range(0, 6)
            .Select(_ => gate.ExecuteAsync(operation.InvokeAsync, CancellationToken.None))
            .ToArray();

        await operation.WaitForInvocationsAsync(2);
        Assert.Equal(2, operation.InvocationCount);
        Assert.Equal(2, operation.PeakConcurrency);

        operation.Release();
        var results = await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(5));

        Assert.All(results, result => Assert.Equal("ok", result));
        Assert.Equal(6, operation.InvocationCount);
        Assert.Equal(2, operation.PeakConcurrency);
        Assert.Equal(0, operation.ActiveCount);
    }

    [Fact]
    public async Task Gate_QueuedCancellation_DoesNotInvokeOperationOrConsumePermit()
    {
        var gate = new TkgmUpstreamConcurrencyGate(1);
        var blocker = new BlockingOperation();
        var first = gate.ExecuteAsync(blocker.InvokeAsync, CancellationToken.None);
        await blocker.WaitForInvocationsAsync(1);

        var queuedInvocations = 0;
        using var cancellation = new CancellationTokenSource();
        var queued = gate.ExecuteAsync(
            _ =>
            {
                Interlocked.Increment(ref queuedInvocations);
                return Task.FromResult("queued");
            },
            cancellation.Token);

        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => queued);
        Assert.Equal(0, Volatile.Read(ref queuedInvocations));

        blocker.Release();
        Assert.Equal("ok", await first.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(
            "after",
            await gate.ExecuteAsync(_ => Task.FromResult("after"), CancellationToken.None)
                .WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task Gate_FaultedOperation_ReleasesPermit()
    {
        var gate = new TkgmUpstreamConcurrencyGate(1);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            gate.ExecuteAsync<string>(
                _ => Task.FromException<string>(new InvalidOperationException("boom")),
                CancellationToken.None));

        var result = await gate.ExecuteAsync(
                _ => Task.FromResult("recovered"),
                CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal("recovered", result);
    }

    [Fact]
    public async Task Gate_ActiveCancellation_ReleasesPermit()
    {
        var gate = new TkgmUpstreamConcurrencyGate(1);
        var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();

        var active = gate.ExecuteAsync(
            async token =>
            {
                entered.TrySetResult(true);
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                return "unreachable";
            },
            cancellation.Token);

        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => active);

        var result = await gate.ExecuteAsync(
                _ => Task.FromResult("after-cancel"),
                CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal("after-cancel", result);
    }

    [Fact]
    public async Task Operations_ShareUpstreamGateAcrossParcelAndAdministrativeRequests()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
        using var context = CreateContext();
        var transport = new BlockingTransport();
        using var operations = new GisTkgmOperations(context, transport);
        var parcels = Enumerable.Range(1, GisTkgmOperations.MaxConcurrentUpstreamRequests)
            .Select(block => operations.ParcelAsync(1, 1, block, 1))
            .ToArray();

        try
        {
            await transport.WaitForInvocationsAsync(GisTkgmOperations.MaxConcurrentUpstreamRequests);
            Assert.Equal(GisTkgmOperations.MaxConcurrentUpstreamRequests, transport.InvocationCount);

            using var cancellation = new CancellationTokenSource();
            var districtId = Random.Shared.Next(2_000_000, 3_000_000);
            var administrative = operations.DistrictsAsync(districtId, cancellation.Token);
            await Task.Yield();

            Assert.Equal(GisTkgmOperations.MaxConcurrentUpstreamRequests, transport.InvocationCount);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => administrative);
            Assert.Equal(GisTkgmOperations.MaxConcurrentUpstreamRequests, transport.InvocationCount);
        }
        finally
        {
            transport.Release();
            await Task.WhenAll(parcels).WaitAsync(TimeSpan.FromSeconds(5));
            GisTkgmOperations.ClearAdministrativeCachesForTesting();
        }

        Assert.Equal(0, transport.ActiveCount);
    }

    private sealed class BlockingOperation
    {
        private readonly SemaphoreSlim entered = new(0);
        private readonly TaskCompletionSource<bool> release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int activeCount;
        private int invocationCount;
        private int peakConcurrency;

        public int ActiveCount => Volatile.Read(ref activeCount);
        public int InvocationCount => Volatile.Read(ref invocationCount);
        public int PeakConcurrency => Volatile.Read(ref peakConcurrency);

        public async Task<string> InvokeAsync(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref invocationCount);
            var active = Interlocked.Increment(ref activeCount);
            UpdatePeak(ref peakConcurrency, active);
            entered.Release();

            try
            {
                await release.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
                return "ok";
            }
            finally
            {
                Interlocked.Decrement(ref activeCount);
            }
        }

        public async Task WaitForInvocationsAsync(int count)
        {
            for (var index = 0; index < count; index++)
            {
                if (!await entered.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false))
                    throw new TimeoutException("Timed out waiting for a gated TKGM operation to enter.");
            }
        }

        public void Release() => release.TrySetResult(true);
    }

    private sealed class BlockingTransport : ITkgmTransport
    {
        private readonly SemaphoreSlim entered = new(0);
        private readonly TaskCompletionSource<bool> release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int activeCount;
        private int invocationCount;

        public int ActiveCount => Volatile.Read(ref activeCount);
        public int InvocationCount => Volatile.Read(ref invocationCount);

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref invocationCount);
            Interlocked.Increment(ref activeCount);
            entered.Release();

            try
            {
                await release.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
                return relativePath;
            }
            finally
            {
                Interlocked.Decrement(ref activeCount);
            }
        }

        public async Task WaitForInvocationsAsync(int count)
        {
            for (var index = 0; index < count; index++)
            {
                if (!await entered.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false))
                    throw new TimeoutException("Timed out waiting for a TKGM transport call to enter.");
            }
        }

        public void Release() => release.TrySetResult(true);
    }

    private static void UpdatePeak(ref int target, int candidate)
    {
        while (true)
        {
            var current = Volatile.Read(ref target);
            if (candidate <= current) return;
            if (Interlocked.CompareExchange(ref target, candidate, current) == current) return;
        }
    }
}
