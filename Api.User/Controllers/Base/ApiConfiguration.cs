public static class ApiConfiguration
{
    // Legacy compatibility only. New public endpoints must not depend on browser-held shared secrets.
    public const string ApiRequestSecretConfigKey = "Security:ApiRequestSecret";
}
