using Business._Base;
using Business.Core.Model;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class SessionInfo : _BaseViewModel
    {
        public string SessionId { get; set; }
        public string AccessToken { get; set; }
        public string RefreshToken { get; set; }
        public string FirstName { get; set; }
        public string LastName { get; set; }
        public string SessionStart { get; set; }
        public string UserName { get; set; }
        public UserAccountType AccountType { get; internal set; }
        public string Roles { get; internal set; }
    }
}
