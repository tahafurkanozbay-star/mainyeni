using System.Collections.Generic;
using Business.Extensions.Gis.Model;

namespace Business.Extensions.Gis.ViewModel
{
    public class GisConfigServiceGroup
    {
        public string GroupTitle { get; set; }
        public List<GisConfigService> Services { get; set; }
    }
}
