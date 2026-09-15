using System;
using System.Security.Cryptography;
using System.Text;
using Api.Core.Base;
using Microsoft.AspNetCore.Mvc;
using Toolbox.Security;
using Toolbox.Security.Cryptography;

public class _BaseUserApiController : _BaseController
{

    protected bool ValidateAuthToken()
    {
        var token=HttpContext.Request.Headers["Authorization"].ToString();
        var tokenParts = token.Split(' ');
        if (tokenParts.Length != 2)
        {
            return false;
        }
        
        var tokenValue = tokenParts[1];
        var cipherBytes = Convert.FromBase64String(tokenValue);
          
        // Set up the encryption objects
        using (Aes aes = Aes.Create())
        {
            aes.Key = Encoding.UTF8.GetBytes(ApiConfiguration.SECRET);
            aes.Mode = CipherMode.ECB;
            aes.Padding = PaddingMode.PKCS7;

            // Decrypt the input ciphertext using the AES algorithm
            using (ICryptoTransform decryptor = aes.CreateDecryptor())
            {
                var decryptedBytes = decryptor.TransformFinalBlock(cipherBytes, 0, cipherBytes.Length);
                var decryptedText = Encoding.UTF8.GetString(decryptedBytes);

                var chunks = decryptedText.Split('|');
                if (chunks.Length != 3)
                {
                    return false;
                }

                var timestamp = chunks[1];
                DateTime dateTime = new DateTime(1970, 1, 1, 0, 0, 0, 0, DateTimeKind.Utc);
                dateTime = dateTime.AddSeconds( double.Parse(timestamp) / 1000 ).ToLocalTime();

                var now = DateTime.Now;
                var diff = now - dateTime;
                if (diff.TotalSeconds > 10)
                {
                    return false;
                }
                else{
                    return true;
                }

                System.Console.WriteLine(decryptedText);
            }
        }

        
        return true;
    }


    protected IActionResult UnAuthorizedResult()
    {
        HttpContext.Response.StatusCode = 401;
        return new JsonResult("Unauthorized");
    }
}