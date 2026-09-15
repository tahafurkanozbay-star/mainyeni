using System;
using System.Security.Cryptography;

namespace Toolbox.Security
{
    public static class SaltCreator
    {
        /// <summary>
        /// Legacy callers receive a cryptographically random 32-byte salt encoded as Base64.
        /// </summary>
        public static string CreateRandomSalt()
        {
            return Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        }
    }
}
