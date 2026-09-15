using System.Collections.Generic;
using Business._Base;

namespace Business.Core.Model
{
    public partial class UserRole : _BaseModel
    {
        public string Name { get; set; }

        public bool IsReadOnly { get; set; }
                
    }

}