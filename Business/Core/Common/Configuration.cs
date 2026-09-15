namespace Business.Core.Common
{
    public partial class Configuration{

        public static bool DEBUG_MODE=true;
        public static string SCHEMA_NAME="public";
        public static string LDAP_DOMAIN="manisa.bel.tr";
        public static string GENERIC_SALT="1234";
        
        public static string EMAIL_USER="testuser@testdomain.com";
        public static string EMAIL_PASSWORD="1234";
        public static string EMAIL_SERVER="smtp.domain.com";
        public static int EMAIL_PORT=45;
        
        public static int RESET_PASSWORD_VALID_MINUTES=30;
        
        public static int MIN_PASSWORD_LENGTH=4;
        public static int MAX_PASSWORD_LENGTH=16;

        public static string FILE_EXCEPTION_LOG_PATH="logs";


        public static string ConfigKey_ClientAppConfig = "ClientAppConfig";
        public static string ConfigKey_GisMapConfig = "GisMapConfig";

        public static string UserSettings_DefaultPassword="1234";
        
    }
}