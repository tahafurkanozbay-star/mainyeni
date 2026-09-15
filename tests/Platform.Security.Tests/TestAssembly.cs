using Xunit;

// These tests mutate process-wide environment variables and therefore must
// remain serialized. CollectionBehavior is supported by xUnit v3 and avoids
// relying on runner-specific parallelization attributes.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
