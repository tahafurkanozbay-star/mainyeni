using Business._Base;
using Business.Core.Model;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserSessionViewModel : _BaseViewModel
    {
        public int UserId { get; set; }
        public string UserName { get; set; }
        public string FirstName { get; set; }
        public string LastName { get; set; }
        public string SessionStart { get; set; }
        public string Roles { get; set; }
    }
}
