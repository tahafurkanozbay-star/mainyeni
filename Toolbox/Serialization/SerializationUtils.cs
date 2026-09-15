using Newtonsoft.Json;
using System;
using System.IO;
using System.Text;
using System.Xml;
using System.Xml.Serialization;

namespace Toolbox.Serialization
{
    public static class SerializationUtils
    {
        public static string SerializeToXml<T>(T @object)
        {
            if (@object == null)
            {
                return null;
            }

            try
            {
                XmlSerializer serializer = new XmlSerializer(typeof(T));

                XmlWriterSettings settings = new XmlWriterSettings();
                settings.Encoding = new UnicodeEncoding(false, false); // no BOM in a .NET string
                settings.Indent = false;
                settings.OmitXmlDeclaration = false;

                using (StringWriter textWriter = new StringWriter())
                {
                    using (XmlWriter xmlWriter = XmlWriter.Create(textWriter, settings))
                    {
                        serializer.Serialize(xmlWriter, @object);
                    }
                    return textWriter.ToString();
                }
            }
            catch (Exception ex)
            {
                throw ex;
            }
        }

        public static T DeserializeFromXml<T>(string Xml)
        {
            if (string.IsNullOrEmpty(Xml))
            {
                return default(T);
            }

            try
            {
                XmlSerializer serializer = new XmlSerializer(typeof(T));

                XmlReaderSettings settings = new XmlReaderSettings();
                // No settings need modifying here

                using (StringReader textReader = new StringReader(Xml))
                {
                    using (XmlReader xmlReader = XmlReader.Create(textReader, settings))
                    {
                        return (T)serializer.Deserialize(xmlReader);
                    }
                }
            }
            catch (Exception ex)
            {
                throw ex;
            }
        }

        public static string ObjectToJson<T>(T model)
        {
            var list = JsonConvert.SerializeObject(model, Newtonsoft.Json.Formatting.Indented, new JsonSerializerSettings()
            {
                ReferenceLoopHandling = Newtonsoft.Json.ReferenceLoopHandling.Ignore
            });

            return list;
        }

        public static T JsonToObject<T>(string Json)
        {
            try
            {
                T obj= JsonConvert.DeserializeObject<T>(Json);
                return obj;
            }
            catch (Exception ex)
            {
                throw ex;
            }
        }
    }
}