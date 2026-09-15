using Novell.Directory.Ldap;
using System;

namespace Toolbox.Generic
{
    public class LdapConfig
    {
        public string Path { get; set; }
        public string UserDomainName { get; set; }
        public string Server { get; set; }
        public int Port { get; set; } = LdapConnection.DefaultPort;
        public bool SecureSocketLayer { get; set; }
        public string BindDomain { get; set; }
    }

    public class LdapUser
    {
        public string UserName { get; set; }
        public string DisplayName { get; set; }
    }

    public class LdapUtility
    {
        private readonly LdapConfig config;

        public LdapUtility(LdapConfig config)
        {
            this.config = config ?? throw new ArgumentNullException(nameof(config));
        }

        public bool Login(string userName, string password)
        {
            if (string.IsNullOrWhiteSpace(config.Server) ||
                string.IsNullOrWhiteSpace(userName) ||
                string.IsNullOrEmpty(password))
            {
                return false;
            }

            var port = config.Port > 0
                ? config.Port
                : config.SecureSocketLayer ? 636 : LdapConnection.DefaultPort;
            var bindDomain = string.IsNullOrWhiteSpace(config.BindDomain)
                ? config.UserDomainName
                : config.BindDomain;
            var userDn = string.IsNullOrWhiteSpace(bindDomain)
                ? userName
                : $"{bindDomain}\\{userName}";

            try
            {
                using var connection = new LdapConnection
                {
                    SecureSocketLayer = config.SecureSocketLayer
                };
                connection.Connect(config.Server.Trim(), port);
                connection.Bind(userDn, password);
                return connection.Bound;
            }
            catch (LdapException)
            {
                // Authentication/network failures are intentionally indistinguishable to callers.
                return false;
            }
        }
    }
}
