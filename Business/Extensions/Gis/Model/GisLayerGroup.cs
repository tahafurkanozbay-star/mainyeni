using System.Collections.Generic;
using Business._Base;

namespace Business.Extensions.Gis.Model
{
    public class GisLayerGroup : _BaseModel
    {
        public int OrderPriority { get; set; }

        public string Title { get; set; }

        public virtual ICollection<GisLayer> Layers { get; set; }
    }
}