using Api.Core.Base;
using Business.Core.Common;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System.Net;
using Xunit;

namespace Platform.Security.Tests;

public sealed class ClientRequestIpTrustTests
{
    private sealed class ProbeController : _BaseController
    {
        public ClientRequestInfo InspectClient() => GetClientRequestInfo();
    }

    [Fact]
    public void ClientAuditIp_IgnoresUntrustedRawForwardedHeader()
    {
        var http = new DefaultHttpContext();
        http.Connection.RemoteIpAddress = IPAddress.Parse("192.0.2.42");
        http.Connection.LocalIpAddress = IPAddress.Loopback;
        http.Request.Headers.UserAgent = "Mozilla/5.0";
        http.Request.Headers["X-Forwarded-For"] = "198.51.100.1, 198.51.100.2";

        var controller = new ProbeController
        {
            ControllerContext = new ControllerContext { HttpContext = http }
        };
        var info = controller.InspectClient();

        Assert.Equal("192.0.2.42", info.Ip);
        Assert.Equal("127.0.0.1", info.IpLocal);
        Assert.DoesNotContain("198.51.100", info.Ip);
    }

    [Fact]
    public void ClientAuditIp_HandlesMissingConnectionAddressesSafely()
    {
        var http = new DefaultHttpContext();
        http.Connection.RemoteIpAddress = null;
        http.Connection.LocalIpAddress = null;
        http.Request.Headers["X-Forwarded-For"] = "203.0.113.99";
        http.Request.Headers.UserAgent = "Mozilla/5.0";

        var controller = new ProbeController
        {
            ControllerContext = new ControllerContext { HttpContext = http }
        };
        var info = controller.InspectClient();

        Assert.Equal(string.Empty, info.Ip);
        Assert.Equal(string.Empty, info.IpLocal);
    }
}
