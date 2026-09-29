# Request framing governance

The API request-governance layer rejects message-framing forms that can be interpreted differently by intermediaries and the application server.

## Invariants

`Content-Length` is optional. When present it must be represented by exactly one field value containing only a non-negative base-10 integer that fits in `Int64`. Signed values, comma-joined values, decimals, whitespace-only values, nonnumeric values and overflow are rejected before content-type evaluation.

`Transfer-Encoding` is optional. When present it must be represented by exactly one field value and the coding must be `chunked`, compared case-insensitively after outer whitespace trimming. Coding chains and unsupported codings are rejected.

A request containing both `Content-Length` and `Transfer-Encoding` is rejected as ambiguous before either individual field is interpreted. This preserves one deterministic precedence rule for diagnostics and avoids accepting a request that an upstream proxy may frame differently.

The policy never reads or buffers the body. It examines bounded metadata already parsed into the ASP.NET Core header dictionary. Rejection details describe the class of failure and never echo raw header values.

## Operational behavior

These checks complement Kestrel transport limits rather than replacing them. Transport remains responsible for connection-level parsing and byte limits; governance supplies an application-level invariant that remains explicit and regression-tested when hosting or proxy topology changes.

No compatibility fallback accepts obsolete transfer codings. If a future deployment genuinely requires another coding, it must be introduced deliberately across proxy, server, governance, tests and release validation rather than being accepted implicitly.
