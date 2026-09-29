using System;
using System.Collections.Generic;
using System.ServiceModel;
using System.Threading;
using System.Threading.Tasks;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Resources;
using Business.Extensions.Integrations.Pod.AEOServiceReference;
using Business.Extensions.Integrations.ViewModel;

namespace Business.Extensions.Integrations.Operations
{
    /// <summary>
    /// Owns the server-side boundary to the Ankara Chamber of Pharmacists SOAP service.
    /// Browser callers never receive the upstream endpoint and cancellation is propagated from
    /// ASP.NET so abandoned requests do not retain an application request indefinitely.
    /// </summary>
    public class PodOperations : _BaseOperations
    {
        public const string ServiceEndpoint = "https://mvc.aeo.org.tr/PublicSayfalar/WebServices/ws_AEO_Nobet.asmx";

        private static readonly TimeSpan PreviousDayCutoff = new TimeSpan(9, 30, 0);
        private readonly BusinessContext db;

        public PodOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        public Task<ServiceResult<List<PodViewModel>>> GetTodaysPods()
        {
            return GetTodaysPods(CancellationToken.None);
        }

        public async Task<ServiceResult<List<PodViewModel>>> GetTodaysPods(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var endpointAddress = new EndpointAddress(ServiceEndpoint);
            using var client = new ws_AEO_NobetSoapClient(
                ws_AEO_NobetSoapClient.EndpointConfiguration.ws_AEO_NobetSoap,
                endpointAddress);

            var requestDate = ResolveServiceDate(DateTime.Now);
            try
            {
                // The generated SOAP proxy does not expose a CancellationToken overload. WaitAsync
                // still releases this request as soon as the caller disconnects instead of holding
                // the ASP.NET request open until the remote service eventually completes.
                var result = await client
                    .NobetciEczaneGetirTarihAsync(requestDate)
                    .WaitAsync(cancellationToken)
                    .ConfigureAwait(false);

                cancellationToken.ThrowIfCancellationRequested();
                return MapResponse(result);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                AbortSafely(client);
                throw;
            }
            catch (TimeoutException)
            {
                AbortSafely(client);
                throw;
            }
            catch (CommunicationException)
            {
                AbortSafely(client);
                throw;
            }
        }

        /// <summary>
        /// The provider publishes the new duty roster at 09:30 local server time. Before that
        /// boundary the previous calendar day is authoritative. Keeping this calculation pure
        /// makes the rollover contract deterministic and regression-testable.
        /// </summary>
        public static DateTime ResolveServiceDate(DateTime localNow)
        {
            var date = localNow.Date;
            return localNow.TimeOfDay < PreviousDayCutoff ? date.AddDays(-1) : date;
        }

        private static ServiceResult<List<PodViewModel>> MapResponse(NobetciEczaneGetirTarihResponse result)
        {
            var payload = result?.Body?.NobetciEczaneGetirTarihResult;
            if (payload == null || !payload.isSuccess || payload.NobetciEczaneBilgisiListesi == null)
            {
                return new ServiceResult<List<PodViewModel>>(
                    ServiceResultType.Error,
                    BusinessMessages.Get("NOT_FOUND"),
                    null);
            }

            var source = payload.NobetciEczaneBilgisiListesi;
            var pods = new List<PodViewModel>(source.Length);
            for (var index = 0; index < source.Length; index++)
            {
                var item = source[index];
                if (item == null)
                {
                    continue;
                }

                pods.Add(new PodViewModel
                {
                    Id = index,
                    Distance = item.Distance,
                    DistrictName = item.BolgeAdi,
                    Address = item.EczaneAdresi,
                    AddressDescription = item.AdresAciklamasi,
                    Lat = item.KoordinatLat,
                    Lng = item.KoordinatLng,
                    Phone = item.Telefon,
                    Title = Toolbox.Text.TextUtils.Capitalize(item.EczaneAdi) + " Eczanesi"
                });
            }

            return new ServiceResult<List<PodViewModel>>(ServiceResultType.Success, pods);
        }

        private static void AbortSafely(ws_AEO_NobetSoapClient client)
        {
            try
            {
                client.Abort();
            }
            catch
            {
                // Preserve the original cancellation/transport failure. Abort is best-effort only.
            }
        }
    }
}
