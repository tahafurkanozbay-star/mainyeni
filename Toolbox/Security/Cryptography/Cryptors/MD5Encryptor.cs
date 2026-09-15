using System;
using System.Security.Cryptography;
using System.Text;

namespace Toolbox.Security
{
    /// <summary>
    /// Legacy MD5 + TripleDES compatibility transform.
    /// Retained only for historical data compatibility; do not use for new security-sensitive data.
    /// </summary>
    internal sealed class MD5Encryptor : IEncryptDecrypt
    {
        private static string TransformEncrypt(string plainText, string key, bool useHashing)
        {
            if (plainText == null) throw new ArgumentNullException(nameof(plainText));
            if (key == null) throw new ArgumentNullException(nameof(key));

            var input = Encoding.UTF8.GetBytes(plainText);
            var keyBytes = BuildLegacyKey(key, useHashing);

            using var tripleDes = TripleDES.Create();
            tripleDes.Key = keyBytes;
            tripleDes.Mode = CipherMode.ECB;
            tripleDes.Padding = PaddingMode.PKCS7;

            using var transform = tripleDes.CreateEncryptor();
            var encrypted = transform.TransformFinalBlock(input, 0, input.Length);
            return Convert.ToBase64String(encrypted);
        }

        private static string TransformDecrypt(string encryptedText, string key, bool useHashing)
        {
            if (encryptedText == null) throw new ArgumentNullException(nameof(encryptedText));
            if (key == null) throw new ArgumentNullException(nameof(key));

            var input = Convert.FromBase64String(encryptedText);
            var keyBytes = BuildLegacyKey(key, useHashing);

            using var tripleDes = TripleDES.Create();
            tripleDes.Key = keyBytes;
            tripleDes.Mode = CipherMode.ECB;
            tripleDes.Padding = PaddingMode.PKCS7;

            using var transform = tripleDes.CreateDecryptor();
            var decrypted = transform.TransformFinalBlock(input, 0, input.Length);
            return Encoding.UTF8.GetString(decrypted);
        }

        private static byte[] BuildLegacyKey(string key, bool useHashing)
        {
            var bytes = Encoding.UTF8.GetBytes(key);
            return useHashing ? MD5.HashData(bytes) : bytes;
        }

        public string Encrypt(string plainText, string key)
        {
            return TransformEncrypt(plainText, key, useHashing: true);
        }

        public string Decrypt(string encryptedText, string key)
        {
            return TransformDecrypt(encryptedText, key, useHashing: true);
        }
    }
}
