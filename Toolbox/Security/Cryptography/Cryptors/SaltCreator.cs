using System;
using System.Security.Cryptography;

namespace Toolbox.Security
{
    public static class SaltCreator
    {
        /// <summary>
        /// Şifreleme için rastgele tuz oluşturur
        /// </summary>
        /// <returns>Tuz metni döndürür</returns>
        public static string CreateRandomSalt()
        {
            var rng = new RNGCryptoServiceProvider();
            var buff = new byte[32];
            rng.GetBytes(buff);

            return Convert.ToBase64String(buff);
        }
    }
}