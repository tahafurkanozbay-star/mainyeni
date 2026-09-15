using System;
using System.Collections.Generic;
using System.Net.Mail;
using System.Text;
using System.Text.RegularExpressions;

namespace Toolbox.Generic
{
    public class RelayMailUtility
    {
        private string smtpServer { get; }
        private string smtpUserName { get; }
        private string smtpUserPass { get; }
        private int smtpPort { get; }

        public RelayMailUtility(string smtpServer, string smtpUserName, string smtpUserPass, int smtpPort)
        {
            this.smtpServer = smtpServer;
            this.smtpUserName = smtpUserName;
            this.smtpUserPass = smtpUserPass;
            this.smtpPort = smtpPort;
        }


        public void SendMail(string _fromAdress, string _toAdress,
                                    string _subject, string _body)
        {
            try
            {
                MailMessage mail = new MailMessage();
                
                
                SmtpClient SmtpServer = new SmtpClient(this.smtpServer,this.smtpPort);
                
                SmtpServer.UseDefaultCredentials = false;

                mail.From = new MailAddress(_fromAdress);
                mail.To.Add(_toAdress);
                mail.Subject = _subject;
                mail.Body = _body;
                mail.BodyEncoding = Encoding.UTF8;
                mail.IsBodyHtml = true;

                
                mail.Priority = MailPriority.Normal;
                SmtpServer.DeliveryMethod = SmtpDeliveryMethod.Network;
                SmtpServer.Port = Convert.ToInt32(this.smtpPort);
                SmtpServer.Host = this.smtpServer;
                
                SmtpServer.Credentials = new System.Net.NetworkCredential(smtpUserName, smtpUserPass);
                SmtpServer.EnableSsl = true;
                SmtpServer.Send(mail);
            }
            catch (Exception ex)
            {
                throw ex;
            }
           

        }
    }
}
