using System.Collections.Generic;
using System.Linq;
using Business._Base;
using Business.Core.Context;
using Business.Core.Common;
using Business.Extensions.Gis.Model;
using Business.Extensions.Integrations.ViewModel;
using Business.Core.Resources;
using System.Threading.Tasks;
using System.ServiceModel;
using Business.Extensions.Integrations.Pod.AEOServiceReference;

namespace Business.Extensions.Integrations.Operations
{
    public class PodOperations : _BaseOperations
    {

        private BusinessContext db;

        public PodOperations(BusinessContext context)
        {
            this.db = context;
        }


        public async Task<ServiceResult<List<PodViewModel>>> GetTodaysPods()
        {
            List<PodViewModel> pods = new List<PodViewModel>();

            var url="https://mvc.aeo.org.tr/PublicSayfalar/WebServices/ws_AEO_Nobet.asmx";
            
            var endpointAddress=new EndpointAddress(url);
            using(var client = new ws_AEO_NobetSoapClient(ws_AEO_NobetSoapClient.EndpointConfiguration.ws_AEO_NobetSoap, 
            endpointAddress)){

            var date = System.DateTime.Today;

            var hour = System.DateTime.Now.Hour;
            var minutes = System.DateTime.Now.Minute;
            if (hour < 9 && minutes <= 30)
            {
                date = date.AddDays(-1); //yesterday
            }

            //var result = await client.NobetciEczaneGetirTarihAsync(date);
            var result = await client.NobetciEczaneGetirTarihAsync(System.DateTime.Today);

            System.Console.WriteLine("---------------------------");
            System.Console.WriteLine(Toolbox.Serialization.SerializationUtils.ObjectToJson(result));
            System.Console.WriteLine("---------------------------");

            if (result.Body.NobetciEczaneGetirTarihResult.isSuccess)
            {
                int count = 0;

                foreach (var item in result.Body.NobetciEczaneGetirTarihResult.NobetciEczaneBilgisiListesi)
                {
                    var pod = new PodViewModel();
                    pod.Id = count;
                    pod.Distance = item.Distance;
                    pod.DistrictName = item.BolgeAdi;
                    pod.Address = item.EczaneAdresi;
                    pod.AddressDescription = item.AdresAciklamasi;
                    pod.Lat = item.KoordinatLat;
                    pod.Lng = item.KoordinatLng;
                    pod.Phone = item.Telefon;
                    pod.Title = Toolbox.Text.TextUtils.Capitalize(item.EczaneAdi) + " Eczanesi";
                    pods.Add(pod);
                    count++;
                }
            }
            else
            {

                return new ServiceResult<List<PodViewModel>>(ServiceResultType.Error, BusinessMessages.Get("NOT_FOUND"), null);
            }
            }
            

            


            return new ServiceResult<List<PodViewModel>>(ServiceResultType.Success, pods);

        }

    }
}