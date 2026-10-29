# Persistent Simulator worker — 29 October 2026

The MCP now reuses a Mac-side Python worker and the installed IDB gRPC client. It avoids launching system Python and the IDB CLI for each screenshot, accessibility read, hit test, tap, swipe or selected-field text operation. No dependencies or runtime archives changed. Images remain full-resolution PNGs, and every requested tree/screenshot is freshly captured.

## Paired measurements

The read-only benchmark alternated CLI and worker operations on the same running iPhone 17 Simulator and unchanged Khuta Quran screen. Each action had one warm-up per path and three measured pairs, reversing order in the middle pair. Accessibility screen bounds and all identifier/label/type/value content matched between paths in every pair.

The final comparison, with the Mac quieter, measured:

| Operation | CLI median | Worker median | Reduction |
| --- | ---: | ---: | ---: |
| Screenshot | 890 ms | 293 ms | 67% |
| Accessibility tree | 817 ms | 195 ms | 76% |

An earlier paired comparison under heavier Mac load measured 12,430 → 1,814 ms for screenshots (85% reduction) and 14,535 → 2,641 ms for trees (82%). These are small local samples under changing host load, not latency guarantees. The quieter comparison is the more useful baseline.

The original instrumentation placed almost all operation time in the CLI subprocess, with runtime validation contributing approximately 69–107 ms. Reusing the interpreter, imported modules and IDB connection directly addresses that repeated work.

## Actual MCP navigation check

The final end-to-end check used the installed Electron executable in Node mode, the workspace MCP server and the saved host configuration. It passed:

- Concurrent cold screenshot and tree requests, sharing one connection and runtime preparation.
- Exact-label Next Page with an explicit expected-state check.
- A relative-coordinate reverse swipe and an assertion that the original page counter returned.
- A final full-resolution screenshot, visually confirmed at Al-Baqarah page 2.
- Client disconnect and assertion that the MCP process exited.

Measured final calls included:

| MCP call | Server elapsed time |
| --- | ---: |
| Warm tree read before navigation | 200 ms |
| Exact-label tap, including expected-state verification | 1,084 ms |
| Warm tree read after tap | 255 ms |
| Relative swipe | 480 ms |
| Tree read after swipe/transition | 1,455 ms |
| Final screenshot | 464 ms |
| MCP shutdown | 237 ms |

The first screenshot took 2,126 ms; the concurrent tree took 2,339 ms including its queue wait. Startup was much slower during earlier host saturation. Worker reuse removes repeated startup, not the cost of initial verification or Mac scheduling delays.

## Lifecycle and correctness

- The worker lives on an SSH stdio channel, not a daemon, login agent or public socket. Resource Manager connections use the verified OpenSSH recipe for this channel.
- It uses the already-verified bundled Python/IDB runtime and private IDB session directory.
- Bootstrap disables bytecode writes until the private external cache is configured. Final inspection found zero new bytecode files inside the pinned runtime and 290 cache files in the private external cache. A final-source read-only check returned a warm screenshot in 269 ms and trees in 199–204 ms.
- One worker serializes Simulator operations per host. Concurrent calls share connection startup and runtime preparation.
- Five idle minutes close the connection. MCP EOF, termination and normal disconnect explicitly close connections and workers. Remote process inspection after live testing found no worker left running.
- Existing host permissions, per-device locks, viewer handoff, bounds checks, point hit testing, secure-field redaction and mutation outcome tracking remain active.
- Requests are bounded to 64 KiB; response budgets remain 4 MiB normally and 24 MiB for screenshot transfer. Response IDs must match the active request.
- Cancellation, malformed responses, oversized output and broken channels fail closed. No failed action is replayed. A later independent read can reopen the worker.
- SDK clients are discarded after a transport/operation failure so a later request can establish a fresh client. That cleanup does not retry the failed input.
- The read-only long-poll viewer watcher and real-device path keep their existing execution model. Rare Simulator CLI operations outside the optimized set also keep the existing implementation.

## Verification and artifacts

`npm test` passed all 64 Node test cases, including the Python driver and worker checks. Tests cover framing, Unicode preservation, shared startup, queue cancellation, disconnects without replay, late startup failures, message budgets, SDK argument parity, per-request state reset, process-group cleanup and worker shutdown. `git diff --check` passed. The live MCP navigation and shutdown check passed on the final source.

Sanitized evidence:

- `worker-benchmark-2026-10-29.json`: final paired benchmark and parity assertion.
- `worker-benchmark-loaded-2026-10-29.json`: earlier comparison under heavier load.
- `worker-live-2026-10-29.json`: final MCP calls and navigation assertions.
- `release/performance/worker-live.png`: final screenshot.

## Operational limits

Reconnect the MCP once to load the updated source; the existing registration already points to this workspace. No Mac-side installation step is required. Keep the workspace in place while using that registration. This change has not been packaged into a new desktop installer.

The worker does not fix application overlays omitted from AX, guarantee sustained video FPS, or establish long-duration reliability. It intentionally keeps the full tree and hit-test checks and does not lower screenshot quality. Parallel control of multiple simulators on the same host would require separate worker queues.
