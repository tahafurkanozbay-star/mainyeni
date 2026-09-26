using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml;
using System.Xml.Serialization;

namespace Toolbox.Serialization
{
    public static class SerializationUtils
    {
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            WriteIndented = true,
            ReferenceHandler = ReferenceHandler.IgnoreCycles
        };

        public static string SerializeToXml<T>(T @object)
        {
            if (@object == null)
            {
                return null;
            }

            var serializer = new XmlSerializer(typeof(T));
            var settings = new XmlWriterSettings
            {
                Encoding = new UnicodeEncoding(bigEndian: false, byteOrderMark: false),
                Indent = false,
                OmitXmlDeclaration = false
            };

            using var textWriter = new StringWriter();
            using (var xmlWriter = XmlWriter.Create(textWriter, settings))
            {
                serializer.Serialize(xmlWriter, @object);
            }

            return textWriter.ToString();
        }

        public static T DeserializeFromXml<T>(string xml)
        {
            if (string.IsNullOrWhiteSpace(xml))
            {
                return default;
            }

            var serializer = new XmlSerializer(typeof(T));
            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
                MaxCharactersFromEntities = 0
            };

            using var textReader = new StringReader(xml);
            using var xmlReader = XmlReader.Create(textReader, settings);
            return (T)serializer.Deserialize(xmlReader);
        }

        public static string ObjectToJson<T>(T model)
        {
            return JsonSerializer.Serialize(model, JsonOptions);
        }

        public static T JsonToObject<T>(string json)
        {
            ArgumentNullException.ThrowIfNull(json);
            return JsonSerializer.Deserialize<T>(json, JsonOptions);
        }
    }
}
