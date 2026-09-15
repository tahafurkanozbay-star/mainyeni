using Business._Base;

namespace Business.Core.Model
{
    public partial class BusinessException : _BaseModel
    {
        public string Source { get; set; } 

        public string Message { get; set; }
        
        public string StackTrace { get; set; }

    }
}
