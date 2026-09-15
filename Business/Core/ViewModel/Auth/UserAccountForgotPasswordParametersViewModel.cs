using System;
using System.Collections.Generic;
using System.Text;

namespace Business.Core.ViewModel
{
    public class UserAccountForgotPasswordParametersViewModel
    {
        public string t { get; set; }  //Random string
        public string pa { get; set; } //KeyA
        public string kb { get; set; } //Key B
        public string i { get; set; }  //Declined
    }
}
