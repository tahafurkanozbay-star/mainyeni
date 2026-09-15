using System;

namespace Business.Extensions.Integrations.ViewModel
{

    public class PodViewModel
    {
        public int Id { get; set; }
 
        public String Title { get; set; }
 
        public String Address { get; set; }
 
        public String AddressDescription { get; set; }
 
        public String Phone { get; set; }
 
        public decimal? Lat { get; set; }
         
        public decimal? Lng { get; set; }
 
        public double Distance { get; internal set; }
 
        public string DistrictName { get; internal set; }
    }
}
