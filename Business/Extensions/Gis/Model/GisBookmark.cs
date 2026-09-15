using Business._Base;

namespace Business.Extensions.Gis.Model
{
    public class GisBookmark : _BaseModel
    {
        public int UserId { get; set; }
        public string Title { get; set; }
        public string Center { get; set; }
        public string Zoom { get; set; }

        public string aaaaa { get; set; }
        
        public string MyOtherProperty { get; set; }
        
        public int MyIntProperty { get; set; }
    }
}