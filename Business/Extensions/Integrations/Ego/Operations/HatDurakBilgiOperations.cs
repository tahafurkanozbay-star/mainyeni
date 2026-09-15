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
    public class HatDurakBilgiOperations : _BaseOperations
    {

        private BusinessContext db;
        private HatDurakBilgiServisSoap client;
        private string token=Configuration.EGO_SERVICE_TOKEN;

        public HatDurakBilgiOperations(BusinessContext context)
        {
            this.db = context;
            client= new HatDurakBilgiServisSoapClient(HatDurakBilgiServisSoapClient.EndpointConfiguration.HatDurakBilgiServisSoap);
        }

        public async Task<ServiceResult<List<Hat>>> ActiveLines()
        {
            var results=await client.AktifHatlarAsync(token);
            return new ServiceResult<List<Hat>>(ServiceResultType.Success,results.ToList());
        }

        public async Task<ServiceResult<List<HatGuzergahDuraklar>>> ActiveLineInfos()
        {
            var results=await client.AktifHatlarBilgisiAsync(token);
            return new ServiceResult<List<HatGuzergahDuraklar>>(ServiceResultType.Success,results.ToList());
        }

        public async Task<ServiceResult<List<MasterDurak>>> ActiveStops()
        {
            var results=await client.AktifDuraklarAsync(token);
            return new ServiceResult<List<MasterDurak>>(ServiceResultType.Success,results.ToList());
        }

        public async Task<ServiceResult<List<DuraktanGecenHatlar>>> LinesOfStop()
        {
            var results=await client.DuraktanGecenHatlarAsync(token);
            return new ServiceResult<List<DuraktanGecenHatlar>>(ServiceResultType.Success,results.ToList());
        }

        public async Task<ServiceResult<HatGuzergahDuraklar>> LineInfo(string lineNumber)
        {
            var result=await client.HatBilgisiAsync(token, lineNumber);
            return new ServiceResult<HatGuzergahDuraklar>(ServiceResultType.Success,result);
        }
    }
}