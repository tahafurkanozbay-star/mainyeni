using Business._Base;
using Business.Core.Model;

namespace Business.Core.Model
{
    public partial class AppConfig : _BaseModel
    {
        public string ConfigKey { get; set; }
        public string ConfigValue { get; set; }
    }
}
