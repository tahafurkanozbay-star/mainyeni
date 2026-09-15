using Business._Base;
using Business.Core.Model;

namespace Business.Core.Model
{
    public partial class ClientLog
    {   
        public int Id { get; set; }
        public string Guid { get; set; }

        public long CreateDate { get; set; }
        
        public string LogType { get; set; }
        
        public string Details { get; set; }
        
        public string Browser { get; set; } 
        
        public string Device { get; set; } 
        
        public string Os { get; set; } 
        
        public string Ip { get; set; } 
    }
}
