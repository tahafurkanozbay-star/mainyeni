using System.Runtime.Serialization;

namespace Business.Extensions.Gis.ViewModel
{    
    public class GisBookmarkViewModel
    {
        
        public int Id { get; set; }

        public int UserId { get; set; }

        public string Title { get; set; }

        public string Center { get; set; }

        public string Zoom { get; internal set; }
    }
}