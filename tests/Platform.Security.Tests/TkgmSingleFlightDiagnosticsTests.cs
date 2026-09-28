using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Platform.Security.Tests;

[Collection(TkgmAdministrativeCacheCollection.Name)]
public sealed class TkgmSingleFlightDiagnosticsTests
{
    public TkgmSingleFlightDiagnosticsTests()
    {
        GisTkgmOperations.ClearAdministrativeCachesForTesting();
    }

    [Fact]
    public async Task DistrictFlight_LastCallerCancellation_ReachesSharedCts()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport();
        using var operations = new GisTkgmOperations(context, transport);
        using var caller = new CancellationTokenSource();
        var id = Random.Shared.Next(30_000_000, 30_900_000);

        var request = operations.DistrictsAsync(id, caller.Token);
        await transport.Started.WaitAsync(TimeSpan.FromSeconds(5));
        var flight = CaptureFlight("DistrictsInFlight", id);

        AssertFlightState(flight, expectedSubscribers: 1, expectedCancellation: false);

        caller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);

        AssertFlightState(flight, expectedSubscribers: 0, expectedCancellation: true);
        await transport.CancellationObserved.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task DistrictFlight_TwoCallerCancellation_DecrementsToZero()
    {
        using var context = CreateContext();
        var transport = new BlockingTransport();
        using var operations = new GisTkgmOperations(context, transport);
        using var firstCaller = new CancellationTokenSource();
        using var secondCaller = new CancellationTokenSource();
        var id = Random.Shared.Next(31_000_000, 31_900_000);

        var first = operations.DistrictsAsync(id, firstCaller.Token);
        await transport.Started.WaitAsync(TimeSpan.FromSeconds(5));
        var second = operations.DistrictsAsync(id, secondCaller.Token);
        await Task.Yield();
        var flight = CaptureFlight("DistrictsInFlight", id);

        AssertFlightState(flight, expectedSubscribers: 2, expectedCancellation: false);

        firstCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        AssertFlightState(flight, expectedSubscribers: 1, expectedCancellation: false);

        secondCaller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => second);
        AssertFlightState(flight, expectedSubscribers: 0, expectedCancellation: true);
        await transport.CancellationObserved.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static object CaptureFlight(string dictionaryFieldName, int id)
    {
        var dictionaryField = typeof(GisTkgmOperations).GetField(
            dictionaryFieldName,
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("Flight dictionary was not found.");
        var dictionary = dictionaryField.GetValue(null) as IEnumerable
            ?? throw new InvalidOperationException("Flight dictionary is not enumerable.");

        foreach (var pair in dictionary)
        {
            var pairType = pair!.GetType();
            var key = (int)(pairType.GetProperty("Key")?.GetValue(pair)
                ?? throw new InvalidOperationException("Flight key was not found."));
            if (key != id) continue;
            return pairType.GetProperty("Value")?.GetValue(pair)
                ?? throw new InvalidOperationException("Flight value was not found.");
        }

        throw new InvalidOperationException("Expected flight was not found.");
    }

    private static void AssertFlightState(object flight, int expectedSubscribers, bool expectedCancellation)
    {
        var type = flight.GetType();
        var subscribers = (int)(type.GetField("subscribers", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(flight)
            ?? throw new InvalidOperationException("Subscriber count was not found."));
        var source = type.GetField("cancellationSource", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(flight) as CancellationTokenSource
            ?? throw new InvalidOperationException("Shared cancellation source was not found.");

        Assert.Equal(expectedSubscribers, subscribers);
        Assert.Equal(expectedCancellation, source.IsCancellationRequested);
    }

    private static BusinessContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<BusinessContext>()
            .UseInMemoryDatabase("tkgm-single-flight-diagnostics-" + Guid.NewGuid())
            .Options;
        return new BusinessContext(options);
    }

    private sealed class BlockingTransport : ITkgmTransport
    {
        private readonly TaskCompletionSource<bool> started =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> cancellationObserved =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Started => started.Task;
        public Task CancellationObserved => cancellationObserved.Task;

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            started.TrySetResult(true);
            using var registration = cancellationToken.Register(
                () => cancellationObserved.TrySetResult(true));
            await release.Task.WaitAsync(cancellationToken);
            return "unused";
        }
    }
}
