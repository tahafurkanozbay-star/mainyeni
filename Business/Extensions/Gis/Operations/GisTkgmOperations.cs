using Business._Base;
using Business.Core.Context;
using RestSharp;
using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace Business.Extensions.Gis.Operations
{
    public interface ITkgmTransport
    {
        Task<string> GetAsync(string relativePath, CancellationToken cancellationToken);
    }

    /// <summary>
    /// RestSharp-backed TKGM transport. The transport owns protocol concerns while the operation
    /// owns validation and cache policy, which keeps external I/O independently testable.
    /// </summary>
    public sealed class RestSharpTkgmTransport : ITkgmTransport, IDisposable
    {
        private const string TkgmBaseUrl = "http://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api";
        private const string Referrer = "http://parselsorgu.tkgm.gov.tr";
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);
        private readonly RestClient client;

        public RestSharpTkgmTransport()
        {
            client = new RestClient(new RestClientOptions(TkgmBaseUrl)
            {
                Timeout = RequestTimeout
            });
        }

        public async Task<string> GetAsync(string relativePath, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(relativePath) || relativePath[0] != '/')
            {
                throw new ArgumentException("TKGM request path must be a non-empty relative API path.", nameof(relativePath));
            }

            cancellationToken.ThrowIfCancellationRequested();
            var request = new RestRequest(relativePath, Method.Get);
            request.AddHeader("Referer", Referrer);
            request.AddHeader("Origin", Referrer);

            var response = await client.ExecuteAsync(request, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();

            if (!response.IsSuccessful)
            {
                throw new InvalidOperationException(
                    "TKGM request failed with HTTP status " + (int)response.StatusCode + ".");
            }

            if (string.IsNullOrWhiteSpace(response.Content))
            {
                throw new InvalidOperationException("TKGM request returned an empty response body.");
            }

            return response.Content;
        }

        public void Dispose()
        {
            client.Dispose();
        }
    }

    /// <summary>
    /// Server-side adapter for the legacy TKGM parcel service.
    /// External requests stay behind an injectable transport boundary, honor ASP.NET request
    /// cancellation and publish only successful administrative-list responses into bounded caches.
    /// </summary>
    public class GisTkgmOperations : _BaseOperations, IDisposable
    {
        private const int MaxAdministrativeCacheEntries = 512;
        private static readonly ConcurrentDictionary<int, string> DistrictsCache = new ConcurrentDictionary<int, string>();
        private static readonly ConcurrentDictionary<int, string> NbhoodsCache = new ConcurrentDictionary<int, string>();

        private readonly ITkgmTransport transport;
        private readonly bool ownsTransport;

        public GisTkgmOperations(BusinessContext gisContext)
            : this(gisContext, new RestSharpTkgmTransport(), true)
        {
        }

        public GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport)
            : this(gisContext, transport, false)
        {
        }

        private GisTkgmOperations(BusinessContext gisContext, ITkgmTransport transport, bool ownsTransport)
        {
            _ = gisContext ?? throw new ArgumentNullException(nameof(gisContext));
            this.transport = transport ?? throw new ArgumentNullException(nameof(transport));
            this.ownsTransport = ownsTransport;
        }

        public async Task<string> DistrictsAsync(int cityId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(cityId, nameof(cityId));
            cancellationToken.ThrowIfCancellationRequested();
            if (DistrictsCache.TryGetValue(cityId, out var cached))
            {
                return cached;
            }

            var content = await transport.GetAsync("/idariYapi/ilceListe/" + cityId, cancellationToken).ConfigureAwait(false);
            PublishBounded(DistrictsCache, cityId, content);
            return content;
        }

        public async Task<string> NbhoodsAsync(int districtId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(districtId, nameof(districtId));
            cancellationToken.ThrowIfCancellationRequested();
            if (NbhoodsCache.TryGetValue(districtId, out var cached))
            {
                return cached;
            }

            var content = await transport.GetAsync("/idariYapi/mahalleListe/" + districtId, cancellationToken).ConfigureAwait(false);
            PublishBounded(NbhoodsCache, districtId, content);
            return content;
        }

        /// <summary>
        /// Parcel responses remain uncached because this adapter has no authoritative invalidation signal.
        /// </summary>
        public Task<string> ParcelAsync(
            int districtId,
            int nbhoodId,
            int cityblock,
            int parcel,
            CancellationToken cancellationToken = default)
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
            DistrictsCache.Clear();
            NbhoodsCache.Clear();
        }

        private static void PublishBounded(ConcurrentDictionary<int, string> cache, int key, string content)
        {
            if (cache.Count >= MaxAdministrativeCacheEntries && !cache.ContainsKey(key))
            {
                // Administrative lists are an optimization, not an authority. Clearing is deterministic,
                // bounded and safer than retaining an unbounded process-wide key set indefinitely.
                cache.Clear();
            }

            cache.TryAdd(key, content);
        }

        private static void EnsurePositiveId(int value, string parameterName)
        {
            if (value <= 0)
            {
                throw new ArgumentOutOfRangeException(parameterName, value, "TKGM identifiers must be positive.");
            }
        }

        public void Dispose()
        {
            if (ownsTransport && transport is IDisposable disposable)
            {
                disposable.Dispose();
            }
        }
    }
}