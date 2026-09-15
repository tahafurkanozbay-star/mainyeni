using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Threading.Tasks;

namespace Business.Core.Common
{
    public class ClientRequestInfo
    {
        public string Os { get; set; }
        public string Device { get; set; }
        public string Browser { get;  set; }
        public string Ip { get; set; }
        public string IpLocal { get; set; }
    }
}
