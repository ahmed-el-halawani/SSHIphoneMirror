# Simulator MCP stability — 29 October 2026

A read-only 10-minute soak used the registered iPhone Mirror MCP against the already booted iPhone 17 simulator (iOS 26.3). No real device was used.

- Started: 2026-10-29T19:48:30.847Z (22:48:30 Riyadh)
- Finished: 2026-10-29T19:58:31.432Z (22:58:31 Riyadh)
- Duration: 600.584 seconds.
- Schedule: fresh screenshot followed by UI tree every five seconds, including start and end samples.
- Result: 242/242 successful requests, with no test-level retry or reconnect.
- Validation: all 121 screenshot responses contained PNG image blocks with PNG signatures; all 121 accessibility trees were nonempty with 402 × 874-point screen bounds.

| Operation | Requests | Median | P95 | Maximum | First-minute median | Last-minute median |
|---|---:|---:|---:|---:|---:|---:|
| screenshot | 121 | 346 ms | 424 ms | 498 ms | 385 ms | 345 ms |
| get_ui_tree | 121 | 253 ms | 321 ms | 361 ms | 243 ms | 263 ms |

Timings are wall-clock tool-call durations. This establishes repeated MCP capture and accessibility stability during this window. It does not establish continuous video FPS, WebRTC viewer stability, decoded-image correctness, memory stability, or multi-hour endurance. Individual screenshot calls must not be interpreted as video FPS.

The existing frontmost app was left untouched. Screen images and accessibility contents were not saved. No installer was rebuilt or application source changed. Cold starts and synthetic Mac load were not tested. Workspace-based MCP registration still depends on this workspace remaining in place.

The JSON companion contains per-request timing and validation metadata only.
