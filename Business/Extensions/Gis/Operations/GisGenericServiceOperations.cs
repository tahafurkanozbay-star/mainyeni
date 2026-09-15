using System;
using System.Linq;
using System.Collections.Generic;
using Business._Base;
using Business.Core.Context;
using Business.Extensions.Gis.Model;
using Business.Extensions.Gis._Base;

namespace Business.Extensions.Gis.Operations
{
    public class GisGenericServiceOperations : _BaseOperations
    {
        private BusinessContext gisDb;

        public GisGenericServiceOperations(BusinessContext gisContext)
        {
            this.gisDb = gisContext;
        }


        public _BaseGisService GetServiceByEncryptedGuid(string eg)
        {

            _BaseGisService service = null;
                using (gisDb)
                {
                    GisLayer layer= GetEntityByEncryptedGuid<GisLayer>(gisDb, eg);
                    if (layer!=null) {

                        service = (_BaseGisService)GetEntityByEncryptedGuid<GisLayer>(gisDb, eg);
                        //service.ServiceType = "layer/"+layer.LayerType.ToString();
                        return service;
                    }


                    if (layer == null)
                    {
                        service = (_BaseGisService)GetEntityByEncryptedGuid<GisConfigService>(gisDb, eg);
                        //service.ServiceType = "configuration";
                    }

                    if (service == null)
                    {
                        service = (_BaseGisService)GetEntityByEncryptedGuid<GisBasemapLayer>(gisDb, eg);
                        //service.ServiceType = "basemaplayer";
                    }

                }


            return service;
        }

        public static List<_BaseGisService> EimarServiceCache = new List<_BaseGisService>();

        public _BaseGisService GetServiceByUrl(string serviceurl)
        {
            _BaseGisService service = null;
            serviceurl = serviceurl.Trim();
            
               using (gisDb)
                {   
                    if (!String.IsNullOrEmpty(serviceurl))
                    {
                        service = (_BaseGisService)gisDb.GisLayers.FirstOrDefault(x => x.Url.Contains(serviceurl));

                        if (service == null)
                        {
                            service = (_BaseGisService)gisDb.GisConfigServices.FirstOrDefault(x => x.Url.Contains(serviceurl));
                        }

                        if (service == null)
                        {
                            service = (_BaseGisService)gisDb.GisBasemapLayers.FirstOrDefault(x => x.Url.Contains(serviceurl));
                        }
                    }
                }
         
            return service;
        }
    }
}