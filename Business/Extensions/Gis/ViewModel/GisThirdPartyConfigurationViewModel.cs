using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Business.Extensions.Gis.ViewModel
{
    public class GisThirdPartyConfigurationViewModel
    {
        public String EsriApiKey { get; set; }

        public String GoogleMapsApiKey { get; set; }

        public String YandexApiKey { get; set; }

        public String TucbsRootUrl { get; set; }        
    }
}
