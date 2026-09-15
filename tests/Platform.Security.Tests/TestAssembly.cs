using Xunit.Sdk;
using Xunit.v3;

// These tests mutate process-wide environment variables and therefore must
// remain serialized under xUnit v3's current parallelization contract.
[assembly: Parallelization(Mode = ParallelMode.None)]
