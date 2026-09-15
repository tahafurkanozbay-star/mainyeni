using System;
using System.Security.Cryptography;
using System.Text;

namespace Toolbox.Security
{
    /// <summary>
    /// Legacy SHA-1 password compatibility transform.
    /// Do not use for new password writes; PBKDF2 is the current password format.
    /// </summary>
    public sealed class SHA1Encryptor : IEncryptDecrypt
    {
        public string Decrypt(string encryptedText, string key)
        {
            throw new NotSupportedException("SHA-1 is a one-way hash and cannot be decrypted.");
        }

        public string Encrypt(string plainText, string key)
        {
            if (plainText == null) throw new ArgumentNullException(nameof(plainText));
            if (key == null) throw new ArgumentNullException(nameof(key));

            var plainBytes = Encoding.Unicode.GetBytes(plainText);
            var keyBytes = Encoding.Unicode.GetBytes(key);
            var input = new byte[keyBytes.Length + plainBytes.Length];
            Buffer.BlockCopy(keyBytes, 0, input, 0, keyBytes.Length);
            Buffer.BlockCopy(plainBytes, 0, input, keyBytes.Length, plainBytes.Length);

            // SHA1.HashData preserves the exact legacy digest semantics without the obsolete
            // name-based HashAlgorithm factory. This path exists only to verify historical hashes.
            return Convert.ToBase64String(SHA1.HashData(input));
        }
    }
}
