using Xunit;

// Several platform characterization suites exercise process-wide static state
// (for example the TKGM administrative caches). Running those suites in
// parallel allows an unrelated test to clear or repopulate shared state while
// another test is asserting hard capacity/freshness invariants. Keep this
// backend validation assembly deterministic; concurrency behavior is exercised
// explicitly inside the dedicated tests with controlled barriers.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
