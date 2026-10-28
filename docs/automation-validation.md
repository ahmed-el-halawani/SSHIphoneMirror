# IDB / headless MCP validation — 28 October 2026

The first working headless milestone is demonstrated. This is a development implementation with remaining release gates, not a production certification. The user-owned final-release checklist has not been marked complete.

## Implemented

* Shared SSH transport extracted behind the existing `connections.cjs` export; Electron callers keep the same interface.
* Separate headless configuration, strict key trust, read-only defaults, safe key-profile migration, and preserved Resource Manager signing.
* Pinned Intel IDB compatibility patch, captured Python dependencies, source/build manifest, SHA-256 verification, explicit versioned setup and rollback instructions.
* Simulator automation, exact selectors, targeted hit tests, bounded scrolling, deadline waits, Arabic/emoji AX set-value, explicit clipboard fallback, screenshots and bounded logs.
* Standalone SDK v2 stdio server with 16 tools and structured results; no arbitrary shell or destructive-reset tool.
* WDA adapter and explicit single-real-iPhone startup/reuse; viewer lifetime detached from Appium lifetime.
* Host-side logical-operation locks, manual-viewer reservations, explicit crash recovery, and read-only video mode for coexistence.
* Packaged runtime launcher, Windows installer packaging, local/opt-in live tests, CI and operating documentation.

## Evidence obtained

| Check | Observed result | Scope |
| --- | --- | --- |
| Existing regression baseline | 26 / 26 pass | Original suite retained |
| Final local suite | 45 / 45 pass | Includes client setup, binary streaming and runtime integrity cases; Python assertions run within the suite |
| Dependency audit | Zero known vulnerabilities | `npm audit` after locked dependency installation |
| MCP SDK stdio negotiation | Pass | Actual child process, list tools, structured results, denied mutation, clean client close |
| MCP Inspector 2.12.0 | Pass | CLI `tools/list` discovers all 16 tools |
| Headless SSH | Pass | Windows MCP → Resource Manager → SSH → Mac IDB with no Electron process needed |
| Flow A: counter | Pass | Ten exact `counter_button` taps; `counter_label == Count: 10` |
| Flow B: Unicode | Pass | `IDBTest تجربة الأتمتة 🙂` through AX set-value, then submission and exact readback after stripping SwiftUI direction-isolation markers |
| Flow C: navigation | Pass | Push, title assertion, back by exact label/type, root assertion |
| Flow D: list | Pass | Bounded scrolling to `row_item_45`; targeted hit test; `Selected: Row 45` verified |
| Flow E: async | Pass | Trigger then verified completion through deadline polling |
| MCP screenshot | Pass | Image content with PNG signature, returned through stdio |
| Cross-process device locking | Pass | A second Python process on the Mac receives `BlockingIOError` while the first owns `flock` |
| Manual/AI contention | Pass | Viewer reservation returns `DEVICE_BUSY` for AI tap while AX reads remain available |
| Read-only viewer input | Pass | Manual click on fixture counter in the video viewer leaves `Count: 0` unchanged |
| SimBeam coexistence smoke | Pass | All five flows run again with live read-only SimBeam video attached; video remained visible afterward |
| Large SSH response | Pass | 6 MB response succeeds with explicit 8 MiB budget and fails under the normal 4 MB cap |
| Windows unpacked package | Pass | `npm run pack -- --publish never` |
| Packaged MCP launch | Pass | Packaged EXE serves all tools in direct bundled Node mode; no external Node used by server |
| Packaged end-to-end | Pass | All five fixture flows and screenshot also pass through the bundled runtime with the desktop viewer closed |
| Windows NSIS build | Pass | `npm run dist -- --publish never`; unsigned installer produced |
| Real iPhone health handling | Pass for failure behavior only | Saved Wi-Fi session was unavailable; adapter returned `SESSION_LOST` without trying a destructive restart |

No tap was retried automatically after an uncertain acknowledgement. Early live failures were investigated by reading device state and resetting the disposable fixture between test runs. Those failures exposed integer-only IDB HID coordinates and a target obscured by a fixed header; the final five-flow runs passed after the adapter fixes. A desktop read-only attach failure exposed an uncloneable function result from `executeJavaScript`; the final expression returns `undefined` and video attachment succeeded.

The final prepackaging source also rejects shutdown from a read-only viewer, locks manual Simulator shutdown, propagates uncertain action outcomes, redacts secure subtrees, bounds image transfer and checks runtime Xcode/macOS/architecture/companion checksum. These additional paths have local assertions or targeted smoke coverage; they have not all been exercised on physical hardware.

## Automatic provisioning and MCP Setup

