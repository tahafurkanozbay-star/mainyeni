using Business.Extensions.Gis._Base;

namespace Business.Extensions.Gis.Model
{
    public partial class GisLayer : _BaseGisService
    {
        public int GisLayerGroupId { get; set; }
        public virtual GisLayerGroup LayerGroup { get; set; }

        public int OrderPriority { get; set; }
        public bool VisibleAtStartup { get; set; }
        public int StartupOpacity { get; set; }
        public bool IsSwipeLayer {get;set;}
        public bool IsTimelineLayer {get;set;}

        public GisLayerType LayerType { get; set; }

    }   

 public enum GisLayerType
    {        
        MapImageLayer=0,
        FeatureLayer=2,
        WMSLayer=3,
    }
}