using Business._Base;
using Business.Core.Context;
using RestSharp;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Business.Extensions.Gis.Operations
{
    public interface ITkgmTransport
    {
        Task<string> GetAsync(string relativePath, CancellationToken cancellationToken);
    }

    internal sealed class TkgmUpstreamConcurrencyGate
    {
        private readonly SemaphoreSlim gate;

        public TkgmUpstreamConcurrencyGate(int maxConcurrency)
        {
            if (maxConcurrency <= 0)
                throw new ArgumentOutOfRangeException(nameof(maxConcurrency), maxConcurrency, "TKGM upstream concurrency must be positive.");

            gate = new SemaphoreSlim(maxConcurrency, maxConcurrency);
        }

        public async Task<T> ExecuteAsync<T>(Func<CancellationToken, Task<T>> operation, CancellationToken cancellationToken)
        {
            if (operation == null) throw new ArgumentNullException(nameof(operation));
            cancellationToken.ThrowIfCancellationRequested();
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                return await operation(cancellationToken).ConfigureAwait(false);
            }
            finally { gate.Release(); }
        }
    }

    public sealed class RestSharpTkgmTransport : ITkgmTransport, IDisposable
    {
        private const string TkgmBaseUrl = "http://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api";
        private const string Referrer = "http://parselsorgu.tkgm.gov.tr";
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);
        private readonly RestClient client = new(new RestClientOptions(TkgmBaseUrl) { Timeout = RequestTimeout });

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            ValidateRelativePath(relativePath);
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

        internal static void ValidateRelativePath(string relativePath)
        {
            if (string.IsNullOrWhiteSpace(relativePath))
                throw new ArgumentException("TKGM request path must be a non-empty relative API path.", nameof(relativePath));
            if (relativePath[0] != '/' || relativePath.Length == 1)
                throw new ArgumentException("TKGM request path must start with one slash and contain an API route.", nameof(relativePath));
            if (relativePath.Length > 512)
                throw new ArgumentException("TKGM request path exceeds the supported length.", nameof(relativePath));
            if (relativePath.StartsWith("//", StringComparison.Ordinal) || relativePath.Contains('\\'))
                throw new ArgumentException("TKGM request path must not contain an authority or backslash separator.", nameof(relativePath));
            if (relativePath.Contains('?') || relativePath.Contains('#'))
                throw new ArgumentException("TKGM request path must not contain query or fragment components.", nameof(relativePath));
            if (relativePath.Contains("..", StringComparison.Ordinal))
                throw new ArgumentException("TKGM request path must not contain traversal segments.", nameof(relativePath));

            foreach (var character in relativePath)
            {
                if (char.IsControl(character) || char.IsWhiteSpace(character))
                    throw new ArgumentException("TKGM request path must not contain control or whitespace characters.", nameof(relativePath));
                if (!(char.IsAsciiLetterOrDigit(character) || character is '/' or '-' or '_' or '.'))
                    throw new ArgumentException("TKGM request path contains an unsupported character.", nameof(relativePath));
            }
        }

        public void Dispose() => client.Dispose();
    }

    public class GisTkgmOperations : _BaseOperations, IDisposable
    {
        internal const int MaxAdministrativeCacheEntries = 512;
        internal const int MaxAdministrativeCacheEntryBytes = 1 * 1024 * 1024;
        internal const int MaxAdministrativeCacheBytes = 8 * 1024 * 1024;
        internal const int MaxConcurrentUpstreamRequests = 16;
        private static readonly TimeSpan AdministrativeCacheTtl = TimeSpan.FromMinutes(15);
        private static readonly ITkgmTransport SharedTransport = new RestSharpTkgmTransport();
        private static readonly TkgmUpstreamConcurrencyGate UpstreamConcurrencyGate = new(MaxConcurrentUpstreamRequests);
        private static readonly ConcurrentDictionary<int, AdministrativeCacheEntry> DistrictsCache = new();
        private static readonly ConcurrentDictionary<int, AdministrativeCacheEntry> NbhoodsCache = new();
        private static readonly ConcurrentDictionary<int, AdministrativeFetch> DistrictsInFlight = new();
        private static readonly ConcurrentDictionary<int, AdministrativeFetch> NbhoodsInFlight = new();
        private static readonly object DistrictsCacheAdmissionGate = new();
        private static readonly object NbhoodsCacheAdmissionGate = new();
        private readonly ITkgmTransport transport;
        private readonly TimeProvider timeProvider;

        public GisTkgmOperations(BusinessContext gisContext) : this(gisContext, SharedTransport, TimeProvider.System) { }
        public GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport) : this(gisContext, transport, TimeProvider.System) { }
        public GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport, TimeProvider timeProvider)
        {
            _ = gisContext ?? throw new ArgumentNullException(nameof(gisContext));
            this.transport = transport ?? throw new ArgumentNullException(nameof(transport));
            this.timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        }

        public Task<string> DistrictsAsync(int cityId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(cityId, nameof(cityId));
            return GetAdministrativeAsync(DistrictsCache, DistrictsCacheAdmissionGate, DistrictsInFlight, cityId, "/idariYapi/ilceListe/" + cityId, cancellationToken);
        }

        public Task<string> NbhoodsAsync(int districtId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(districtId, nameof(districtId));
            return GetAdministrativeAsync(NbhoodsCache, NbhoodsCacheAdmissionGate, NbhoodsInFlight, districtId, "/idariYapi/mahalleListe/" + districtId, cancellationToken);
        }

        public Task<string> ParcelAsync(int districtId, int nbhoodId, int cityblock, int parcel, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(districtId, nameof(districtId));
            EnsurePositiveId(nbhoodId, nameof(nbhoodId));
            EnsurePositiveId(cityblock, nameof(cityblock));
            EnsurePositiveId(parcel, nameof(parcel));
            return ExecuteTransportAsync("/parsel/" + nbhoodId + "/" + cityblock + "/" + parcel, cancellationToken);
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

        internal static (long Districts, long Neighbourhoods) GetAdministrativeCacheByteCountsForTesting()
        {
            lock (DistrictsCacheAdmissionGate)
            lock (NbhoodsCacheAdmissionGate)
                return (CalculateCacheBytes(DistrictsCache), CalculateCacheBytes(NbhoodsCache));
        }

        private async Task<string> GetAdministrativeAsync(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, object admissionGate, ConcurrentDictionary<int, AdministrativeFetch> inFlight, int key, string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (TryGetFresh(cache, key, out var cached)) return cached;
            AdministrativeFetch flight;
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (TryGetFresh(cache, key, out cached)) return cached;
                if (inFlight.TryGetValue(key, out var existing))
                {
                    if (existing.TryAddSubscriber()) { flight = existing; break; }
                    inFlight.TryRemove(new KeyValuePair<int, AdministrativeFetch>(key, existing));
                    continue;
                }
                var candidate = new AdministrativeFetch(
                    sharedCancellation => FetchAndPublishAdministrativeAsync(cache, admissionGate, key, relativePath, sharedCancellation),
                    completed => inFlight.TryRemove(new KeyValuePair<int, AdministrativeFetch>(key, completed)));
                if (inFlight.TryAdd(key, candidate))
                {
                    if (candidate.TryAddSubscriber()) { flight = candidate; break; }
                    inFlight.TryRemove(new KeyValuePair<int, AdministrativeFetch>(key, candidate));
                }
                candidate.Dispose();
            }

            var subscriberReleased = 0;
            using var cancellationRegistration = cancellationToken.Register(() =>
            {
                if (Interlocked.Exchange(ref subscriberReleased, 1) == 0) flight.ReleaseSubscriber();
            });
            try { return await flight.Work.WaitAsync(cancellationToken).ConfigureAwait(false); }
            finally
            {
                if (Interlocked.Exchange(ref subscriberReleased, 1) == 0) flight.ReleaseSubscriber();
            }
        }

        private async Task<string> FetchAndPublishAdministrativeAsync(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, object admissionGate, int key, string relativePath, CancellationToken sharedCancellation)
        {
            sharedCancellation.ThrowIfCancellationRequested();
            if (TryGetFresh(cache, key, out var cached)) return cached;
            var content = await ExecuteTransportAsync(relativePath, sharedCancellation).ConfigureAwait(false);
            sharedCancellation.ThrowIfCancellationRequested();
            PublishBounded(cache, admissionGate, key, content);
            return content;
        }

        private Task<string> ExecuteTransportAsync(string relativePath, CancellationToken cancellationToken) =>
            UpstreamConcurrencyGate.ExecuteAsync(token => transport.GetAsync(relativePath, token), cancellationToken);

        private bool TryGetFresh(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, int key, out string content)
        {
            if (cache.TryGetValue(key, out var entry))
            {
                var age = timeProvider.GetUtcNow() - entry.CreatedAt;
                if (age >= TimeSpan.Zero && age < AdministrativeCacheTtl) { content = entry.Content; return true; }
                cache.TryRemove(new KeyValuePair<int, AdministrativeCacheEntry>(key, entry));
            }
            content = string.Empty;
            return false;
        }

        private void PublishBounded(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, object admissionGate, int key, string content)
        {
            if (string.IsNullOrWhiteSpace(content)) throw new InvalidOperationException("TKGM administrative response cannot be cached when empty.");
            var byteCount = Encoding.UTF8.GetByteCount(content);
            if (byteCount > MaxAdministrativeCacheEntryBytes) return;
            lock (admissionGate)
            {
                var now = timeProvider.GetUtcNow();
                PruneExpiredAndFutureEntries(cache, now);
                cache.TryRemove(key, out _);
                EnsureAdmissionCapacity(cache, byteCount);
                cache[key] = new AdministrativeCacheEntry(content, now, byteCount);
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

        private static void EnsureAdmissionCapacity(ConcurrentDictionary<int, AdministrativeCacheEntry> cache, int incomingBytes)
        {
            var cachedBytes = CalculateCacheBytes(cache);
            while (cache.Count >= MaxAdministrativeCacheEntries || cachedBytes + incomingBytes > MaxAdministrativeCacheBytes)
            {
                var oldest = cache.OrderBy(pair => pair.Value.CreatedAt).ThenBy(pair => pair.Key).FirstOrDefault();
                if (oldest.Value is null) throw new InvalidOperationException("TKGM administrative cache cannot satisfy configured admission budgets.");
                if (!cache.TryRemove(new KeyValuePair<int, AdministrativeCacheEntry>(oldest.Key, oldest.Value))) { Thread.Yield(); continue; }
                cachedBytes -= oldest.Value.ByteCount;
            }
        }

        private static long CalculateCacheBytes(ConcurrentDictionary<int, AdministrativeCacheEntry> cache)
        {
            long total = 0;
            foreach (var entry in cache.Values) total = checked(total + entry.ByteCount);
            return total;
        }

        private static void CancelAndClearFlights(ConcurrentDictionary<int, AdministrativeFetch> inFlight)
        {
            foreach (var pair in inFlight)
                if (inFlight.TryRemove(new KeyValuePair<int, AdministrativeFetch>(pair.Key, pair.Value))) pair.Value.StopAcceptingAndCancel();
        }

        private static void EnsurePositiveId(int value, string parameterName)
        {
            if (value <= 0) throw new ArgumentOutOfRangeException(parameterName, value, "TKGM identifiers must be positive.");
        }

        public void Dispose() { }
        private sealed record AdministrativeCacheEntry(string Content, DateTimeOffset CreatedAt, int ByteCount);

        private sealed class AdministrativeFetch : IDisposable
        {
            private readonly object gate = new();
            private readonly CancellationTokenSource cancellationSource = new();
            private readonly Lazy<Task<string>> workFactory;
            private readonly Action<AdministrativeFetch> completedCallback;
            private bool accepting = true;
            private bool completed;
            private bool disposed;
            private int subscribers;

            public AdministrativeFetch(Func<CancellationToken, Task<string>> factory, Action<AdministrativeFetch> completedCallback)
            {
                this.completedCallback = completedCallback ?? throw new ArgumentNullException(nameof(completedCallback));
                workFactory = new Lazy<Task<string>>(() => ExecuteAsync(factory ?? throw new ArgumentNullException(nameof(factory))), LazyThreadSafetyMode.ExecutionAndPublication);
            }
            public Task<string> Work => workFactory.Value;
            public bool TryAddSubscriber() { lock (gate) { if (!accepting || disposed) return false; subscribers++; return true; } }
            public void ReleaseSubscriber()
            {
                bool cancelWork = false, disposeSource = false;
                lock (gate)
                {
                    if (subscribers <= 0) throw new InvalidOperationException("TKGM single-flight subscriber accounting underflow.");
                    subscribers--;
                    if (subscribers == 0) { accepting = false; cancelWork = !completed; disposeSource = completed; }
                }
                if (cancelWork) Cancel();
                if (disposeSource) DisposeCancellationSource();
            }
            public void StopAcceptingAndCancel() { bool cancelWork; lock (gate) { accepting = false; cancelWork = !completed; } if (cancelWork) Cancel(); }
            public void Dispose() { bool cancelWork; lock (gate) { if (disposed) return; accepting = false; cancelWork = !completed; } if (cancelWork) Cancel(); DisposeCancellationSource(); }
            private async Task<string> ExecuteAsync(Func<CancellationToken, Task<string>> factory)
            {
                try { return await factory(cancellationSource.Token).ConfigureAwait(false); }
                finally
                {
                    bool disposeSource;
                    lock (gate) { completed = true; accepting = false; disposeSource = subscribers == 0; }
                    completedCallback(this);
                    if (disposeSource) DisposeCancellationSource();
                }
            }
            private void Cancel() { try { cancellationSource.Cancel(); } catch (ObjectDisposedException) { } }
            private void DisposeCancellationSource() { lock (gate) { if (disposed) return; disposed = true; } cancellationSource.Dispose(); }
        }
    }
}
