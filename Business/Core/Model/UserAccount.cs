using System.Collections.Generic;
using Business._Base;

namespace Business.Core.Model
{
    public partial class UserAccount : _BaseModel
    {
        public string UserName { get; set; }             //Email ya da LDAP kullanıcı adı
        
        public string FirstName { get; set; }            //Kullanıcı gerçek adı
        
        public string LastName { get; set; }             //Kullanıcı gerçek soyadı
        
        public string Password { get; set; }             //Kullanıcı şifresi
        
        public string Salt { get; set; }                 //Password Salt
        
        public bool IsActive { get; set; }             //Kullanıcı hesabının onaylanıp onaylanmadığı
        
        public bool IsReadOnly { get; set; }            //salt okunur hesap
        
        public UserAccountType AccountType { get; set; } //Kullanıcı hesabı tipi //Kurum kullanıcısı olup olmadığı
        
        public bool IsSuperUser { get; set; }            //Super user hesabı listelerde görünmez

        public string Roles { get; set; }
        public virtual ICollection<UserRoleRegistration> RoleRegistrations { get; set; }

    }


    public enum UserAccountType //Kullanıcı türü
    {
        LDAP=1,     //Kurum kullanıcısı
        EXTERNAL= 2 //Diğer kullanıcı
    }
}