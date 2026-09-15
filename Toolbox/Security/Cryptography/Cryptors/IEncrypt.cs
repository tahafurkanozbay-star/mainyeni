namespace Toolbox.Security
{
    public interface IEncryptDecrypt
    {
        string Encrypt(string PlainText, string key);

        string Decrypt(string EncryptedText, string key);
    }
}