A fresh native companion was built from the pinned source in an isolated Mac build directory. A portable Python 3.14.10 / same-source CLI runtime was packaged into the app (43,131,325 bytes; SHA-256 `dbab8d3340c092980dd215970204f1c663e66150af0b791a9f51aca89196f43e`). The five Simulator flows passed after the production path automatically installed this runtime; the original `~/idb` experiment was not used by the driver.

`tests/live-provision.cjs` also passed against a fresh test-owned Mac directory: interrupted upload cleanup, no partial activation, successful installation, reuse with no archive transfer, deliberate file corruption and verified repair. The installer's subprocess health checks isolate Python and restrict PATH to system directories.

The compact top-bar MCP Setup panel was visually checked with the saved Mac populated. Local tests verify all three client schemas, repeat setup, backups, other settings, existing tool restrictions, JSONC comments, malformed files and unrelated server-name collisions. The native Codex CLI accepted the generated TOML in an isolated directory. OpenCode loaded the generated user configuration and connected to the MCP server in an isolated environment. Native Claude Code calls and clean-account Windows installation remain separate qualification gates.

## Tested environment

* Windows 11 x64; Node development runtime 25.2.1; bundled Electron 44.9.3.
* Intel Mac, macOS 15.8.1, Xcode 26.3 build 17C529.
* IDB commit `1387b360a9dcad34573cb1d9f277e5a0eacfd804`, Python CLI 1.1.8.
* Companion SHA-256 `29d5e1b67ac4ab0dd383bab6b381819f1f013940515e0aa2b6bc5bb0833a9c19`.
* iPhone 16e Simulator, iOS 26.3, `8AA89128-E540-44BB-82FD-43999DDC6838`.
* Disposable fixture bundle `com.evaluation.TestFixture` from the existing evaluation folder.

## Timing samples

These are Windows client-to-Mac round-trip durations from one complete suite per mode, including SSH/manager startup, validation, AX and action work. They are not CLI-only latency figures, a controlled CPU benchmark, an SLA, or a statistically useful p95. The coexistence run also enabled per-operation environment/checksum validation, so the difference cannot be attributed solely to video.

| Operation | Headless sample | With live video sample |
| --- | --- | --- |
| Element tap median, 16 actions including navigation and waits | 2,520 ms | 3,365 ms |
| Row-45 scroll + tap + verification | 21,462 ms | 26,691 ms |
| AX set-value | 2,891 ms | 3,378 ms |
| Full AX tree | 1,989 ms | 2,156 ms |
| Screenshot through MCP | 1,207 ms | 1,782 ms |

Raw action timings without screen contents or input values are retained in `headless-live-output.json`, `headless-coexistence-output.json` and `headless-packaged-output.json`. CLI-over-SSH works for the milestone, but the earlier standalone CLI timing targets have not been established as product performance targets. A persistent transport or gRPC adapter requires a separate measured comparison.

## Remaining gates

| Gate | Status / required evidence |
| --- | --- |
| G1 unit/regression | Passed locally; hosted CI not yet run |
| G2 Intel smoke | Fresh isolated native rebuild and bundled-runtime installation pass; five flows pass after automatic provisioning |
| G3 headless five flows | Passed |
| G4 video coexistence | Smoke passed; CPU, frame-drop, disconnect and sustained-stream benchmarks pending |
| G5 element accuracy | Deterministic flows and ambiguity/bounds assertions pass; repeated ≥99% suite, rotation/modal/movement fault matrix pending |
| G6 Unicode | Arabic, English and emoji pass through AX; secure fields, multiline/RTL editing and clipboard interference matrix pending |
| G7 recovery | Fail-closed handling and explicit stale-reservation recovery implemented; real network fault injection and companion restart soak pending |
| G8 physical iPhone | WDA adapter implemented; actual lifecycle, touch, secure input, screenshot and reconnect qualification pending because the saved session was unavailable |
| G9 client compatibility | SDK client and Inspector pass; native Codex registration and OpenCode connection pass; native Claude Code calls pending |
| G10 installed release | Installer built and packaged EXE tested; installation into a clean Windows account without Node, install-over-existing and uninstall tests pending |
| G11 security | Input validation, host trust, permissions, redaction, no-shell surface, bounded outputs and non-retry assertions pass; full fault/security review pending |
| Native compatibility | ARM qualification, private-framework/Xcode upgrade testing, and `@unchecked Sendable` concurrency stress review pending |

One physical iPhone per Mac is supported by design. An older desktop build or an external controller that ignores these locks cannot participate in coordination. A crashed manual viewer leaves a reservation until explicitly recovered; this favors refusing control over risking conflicting input. IDB's private Apple APIs remain the main compatibility risk.

The installer remains a development candidate until the outstanding qualification gates have evidence. Branch publication is separate from a production release.
