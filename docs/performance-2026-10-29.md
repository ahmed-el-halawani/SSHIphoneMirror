# Khuta Quran simulator performance investigation — 29 October 2026

Follow-up: [the persistent worker implementation and paired benchmarks](worker-performance-2026-10-29.md) supersede the one-shot command path discussed in this initial investigation.

The live target was the already-running iPhone 17 simulator, iOS 26.3, on Ahmed's Mac. Khuta Quran is installed as `com.halawany.madad`. Calls used the actual stdio MCP server and the existing SSH Resource Manager connection.

## Connection and host findings

The configured Mac address `192.168.194.129` was unreachable. Device discovery failed after 15,385 ms. The existing Resource Manager LAN profile at `192.168.8.222` worked; MCP device discovery took 1,106 ms.

The mirror's local automation configuration now retains its original public host ID but routes through the working Resource Manager LAN profile. Backups were created before changing configuration. Codex's MCP entry now uses the tested workspace source with the existing installed Electron executable in Node mode; the executable successfully negotiated MCP and listed all 16 tools. An MCP reconnect is required to load those changes. The installed desktop application archive was not rebuilt.

The Mac had 8 logical CPUs and 16 GiB RAM. Load averages increased from approximately 252 to 407 during the initial run; reported memory free percentage was 77%, and the OS reported no CPU speed or scheduler limit. This was an abnormal environment for a speed comparison. The specific cause of that whole saturation episode was not established; process snapshots alone do not prove which process caused it.

## Measured timings

These are individual observations, not percentiles or a controlled before/after benchmark.

| Operation | Observed elapsed time | Interpretation |
| --- | --- | --- |
| Establish SSH runner, including Resource Manager lookup | 3,115 ms | Cold connection |
| Three warm SSH `printf` calls | 1,483 / 288 / 237 ms | Transport and remote shell baseline |
| Launch Khuta Quran | 1,280 ms | MCP command completion; screen checked afterward |
| MCP simulator screenshots during the overloaded walkthrough | 2,984–27,460 ms | First sample (19,861 ms) includes runtime preparation; host load varied substantially |
| Direct Apple `simctl` screenshot | 23,787 ms | Slow without MCP or IDB, too |
| Accessibility reads | 6,888–55,323 ms | Host and AX work dominate simple transport |
| Successful coordinate taps without a postcondition | 12,513–26,106 ms | Subsequent screen reads confirmed navigation |
| Exact element taps | 37,220 / 37,828 ms, TIMEOUT | Failed at `idb.ui.describe-point` before input dispatch |
| Mixed-axis pixel tap with postcondition, old idle timer | 62,958 ms, OUTCOME_UNKNOWN | Connection closed while work was active; subsequent read confirmed the intended Back navigation; tap was not replayed |
| Navigation tap with verified postcondition after timer fix | 50,901 ms | Reached the expected world-selection screen |
| Exact-label tap on the journey's Learn button | 43,080 ms | Input dispatched, but tutorial overlay blocked navigation; see below |
| Page swipe | 1,453 ms | Screenshot confirmed Al-Fatiha page 1 → Al-Baqarah page 2 |
| Fresh MCP through saved configuration, screenshots | 2,811 / 1,332 / 1,271 ms | Installed Electron executable, workspace source, original host ID routed to LAN; initial screenshot includes connection/runtime checks |
| Fresh MCP through saved configuration, AX read | 1,198 ms | Host load had returned to approximately 3.5 |
| Exact-label Next Page after closing Settings | 1,719 ms | Screenshot confirmed page 2 → page 3; screenshot took 1,567 ms |
| Exact-label Previous Page after closing Settings | 2,383 ms | Screenshot confirmed return to page 2; screenshot took 1,700 ms |

No claim of a general latency improvement is supported while host load is changing this much.

## Fixes and verification

