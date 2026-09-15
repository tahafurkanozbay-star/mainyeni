using System;
using System.Security.Cryptography;
using System.Text;
using Api.Core.Base;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

public class _BaseUserApiController : _BaseController
{
    protected bool ValidateAuthToken()
    {
        var authorization = HttpContext.Request.Headers["Authorization"].ToString();
        var tokenParts = authorization.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokenParts.Length != 2 || !string.Equals(tokenParts[0], "Bearer", StringComparison.OrdinalIgnoreCase)) return false;

        var configuration = HttpContext.RequestServices.GetService<IConfiguration>();
        var secretValue = configuration?[ApiConfiguration.ApiRequestSecretConfigKey];
        if (string.IsNullOrWhiteSpace(secretValue)) return false;

        try
        {
            var cipherBytes = Convert.FromBase64String(tokenParts[1]);
            using (var aes = Aes.Create())
            {
                aes.Key = Encoding.UTF8.GetBytes(secretValue);
                aes.Mode = CipherMode.ECB;
                aes.Padding = PaddingMode.PKCS7;
                using (var decryptor = aes.CreateDecryptor())
                {
                    var decryptedText = Encoding.UTF8.GetString(
                        decryptor.TransformFinalBlock(cipherBytes, 0, cipherBytes.Length));
                    var chunks = decryptedText.Split('|');
                    if (chunks.Length != 3 || !double.TryParse(chunks[1], out var timestamp)) return false;

                    var issuedUtc = DateTime.UnixEpoch.AddMilliseconds(timestamp);
                    var age = DateTime.UtcNow - issuedUtc;
                    return age.TotalSeconds >= -5 && age.TotalSeconds <= 10;
                }
            }
        }
        catch (FormatException) { return false; }
        catch (CryptographicException) { return false; }
        catch (ArgumentException) { return false; }
    }

    protected IActionResult UnAuthorizedResult()
    {
        HttpContext.Response.StatusCode = 401;
        return new JsonResult("Unauthorized");
    }
}
