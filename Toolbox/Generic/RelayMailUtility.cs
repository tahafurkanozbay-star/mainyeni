using System;
using System.Net;
using System.Net.Mail;
using System.Text;

namespace Toolbox.Generic
{
    public sealed class RelayMailUtility
    {
        private readonly string _smtpServer;
        private readonly string _smtpUserName;
        private readonly string _smtpUserPass;
        private readonly int _smtpPort;

        public RelayMailUtility(string smtpServer, string smtpUserName, string smtpUserPass, int smtpPort)
        {
            if (string.IsNullOrWhiteSpace(smtpServer))
            {
                throw new ArgumentException("SMTP server is required.", nameof(smtpServer));
            }
            if (smtpPort < 1 || smtpPort > 65535)
            {
                throw new ArgumentOutOfRangeException(nameof(smtpPort));
            }

            _smtpServer = smtpServer.Trim();
            _smtpUserName = smtpUserName ?? string.Empty;
            _smtpUserPass = smtpUserPass ?? string.Empty;
            _smtpPort = smtpPort;
        }

        public void SendMail(string fromAddress, string toAddress, string subject, string body)
        {
            if (string.IsNullOrWhiteSpace(fromAddress))
            {
                throw new ArgumentException("Sender address is required.", nameof(fromAddress));
            }
            if (string.IsNullOrWhiteSpace(toAddress))
            {
                throw new ArgumentException("Recipient address is required.", nameof(toAddress));
            }

            using var mail = new MailMessage
            {
                From = new MailAddress(fromAddress),
                Subject = subject ?? string.Empty,
                Body = body ?? string.Empty,
                BodyEncoding = Encoding.UTF8,
                IsBodyHtml = true,
                Priority = MailPriority.Normal
            };
            mail.To.Add(toAddress);

            using var smtpClient = new SmtpClient(_smtpServer, _smtpPort)
            {
                UseDefaultCredentials = false,
                DeliveryMethod = SmtpDeliveryMethod.Network,
                Credentials = new NetworkCredential(_smtpUserName, _smtpUserPass),
                EnableSsl = true
            };

            smtpClient.Send(mail);
        }
    }
}
