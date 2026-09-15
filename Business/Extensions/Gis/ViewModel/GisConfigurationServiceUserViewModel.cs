using System.Collections.Generic;
using Business.Extensions.Gis.Model;

namespace Business.Extensions.Gis.ViewModel
{
    public class GisConfigurationServiceUserViewModel
    {
        public string Title { get; set; }

        public string Url { get; set; }

        public bool ShowInSearch { get; set; }
        public string SearchCategoryTitle { get; set; }
        public bool IsIdentifiable { get; set; }
        public string IdentifyLayers { get; set; }
        public string AdditionalInfo { get; set; }
        public string Eg { get; set; }
    }
}
