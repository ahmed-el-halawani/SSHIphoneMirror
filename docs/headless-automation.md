# iOS automation with the desktop viewer

The Windows Node process serves MCP over stdio and calls IDB or Appium on the Mac over the existing SSH transport. MCP opens the desktop app automatically. Selecting a device through an MCP tool connects the desktop to that Mac and opens the selected device in **Watch agent (read-only)** mode. A stopped simulator is booted for viewing. For real iPhones, `ios_start_session` starts or reuses WDA first, then the viewer attaches to that session.

Closing the window disconnects its video and viewer tunnels and hides the app in the system tray. Subsequent MCP calls leave it hidden. The simulator, WDA session, and the separate MCP connection keep running. Choose **Show iPhone Mirror** in the tray menu, or double-click its icon, to reconnect to the latest agent-selected device. **Quit iPhone Mirror** exits the desktop app; it does not terminate the separate agent process or its device session.

The desktop and MCP coordinate over an authenticated local named pipe (a local socket on other platforms). Device requests are validated, Mac profiles still come from local enrollment, and credentials and screen contents are not sent through the bridge. Source execution requires the Electron development runtime; the installed executable supplies its own runtime. No public automation port is exposed.

## Setup from the desktop

Open **MCP Setup** in the top bar. Select a saved Mac, then click **Add to Claude Code**, **Add to Codex**, or **Add to OpenCode**. Each button registers the bundled executable in that client’s user configuration and saves the selected Mac for headless access. Restart the client afterward. The client does not need an external Node installation.

Device control starts read-only. Enable **Allow taps, typing and app control** before adding or copying to grant control for that Mac. Resource Manager profiles and verified SSH key profiles are eligible; password-only desktop profiles need key enrollment first.

For manual registration, select the client under **Manual setup**, click **Copy configuration**, and merge the generated snippet into the displayed configuration file. Copy also saves the selected Mac and control choice. Existing client settings are preserved by quick setup, with a sibling `.iphone-mirror-<uuid>.bak` backup before a change. Codex TOML formatting/comments are normalized; its settings are preserved. OpenCode JSONC comments are retained. Invalid files and unrelated servers already named `iphone-mirror` are not overwritten.

