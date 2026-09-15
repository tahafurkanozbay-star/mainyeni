using Api.Core.Base;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

public class _BaseUserApiController : _BaseController
{
    /// <summary>
    /// Legacy compatibility path for any endpoint that still expects the historical short-lived
    /// encrypted request proof. The secret is server-owned and absent by default, so this fails
    /// closed. New anonymous bootstrap endpoints must use explicit data minimization instead.
    /// </summary>
    protected bool ValidateAuthToken()
    {
        var authorization = HttpContext.Request.Headers.Authorization.ToString();
        var tokenParts = authorization.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokenParts.Length != 2 ||
            !string.Equals(tokenParts[0], "Bearer", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var configuration = HttpContext.RequestServices.GetService<IConfiguration>();
        var secret = configuration?[ApiConfiguration.ApiRequestSecretConfigKey]?.Trim();
        if (string.IsNullOrWhiteSpace(secret))
        {
            return false;
        }

        try
        {
            var secretBytes = Encoding.UTF8.GetBytes(secret);
            if (secretBytes.Length is not (16 or 24 or 32))
            {
                return false;
            }

            var cipherBytes = Convert.FromBase64String(tokenParts[1]);
            using var aes = Aes.Create();
            aes.Key = secretBytes;
            aes.Mode = CipherMode.ECB;
            aes.Padding = PaddingMode.PKCS7;

            using var decryptor = aes.CreateDecryptor();
            var decryptedBytes = decryptor.TransformFinalBlock(cipherBytes, 0, cipherBytes.Length);
            var decryptedText = Encoding.UTF8.GetString(decryptedBytes);
            var chunks = decryptedText.Split('|');

            if (chunks.Length != 3 ||
                !double.TryParse(chunks[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var timestampMilliseconds))
            {
                return false;
            }

            var issuedUtc = DateTime.UnixEpoch.AddMilliseconds(timestampMilliseconds);
            var age = DateTime.UtcNow - issuedUtc;
            return age >= TimeSpan.FromSeconds(-5) && age <= TimeSpan.FromSeconds(10);
        }
        catch (Exception ex) when (
            ex is FormatException ||
            ex is CryptographicException ||
            ex is ArgumentException ||
            ex is OverflowException)
        {
            return false;
        }
    }

    protected IActionResult UnAuthorizedResult()
    {
        return Unauthorized(new { message = "Unauthorized" });
    }
}
