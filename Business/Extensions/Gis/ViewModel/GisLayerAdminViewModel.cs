using System;
using System.Runtime.Serialization;
using Business.Core.Model;
using Business.Extensions.Gis.Model;

namespace Business.Extensions.Gis.ViewModel
{    
    public class GisLayerAdminViewModel
    {
        public int GisLayerGroupId { get; set; }        
        public string Title { get; set; }
        public string Url { get; set; }
        public GisLayerType LayerType { get; set; }
        public string Eg { get; set; }
        public bool VisibleAtStartup { get; set; }
        public int StartupOpacity { get; set; }
        public int OrderPriority { get; set; }
        public string AdditionalInfo { get; set; }
        public bool IsSwipeLayer {get;set;}
        public bool IsTimelineLayer {get;set;}
        public string Description { get; set; }
        public bool RequiresSC { get; set; }
        public string SCUserName { get; set; }
        public string SCPassword { get; set; }
        public int Id { get;  set; }
    }
}