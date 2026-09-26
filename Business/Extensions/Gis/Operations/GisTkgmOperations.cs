using Business._Base;
using Business.Core.Context;
using RestSharp;
using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace Business.Extensions.Gis.Operations
{
    /// <summary>
    /// Server-side adapter for the legacy TKGM parcel service.
    /// External requests stay behind this operation boundary, are time-bounded, and honor the
    /// ASP.NET request cancellation token so disconnected clients do not leave orphaned I/O.
    /// </summary>
    public class GisTkgmOperations : _BaseOperations
    {
        private const string TkgmBaseUrl = "http://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api";
        private const string Referrer = "http://parselsorgu.tkgm.gov.tr";
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

        private static readonly ConcurrentDictionary<int, string> DistrictsCache = new ConcurrentDictionary<int, string>();
        private static readonly ConcurrentDictionary<int, string> NbhoodsCache = new ConcurrentDictionary<int, string>();

        private readonly BusinessContext gisDb;

        public GisTkgmOperations(BusinessContext gisContext)
        {
            gisDb = gisContext ?? throw new ArgumentNullException(nameof(gisContext));
        }

        public async Task<string> DistrictsAsync(int cityId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(cityId, nameof(cityId));
            if (DistrictsCache.TryGetValue(cityId, out var cached))
            {
                return cached;
            }

            var content = await ExecuteGetAsync("/idariYapi/ilceListe/" + cityId, cancellationToken).ConfigureAwait(false);
            DistrictsCache.TryAdd(cityId, content);
            return content;
        }

        public async Task<string> NbhoodsAsync(int districtId, CancellationToken cancellationToken = default)
        {
            EnsurePositiveId(districtId, nameof(districtId));
            if (NbhoodsCache.TryGetValue(districtId, out var cached))
            {
                return cached;
            }

            var content = await ExecuteGetAsync("/idariYapi/mahalleListe/" + districtId, cancellationToken).ConfigureAwait(false);
            NbhoodsCache.TryAdd(districtId, content);
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

            return ExecuteGetAsync("/parsel/" + nbhoodId + "/" + cityblock + "/" + parcel, cancellationToken);
        }

        private static async Task<string> ExecuteGetAsync(string relativePath, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var options = new RestClientOptions(TkgmBaseUrl)
            {
                Timeout = RequestTimeout
            };
            using var client = new RestClient(options);
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

        private static void EnsurePositiveId(int value, string parameterName)
        {
            if (value <= 0)
            {
                throw new ArgumentOutOfRangeException(parameterName, value, "TKGM identifiers must be positive.");
            }
        }
    }
}
