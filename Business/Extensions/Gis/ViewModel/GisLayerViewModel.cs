using System;
using System.Runtime.Serialization;
using Business.Extensions.Gis.Model;

namespace Business.Extensions.Gis.ViewModel
{
    
    public class GisLayerViewModel
    {
        
        public string Title { get; set; }

        
        public string Url { get; set; }

        
        public GisLayerType LayerType { get; set; }

        
        public int Id { get; set; }

        
        public bool Visible { get; set; }

        
        public int Opacity { get; set; }

        
        public int Priority { get; set; }

        
        public string AdditionalInfo { get; set; }


        public bool IsSwipeLayer {get;set;}

        
        public bool IsTimelineLayer {get;set;}

        public string Description { get; set; }
        public string Eg { get; set; }
    }
}
