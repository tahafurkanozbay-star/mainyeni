using Business._Base;

namespace Business.Extensions.Gis._Base
{
    public class _BaseGisService : _BaseModel
    {
        public string Title { get; set; }

        public string Url { get; set; }

        public bool RequiresSC { get; set; }

        public string SCUserName { get; set; }

        public string SCPassword { get; set; }

        public string Description { get; set; }

        public string AdditionalInfo { get; set; }
    }
}