- Coordinate autodetection now selects one scale for the complete tap or swipe. Previously a pixel coordinate could exceed point bounds on one axis only, leaving the other axis unscaled and moving the target. Tests cover mixed-axis taps and swipes. Live testing used pixel `(1080, 273)` for point `(360, 91)` and a later screen read confirmed the intended Back navigation.
- Connection idle expiry now starts after the last active command finishes. A regression test advances a fake clock past 60 seconds while two commands overlap, then confirms cleanup occurs only after the last command finishes and the connection is actually idle.
- Screenshot calibration reuses the captured PNG dimensions instead of taking another screenshot. Cached bounds are refreshed when a captured image indicates rotation. Tests verify calibration, cache reuse, rotated bounds, and zero additional capture calls.
- Large Windows signing payloads are staged through SSH instead of exceeding the signing launcher's Windows process argument limit. The original 46,885-byte session payload failed with `spawn ENAMETOOLONG`. Tests cover cleanup on success and failure; live startup passed this failure point after the change.
- Real-device recovery can reuse the same iPhone's previously selected signing team when it remains valid. Tests also reject reuse for another phone or an unavailable team. Physical-device investigation was discontinued when the user clarified the simulator target; helper processes started for that attempt were stopped. Successful physical-device recovery is not claimed.

Local verification: `npm test` passed all 55 tests, including the Python driver assertions. `git diff --check` passed. The existing installed executable successfully launched the workspace MCP server and enumerated its 16 tools.

## App-specific blocked-tap finding

After onboarding, a visual first-run tutorial covered the journey screen. The AX tree and point hit test still exposed the journey controls underneath and omitted the tutorial's buttons. An exact-label tap was therefore dispatched successfully without opening the lesson. A screenshot established the actual cause; this was not a coordinate conversion failure. The visible Skip button was tapped by screen points, and the following screenshot confirmed the overlay was dismissed.

The `tap_element` description now explicitly advises using an expected postcondition and checking a screenshot when navigation does not change. An `executed: true, verified: false` result confirms input dispatch only. The mirror cannot infer an overlay that the application omits from accessibility; the app would need to expose its tutorial/modal semantics to make AX-only interaction reliable.

## Walkthrough coverage

The simulator walkthrough completed onboarding through address/form of speech, style, reciter, world selection, starting point, daily pace and reminder preference. Reminders were skipped. It reached the journey screen, inspected and dismissed the first-run tutorial, and opened the Learn 5 Verses lesson for Al-Mursalat 1–5. The lesson's accessibility read exposed the verse, display options, close button, recitation/listening controls, and next/previous controls. The close action was verified against the journey's Mushaf button. The Mushaf opened at Al-Fatiha page 1, a swipe reached Al-Baqarah page 2, and exact-label page navigation reached page 3. Lesson completion, audio output and speech recognition were not verified.

## Follow-up Mac investigation through SSH Resource Manager

After the user confirmed no build or stress test was running, SSH Resource Manager rechecked the LAN profile successfully. A two-sample `top` reading showed approximately 77% CPU idle, low disk I/O, no swap-outs, and a 1-minute load of 3.47. The extreme spike had already subsided before any Settings process was stopped.

Unified logs showed repeated `airportd` errors: `PROCESS NOT ALLOWED FOR REQUEST TYPE`, originating from the two Wi-Fi Settings extensions, for `GET COUNTRY CODE`. The System Settings process and Wi-Fi/Network extensions had been running since before this test. A system diagnostic report from earlier the same day also recorded excessive `diagnosticd` CPU use, before this session.

The System Settings process was identified by its exact executable path before sending SIGTERM. Its Wi-Fi/Network extensions exited as well. The next bounded 10-second error query returned no matching errors. SSH stayed connected, simulator Next Page worked by exact label, and a later `top` sample showed approximately 81% CPU idle and a 1-minute load around 2.2. No network settings were changed, and no networking daemon was killed. This resolves the observed Settings polling/error loop; it does not prove that loop alone caused the earlier load above 400.

## Remaining limits

The severe Mac load caused slow screenshots, slow AX reads, and pre-dispatch element hit-test timeouts during the initial walkthrough. The follow-up establishes only a small normal-load sample, not video frame rate, a sustained throughput limit, or long-term stability. The application-specific tutorial/accessibility limitation remains. Detailed sanitized per-call timings are in `performance-samples-2026-10-29.json`: 46 host/simulator calls, including eight successful follow-up calls through the saved configuration. The simulator was left on Al-Baqarah page 2. A final screenshot is saved at `release/performance/khuta-quran-final.png`.
