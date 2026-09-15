using Business._Base;
using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountForgotPasswordViewModel : _BaseViewModel
    {
        public string username { get; set; }
        public string locale { get; set; }
    }
}
