using System;

namespace Business.Extensions.FeedbackService.ViewModel
{
    public class FeedbackViewModel
    {
        public int Id { get; set; }
        public DateTime? CreateDate { get; set; }
        public int FeedbackType { get; set; }
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
        public int Status { get; set; }
        public int ActionTaken { get; set; }
        public int UpdatedBy { get; set; }
        public DateTime UpdateDate { get; set; }
    }
}
