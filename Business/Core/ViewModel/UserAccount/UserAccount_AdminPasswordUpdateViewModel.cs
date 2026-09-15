using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccount_AdminPasswordUpdateViewModel
    {
        public int Id { get; set; }
        public string password { get; set; }
        public string passwordRepeat { get; set; }
    }
}
