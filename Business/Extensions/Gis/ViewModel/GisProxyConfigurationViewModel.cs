using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Business.Extensions.Gis.ViewModel
{
    public class GisProxyConfigurationViewModel
    {
        [Display(Name ="Proxy Kullan")]
        public bool UseProxy { get; set; }

        [Display(Name = "Maskeleme Url")]
        public string MaskingUrl { get; set; }

        [Display(Name = "Referrer Kontrolü")]
        public bool ReferrerCheck { get; set; }
    }
}
