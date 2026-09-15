using System.ComponentModel.DataAnnotations;
using Business._Base;

namespace Business.Core.Model
{
    public class UserRoleRegistration : _BaseModel
    {
        public int UserId { get; set; }
        public virtual UserAccount User { get; set; }

        public int RoleId { get; set; }

        public virtual UserRole Role { get; set; }
    }
}