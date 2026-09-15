using Business._Base;
using Business.Core.Context;
using RestSharp;
using System.Collections.Generic;

namespace Business.Extensions.Gis.Operations
{
    public class GisTkgmOperations : _BaseOperations
    {
        private const string tkgmBaseUrl = "http://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api";
        private const string referrer = "http://parselsorgu.tkgm.gov.tr"; //http://parselsorgu.tkgm.gov.tr

        private BusinessContext gisDb;

        public GisTkgmOperations(BusinessContext gisContext)
        {
            this.gisDb = gisContext;
        }

        private static string districtsCache=null;
        public string Districts(int cityId)
        {
            if(districtsCache!=null){
                return districtsCache;
            }

            var url = tkgmBaseUrl + "/idariYapi/ilceListe/" + cityId;
            var request = new RestRequest(url, Method.Get);
            request.AddHeader("Referer", referrer);
            request.AddHeader("Origin", referrer);

            var client = new RestClient();
            var response = client.Execute(request);

            districtsCache=response.Content;
            return response.Content;
        }


        private static Dictionary<int, string> nbhoodsCache=new Dictionary<int, string>();
        public string Nbhoods(int districtId)
        {
            if(nbhoodsCache.ContainsKey(districtId)){
                return nbhoodsCache.GetValueOrDefault(districtId);
            }

            var url = tkgmBaseUrl + "/idariYapi/mahalleListe/" + districtId;
            var request = new RestRequest(url, Method.Get);
            request.AddHeader("Referer", referrer);
            request.AddHeader("Origin", referrer);

            var client = new RestClient();
            var response = client.Execute(request);

            nbhoodsCache.Add(districtId, response.Content);

            return response.Content;
        }


        public string Parcel(int districtId, int nbhoodId, int cityblock, int parcel)
        {
            var url = tkgmBaseUrl + "/parsel/" + nbhoodId + "/" + cityblock + "/" + parcel;
            var request = new RestRequest(url, Method.Get);
            request.AddHeader("Referer", referrer);
            request.AddHeader("Origin", referrer);

            var client = new RestClient();
            var response = client.Execute(request);

            return response.Content;
        }
    }
}