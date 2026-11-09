# Compact Simulator MCP validation — 9 November 2026

The compact workflow is implemented over the existing SSH/IDB worker. The final combined live run passed. It substantially reduces the context returned to the agent and the number of tool calls. Raw device time is approximately unchanged; initial snapshot stabilization adds an upfront cost.

## Implementation

`ios_snapshot` returns a bounded, settled visible view with refs and a snapshot ID. `ios_act` supports tap, fill, long press and controlled scrolling. It validates the current UI against the snapshot, resolves the observed node occurrence, checks bounds and performs a point hit test before input. Its response contains a compact diff and a new snapshot ID. Unchanged refs remain available with that new ID.

Explicit `expected` postconditions verify intent. `settled` reports matching UI observations, not successful intent. An uncertain input is never replayed. A read-only accessibility acquisition can recover once within its deadline, and the snapshot retains its AX backend. Snapshot state stays in worker memory; secure values are redacted before compaction. Existing permissions, viewer handoff and device locks remain active.

No application dependency or native runtime archive changed. [Upstream reference notes](agent-device-reference.md) record the downloaded agent-device commit and the boundary between its workflow and this independently written implementation.

## Paired measurement

The actual MCP stdio client called the Mac over SSH. The target was the iPhone 17 Pro Simulator running iOS 26.3, with a 402×874-point viewport and the disposable `com.evaluation.CompactFixture` app. The order was baseline, compact, compact, baseline, with ten verified counter increments per batch. Each batch relaunched the fixture outside the timed section. The same final driver served both paths.

Baseline: full tree, then exact element tap with an expected counter value, for every increment. Compact: one initial compact snapshot, then one reference action with that expected value per increment. The two initial compact snapshots are included in compact totals.

| Metric, 20 verified increments per workflow | Full-tree baseline | Compact workflow | Change |
| --- | ---: | ---: | --- |
| MCP calls | 40 | 22 | 45.0% fewer |
| Tool response text tokens | 220,896 | 4,880 | 97.8% fewer |
| JSON tool request tokens | 3,320 | 2,444 | 26.4% fewer |
| Serialized MCP result bytes | 1,716,032 | 29,338 | 98.3% fewer |
| Total measured device workflow time | 46.287 s | 49.084 s | Compact was 6.0% slower |
| Mean time per increment, including initial compact snapshots | 2.314 s | 2.454 s | +140 ms |
| First-attempt counter results | 20/20 | 20/20 | No corrective taps |

The steady interaction medians in the two baseline batches were 2,356 and 2,264 ms; compact medians were 2,210 and 2,261.5 ms. These exclude the compact initial snapshot. There is no evidence of a large raw device latency improvement. Fewer agent tool turns and smaller responses are the measured efficiency gains; model inference and total agent completion time were not benchmarked.

This comparison is specifically against an inspect-every-action workflow. Existing exact selectors can already be reused without fetching another full tree. For a known target and an explicit postcondition, `ios_tap_element` remains useful and avoids requesting a new view when the agent does not need one. Prefer compact actions when the agent needs the changed UI to decide its next step; do not interpret the table as a universal improvement over every existing tool sequence.

Token counts use `cl100k_base` on actual MCP text content and serialized tool requests. They exclude model reasoning, transport framing and client-specific schema conversion. The two new tool definitions contain 768 tokens when serialized as JSON with that encoding. These are comparison measurements, not provider billing totals.

The [sanitized measurements](compact-benchmark-2026-11-09.json) include group timings, observed p95 values and SHA-256 hashes of the four production source files. This is a small, single-host sample, not an SLA or a statistically established accuracy rate.

## Functional coverage

The final recorded validation contains 61 successful compact actions and two intentional refusals. The counter benchmark and corrected UTF-8 functional validation were recorded in separate complete invocations against identical production source hashes. No unexpected positive-path failure or corrective input call occurred in those recorded samples.

