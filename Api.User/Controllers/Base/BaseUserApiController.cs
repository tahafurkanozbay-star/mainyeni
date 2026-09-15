using System;
using System.Security.Cryptography;
using System.Text;
using Api.Core.Base;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;

public class _BaseUserApiController : _BaseController
{
    protected bool ValidateAuthToken()
    {
        var token = HttpContext.Request.Headers["Authorization"].ToString();
        var tokenParts = token.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokenParts.Length != 2 || !string.Equals(tokenParts[0], "Bearer", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var secret = HttpContext.RequestServices
            .GetService(typeof(IConfiguration)) as IConfiguration;
        var secretValue = secret?[ApiConfiguration.ApiRequestSecretConfigKey];

        // A missing server secret must fail closed. No fallback secret is kept in
        // source code, configuration defaults or the browser bundle.
        if (string.IsNullOrWhiteSpace(secretValue))
        {
            return false;
        }

        try
        {
            var tokenValue = tokenParts[1];
            var cipherBytes = Convert.FromBase64String(tokenValue);

            using (var aes = Aes.Create())
            {
                aes.Key = Encoding.UTF8.GetBytes(secretValue);
                aes.Mode = CipherMode.ECB;
                aes.Padding = PaddingMode.PKCS7;

                using (ICryptoTransform decryptor = aes.CreateDecryptor())
                {
                    var decryptedBytes = decryptor.TransformFinalBlock(cipherBytes, 0, cipherBytes.Length);
                    var decryptedText = Encoding.UTF8.GetString(decryptedBytes);
                    var chunks = decryptedText.Split('|');
                    if (chunks.Length != 3 || !double.TryParse(chunks[1], out var timestamp))
                    {
                        return false;
                    }

                    var issuedUtc = DateTime.UnixEpoch.AddMilliseconds(timestamp);
                    var age = DateTime.UtcNow - issuedUtc;
                    return age.TotalSeconds >= -5 && age.TotalSeconds <= 10;
                }
            }
        }
        catch (FormatException)
        {
            return false;
        }
        catch (CryptographicException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    protected IActionResult UnAuthorizedResult()
    {
        HttpContext.Response.StatusCode = 401;
        return new JsonResult("Unauthorized");
    }
}
