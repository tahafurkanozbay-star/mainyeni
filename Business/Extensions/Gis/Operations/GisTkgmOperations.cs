using Business._Base;
using Business.Core.Context;
using RestSharp;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Business.Extensions.Gis.Operations
{
    public interface ITkgmTransport
    {
        Task<string> GetAsync(string relativePath, CancellationToken cancellationToken);
    }

    public sealed class RestSharpTkgmTransport : ITkgmTransport, IDisposable
    {
        private const string TkgmBaseUrl = "http://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api";
        private const string Referrer = "http://parselsorgu.tkgm.gov.tr";
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);
        private readonly RestClient client;

        public RestSharpTkgmTransport()
        {
            client = new RestClient(new RestClientOptions(TkgmBaseUrl) { Timeout = RequestTimeout });
        }

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(relativePath) || relativePath[0] != '/')
                throw new ArgumentException("TKGM request path must be a non-empty relative API path.", nameof(relativePath));

            cancellationToken.ThrowIfCancellationRequested();
            var request = new RestRequest(relativePath, Method.Get);
            request.AddHeader("Referer", Referrer);
            request.AddHeader("Origin", Referrer);
            var response = await client.ExecuteAsync(request, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();

            if (!response.IsSuccessful)
                throw new InvalidOperationException("TKGM request failed with HTTP status " + (int)response.StatusCode + ".");
            if (string.IsNullOrWhiteSpace(response.Content))
                throw new InvalidOperationException("TKGM request returned an empty response body.");
            return response.Content;
        }

        public void Dispose() => client.Dispose();
    }

    public class GisTkgmOperations : _BaseOperations, IDisposable
    {
        internal const int MaxAdministrativeCacheEntries = 512;
        private static readonly TimeSpan AdministrativeCacheTtl = TimeSpan.FromMinutes(15);

        // The default TKGM transport is intentionally process-lived. RestClient owns reusable HTTP
        // connection state and should not be recreated for every controller/request. Test and custom
        // transports remain injectable and are never disposed by this operations facade.
        private static readonly ITkgmTransport SharedTransport = new RestSharpTkgmTransport();

        private static readonly ConcurrentDictionary<int, AdministrativeCacheEntry> DistrictsCache = new();
        private static readonly ConcurrentDictionary<int, AdministrativeCacheEntry> NbhoodsCache = new();
        private static readonly ConcurrentDictionary<int, Lazy<AdministrativeFetch>> DistrictsInFlight = new();
        private static readonly ConcurrentDictionary<int, Lazy<AdministrativeFetch>> NbhoodsInFlight = new();
        private static readonly object DistrictsCacheAdmissionGate = new();
        private static readonly object NbhoodsCacheAdmissionGate = new();

        private readonly ITkgmTransport transport;
        private readonly TimeProvider timeProvider;

        public GisTkgmOperations(BusinessContext gisContext)
            : this(gisContext, SharedTransport, TimeProvider.System) { }

        public GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport)
            : this(gisContext, transport, TimeProvider.System) { }

        public GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport, TimeProvider timeProvider)
        {
            _ = gisContext ?? throw new ArgumentNullException(nameof(gisContext));
            this.transport = transport ?? throw new ArgumentNullException(nameof(transport));
            this.timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        }

        public Task<string> DistrictsAsync(int cityId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(cityId, nameof(cityId));
            return GetAdministrativeAsync(
                DistrictsCache,
                DistrictsCacheAdmissionGate,
                DistrictsInFlight,
                cityId,
                "/idariYapi/ilceListe/" + cityId,
                cancellationToken);
        }

        public Task<string> NbhoodsAsync(int districtId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(districtId, nameof(districtId));
            return GetAdministrativeAsync(
                NbhoodsCache,
                NbhoodsCacheAdmissionGate,
                NbhoodsInFlight,
                districtId,
                "/idariYapi/mahalleListe/" + districtId,
                cancellationToken);
        }

        public Task<string> ParcelAsync(int districtId, int nbhoodId, int cityblock, int parcel, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(districtId, nameof(districtId));
            EnsurePositiveId(nbhoodId, nameof(nbhoodId));
            EnsurePositiveId(cityblock, nameof(cityblock));
            EnsurePositiveId(parcel, nameof(parcel));
            cancellationToken.ThrowIfCancellationRequested();
            return transport.GetAsync("/parsel/" + nbhoodId + "/" + cityblock + "/" + parcel, cancellationToken);
        }

        internal static void ClearAdministrativeCachesForTesting()
        {
            CancelAndClearFlights(DistrictsInFlight);
            CancelAndClearFlights(NbhoodsInFlight);
            lock (DistrictsCacheAdmissionGate) DistrictsCache.Clear();
            lock (NbhoodsCacheAdmissionGate) NbhoodsCache.Clear();
        }

        internal static (int Districts, int Neighbourhoods) GetAdministrativeCacheCountsForTesting()
        {
            lock (DistrictsCacheAdmissionGate)
            lock (NbhoodsCacheAdmissionGate)
                return (DistrictsCache.Count, NbhoodsCache.Count);
        }

        private async Task<string> GetAdministrativeAsync(
            ConcurrentDictionary<int, AdministrativeCacheEntry> cache,
            object admissionGate,
            ConcurrentDictionary<int, Lazy<AdministrativeFetch>> inFlight,
            int key,
            string relativePath,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (TryGetFresh(cache, key, out var cached)) return cached;

            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (TryGetFresh(cache, key, out cached)) return cached;

                var lazy = inFlight.GetOrAdd(
                    key,
                    _ => new Lazy<AdministrativeFetch>(
                        () => new AdministrativeFetch(
                            sharedCancellation => FetchAndPublishAdministrativeAsync(
                                cache,
                                admissionGate,
                                key,
                                relativePath,
                                sharedCancellation)),
                        LazyThreadSafetyMode.ExecutionAndPublication));

                var flight = lazy.Value;
                if (!flight.TryAttach())
                {
                    inFlight.TryRemove(new KeyValuePair<int, Lazy<AdministrativeFetch>>(key, lazy));
                    continue;
                }

                try
                {
                    return await flight.Work.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    var shouldCancel = flight.Detach(out var shouldRemove);
                    if (shouldRemove)
                        inFlight.TryRemove(new KeyValuePair<int, Lazy<AdministrativeFetch>>(key, lazy));
                    if (shouldCancel)
                        flight.Cancel();
                }
            }
        }

        private async Task<string> FetchAndPublishAdministrativeAsync(
            ConcurrentDictionary<int, AdministrativeCacheEntry> cache,
            object admissionGate,
            int key,
            string relativePath,
            CancellationToken sharedCancellation)
        {
            sharedCancellation.ThrowIfCancellationRequested();

            // A previous flight may have populated the cache after a caller's initial miss but
            // before this flight was materialized. Re-check before issuing network I/O.
            if (TryGetFresh(cache, key, out var cached)) return cached;

            var content = await transport.GetAsync(relativePath, sharedCancellation).ConfigureAwait(false);
            sharedCancellation.ThrowIfCancellationRequested();
            PublishBounded(cache, admissionGate, key, content);
            return content;
        }

        private bool TryGetFresh(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, int key, out string content)
        {
            if (cache.TryGetValue(key, out var entry))
            {
                var age = timeProvider.GetUtcNow() - entry.CreatedAt;
                if (age >= TimeSpan.Zero && age < AdministrativeCacheTtl)
                {
                    content = entry.Content;
                    return true;
                }
                cache.TryRemove(new KeyValuePair<int, AdministrativeCacheEntry>(key, entry));
            }
            content = string.Empty;
            return false;
        }

        private void PublishBounded(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, object admissionGate, int key, string content)
        {
            if (string.IsNullOrWhiteSpace(content))
                throw new InvalidOperationException("TKGM administrative response cannot be cached when empty.");

            lock (admissionGate)
            {
                var now = timeProvider.GetUtcNow();
                PruneExpiredAndFutureEntries(cache, now);
                EnsureCapacityForNewKey(cache, key);
                cache[key] = new AdministrativeCacheEntry(content, now);
            }
        }

        private static void PruneExpiredAndFutureEntries(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, DateTimeOffset now)
        {
            foreach (var pair in cache)
            {
                var age = now - pair.Value.CreatedAt;
                if (age < TimeSpan.Zero || age >= AdministrativeCacheTtl)
                    cache.TryRemove(new KeyValuePair<int, AdministrativeCacheEntry>(pair.Key, pair.Value));
            }
        }

        private static void EnsureCapacityForNewKey(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, int key)
        {
            if (cache.ContainsKey(key)) return;
            while (cache.Count >= MaxAdministrativeCacheEntries)
            {
                var oldest = cache.OrderBy(pair => pair.Value.CreatedAt).ThenBy(pair => pair.Key).FirstOrDefault();
                if (oldest.Value is null) return;
                if (cache.TryRemove(new KeyValuePair<int, AdministrativeCacheEntry>(oldest.Key, oldest.Value))) continue;
                Thread.Yield();
            }
        }

        private static void CancelAndClearFlights(ConcurrentDictionary<int, Lazy<AdministrativeFetch>> inFlight)
        {
            foreach (var pair in inFlight)
            {
                if (!inFlight.TryRemove(new KeyValuePair<int, Lazy<AdministrativeFetch>>(pair.Key, pair.Value)))
                    continue;

                if (pair.Value.IsValueCreated)
                    pair.Value.Value.StopAcceptingAndCancel();
            }
        }

        private static void EnsurePositiveId(int value, string parameterName)
        {
            if (value <= 0) throw new ArgumentOutOfRangeException(parameterName, value, "TKGM identifiers must be positive.");
        }

        // The operations facade no longer owns a per-request transport. Kept for source compatibility
        // with existing using/disposal call sites and injected test transports.
        public void Dispose() { }

        private sealed record AdministrativeCacheEntry(string Content, DateTimeOffset CreatedAt);

        /// <summary>
        /// One shared administrative upstream fetch. Individual callers may cancel their own wait;
        /// the upstream request is cancelled only when the last attached waiter leaves. This keeps a
        /// disconnected client from aborting useful work for other callers while still propagating
        /// cancellation to network I/O when nobody remains interested.
        /// </summary>
        private sealed class AdministrativeFetch
        {
            private readonly object gate = new();
            private readonly CancellationTokenSource cancellationSource = new();
            private bool accepting = true;
            private int waiters;

            public AdministrativeFetch(Func<CancellationToken, Task<string>> factory)
            {
                if (factory == null) throw new ArgumentNullException(nameof(factory));
                Work = Run(factory);
                _ = Work.ContinueWith(
                    _ => cancellationSource.Dispose(),
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }

            public Task<string> Work { get; }

            public bool TryAttach()
            {
                lock (gate)
                {
                    if (!accepting) return false;
                    waiters++;
                    return true;
                }
            }

            public bool Detach(out bool shouldRemove)
            {
                lock (gate)
                {
                    if (waiters <= 0)
                        throw new InvalidOperationException("TKGM single-flight waiter accounting underflow.");

                    waiters--;
                    if (waiters != 0)
                    {
                        shouldRemove = false;
                        return false;
                    }

                    accepting = false;
                    shouldRemove = true;
                    return !Work.IsCompleted;
                }
            }

            public void Cancel()
            {
                try { cancellationSource.Cancel(); }
                catch (ObjectDisposedException) { }
            }

            public void StopAcceptingAndCancel()
            {
                lock (gate) accepting = false;
                if (!Work.IsCompleted) Cancel();
            }

            private async Task<string> Run(Func<CancellationToken, Task<string>> factory)
            {
                return await factory(cancellationSource.Token).ConfigureAwait(false);
            }
        }
    }
}