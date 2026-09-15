using Business.Core.Model;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.Serialization;
using System.Text;
using System.Threading.Tasks;

namespace Business.Extensions.Gis.ViewModel
{
    public class GisLayerGroupAdminViewModel
    {
        public string Eg { get; set; }

        public String Title { get; set; }        

        public List<GisLayerAdminViewModel> Layers{ get; set; }

        public int Id { get; set; }
    }
}