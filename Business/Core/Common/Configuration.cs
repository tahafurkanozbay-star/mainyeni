using System;
using System.Security.Cryptography;

namespace Business.Core.Common
{
    public partial class Configuration
    {
        public static bool DEBUG_MODE = false;
        public static string SCHEMA_NAME = Environment.GetEnvironmentVariable("KENT_REHBERI_DB_SCHEMA") ?? "public";

        public static string LDAP_DOMAIN = Environment.GetEnvironmentVariable("KENT_REHBERI_LDAP_DOMAIN") ?? string.Empty;
        public static string LDAP_SERVER = Environment.GetEnvironmentVariable("KENT_REHBERI_LDAP_SERVER") ?? string.Empty;
        public static int LDAP_PORT = ParseIntEnvironment("KENT_REHBERI_LDAP_PORT", 636, 1, 65535);
        public static bool LDAP_USE_SSL = ParseBoolEnvironment("KENT_REHBERI_LDAP_USE_SSL", true);
        public static string LDAP_BIND_DOMAIN = Environment.GetEnvironmentVariable("KENT_REHBERI_LDAP_BIND_DOMAIN") ?? string.Empty;

        // ParameterEncryptionUtils currently uses Base64 encoding; this legacy value is not a
        // cryptographic secret. Do not use it as proof of authorization.
        public static string GENERIC_SALT = "legacy-base64-compat";

        public static string EMAIL_USER = Environment.GetEnvironmentVariable("KENT_REHBERI_EMAIL_USER") ?? string.Empty;
        public static string EMAIL_PASSWORD = Environment.GetEnvironmentVariable("KENT_REHBERI_EMAIL_PASSWORD") ?? string.Empty;
        public static string EMAIL_SERVER = Environment.GetEnvironmentVariable("KENT_REHBERI_EMAIL_SERVER") ?? string.Empty;
        public static int EMAIL_PORT = ParseIntEnvironment("KENT_REHBERI_EMAIL_PORT", 587, 1, 65535);

        public static int RESET_PASSWORD_VALID_MINUTES = 30;
        public static int MIN_PASSWORD_LENGTH = 12;
        public static int MAX_PASSWORD_LENGTH = 128;

        public static string FILE_EXCEPTION_LOG_PATH = "logs";
        public static string ConfigKey_ClientAppConfig = "ClientAppConfig";
        public static string ConfigKey_GisMapConfig = "GisMapConfig";

        // Existing account-creation code expects a value. A process-local random fallback prevents
        // predictable default credentials; inactive external accounts must be explicitly reset.
        public static string UserSettings_DefaultPassword =
            Environment.GetEnvironmentVariable("KENT_REHBERI_DEFAULT_USER_PASSWORD") ??
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

        private static int ParseIntEnvironment(string name, int fallback, int min, int max)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (!int.TryParse(value, out var parsed)) return fallback;
            return Math.Min(Math.Max(parsed, min), max);
        }

        private static bool ParseBoolEnvironment(string name, bool fallback)
        {
            var value = Environment.GetEnvironmentVariable(name);
            return bool.TryParse(value, out var parsed) ? parsed : fallback;
        }
    }
}
