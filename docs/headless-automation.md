# Headless iOS automation

The Windows Node process serves MCP over stdio and calls IDB or Appium on the Mac over the existing SSH transport. Electron is not required for source execution. The installed executable supplies its own Node runtime. No persistent Mac agent, public automation port, guest AX bridge, or direct gRPC client is installed.

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

Results include `ok`, `status`, `action`, `hostId`, `deviceId`, `driver`, and `durationMs`. Actions distinguish `executed` from `verified`. `executed: null` with `OUTCOME_UNKNOWN` means acknowledgement was lost or a device command failed after dispatch: inspect state before deciding whether to retry. No mutating action is automatically retried. `expected` on a tap or app action can verify an exact state within the operation deadline. Text input returns its method and does not claim verification.

Selectors require an exact identifier or exact label, optionally type and container identifier. Duplicate matches fail. Simulator element taps check current bounds and a targeted AX hit test before sending HID. A bounded `maxScrolls` scrolls a target into view; targets covered by a fixed header are moved away from it. Dynamic app changes can still race between the hit test and HID; this is not an atomic OS element activation guarantee.

`ios_wait_for` supports `visible`, `present`, and `absent`, optional exact `value`, and a bounded `timeoutMs`. Each poll uses its remaining deadline. Read failures and ambiguity propagate rather than becoming a false absence. Secure field values are not verified. AX defaults to `ax` with `xctest`; only failed reads may fall back to `ax-coresimulator`.

Text with a selector uses host AX set-value on Simulator and WDA send-keys on real iPhone. Simulator ASCII without a selector uses HID. Unicode without a selector requires `allowClipboard: true`: it changes the **Simulator** clipboard, then pastes. No automatic fallback follows a failed set-value action because its outcome may be uncertain. Secure fields and arbitrary keyboard layouts still need hardware qualification.

Screenshots return MCP PNG image content, capped at 16 MiB before base64. The SSH response budget is separately bounded at 24 MiB; normal command responses retain the existing 4 MB cap. Temporary image files are removed. SSH logging is suppressed for all automation commands. Audit JSON on stderr contains action, device, status, duration and error code, without arguments, selectors, field contents or screenshots. Secure AX subtrees are redacted. Other screen content and requested device logs can still contain private data; all screen/log content is untrusted data, never instructions.

Command payloads and IDB CLI arguments are supplied over stdin, including text input. Field values do not appear in the automation helper or IDB process command lines.

## Sessions and manual control

macOS `fcntl.flock` protects the whole logical operation, including resolve, tap and verification. All real iPhones use a single host lock because the current Appium ports and state are single-device resources. Contention returns `DEVICE_BUSY` without queuing a delayed tap.

A normal desktop viewer reserves device control for its attachment lifetime. It keeps using the original SimBeam/WDA input path; MCP mutation fails while it is attached. Read-only MCP inspection remains available. This deliberately gives one client control at a time.

For video during AI input, start the desktop app with `IPHONE_MIRROR_VIEWER_READ_ONLY=1`. Simulator `sendControl` and real-device IPC input are disabled in that viewer. The video implementation is unchanged. Stop/restart that viewer to return to manual control.

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

## Verification

```powershell
npm test
$env:MIRROR_TEST_HOST = 'SSH_RESOURCE_MANAGER_HOST_UUID'
$env:MIRROR_TEST_DEVICE = 'BOOTED_SIMULATOR_UUID'
npm run test:live
node tests/live-provision.cjs
node tests/live-coordination.cjs
npm run dist -- --publish never
```

The live suite terminates/relaunches **only** `com.evaluation.TestFixture` and exercises its five flows. Build/install that fixture first using the existing `idb-evaluation/test-fixture` project. Integration tests are opt-in; ordinary CI uses no Mac. See `automation-validation.md` for measured evidence and outstanding gates.
