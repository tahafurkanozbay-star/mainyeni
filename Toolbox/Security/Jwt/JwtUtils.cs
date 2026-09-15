using Microsoft.IdentityModel.Tokens;
using System;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Claims;

namespace Toolbox.Security.Jwt
{
    public static class JwtUtils
    {
        private const string SigningKeyEnvironmentVariable = "KENT_REHBERI_JWT_SIGNING_KEY";
        private const string IssuerEnvironmentVariable = "KENT_REHBERI_JWT_ISSUER";
        private const string AudienceEnvironmentVariable = "KENT_REHBERI_JWT_AUDIENCE";
        private const string DefaultIssuer = "kent-rehberi-api";
        private const string DefaultAudience = "kent-rehberi-admin";
        private static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromMinutes(30);
        private static readonly TimeSpan AllowedClockSkew = TimeSpan.FromSeconds(30);

        public static string GenerateToken(string encryptedUserGuid)
        {
            if (string.IsNullOrWhiteSpace(encryptedUserGuid))
            {
                throw new ArgumentException("Token subject cannot be empty.", nameof(encryptedUserGuid));
            }

            var now = DateTime.UtcNow;
            var descriptor = new SecurityTokenDescriptor
            {
                Subject = new ClaimsIdentity(new[]
                {
                    new Claim(ClaimTypes.Name, encryptedUserGuid),
                    new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N"))
                }),
                Issuer = GetIssuer(),
                Audience = GetAudience(),
                NotBefore = now,
                IssuedAt = now,
                Expires = now.Add(AccessTokenLifetime),
                SigningCredentials = new SigningCredentials(GetSigningKey(), SecurityAlgorithms.HmacSha256)
            };

            var handler = new JwtSecurityTokenHandler();
            return handler.WriteToken(handler.CreateJwtSecurityToken(descriptor));
        }

        public static ClaimsPrincipal GetPrincipal(string token)
        {
            if (string.IsNullOrWhiteSpace(token))
            {
                return null;
            }

            try
            {
                var handler = new JwtSecurityTokenHandler
                {
                    MapInboundClaims = true
                };

                var principal = handler.ValidateToken(token, CreateValidationParameters(), out var validatedToken);
                if (validatedToken is not JwtSecurityToken jwt ||
                    !string.Equals(jwt.Header.Alg, SecurityAlgorithms.HmacSha256, StringComparison.Ordinal))
                {
                    return null;
                }

                return principal;
            }
            catch (Exception ex) when (
                ex is SecurityTokenException ||
                ex is ArgumentException ||
                ex is FormatException ||
                ex is InvalidOperationException)
            {
                return null;
            }
        }

        public static bool ValidateToken(string token)
        {
            return GetPrincipal(token) != null;
        }

        public static bool TryGetBearerToken(string authorizationHeader, out string token)
        {
            token = null;
            if (string.IsNullOrWhiteSpace(authorizationHeader))
            {
                return false;
            }

            const string prefix = "Bearer ";
            if (!authorizationHeader.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var candidate = authorizationHeader.Substring(prefix.Length).Trim();
            if (candidate.Length == 0 || candidate.Any(char.IsWhiteSpace))
            {
                return false;
            }

            token = candidate;
            return true;
        }

        public static JwtSecurityToken ReadToken(string token)
        {
            if (string.IsNullOrWhiteSpace(token))
            {
                return null;
            }

            try
            {
                return new JwtSecurityTokenHandler().ReadJwtToken(token);
            }
            catch (Exception ex) when (
                ex is ArgumentException ||
                ex is SecurityTokenException ||
                ex is FormatException)
            {
                return null;
            }
        }

        private static TokenValidationParameters CreateValidationParameters()
        {
            return new TokenValidationParameters
            {
                RequireSignedTokens = true,
                RequireExpirationTime = true,
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = GetSigningKey(),
                ValidateIssuer = true,
                ValidIssuer = GetIssuer(),
                ValidateAudience = true,
                ValidAudience = GetAudience(),
                ValidateLifetime = true,
                ClockSkew = AllowedClockSkew,
                ValidAlgorithms = new[] { SecurityAlgorithms.HmacSha256 }
            };
        }

        private static SymmetricSecurityKey GetSigningKey()
        {
            var configured = Environment.GetEnvironmentVariable(SigningKeyEnvironmentVariable)?.Trim();
            if (string.IsNullOrWhiteSpace(configured))
            {
                throw new InvalidOperationException(
                    $"JWT signing key is not configured. Set {SigningKeyEnvironmentVariable} in the server secret store/environment.");
            }

            byte[] keyBytes;
            try
            {
                keyBytes = Convert.FromBase64String(configured);
            }
            catch (FormatException ex)
            {
                throw new InvalidOperationException(
                    $"{SigningKeyEnvironmentVariable} must be a base64-encoded random key.", ex);
            }

            if (keyBytes.Length < 32)
            {
                throw new InvalidOperationException(
                    $"{SigningKeyEnvironmentVariable} must decode to at least 32 random bytes.");
            }

            return new SymmetricSecurityKey(keyBytes);
        }

        private static string GetIssuer()
        {
            return GetOptionalEnvironmentValue(IssuerEnvironmentVariable) ?? DefaultIssuer;
        }

        private static string GetAudience()
        {
            return GetOptionalEnvironmentValue(AudienceEnvironmentVariable) ?? DefaultAudience;
        }

        private static string GetOptionalEnvironmentValue(string variableName)
        {
            var value = Environment.GetEnvironmentVariable(variableName)?.Trim();
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }
    }
}
