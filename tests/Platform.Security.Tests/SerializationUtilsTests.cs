using System.Text.Json;
using Toolbox.Serialization;
using Xunit;

namespace Platform.Security.Tests;

public sealed class SerializationUtilsTests
{
    [Fact]
    public void ObjectToJson_ProducesIndentedJson()
    {
        var json = SerializationUtils.ObjectToJson(new SampleDto { Name = "Kent", Count = 2 });

        Assert.Contains(Environment.NewLine, json, StringComparison.Ordinal);
        using var document = JsonDocument.Parse(json);
        Assert.Equal("Kent", document.RootElement.GetProperty("Name").GetString());
        Assert.Equal(2, document.RootElement.GetProperty("Count").GetInt32());
    }

    [Fact]
    public void ObjectToJson_IgnoresReferenceCycles()
    {
        var parent = new Node { Name = "parent" };
        var child = new Node { Name = "child", Parent = parent };
        parent.Child = child;

        var json = SerializationUtils.ObjectToJson(parent);

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        Assert.Equal("parent", root.GetProperty("Name").GetString());
        Assert.Equal("child", root.GetProperty("Child").GetProperty("Name").GetString());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("Child").GetProperty("Parent").ValueKind);
    }

    [Fact]
    public void JsonToObject_DeserializesPublicDtoProperties()
    {
        var result = SerializationUtils.JsonToObject<SampleDto>("{\"Name\":\"Ankara\",\"Count\":25}");

        Assert.NotNull(result);
        Assert.Equal("Ankara", result.Name);
        Assert.Equal(25, result.Count);
    }

    [Fact]
    public void JsonToObject_RejectsNullInput()
    {
        Assert.Throws<ArgumentNullException>(() => SerializationUtils.JsonToObject<SampleDto>(null!));
    }

    [Fact]
    public void JsonToObject_RejectsMalformedJson()
    {
        Assert.Throws<JsonException>(() => SerializationUtils.JsonToObject<SampleDto>("{not-json}"));
    }

    [Fact]
    public void JsonToObject_UsesCaseSensitivePropertyMatchingByDefault()
    {
        var result = SerializationUtils.JsonToObject<SampleDto>("{\"name\":\"lower\",\"count\":7}");

        Assert.NotNull(result);
        Assert.Null(result.Name);
        Assert.Equal(0, result.Count);
    }

    [Fact]
    public void SerializeToXml_ReturnsNullForNullObject()
    {
        Assert.Null(SerializationUtils.SerializeToXml<SampleDto>(null!));
    }

    [Fact]
    public void SerializeToXml_AndDeserializeFromXml_RoundTrip()
    {
        var original = new SampleDto { Name = "Çankaya", Count = 123 };

        var xml = SerializationUtils.SerializeToXml(original);
        var result = SerializationUtils.DeserializeFromXml<SampleDto>(xml);

        Assert.Contains("Çankaya", xml, StringComparison.Ordinal);
        Assert.NotNull(result);
        Assert.Equal(original.Name, result.Name);
        Assert.Equal(original.Count, result.Count);
    }

    [Fact]
    public void DeserializeFromXml_ReturnsDefaultForBlankInput()
    {
        Assert.Null(SerializationUtils.DeserializeFromXml<SampleDto>("   "));
    }

    [Fact]
    public void DeserializeFromXml_ProhibitsDtdProcessing()
    {
        const string xml = "<!DOCTYPE root [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><SampleDto><Name>&xxe;</Name><Count>1</Count></SampleDto>";

        Assert.ThrowsAny<Exception>(() => SerializationUtils.DeserializeFromXml<SampleDto>(xml));
    }

    public sealed class SampleDto
    {
        public string? Name { get; set; }
        public int Count { get; set; }
    }

    public sealed class Node
    {
        public string? Name { get; set; }
        public Node? Parent { get; set; }
        public Node? Child { get; set; }
    }
}
