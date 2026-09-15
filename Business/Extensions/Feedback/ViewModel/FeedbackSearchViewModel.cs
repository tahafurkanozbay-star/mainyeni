using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Business.Extensions.FeedbackService.ViewModel
{
    public class FeedbackSearchViewModel
    {
        public int Id { get; set; }    
        public int FeedbackType { get; set; }
        public int Status { get; set; }
        public int ActionTaken { get; set; }
        public string Description { get; set; }
        public string FullName { get; set; }
        public string Country { get; set; }
        public string City { get; set; }
        public string Email { get; set; }
        public string Address { get; set; }
        public string Ip { get; set; }
        public string Browser { get; set; }
        public string Device { get; set; }
        public string Os { get; set; }
        public string CreateDateEnd { get; set; }
        public string CreateDateStart { get; set; }
        public int page { get; set; }
        public int pageSize { get; set; }

        public string _export { get; set; }
    }
}
