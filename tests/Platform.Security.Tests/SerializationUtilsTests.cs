using System;
using System.Text.Json;
using System.Xml;
using Toolbox.Serialization;
using Xunit;

namespace Platform.Security.Tests;

public sealed class SerializationUtilsTests
{
    [Fact]
    public void ObjectToJson_UsesIndentedStablePropertyNames()
    {
        var json = SerializationUtils.ObjectToJson(new SampleModel
        {
            Name = "Ankara",
            Count = 25
        });

        Assert.Contains(Environment.NewLine, json, StringComparison.Ordinal);
        Assert.Contains("\"Name\": \"Ankara\"", json, StringComparison.Ordinal);
        Assert.Contains("\"Count\": 25", json, StringComparison.Ordinal);
    }

    [Fact]
    public void ObjectToJson_SerializesNullAsJsonNull()
    {
        Assert.Equal("null", SerializationUtils.ObjectToJson<SampleModel>(null));
    }

    [Fact]
    public void ObjectToJson_IgnoresReferenceCyclesWithoutThrowing()
    {
        var root = new CyclicNode { Name = "root" };
        var child = new CyclicNode { Name = "child", Parent = root };
        root.Child = child;

        var json = SerializationUtils.ObjectToJson(root);

        Assert.Contains("\"Name\": \"root\"", json, StringComparison.Ordinal);
        Assert.Contains("\"Name\": \"child\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Parent\": {", json, StringComparison.Ordinal);
    }

    [Fact]
    public void JsonToObject_DeserializesCaseInsensitivePropertyNames()
    {
        var model = SerializationUtils.JsonToObject<SampleModel>(
            """
            {
              "name": "Çankaya",
              "COUNT": 7
            }
            """);

        Assert.NotNull(model);
        Assert.Equal("Çankaya", model.Name);
        Assert.Equal(7, model.Count);
    }

    [Fact]
    public void JsonToObject_RejectsNullInput()
    {
        Assert.Throws<ArgumentNullException>(
            () => SerializationUtils.JsonToObject<SampleModel>(null));
    }

    [Theory]
    [InlineData("{")]
    [InlineData("{\"Name\":}")]
    [InlineData("[1,2,")]
    public void JsonToObject_RejectsMalformedJson(string json)
    {
        Assert.Throws<JsonException>(
            () => SerializationUtils.JsonToObject<SampleModel>(json));
    }

    [Fact]
    public void JsonToObject_RejectsPayloadBeyondConfiguredDepth()
    {
        var json = new string('[', 70) + "0" + new string(']', 70);

        Assert.Throws<JsonException>(
            () => SerializationUtils.JsonToObject<object>(json));
    }

    [Fact]
    public void JsonRoundTrip_PreservesUnicodeAndScalarValues()
    {
        var original = new SampleModel
        {
            Name = "Şereflikoçhisar / ğüşiöç",
            Count = 123456
        };

        var json = SerializationUtils.ObjectToJson(original);
        var roundTrip = SerializationUtils.JsonToObject<SampleModel>(json);

        Assert.NotNull(roundTrip);
        Assert.Equal(original.Name, roundTrip.Name);
        Assert.Equal(original.Count, roundTrip.Count);
    }

    [Fact]
    public void JsonRoundTrip_PreservesNestedCollections()
    {
        var original = new CollectionModel
        {
            Items =
            [
                new SampleModel { Name = "A", Count = 1 },
                new SampleModel { Name = "B", Count = 2 }
            ]
        };

        var json = SerializationUtils.ObjectToJson(original);
        var roundTrip = SerializationUtils.JsonToObject<CollectionModel>(json);

        Assert.NotNull(roundTrip);
        Assert.Equal(2, roundTrip.Items.Length);
        Assert.Equal("A", roundTrip.Items[0].Name);
        Assert.Equal(2, roundTrip.Items[1].Count);
    }

    [Fact]
    public void SerializeToXml_ReturnsNullForNullInput()
    {
        Assert.Null(SerializationUtils.SerializeToXml<SampleModel>(null));
    }

    [Fact]
    public void DeserializeFromXml_ReturnsDefaultForBlankInput()
    {
        Assert.Null(SerializationUtils.DeserializeFromXml<SampleModel>("   "));
    }

    [Fact]
    public void XmlRoundTrip_PreservesPublicProperties()
    {
        var original = new SampleModel
        {
            Name = "Keçiören",
            Count = 42
        };

        var xml = SerializationUtils.SerializeToXml(original);
        var roundTrip = SerializationUtils.DeserializeFromXml<SampleModel>(xml);

        Assert.NotNull(roundTrip);
        Assert.Equal(original.Name, roundTrip.Name);
        Assert.Equal(original.Count, roundTrip.Count);
    }

    [Fact]
    public void DeserializeFromXml_RejectsDocumentTypeDeclarations()
    {
        const string xml =
            """
            <!DOCTYPE SampleModel [
              <!ELEMENT SampleModel ANY >
            ]>
            <SampleModel>
              <Name>Ankara</Name>
              <Count>1</Count>
            </SampleModel>
            """;

        Assert.Throws<InvalidOperationException>(
            () => SerializationUtils.DeserializeFromXml<SampleModel>(xml));
    }

    [Fact]
    public void DeserializeFromXml_RejectsExternalEntityPayloads()
    {
        const string xml =
            """
            <!DOCTYPE SampleModel [
              <!ENTITY xxe SYSTEM "file:///etc/passwd">
            ]>
            <SampleModel>
              <Name>&xxe;</Name>
              <Count>1</Count>
            </SampleModel>
            """;

        Assert.Throws<InvalidOperationException>(
            () => SerializationUtils.DeserializeFromXml<SampleModel>(xml));
    }

    [Fact]
    public void DeserializeFromXml_RejectsMalformedXml()
    {
        Assert.Throws<InvalidOperationException>(
            () => SerializationUtils.DeserializeFromXml<SampleModel>(
                "<SampleModel><Name>broken</SampleModel>"));
    }

    [Fact]
    public void SerializeToXml_DoesNotOmitXmlDeclaration()
    {
        var xml = SerializationUtils.SerializeToXml(new SampleModel
        {
            Name = "Altındağ",
            Count = 3
        });

        Assert.StartsWith("<?xml", xml, StringComparison.Ordinal);
    }

    public sealed class SampleModel
    {
        public string Name { get; set; }

        public int Count { get; set; }
    }

    public sealed class CollectionModel
    {
        public SampleModel[] Items { get; set; } = Array.Empty<SampleModel>();
    }

    public sealed class CyclicNode
    {
        public string Name { get; set; }

        public CyclicNode Parent { get; set; }

        public CyclicNode Child { get; set; }
    }
}