| Case | Final live result |
| --- | --- |
| Counter and compact diff consumption | Twenty compact increments, each exact value verified |
| Unicode | English, Arabic and emoji filled, submitted and read back |
| Old snapshot ID | Refused before input; counter remained unchanged |
| Delayed UI | Waited for the fixture's 1.5-second task and verified completion |
| Navigation and long list | Opened the list, scrolled to row 45 and verified selection |
| Native switch | Ten alternating on/off changes, each state verified |
| Secure input | Value absent from compact output; submitted length verified |
| Duplicate labels | Ten selections between identically labeled controls, each exact result verified |
| Disabled control | Refused before input |
| Long press | Gesture result verified |
| Sheet | Open and close verified |
| System alert | Confirmed through a ref despite duplicate AX representations |
| Screenshot | Final PNG saved locally for inspection |

Local verification passed all 75 Node tests, including 25 compact Python cases. Those cases cover changed/moved/expired targets, rotation bounds, backend retention, secure redaction, bounded payloads, duplicate node occurrences, header positioning, manual-viewer handoff, transient read recovery, and uncertain input without replay. `npm audit --omit=dev` reported zero known production vulnerabilities.

The Windows unpacked build succeeded. Its actual MCP entry negotiated all 18 tools and rejected an unauthorized compact mutation before dispatch. All four changed production files inside `app.asar` matched the live-tested source hashes. An agent-driven follow-up used the packaged Electron runtime and bundled server/controller over MCP: it read a snapshot, opened the sheet using its ref, and closed it using the returned diff ref. Both actions verified their postconditions on their first input call. The viewer was not auto-opened for this headless check.

## Calibration findings

Live testing exposed details that a schema-only test would miss:

- A navigation row's point read can return its text child. Hit testing now accepts a matching current descendant with the same type and frame.
- A native switch's AX row center can be inert. Semantic switch actions use the actual control bounds and a qualified 100 ms touch. Anonymous thumb Groups require matching app ownership and containment inside the native switch.
- Short list swipes can fling past the target. Compact scrolling uses the already-established one-second controlled gesture.
- Startup AX can temporarily omit screen geometry or fail acquisition. Initial snapshots now settle, and bounded read recovery does not repeat input.
- The fixture's custom long-press Text exposed a whole-row AX rectangle but handled touches only on its glyphs. Its gesture surface was aligned with its accessibility bounds. This fixture fix does not solve misleading bounds in other apps.
- The long-run harness now drains MCP audit stderr and checkpoints each benchmark batch so an unconsumed Windows pipe cannot block the test server.
- Final screenshot inspection caught a locale-encoding error in the harness literal. The actual Arabic/emoji case was rerun after replacing it with ASCII Unicode escapes and explicit code-point assertions. The English counter benchmark was unaffected.
- Arabic rendering was visually confirmed. The actual emoji code point survived the field submission and AX round-trip, but the screenshot shows a placeholder glyph for it. The rendering cause was not investigated.

## Reproduction and limits

Build the fixture on the Mac with `sh tests/build-compact-fixture.sh`, then install the generated app on the selected Simulator. On Windows:

```powershell
$env:MIRROR_TEST_HOST = '<enrolled Mac host ID>'
$env:MIRROR_TEST_DEVICE = '<Simulator UUID>'
$env:MIRROR_TEST_ROUNDS = '10'
node tests/live-compact.mjs
python tests/summarize-compact.py
```

The summarizer uses an already-installed local `tiktoken` analysis package; it is not an application dependency. Raw captures and the test-only token corpus stay in the ignored `.research/` directory. The committed JSON contains no typed field values or screenshots.

The harness exercises headless MCP and SSH without auto-opening the viewer. Physical-device compact sessions, live-video coexistence on this branch, real rotation/fault injection, and a long-session soak remain unqualified. Existing real-iPhone tools remain available. Snapshots expire after sixty seconds or a worker reconnect. External UI changes cause a safe refusal and require a fresh read. Apps with AX-invisible overlays, misleading hit bounds or continuously changing UI can still require visual inspection or an explicit exact-selector workflow. There is no universal first-attempt guarantee.
