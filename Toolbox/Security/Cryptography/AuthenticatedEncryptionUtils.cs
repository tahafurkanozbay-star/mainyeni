using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Toolbox.Security.Cryptography
{
    /// <summary>
    /// Versioned authenticated encryption for new protected application values.
    /// The envelope binds ciphertext to a caller-supplied purpose so values cannot be replayed
    /// across unrelated security contexts without authentication failure.
    /// </summary>
    public static class AuthenticatedEncryptionUtils
    {
        public const string EnvelopePrefix = "aes-gcm-v1";
        public const int CurrentIterations = 600_000;

        private const int MinimumAcceptedIterations = 100_000;
        private const int MaximumAcceptedIterations = 2_000_000;
        private const int SaltSizeBytes = 16;
        private const int NonceSizeBytes = 12;
        private const int TagSizeBytes = 16;
        private const int KeySizeBytes = 32;
        private const int MaxPlaintextBytes = 1024 * 1024;
        private const int MaxPurposeBytes = 512;
        // Invalid Unicode must never be silently replaced in authenticated values.
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        // Bound untrusted input before split or Base64 allocations.
        private static readonly int MaxEnvelopeCharacters =
            EnvelopePrefix.Length + 5 + 7 + 24 + 16 + 24 + ((MaxPlaintextBytes + 2) / 3 * 4);

        public static string Encrypt(string plaintext, string secret, string purpose)
        {
            if (plaintext == null)
            {
                throw new ArgumentNullException(nameof(plaintext));
            }

            ValidateSecret(secret);
            var associatedData = GetPurposeBytes(purpose);
            byte[] plaintextBytes = null;
            byte[] key = null;

            try
            {
                var plaintextByteCount = StrictUtf8.GetByteCount(plaintext);
                if (plaintextByteCount > MaxPlaintextBytes)
                {
                    throw new ArgumentOutOfRangeException(
                        nameof(plaintext),
                        $"Plaintext exceeds the {MaxPlaintextBytes}-byte encryption budget.");
                }

                plaintextBytes = StrictUtf8.GetBytes(plaintext);
                var salt = RandomNumberGenerator.GetBytes(SaltSizeBytes);
                var nonce = RandomNumberGenerator.GetBytes(NonceSizeBytes);
                var ciphertext = new byte[plaintextBytes.Length];
                var tag = new byte[TagSizeBytes];
                key = DeriveKey(secret, salt, CurrentIterations);
                using var aes = new AesGcm(key, TagSizeBytes);
                aes.Encrypt(nonce, plaintextBytes, ciphertext, tag, associatedData);

                return string.Join(
                    "$",
                    EnvelopePrefix,
                    CurrentIterations.ToString(CultureInfo.InvariantCulture),
                    Convert.ToBase64String(salt),
                    Convert.ToBase64String(nonce),
                    Convert.ToBase64String(tag),
                    Convert.ToBase64String(ciphertext));
            }
            finally
            {
                if (key != null) CryptographicOperations.ZeroMemory(key);
                if (plaintextBytes != null) CryptographicOperations.ZeroMemory(plaintextBytes);
                CryptographicOperations.ZeroMemory(associatedData);
            }
        }

        public static string Decrypt(string envelope, string secret, string purpose)
        {
            ValidateSecret(secret);
            var associatedData = GetPurposeBytes(purpose);
            ParsedEnvelope parsed = null;
            byte[] key = null;
            byte[] plaintext = null;

            try
            {
                parsed = ParseEnvelope(envelope);
                key = DeriveKey(secret, parsed.Salt, parsed.Iterations);
                plaintext = new byte[parsed.Ciphertext.Length];
                using var aes = new AesGcm(key, TagSizeBytes);
                aes.Decrypt(
                    parsed.Nonce,
                    parsed.Ciphertext,
                    parsed.Tag,
                    plaintext,
                    associatedData);

                return StrictUtf8.GetString(plaintext);
            }
            finally
            {
                if (key != null) CryptographicOperations.ZeroMemory(key);
                if (plaintext != null) CryptographicOperations.ZeroMemory(plaintext);
                CryptographicOperations.ZeroMemory(associatedData);
                parsed?.Clear();
            }
        }

        public static bool TryDecrypt(
            string envelope,
            string secret,
            string purpose,
            out string plaintext)
        {
            plaintext = null;

            try
            {
                plaintext = Decrypt(envelope, secret, purpose);
                return true;
            }
            catch (Exception exception) when (
                exception is ArgumentException or
                FormatException or
                CryptographicException)
            {
                plaintext = null;
                return false;
            }
        }

        public static bool IsModernEnvelope(string envelope)
        {
            try
            {
                var parsed = ParseEnvelope(envelope);
                parsed.Clear();
                return true;
            }
            catch (Exception exception) when (
                exception is ArgumentException or
                FormatException)
            {
                return false;
            }
        }

        public static bool NeedsReencryption(string envelope)
        {
            try
            {
                var parsed = ParseEnvelope(envelope);
                var needsReencryption = parsed.Iterations != CurrentIterations;
                parsed.Clear();
                return needsReencryption;
            }
            catch (Exception exception) when (
                exception is ArgumentException or
                FormatException)
            {
                return true;
            }
        }

        private static ParsedEnvelope ParseEnvelope(string envelope)
        {
            if (string.IsNullOrWhiteSpace(envelope))
            {
                throw new ArgumentException(
                    "An authenticated encryption envelope is required.",
                    nameof(envelope));
            }

            if (envelope.Length > MaxEnvelopeCharacters)
            {
                throw new FormatException("Authenticated encryption envelope exceeds the input budget.");
            }

            var parts = envelope.Split(new[] { '$' }, 7, StringSplitOptions.None);
            if (parts.Length != 6 ||
                !string.Equals(parts[0], EnvelopePrefix, StringComparison.Ordinal))
            {
                throw new FormatException("Unsupported authenticated encryption envelope.");
            }

            if (!int.TryParse(
                    parts[1],
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var iterations) ||
                iterations < MinimumAcceptedIterations ||
                iterations > MaximumAcceptedIterations)
            {
                throw new FormatException("Authenticated encryption work factor is invalid.");
            }

            byte[] salt = null;
            byte[] nonce = null;
            byte[] tag = null;
            byte[] ciphertext = null;
            try
            {
                salt = DecodeBase64(parts[2], SaltSizeBytes, "salt");
                nonce = DecodeBase64(parts[3], NonceSizeBytes, "nonce");
                tag = DecodeBase64(parts[4], TagSizeBytes, "tag");
                ciphertext = DecodeCiphertext(parts[5]);
                return new ParsedEnvelope(iterations, salt, nonce, tag, ciphertext);
            }
            catch
            {
                // Malformed later fields must not retain earlier decoded buffers.
                if (salt != null) CryptographicOperations.ZeroMemory(salt);
                if (nonce != null) CryptographicOperations.ZeroMemory(nonce);
                if (tag != null) CryptographicOperations.ZeroMemory(tag);
                if (ciphertext != null) CryptographicOperations.ZeroMemory(ciphertext);
                throw;
            }
        }

        private static byte[] DecodeBase64(string value, int expectedLength, string fieldName)
        {
            if (value.Length != ((expectedLength + 2) / 3 * 4))
            {
                throw new FormatException($"Authenticated encryption {fieldName} has an invalid encoded length.");
            }

            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(value);
            }
            catch (FormatException exception)
            {
                throw new FormatException(
                    $"Authenticated encryption {fieldName} is not valid Base64.",
                    exception);
            }

            if (bytes.Length != expectedLength)
            {
                CryptographicOperations.ZeroMemory(bytes);
                throw new FormatException(
                    $"Authenticated encryption {fieldName} must be {expectedLength} bytes.");
            }

            return bytes;
        }

        private static byte[] DecodeCiphertext(string value)
        {
            if (value.Length > ((MaxPlaintextBytes + 2) / 3 * 4))
            {
                throw new FormatException("Authenticated encryption ciphertext exceeds the encoded input budget.");
            }

            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(value);
            }
            catch (FormatException exception)
            {
                throw new FormatException(
                    "Authenticated encryption ciphertext is not valid Base64.",
                    exception);
            }

            if (bytes.Length > MaxPlaintextBytes)
            {
                CryptographicOperations.ZeroMemory(bytes);
                throw new FormatException(
                    $"Authenticated encryption ciphertext exceeds {MaxPlaintextBytes} bytes.");
            }

            return bytes;
        }

        private static byte[] DeriveKey(string secret, byte[] salt, int iterations)
        {
            return Rfc2898DeriveBytes.Pbkdf2(
                secret,
                salt,
                iterations,
                HashAlgorithmName.SHA256,
                KeySizeBytes);
        }

        private static void ValidateSecret(string secret)
        {
            if (string.IsNullOrWhiteSpace(secret))
            {
                throw new ArgumentException(
                    "A non-empty encryption secret is required.",
                    nameof(secret));
            }
        }

        private static byte[] GetPurposeBytes(string purpose)
        {
            if (string.IsNullOrWhiteSpace(purpose))
            {
                throw new ArgumentException(
                    "A non-empty encryption purpose is required.",
                    nameof(purpose));
            }

            if (StrictUtf8.GetByteCount(purpose) > MaxPurposeBytes)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(purpose),
                    $"Encryption purpose exceeds {MaxPurposeBytes} bytes.");
            }

            return StrictUtf8.GetBytes(purpose);
        }

        private sealed class ParsedEnvelope
        {
            public ParsedEnvelope(
                int iterations,
                byte[] salt,
                byte[] nonce,
                byte[] tag,
                byte[] ciphertext)
            {
                Iterations = iterations;
                Salt = salt;
                Nonce = nonce;
                Tag = tag;
                Ciphertext = ciphertext;
            }

            public int Iterations { get; }

            public byte[] Salt { get; }

            public byte[] Nonce { get; }

            public byte[] Tag { get; }

            public byte[] Ciphertext { get; }

            public void Clear()
            {
                CryptographicOperations.ZeroMemory(Salt);
                CryptographicOperations.ZeroMemory(Nonce);
                CryptographicOperations.ZeroMemory(Tag);
                CryptographicOperations.ZeroMemory(Ciphertext);
            }
        }
    }
}
