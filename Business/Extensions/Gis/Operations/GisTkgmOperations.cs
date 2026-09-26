using Business._Base;
using Business.Core.Context;
using RestSharp;
using System;
using System.Collections.Concurrent;
using System.Threading;

namespace Business.Extensions.Gis.Operations
{
    /// <summary>
    /// Server-side adapter for the legacy TKGM parcel service.
    ///
    /// Keep the external transport behind this operation boundary. The endpoint is an existing
    /// integration and is intentionally not exposed to browser code. Requests are bounded by a
    /// finite timeout and cache publication is thread-safe so concurrent ASP.NET requests cannot
    /// corrupt shared state or issue an unbounded number of identical district/ neighbourhood calls.
    /// </summary>
    public class GisTkgmOperations : _BaseOperations
    {
        private const string TkgmBaseUrl = "http://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api";
        private const string Referrer = "http://parselsorgu.tkgm.gov.tr";
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

        private static readonly object DistrictsCacheGate = new object();
        private static readonly ConcurrentDictionary<int, Lazy<string>> NbhoodsCache =
            new ConcurrentDictionary<int, Lazy<string>>();

        private static string districtsCache;
        private static int? districtsCacheCityId;

        private readonly BusinessContext gisDb;

        public GisTkgmOperations(BusinessContext gisContext)
        {
            gisDb = gisContext ?? throw new ArgumentNullException(nameof(gisContext));
        }

        /// <summary>
        /// Gets districts for the requested city. The old implementation kept one process-wide
        /// string without remembering which city produced it; a request for another city could
        /// therefore receive stale data. The cache now binds the payload to its city identifier.
        /// </summary>
        public string Districts(int cityId)
        {
            EnsurePositiveId(cityId, nameof(cityId));

            lock (DistrictsCacheGate)
            {
                if (districtsCache != null && districtsCacheCityId == cityId)
                {
                    return districtsCache;
                }

                var content = ExecuteGet("/idariYapi/ilceListe/" + cityId);
                districtsCache = content;
                districtsCacheCityId = cityId;
                return content;
            }
        }

        /// <summary>
        /// Gets neighbourhoods for a district. Lazy publication provides single-flight semantics
        /// for concurrent cache misses while ConcurrentDictionary makes reads/writes race-safe.
        /// Failed requests are evicted so a transient upstream failure is never cached forever.
        /// </summary>
        public string Nbhoods(int districtId)
        {
            EnsurePositiveId(districtId, nameof(districtId));

            var lazy = NbhoodsCache.GetOrAdd(
                districtId,
                id => new Lazy<string>(
                    () => ExecuteGet("/idariYapi/mahalleListe/" + id),
                    LazyThreadSafetyMode.ExecutionAndPublication));

            try
            {
                return lazy.Value;
            }
            catch
            {
                NbhoodsCache.TryRemove(districtId, out _);
                throw;
            }
        }

        /// <summary>
        /// Gets one parcel. Parcel responses are intentionally not process-cached because parcel
        /// data can change independently and this adapter has no authoritative invalidation signal.
        /// </summary>
        public string Parcel(int districtId, int nbhoodId, int cityblock, int parcel)
        {
            EnsurePositiveId(districtId, nameof(districtId));
            EnsurePositiveId(nbhoodId, nameof(nbhoodId));
            EnsurePositiveId(cityblock, nameof(cityblock));
            EnsurePositiveId(parcel, nameof(parcel));

            return ExecuteGet("/parsel/" + nbhoodId + "/" + cityblock + "/" + parcel);
        }

        private static string ExecuteGet(string relativePath)
        {
            var options = new RestClientOptions
            {
                Timeout = RequestTimeout
            };
            using var client = new RestClient(options);
            var request = new RestRequest(TkgmBaseUrl + relativePath, Method.Get);
            request.AddHeader("Referer", Referrer);
            request.AddHeader("Origin", Referrer);

            var response = client.Execute(request);
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