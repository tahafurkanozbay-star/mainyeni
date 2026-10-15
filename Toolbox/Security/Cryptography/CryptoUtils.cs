using System;
using System.Security.Cryptography;
using Toolbox.Text;

namespace Toolbox.Security.Cryptography
{
    /// <summary>
    /// Compatibility helpers shared by legacy cryptors. New security-sensitive values should use
    /// <see cref="AuthenticatedEncryptionUtils"/> instead of reversible legacy transforms.
    /// </summary>
    public static class CryptoUtils
    {
        private const int MaxGeneratedTokenLength = 4096;
        private const string AlphaNumericCharacters =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

        public static string EncryptDecrypt(
            IEncryptDecrypt encryption,
            CryptoMethod method,
            string plainText,
            string salt = "")
        {
            if (encryption == null)
            {
                throw new ArgumentNullException(nameof(encryption));
            }

            if (plainText == null)
            {
                throw new ArgumentNullException(nameof(plainText));
            }

            switch (method)
            {
                case CryptoMethod.ENCRYPT:
                    if (TextUtils.IsNullOrEmpty(salt))
                    {
                        salt = SaltCreator.CreateRandomSalt();
                    }
                    return encryption.Encrypt(plainText, salt);
                case CryptoMethod.DECRYPT:
                    if (TextUtils.IsNullOrEmpty(salt))
                    {
                        throw new ArgumentException(
                            "A salt/key is required when decrypting a legacy payload.",
                            nameof(salt));
                    }
                    return encryption.Decrypt(plainText, salt);
                default:
                    throw new ArgumentOutOfRangeException(
                        nameof(method),
                        method,
                        "A supported encryption method is required.");
            }
        }

        public static string CreateRandomSalt(int digits = 3)
        {
            if (digits < 1)
            {
                digits = 1;
            }

            ValidateGeneratedLength(digits, nameof(digits));

            var characters = new char[digits];
            characters[0] = (char)('0' + RandomNumberGenerator.GetInt32(1, 10));
            for (var index = 1; index < characters.Length; index++)
            {
                characters[index] = (char)('0' + RandomNumberGenerator.GetInt32(0, 10));
            }

            return new string(characters);
        }

        public static string CreateRandomString(int length = 8)
        {
            if (length < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(length));
            }

            ValidateGeneratedLength(length, nameof(length));
            if (length == 0)
            {
                return string.Empty;
            }

            var characters = new char[length];
            for (var index = 0; index < characters.Length; index++)
            {
                characters[index] =
                    AlphaNumericCharacters[RandomNumberGenerator.GetInt32(AlphaNumericCharacters.Length)];
            }

            return new string(characters);
        }

        private static void ValidateGeneratedLength(int length, string parameterName)
        {
            if (length > MaxGeneratedTokenLength)
            {
                throw new ArgumentOutOfRangeException(
                    parameterName,
                    length,
                    $"Generated token length cannot exceed {MaxGeneratedTokenLength} characters.");
            }
        }
    }

    public enum CryptoMethod
    {
        ENCRYPT,
        DECRYPT
    }
}