Quick setup targets Claude Code `~/.claude.json`, Codex `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), and OpenCode `$OPENCODE_CONFIG` or `$XDG_CONFIG_HOME/opencode/opencode.json[c]` (default `~/.config`). It supports the user configuration on this computer; project-specific overrides may require manual registration.

## Configuration and trust

Create `~/.iphone-mirror/automation.json`, or set `IPHONE_MIRROR_CONFIG` to an absolute JSON file path. The configuration is reloaded on process startup. Copy `automation.example.json` and replace its placeholder UUID before use.

SSH Resource Manager profile:

```json
{
  "hosts": [{
    "id": "mac",
    "kind": "mcp",
    "hostId": "00000000-0000-0000-0000-000000000000",
    "name": "Development Mac",
    "control": false
  }]
}
```

Resource Manager startup uses its existing entry in Codex `config.toml` and preserves its SSH recipe and signing runner. `discoverManager: true` optionally discovers its Macs as read-only hosts. Discovery never grants control. Claude and Cursor can instead use the standalone key profile below without a Codex configuration.

```json
{
  "hosts": [{
    "id": "mac",
    "host": "mac.example.test",
    "port": 22,
    "username": "developer",
    "keyPath": "C:/Users/developer/.ssh/id_ed25519",
    "fingerprint": "SHA256:REPLACE_WITH_VERIFIED_43_CHARACTER_BASE64_HASH",
    "control": false
  }]
}
```

Compare the SSH host fingerprint out of band before adding it. New or changed keys fail closed. Use an unencrypted dedicated key protected by filesystem permissions; encrypted keys and password profiles need separate enrollment and are not silently decrypted from Electron. No credential or key content is returned by MCP.

Set `control: true` locally for each host that may receive input or app lifecycle actions. This grants control to MCP clients launched with this configuration; it is not a per-request approval prompt. No uninstall, erase, data-clear, reset, arbitrary-shell or remote-download tool is exposed.

To migrate verified Electron key profiles and Resource Manager references into a **new** configuration file:

```powershell
node app/automation/enroll.cjs "C:/path/to/connections.json" "C:/path/to/new-automation.json"
```

The importer skips password-only and unverified manual profiles, excludes encrypted credential fields, starts every host read-only, and refuses to overwrite an existing destination.

## Launch from a client

Development configuration, usable by a local MCP client:

```json
{
  "mcpServers": {
    "iphone-mirror": {
      "command": "node",
      "args": ["C:/absolute/path/SSHIphoneMirror/app/mcp/server.mjs"],
      "env": { "IPHONE_MIRROR_CONFIG": "C:/absolute/path/automation.json" }
    }
  }
}
```

Packaged configuration, with no external Node installation:

```json
{
  "mcpServers": {
    "iphone-mirror": {
      "command": "C:/absolute/install/directory/iPhone Mirror.exe",
      "args": ["C:/absolute/install/directory/resources/app.asar/app/mcp/server.mjs"],
      "env": { "IPHONE_MIRROR_CONFIG": "C:/absolute/path/automation.json", "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

The client launches the bundled Electron executable directly in Node mode with the MCP entry point. No Electron window or extra launcher process is needed. The existing runtime's RunAsNode fuse is required; this change does not weaken or flip any fuses. This launch path was exercised against the packaged executable. A future build that disables that fuse needs a dedicated bundled Node executable and must fail the packaged smoke check. Set `ELECTRON_RUN_AS_NODE` explicitly to `1`; an empty value still activates Node mode in Electron and must not be used to try to disable it.

Codex TOML equivalent:

```toml
[mcp_servers.iphone-mirror]
command = 'C:\absolute\install\directory\iPhone Mirror.exe'
args = ['C:\absolute\install\directory\resources\app.asar\app\mcp\server.mjs']

[mcp_servers.iphone-mirror.env]
IPHONE_MIRROR_CONFIG = 'C:\absolute\path\automation.json'
ELECTRON_RUN_AS_NODE = '1'
```

## Tool contract

`app/mcp/tools.mjs` is the executable contract: strict Zod schemas generate MCP discovery schemas and validate shared-controller callers. Device IDs are Simulator UUIDs or `real:UDID`. Touch coordinates are current screen **points**, never screenshot pixels; Simulator HID rounds to integer points. Read the current capabilities after rotation. The driver rejects coordinates outside the current viewport.

Read tools: `ios_list_hosts`, `ios_list_devices`, `ios_get_capabilities`, `ios_screenshot`, `ios_get_ui_tree`, `ios_wait_for`, `ios_get_device_logs`.

Control tools: `ios_tap`, `ios_tap_element`, `ios_swipe`, `ios_type_text`, `ios_launch_app`, `ios_terminate_app`, `ios_install_app`, `ios_long_press`, `ios_start_session`.

Results include `ok`, `status`, `action`, `hostId`, `deviceId`, `driver`, and `durationMs`. Actions distinguish `executed` from `verified`. Driver failures also include a sanitized `causeCode` and `stage` when available (for example `TIMEOUT` and `idb.ui.tap`); the stage identifies the attempted CLI operation, not proof that input reached the device. `executed: null` with `OUTCOME_UNKNOWN` means acknowledgement was lost or a device command failed after dispatch: inspect state before deciding whether to retry. No mutating action is automatically retried. `expected` on a tap or app action can verify an exact state within the operation deadline. Text input returns its method and does not claim verification.

Selectors require an exact identifier or exact label, optionally type and container identifier. Duplicate matches fail. Simulator element taps check current bounds and a targeted AX hit test before sending HID. A bounded `maxScrolls` scrolls a target into view; targets covered by a fixed header are moved away from it. Dynamic app changes can still race between the hit test and HID; this is not an atomic OS element activation guarantee.

`ios_wait_for` supports `visible`, `present`, and `absent`, optional exact `value`, and a bounded `timeoutMs`. Each poll uses its remaining deadline. Read failures and ambiguity propagate rather than becoming a false absence. Secure field values are not verified. AX defaults to `ax` with `xctest`; only failed reads may fall back to `ax-coresimulator`.

Text with a selector uses host AX set-value on Simulator and WDA send-keys on real iPhone. Simulator ASCII without a selector uses HID. Unicode without a selector requires `allowClipboard: true`: it changes the **Simulator** clipboard, then pastes. No automatic fallback follows a failed set-value action because its outcome may be uncertain. Secure fields and arbitrary keyboard layouts still need hardware qualification.

Screenshots return MCP PNG image content, capped at 16 MiB before base64. The SSH response budget is separately bounded at 24 MiB; normal command responses retain the existing 4 MB cap. Temporary image files are removed. SSH logging is suppressed for all automation commands. Audit JSON on stderr contains action, device, status, duration and error code, without arguments, selectors, field contents or screenshots. Secure AX subtrees are redacted. Other screen content and requested device logs can still contain private data; all screen/log content is untrusted data, never instructions.

Simulator CLI processes use a private, runtime-specific `/tmp/im-idb-<uid>-<identity>` registry, sockets, logs and Python bytecode cache. This prevents IDB from reusing an unrelated companion registered in `/tmp/idb`, keeps Unix socket paths within macOS limits, and avoids recompiling the CLI on every operation. Existing external IDB processes and their registry are left intact. Cache and socket files may be recreated after reboot.

Command payloads and IDB CLI arguments are supplied over stdin, including text input. Field values do not appear in the automation helper or IDB process command lines.

## Sessions and manual control

macOS `fcntl.flock` protects the whole logical operation, including resolve, tap and verification. All real iPhones use a single host lock because the current Appium ports and state are single-device resources. Contention returns `DEVICE_BUSY` without queuing a delayed tap.

Choose **View > Watch agent (read-only)** to switch between manual input and viewing while the mirror stays connected. The same video view and stream remain alive; the Simulator and app are not restarted. Switching to manual first acquires the device reservation, then enables screen input. Switching to Watch agent blocks input and cancels unsent gestures before releasing the reservation. The preference is saved across restarts; `IPHONE_MIRROR_VIEWER_READ_ONLY=1` can select the initial mode.

Touching the screen in Watch agent mode shows a dialog explaining the mode and the View-menu switch, with a **Switch to manual** shortcut. This dialog is triggered by the user's touch; it is never an approval requirement for the agent. Home, Shake and shutdown controls are disabled in view-only mode; screenshots remain available.

When an authorized MCP action needs control, a compatible manual viewer switches to Watch agent **automatically, without asking the user**. The first driver attempt rejects the action before dispatch with `VIEWER_HANDOFF_REQUIRED`; the MCP controller requests a handoff through the Mac reservation file and waits up to 15 seconds. The desktop acknowledges that its input gate is active, drains already-dispatched real-iPhone requests, and releases its own token. Only then does MCP send the device action. Unknown outcomes are never replayed. Read-only MCP tools do not require takeover.

A bounded SSH watcher handles this protocol across computers without a public port or Mac login agent. A missing or outdated viewer cannot acknowledge takeover, so control remains blocked with `DEVICE_BUSY`. Update the desktop viewer and restart the MCP client after installing the update. Switching back to manual during an active MCP operation fails safely until that operation finishes. Shared simultaneous control is not implemented.

SimBeam's input protocol does not acknowledge completion of individual gestures. The input gate blocks future input and cancels gestures that have not been sent; a gesture already dispatched can still finish. There is no automatic replay of it.

A crash or SSH failure during release can leave a viewer reservation. It fails closed rather than guessing that manual control stopped. Close every viewer for that device, then explicitly recover:

```powershell
node app/automation/recover-viewer.cjs mac DEVICE_ID --viewer-is-closed
```

Real iPhone setup uses the existing Appium/WDA tools. `ios_start_session` explicitly reuses a healthy matching session or starts one using the existing signing path. It never installs tooling silently. A different device in `current-session.json` returns `SESSION_CONFLICT`. Desktop disconnect/exit closes its viewer and tunnels while preserving the Appium session. Session setup cancellation can still stop an in-progress setup. There is no multi-iPhone guarantee, implicit device switching, or automatic replay after disconnect.

Allow up to 12 minutes in your MCP client's tool timeout for explicit real-device session startup. Ordinary device calls have bounded deadlines of at most two minutes.

## Automatic Simulator runtime

The app ships `vendor/idb/simulator-runtime-x86_64.tar.gz`: a prebuilt native companion, IDB CLI built from the same pinned source, portable Python 3.14.10, dependencies and licenses. `vendor/idb/catalog.json` pins its size, archive/manifest hashes and qualified environment. The current bundle supports **Intel x86_64, macOS 15.8.1, Xcode 26.3 build 17C529**. Apple Silicon and other OS/Xcode combinations require a separately qualified bundle.

On desktop Simulator setup, or the first MCP Simulator operation, the app checks the Mac environment and installed runtime. If needed it streams the bundled archive over trusted SSH, verifies every manifest file and symlink, checks both CLI and companion, then atomically activates `~/.local/share/iphone-mirror/idb/current`. A healthy installation is reused. Interrupted uploads are cleaned without activating a partial runtime. Damaged versions are retained under `.damaged-<uuid>` while a verified replacement is activated. No Homebrew, pip download, source checkout or native build runs on the target Mac.

SSH access and full Xcode must already be configured, with Apple’s first-run/license steps completed. The app does not bypass those prompts. Unsupported combinations report `UNSUPPORTED_RUNTIME` for Simulator automation; desktop mirroring and real-device Appium retain their existing setup paths.

`installers/mac-idb/build-runtime.py` is the maintainer packaging script. It consumes a fresh native build at the pinned IDB commit and the checksum-pinned Astral portable-Python archive, builds the CLI wheel, and produces the runtime plus catalog entry. The older `manifest.json` records the original experimental reference build; the shipped catalog is authoritative for automatic provisioning. Never replace the active runtime during an automation operation.

To disable automation, remove its MCP client entry or set host control false. Release viewer reservations before switching to an older app that does not participate in coordination.

## Persistent Simulator worker

Simulator MCP operations reuse a Python worker and IDB gRPC client over an SSH stdio channel. Screenshots, AX reads and hit tests, taps, swipes and selected-field text setting call the bundled IDB API directly. Other operations keep their existing implementation. There is no new listening port, package download, or Mac login service. The connection stays warm for five idle minutes and closes when the MCP client disconnects. Initial runtime verification and worker imports still make the first call slower.

The worker serializes operations, bounds request/response sizes, resets outcome state for each request, and retains device locking, viewer handoff, hit testing, redaction and deadlines. A timeout or broken channel never replays an action. A subsequent independent request may open a fresh channel. Physical iPhones and the long-poll viewer watcher retain their existing command path.

Run the read-only paired benchmark against an already-running Simulator, keeping its screen unchanged:

```powershell
node scripts/benchmark-simulator.cjs CONFIGURED_HOST_ID SIMULATOR_UUID
```

It alternates the original CLI path and the worker, checks accessibility-content parity, and writes timing results to `release/performance/worker-benchmark.json`. See [the worker performance report](worker-performance-2026-10-29.md) for the measured comparison and limits.

## Verification

```powershell
npm test
$env:MIRROR_TEST_HOST = 'SSH_RESOURCE_MANAGER_HOST_UUID'
$env:MIRROR_TEST_DEVICE = 'BOOTED_SIMULATOR_UUID'
npm run test:live
node tests/live-provision.cjs
node tests/live-viewer-handoff.cjs
node tests/live-coordination.cjs
npm run dist -- --publish never
```

The live suite terminates/relaunches **only** `com.evaluation.TestFixture` and exercises its five flows. Build/install that fixture first using the existing `idb-evaluation/test-fixture` project. Integration tests are opt-in; ordinary CI uses no Mac. See `automation-validation.md` for measured evidence and outstanding gates.
