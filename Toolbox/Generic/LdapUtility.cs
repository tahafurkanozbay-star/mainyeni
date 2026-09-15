using Microsoft.AspNetCore.Authentication;
using Novell.Directory.Ldap;
using System;
using System.Collections.Generic;
using System.Text;

namespace Toolbox.Generic
{
    public class LdapConfig
    {
        public string Path { get; set; }
        public string UserDomainName { get; set; }
    }

    public class LdapUser
    {
        public string UserName { get; set; }
        public string DisplayName { get; set; }
        // other properties
    }

    public class LdapUtility
    {
        private const string DisplayNameAttribute = "DisplayName";
        private const string SAMAccountNameAttribute = "SAMAccountName";

        private readonly LdapConfig config;

        public LdapUtility(LdapConfig config)
        {
            this.config = config;
        }


        public bool Login(string userName, string password)
        {

            var server = "10.0.1.11";

            //string userDn = $"{userName}@{domainName}";
            string userDn = $"abb\\{userName}";
            try
            {
                using (var connection = new LdapConnection { SecureSocketLayer = false })
                {
                    connection.Connect(server, LdapConnection.DefaultPort);
                    connection.Bind(userDn, password);

                    if (connection.Bound)
                        return true;
                }
            }
            catch (LdapException ex)
            {
                // Log exception
                throw ex;
            }
            return false;
        }

        /*
        public LdapUser Login(string userName, string password)
        {
            try
            {
                using (DirectoryEntry entry = new DirectoryEntry(config.Path, config.UserDomainName + "\\" + userName, password))
                {
                    using (DirectorySearcher searcher = new DirectorySearcher(entry))
                    {
                        searcher.Filter = String.Format("({0}={1})", SAMAccountNameAttribute, userName);
                        searcher.PropertiesToLoad.Add(DisplayNameAttribute);
                        searcher.PropertiesToLoad.Add(SAMAccountNameAttribute);
                        var result = searcher.FindOne();
                        if (result != null)
                        {
                            var displayName = result.Properties[DisplayNameAttribute];
                            var samAccountName = result.Properties[SAMAccountNameAttribute];

                            return new LdapUser
                            {
                                DisplayName = displayName == null || displayName.Count <= 0 ? null : displayName[0].ToString(),
                                UserName = samAccountName == null || samAccountName.Count <= 0 ? null : samAccountName[0].ToString()
                            };
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                throw ex;
            }
            return null;
        
        */
    }
}
