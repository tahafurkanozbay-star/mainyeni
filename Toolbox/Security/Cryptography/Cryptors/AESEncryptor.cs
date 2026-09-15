using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Toolbox.Security
{
    /// <summary>
    /// Legacy deterministic AES compatibility implementation.
    /// Existing ciphertext remains readable; new security-sensitive features should use a modern
    /// authenticated encryption format with a random nonce instead of this compatibility class.
    /// </summary>
    public sealed class AESEncryptor : IEncryptDecrypt
    {
        private static readonly byte[] LegacySalt = { 1, 2, 3, 4, 5, 6, 7, 8 };
        private const int LegacyIterations = 1000;
        private const int KeyBytes = 32;
        private const int IvBytes = 16;

        public string Encrypt(string plainText, string key)
        {
            if (plainText == null) throw new ArgumentNullException(nameof(plainText));
            if (key == null) throw new ArgumentNullException(nameof(key));

            var plaintextBytes = Encoding.UTF8.GetBytes(plainText);
            var passwordBytes = SHA256.HashData(Encoding.UTF8.GetBytes(key));
            DeriveLegacyKeyMaterial(passwordBytes, out var encryptionKey, out var iv);

            using var aes = Aes.Create();
            aes.KeySize = 256;
            aes.BlockSize = 128;
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;
            aes.Key = encryptionKey;
            aes.IV = iv;

            using var output = new MemoryStream();
            using (var crypto = new CryptoStream(output, aes.CreateEncryptor(), CryptoStreamMode.Write))
            {
                crypto.Write(plaintextBytes, 0, plaintextBytes.Length);
                crypto.FlushFinalBlock();
            }

            return Convert.ToBase64String(output.ToArray());
        }

        public string Decrypt(string encryptedText, string key)
        {
            if (encryptedText == null) throw new ArgumentNullException(nameof(encryptedText));
            if (key == null) throw new ArgumentNullException(nameof(key));

            var ciphertextBytes = Convert.FromBase64String(encryptedText);
            var passwordBytes = SHA256.HashData(Encoding.UTF8.GetBytes(key));
            DeriveLegacyKeyMaterial(passwordBytes, out var encryptionKey, out var iv);

            using var aes = Aes.Create();
            aes.KeySize = 256;
            aes.BlockSize = 128;
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;
            aes.Key = encryptionKey;
            aes.IV = iv;

            using var output = new MemoryStream();
            using (var crypto = new CryptoStream(output, aes.CreateDecryptor(), CryptoStreamMode.Write))
            {
                crypto.Write(ciphertextBytes, 0, ciphertextBytes.Length);
                crypto.FlushFinalBlock();
            }

            return Encoding.UTF8.GetString(output.ToArray());
        }

        private static void DeriveLegacyKeyMaterial(byte[] passwordBytes, out byte[] key, out byte[] iv)
        {
            // Rfc2898DeriveBytes(byte[], byte[], int) used HMAC-SHA1. Deriving one contiguous block
            // and splitting it reproduces the historical sequential GetBytes(32), GetBytes(16) calls.
            var keyMaterial = Rfc2898DeriveBytes.Pbkdf2(
                passwordBytes,
                LegacySalt,
                LegacyIterations,
                HashAlgorithmName.SHA1,
                KeyBytes + IvBytes);

            key = keyMaterial.AsSpan(0, KeyBytes).ToArray();
            iv = keyMaterial.AsSpan(KeyBytes, IvBytes).ToArray();
            CryptographicOperations.ZeroMemory(keyMaterial);
        }
    }
}
