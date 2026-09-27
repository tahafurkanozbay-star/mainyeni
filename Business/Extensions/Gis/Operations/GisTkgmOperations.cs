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
        private static readonly ConcurrentDictionary<int, AdministrativeCacheEntry> DistrictsCache = new();
        private static readonly ConcurrentDictionary<int, AdministrativeCacheEntry> NbhoodsCache = new();
        private static readonly object DistrictsCacheAdmissionGate = new();
        private static readonly object NbhoodsCacheAdmissionGate = new();
        private readonly ITkgmTransport transport;
        private readonly bool ownsTransport;
        private readonly TimeProvider timeProvider;

        public GisTkgmOperations(BusinessContext gisContext)
            : this(gisContext, new RestSharpTkgmTransport(), true, TimeProvider.System) { }

        public GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport)
            : this(gisContext, transport, false, TimeProvider.System) { }

        public GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport, TimeProvider timeProvider)
            : this(gisContext, transport, false, timeProvider) { }

        private GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport, bool ownsTransport, TimeProvider timeProvider)
        {
            _ = gisContext ?? throw new ArgumentNullException(nameof(gisContext));
            this.transport = transport ?? throw new ArgumentNullException(nameof(transport));
            this.timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
            this.ownsTransport = ownsTransport;
        }

        public async Task<string> DistrictsAsync(int cityId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(cityId, nameof(cityId));
            cancellationToken.ThrowIfCancellationRequested();
            if (TryGetFresh(DistrictsCache, cityId, out var cached)) return cached;
            var content = await transport.GetAsync("/idariYapi/ilceListe/" + cityId, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            PublishBounded(DistrictsCache, DistrictsCacheAdmissionGate, cityId, content);
            return content;
        }

        public async Task<string> NbhoodsAsync(int districtId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(districtId, nameof(districtId));
            cancellationToken.ThrowIfCancellationRequested();
            if (TryGetFresh(NbhoodsCache, districtId, out var cached)) return cached;
            var content = await transport.GetAsync("/idariYapi/mahalleListe/" + districtId, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            PublishBounded(NbhoodsCache, NbhoodsCacheAdmissionGate, districtId, content);
            return content;
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
            lock (DistrictsCacheAdmissionGate) DistrictsCache.Clear();
            lock (NbhoodsCacheAdmissionGate) NbhoodsCache.Clear();
        }

        internal static (int Districts, int Neighbourhoods) GetAdministrativeCacheCountsForTesting()
        {
            lock (DistrictsCacheAdmissionGate)
            lock (NbhoodsCacheAdmissionGate)
                return (DistrictsCache.Count, NbhoodsCache.Count);
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

        private void PublishBounded(
            ConcurrentDictionary<int, AdministrativeCacheEntry> cache,
            object admissionGate,
            int key,
            string content)
        {
            if (string.IsNullOrWhiteSpace(content))
                throw new InvalidOperationException("TKGM administrative response cannot be cached when empty.");

            lock (admissionGate)
            {
                // Read the clock only after entering the admission gate. Capturing it before the
                // lock lets a delayed publisher carry an older timestamp behind a publisher that
                // entered first; its prune pass would then misclassify those newer entries as
                // future-dated and remove valid cache members during a concurrent burst.
                var now = timeProvider.GetUtcNow();
                PruneExpiredAndFutureEntries(cache, now);
                EnsureCapacityForNewKey(cache, key);
                cache[key] = new AdministrativeCacheEntry(content, now);
            }
        }

        private static void PruneExpiredAndFutureEntries(
            ConcurrentDictionary<int, AdministrativeCacheEntry> cache,
            DateTimeOffset now)
        {
            foreach (var pair in cache)
            {
                var age = now - pair.Value.CreatedAt;
                if (age < TimeSpan.Zero || age >= AdministrativeCacheTtl)
                    cache.TryRemove(new KeyValuePair<int, AdministrativeCacheEntry>(pair.Key, pair.Value));
            }
        }

        private static void EnsureCapacityForNewKey(
            ConcurrentDictionary<int, AdministrativeCacheEntry> cache,
            int key)
        {
            if (cache.ContainsKey(key)) return;

            while (cache.Count >= MaxAdministrativeCacheEntries)
            {
                var oldest = cache
                    .OrderBy(pair => pair.Value.CreatedAt)
                    .ThenBy(pair => pair.Key)
                    .FirstOrDefault();

                if (oldest.Value is null) return;
                if (cache.TryRemove(new KeyValuePair<int, AdministrativeCacheEntry>(oldest.Key, oldest.Value))) continue;

                // Reads can invalidate stale entries concurrently. Re-evaluate the bounded set;
                // admission itself is serialized so two publishers cannot both observe spare capacity.
                Thread.Yield();
            }
        }

        private static void EnsurePositiveId(int value, string parameterName)
        {
            if (value <= 0) throw new ArgumentOutOfRangeException(parameterName, value, "TKGM identifiers must be positive.");
        }

        public void Dispose()
        {
            if (ownsTransport && transport is IDisposable disposable) disposable.Dispose();
        }

        private sealed record AdministrativeCacheEntry(string Content, DateTimeOffset CreatedAt);
    }
}