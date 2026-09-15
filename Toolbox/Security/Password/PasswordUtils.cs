using System;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Toolbox.Security.Cryptography;

namespace Toolbox.Security.Password
{
    public static class PasswordUtils
    {
        private const string Pbkdf2Prefix = "pbkdf2-sha256";
        private const int Pbkdf2Iterations = 600_000;
        private const int SaltSizeBytes = 16;
        private const int HashSizeBytes = 32;

        /// <summary>
        /// Legacy one-way transform retained only for compatibility with existing stored hashes.
        /// New password writes must use HashPassword.
        /// </summary>
        public static string Encrypt(string password, string salt, IEncryptDecrypt encryption)
        {
            return CryptoUtils.EncryptDecrypt(encryption, CryptoMethod.ENCRYPT, password, salt);
        }

        public static string Decrypt(string password, string salt, IEncryptDecrypt encryption)
        {
            return CryptoUtils.EncryptDecrypt(encryption, CryptoMethod.DECRYPT, password, salt);
        }

        public static string HashPassword(string password)
        {
            if (string.IsNullOrEmpty(password))
            {
                throw new ArgumentException("Password cannot be empty.", nameof(password));
            }

            var salt = RandomNumberGenerator.GetBytes(SaltSizeBytes);
            var hash = Rfc2898DeriveBytes.Pbkdf2(
                password,
                salt,
                Pbkdf2Iterations,
                HashAlgorithmName.SHA256,
                HashSizeBytes);

            return string.Join(
                "$",
                Pbkdf2Prefix,
                Pbkdf2Iterations.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Convert.ToBase64String(salt),
                Convert.ToBase64String(hash));
        }

        public static bool VerifyPassword(string password, string encodedHash)
        {
            if (string.IsNullOrEmpty(password) || string.IsNullOrWhiteSpace(encodedHash))
            {
                return false;
            }

            var parts = encodedHash.Split('$');
            if (parts.Length != 4 || !string.Equals(parts[0], Pbkdf2Prefix, StringComparison.Ordinal))
            {
                return false;
            }

            if (!int.TryParse(parts[1], out var iterations) || iterations < 100_000 || iterations > 2_000_000)
            {
                return false;
            }

            try
            {
                var salt = Convert.FromBase64String(parts[2]);
                var expected = Convert.FromBase64String(parts[3]);
                if (salt.Length < SaltSizeBytes || expected.Length < HashSizeBytes)
                {
                    return false;
                }

                var actual = Rfc2898DeriveBytes.Pbkdf2(
                    password,
                    salt,
                    iterations,
                    HashAlgorithmName.SHA256,
                    expected.Length);

                return CryptographicOperations.FixedTimeEquals(actual, expected);
            }
            catch (FormatException)
            {
                return false;
            }
        }

        public static bool IsModernHash(string encodedHash)
        {
            return !string.IsNullOrWhiteSpace(encodedHash) &&
                   encodedHash.StartsWith(Pbkdf2Prefix + "$", StringComparison.Ordinal);
        }

        public static bool NeedsRehash(string encodedHash)
        {
            if (!IsModernHash(encodedHash)) return true;
            var parts = encodedHash.Split('$');
            return parts.Length != 4 || !int.TryParse(parts[1], out var iterations) || iterations < Pbkdf2Iterations;
        }

        /// <summary>Returns a coarse UI-facing password strength score; not an authentication policy.</summary>
        public static PasswordScore EvaluatePasswordStrength(string password)
        {
            if (string.IsNullOrEmpty(password)) return PasswordScore.Blank;

            var score = 1;
            if (password.Length < 4) return PasswordScore.VeryWeak;
            if (password.Length >= 8) score++;
            if (password.Length >= 12) score++;
            if (Regex.IsMatch(password, @"\d")) score++;
            if (Regex.IsMatch(password, "[a-z]") && Regex.IsMatch(password, "[A-Z]")) score++;
            if (Regex.IsMatch(password, @"[^a-zA-Z0-9]")) score++;

            return (PasswordScore)Math.Min(score, (int)PasswordScore.VeryStrong);
        }

        public enum PasswordScore
        {
            Blank = 0,
            VeryWeak = 1,
            Weak = 2,
            Medium = 3,
            Strong = 4,
            VeryStrong = 5
        }
    }
}
