using Business.Extensions.Gis._Base;

namespace Business.Extensions.Gis.Model
{
    public partial class GisConfigService : _BaseGisService
    {
        public string Category { get; set; }
        public bool ShowInSearch { get; set; }
        public string SearchCategoryTitle { get; set; }
        public bool IsIdentifiable { get; set; }
        public string IdentifyLayers { get; set; }

    }

}