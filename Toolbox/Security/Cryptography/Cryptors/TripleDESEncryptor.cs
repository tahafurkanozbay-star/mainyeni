using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Toolbox.Security
{
    /// <summary>
    /// Legacy TripleDES compatibility cryptor. Kept only for existing persisted values; new
    /// security-sensitive data should use authenticated encryption and a modern KDF.
    /// </summary>
    public class TripleDESEncryptor : IEncryptDecrypt
    {
        private const string LegacyPassword = "ABC";

        public string Encrypt(string plainText, string key)
        {
            if (plainText == null)
            {
                throw new ArgumentNullException(nameof(plainText));
            }
            if (key == null)
            {
                throw new ArgumentNullException(nameof(key));
            }

            var dataToEncrypt = Encoding.Unicode.GetBytes(plainText);
            using var password = new PasswordDeriveBytes(LegacyPassword, GetBytes(key));
            var encrypted = Transform(
                dataToEncrypt,
                password.GetBytes(16),
                password.GetBytes(8),
                encrypt: true);
            return Convert.ToBase64String(encrypted);
        }

        public string Decrypt(string encryptedText, string key)
        {
            if (encryptedText == null)
            {
                throw new ArgumentNullException(nameof(encryptedText));
            }
            if (key == null)
            {
                throw new ArgumentNullException(nameof(key));
            }

            var cipherBytes = Convert.FromBase64String(encryptedText);
            using var password = new PasswordDeriveBytes(LegacyPassword, GetBytes(key));
            var decrypted = Transform(
                cipherBytes,
                password.GetBytes(16),
                password.GetBytes(8),
                encrypt: false);
            return Encoding.Unicode.GetString(decrypted);
        }

        private static byte[] Transform(byte[] data, byte[] key, byte[] iv, bool encrypt)
        {
            using var output = new MemoryStream();
            using var algorithm = TripleDES.Create();
            algorithm.Key = key;
            algorithm.IV = iv;
            algorithm.Mode = CipherMode.CBC;
            algorithm.Padding = PaddingMode.PKCS7;

            using var transform = encrypt
                ? algorithm.CreateEncryptor()
                : algorithm.CreateDecryptor();
            using (var cryptoStream = new CryptoStream(output, transform, CryptoStreamMode.Write))
            {
                cryptoStream.Write(data, 0, data.Length);
                cryptoStream.FlushFinalBlock();
            }

            return output.ToArray();
        }

        private static byte[] GetBytes(string value)
        {
            var bytes = new byte[value.Length * sizeof(char)];
            Buffer.BlockCopy(value.ToCharArray(), 0, bytes, 0, bytes.Length);
            return bytes;
        }
    }
}
