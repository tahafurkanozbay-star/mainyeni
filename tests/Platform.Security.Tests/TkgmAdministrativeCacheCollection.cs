using Xunit;

namespace Platform.Security.Tests;

/// <summary>
/// Serializes tests that intentionally observe or mutate the process-wide TKGM administrative caches.
/// Dedicated concurrency tests still create parallel request pressure inside each test method.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class TkgmAdministrativeCacheCollection
{
    public const string Name = "TKGM administrative cache";
}
