using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Business.Extensions.Gis.ViewModel
{
    public class GisMapConfigurationViewModel
    {
    
        [Display(Name = "Başlangıç Zoom")]
        public int Zoom { get; set; }

        [Display(Name = "Başlangıç Merkez Noktası X")]
        public string Centerx { get; set; }

        [Display(Name = "Başlangıç Merkez Noktası Y")]
        public string Centery { get; set; }

        [Display(Name = "Varsayılan altlık harita")]
        public string DefaultBasemapTitle { get; set; }

        public String EncryptedGuid { get; set; }

    }
}
