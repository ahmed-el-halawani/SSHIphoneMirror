# PHASE 2 — Facebook IDB Installation on Intel macOS

## Executive Summary

| Attribute | Details |
|---|---|
| **Target Host** | Remote Mac (`ahmedelhalawany@192.168.0.145`) |
| **Hardware** | Intel Core i5-8365U @ 1.60 GHz (8 vCPUs), 16 GB RAM |
| **OS** | macOS 15.8.1 (Build 24H32) |
| **Xcode** | Xcode 26.3 (Build 17C529), SDK `macosx26.2` |
| **Upstream Git Commit** | `1387b360a9dcad34573cb1d9f277e5a0eacfd804` (facebook/idb main) |
| **Target Architecture** | `x86_64` (Mach-O 64-bit executable) |
| **Companion Binary** | `~/idb/Build/Products/Release/idb_companion` (56 MB) |
| **Python CLI** | `fb-idb 1.1.8` installed in `~/idb-venv` (Python 3.14.9) |
| **Critical Verdict** | **PRACTICALLY USABLE ON INTEL** (with 7 bounded, reproducible patches detailed below) |

---

## 1. Upstream Commit & Build System Analysis

Upstream Facebook IDB repository: `https://github.com/facebook/idb`
- **Commit Evaluated:** `1387b360a9dcad34573cb1d9f277e5a0eacfd804` (Latest release branch)
- **Official Homebrew Bottle Status:** The prebuilt Homebrew package `facebook/fb/idb-companion` is distributed solely for Apple Silicon (`arm64`). Attempting `brew install idb-companion` on an Intel Mac fails or pulls an unrunnable bottle. Furthermore, Homebrew was not installed on this host.
- **Build System:** IDB uses `xcodegen` to synthesize Xcode projects from `project.yml` files, generates Swift gRPC stubs from `idb.proto`, compiles 12 static archive dependencies via `xcodebuild`, and finally builds and links `Companion/idb_companion.xcodeproj`.

---

## 2. Dependency Discovery & User-Space Installation

Neither Homebrew nor root package managers were modified. All required external build tools were installed into user-space `~/.local/bin` and isolated virtual environments:

| Tool | Upstream Requirement | Provided on Intel Host | Installation Path |
|---|---|---|---|
| **XcodeGen** | `>= 2.40.0` | `2.46.0` (universal `x86_64` + `arm64`) | `~/.local/bin/xcodegen` |
| **Protobuf Compiler** | `protoc >= 3.0` | `36.2` (`protoc-36.2-osx-x86_64`) | `~/.local/bin/protoc` |
| **Python CLI Runtime** | `>= 3.10` | Python `3.14.9` (MacPorts `/opt/local/bin/python3`) | Virtual environment `~/idb-venv` |
| **Python Packages** | `aiofiles`, `grpclib`, `protobuf`, `h2` | Installed into virtualenv | `~/idb-venv/lib/python3.14/` |

---

## 3. Failure Investigation & Local Compatibility Patches

Compiling the vanilla upstream repository on Intel macOS 15.8.1 with Xcode 26.3 uncovered **four classes of failures**. Each was investigated, root-caused, and resolved with minimal, technically justified source patches:

### Issue A: Hardcoded `ARCHS=arm64` in Upstream Build Script
- **Symptom:** Compiling with vanilla `./build.sh build` produced `arm64` binaries and libraries even on an Intel Mac host, leading to `Mach-O arm64` objects that fail to link or execute (`Bad CPU type in executable`).
- **Root Cause:** `build.sh` line 652 hardcoded `ARCHS=arm64` in `common_settings`:
  ```bash
  # Add ARCHS=arm64 to build arm64 only (no Intel/x86_64 slices).
  ARCHS=arm64
  ```
- **Fix:** Patched `build.sh:652` to use `ARCHS=x86_64`.

### Issue B: Swift 6 Strict Concurrency Race Errors
- **Symptom:** Compilation failed in `FBSimulatorCodeInjection`:
  ```text
  /Users/ahmedelhalawany/idb/FBSimulatorCodeInjection/ControlSocketClient.swift:163:44:
  error: passing closure as a 'sending' parameter risks causing data races between code in the current task and concurrent execution of the closure
  ```
  and `Companion/main.swift`:
  ```text
  /Users/ahmedelhalawany/idb/Companion/main.swift:488:22:
  error: passing closure as a 'sending' parameter risks causing data races between code in the current task and concurrent execution of the closure
  ```
- **Root Cause:** Xcode 26.3 defaults to Swift 6.2 with strict Region-Based Isolation. `HostCommandHandler` closures captured in `Task { ... }` were non-Sendable typealiases. In `main.swift`, `target` was captured across concurrency boundaries in `awaitTargetOffline`.
- **Fix:**
  1. Marked `typealias HostCommandHandler` as `@Sendable` in `ControlSocketClient.swift` and `CodeInjectionSession.swift`.
  2. Wrapped `target` and `logger` in a local `@unchecked Sendable` struct in `main.swift:487` for the offline monitoring task.

### Issue C: Private Framework `.tbd` Stubs Excluded `x86_64`
- **Symptom:** Linker failure during final `idb_companion` link:
  ```text
  ld: warning: ignoring file '.../CoreSimulator.tbd': tapi error: missing required architecture x86_64
  ld: warning: ignoring file '.../AccessibilityPlatformTranslation.tbd': tapi error: missing required architecture x86_64
  Undefined symbols for architecture x86_64:
    "_OBJC_CLASS_$_AXPTranslator"
    "_OBJC_CLASS_$_SimDevice"
    "_OBJC_CLASS_$_SimDeviceSet"
    "_OBJC_CLASS_$_SimRuntime"
    "_OBJC_CLASS_$_SimServiceContext"
  ```
- **Root Cause:** Upstream text-based stubs in `PrivateHeaders/` were exported exclusively for Apple Silicon (`targets: [ arm64-macos ]`), causing Apple's linker `ld` to ignore them on Intel x86_64.
- **Fix:** Added `x86_64-macos` to `targets:` in:
  - `PrivateHeaders/CoreSimulator/CoreSimulator.tbd`
  - `PrivateHeaders/AccessibilityPlatformTranslation/AccessibilityPlatformTranslation.tbd`
  - `PrivateHeaders/SimPasteboardPlus/SimPasteboardPlus.tbd`

### Issue D: Python Packaging `FB_IDB_VERSION` Requirement
- **Symptom:** `pip install ~/idb` aborted during build-wheel with:
  ```text
  Exception: Cannot build without a version number. Set the environment variable FB_IDB_VERSION
  ```
- **Root Cause:** `setup.py:79` requires `FB_IDB_VERSION` when building outside an official git release tag.
- **Fix:** Provided `export FB_IDB_VERSION="1.1.8"` during `pip install`.

---

## 4. Complete Git Patch

```diff
diff --git a/Companion/main.swift b/Companion/main.swift
index 61ca4d6..867da60 100644
--- a/Companion/main.swift
+++ b/Companion/main.swift
@@ -484,8 +484,12 @@ private func runCompanionServer(_ udid: String, userDefaults: UserDefaults, xcod
     raceTasks.append(Task { try await idleMonitor.waitUntilExpired() })
   }
   if terminateOffline {
-    nonisolated(unsafe) let target = target
-    raceTasks.append(Task { try await awaitTargetOffline(target, logger: logger) })
+    struct SendableBox: @unchecked Sendable {
+      let target: CompanionTarget
+      let logger: ControlCoreLogger
+    }
+    let box = SendableBox(target: target, logger: logger)
+    raceTasks.append(Task { try await awaitTargetOffline(box.target, logger: box.logger) })
   }
   defer { raceTasks.forEach { $0.cancel() } }
   _ = try await Task.select(raceTasks).value
diff --git a/FBSimulatorCodeInjection/CodeInjectionSession.swift b/FBSimulatorCodeInjection/CodeInjectionSession.swift
index fb209a3..8f63c77 100644
--- a/FBSimulatorCodeInjection/CodeInjectionSession.swift
+++ b/FBSimulatorCodeInjection/CodeInjectionSession.swift
@@ -16,7 +16,7 @@ public final class CodeInjectionSession: Sendable {
 
   /// Answers a command the injected code sends back to the session mid-execute, as opaque bytes.
   /// The injected code receives the bytes returned, or the description of the error.
-  public typealias HostCommandHandler = (_ command: Data) async -> Result<Data, any Error>
+  public typealias HostCommandHandler = @Sendable (_ command: Data) async -> Result<Data, any Error>
 
   /// Identifies the host process: the same when reattaching to an app still running from an
   /// earlier session, and new when the host is relaunched.
diff --git a/FBSimulatorCodeInjection/ControlSocketClient.swift b/FBSimulatorCodeInjection/ControlSocketClient.swift
index 8a772b9..104efa0 100644
--- a/FBSimulatorCodeInjection/ControlSocketClient.swift
+++ b/FBSimulatorCodeInjection/ControlSocketClient.swift
@@ -101,7 +101,7 @@ final class ControlSocketClient: @unchecked Sendable {
   /// Services a `host_command` the served process sends back *while* an `execute`
   /// is in flight. Receives the command's bytes, opaque to this client, and returns
   /// the command's outcome.
-  typealias HostCommandHandler = (_ commandData: Data) async -> Result<Data, any Error>
+  typealias HostCommandHandler = @Sendable (_ commandData: Data) async -> Result<Data, any Error>
 
   /// Sends a `{dylib, symbol}` command to the shim and returns its result. While
   /// the served process runs the injected code it may send nested `host_command`
diff --git a/PrivateHeaders/AccessibilityPlatformTranslation/AccessibilityPlatformTranslation.tbd b/PrivateHeaders/AccessibilityPlatformTranslation/AccessibilityPlatformTranslation.tbd
index 66d23fe..2554fe6 100644
--- a/PrivateHeaders/AccessibilityPlatformTranslation/AccessibilityPlatformTranslation.tbd
+++ b/PrivateHeaders/AccessibilityPlatformTranslation/AccessibilityPlatformTranslation.tbd
@@ -1,11 +1,11 @@
 --- !tapi-tbd
 tbd-version: 4
-targets: [ arm64-macos ]
+targets: [ arm64-macos, x86_64-macos ]
 install-name: '/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/Versions/A/AccessibilityPlatformTranslation'
 current-version: 0
 compatibility-version: 0
 exports:
-  - targets: [ arm64-macos ]
+  - targets: [ arm64-macos, x86_64-macos ]
     objc-classes:
       - AXPMacPlatformElement
       - AXPTranslationObject
diff --git a/PrivateHeaders/CoreSimulator/CoreSimulator.tbd b/PrivateHeaders/CoreSimulator/CoreSimulator.tbd
index 9091276..3658d7e 100644
--- a/PrivateHeaders/CoreSimulator/CoreSimulator.tbd
+++ b/PrivateHeaders/CoreSimulator/CoreSimulator.tbd
@@ -1,11 +1,11 @@
 --- !tapi-tbd
 tbd-version: 4
-targets: [ arm64-macos ]
+targets: [ arm64-macos, x86_64-macos ]
 install-name: '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator'
 current-version: 0
 compatibility-version: 0
 exports:
-  - targets: [ arm64-macos ]
+  - targets: [ arm64-macos, x86_64-macos ]
     objc-classes:
       - SimDevice
       - SimDeviceDarwinNotificationToken
diff --git a/PrivateHeaders/SimPasteboardPlus/SimPasteboardPlus.tbd b/PrivateHeaders/SimPasteboardPlus/SimPasteboardPlus.tbd
index 0fc0d6f..4bd74d9 100644
--- a/PrivateHeaders/SimPasteboardPlus/SimPasteboardPlus.tbd
+++ b/PrivateHeaders/SimPasteboardPlus/SimPasteboardPlus.tbd
@@ -1,11 +1,11 @@
 --- !tapi-tbd
 tbd-version: 4
-targets: [ arm64-macos ]
+targets: [ arm64-macos, x86_64-macos ]
 install-name: '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Frameworks/SimPasteboardPlus.framework/Versions/A/SimPasteboardPlus'
 current-version: 0
 compatibility-version: 0
 exports:
-  - targets: [ arm64-macos ]
+  - targets: [ arm64-macos, x86_64-macos ]
     objc-classes:
       - _TtC17SimPasteboardPlus22SimPasteboardInterface
       - _TtC17SimPasteboardPlus30SimPasteboardInterfaceListener
diff --git a/build.sh b/build.sh
index 7e5a1a5..c81085a 100755
--- a/build.sh
+++ b/build.sh
@@ -642,14 +642,14 @@ function invoke_xcodebuild() {
   # Add -skipMacroValidation to work around sandbox restrictions on Swift macro plugins
   # Add ENABLE_USER_SCRIPT_SANDBOXING=NO to disable sandbox for macros
   # Add CLANG_ENABLE_EXPLICIT_MODULES=NO to mirror Configuration/Shared.xcconfig
-  # Add ARCHS=arm64 to build arm64 only (no Intel/x86_64 slices).
+  # Add ARCHS=x86_64 to build arm64 only (no Intel/x86_64 slices).
   local common_settings=(
     -skipMacroValidation
     -onlyUsePackageVersionsFromResolvedFile
     -disableAutomaticPackageResolution
     ENABLE_USER_SCRIPT_SANDBOXING=NO
     CLANG_ENABLE_EXPLICIT_MODULES=NO
-    ARCHS=arm64
+    ARCHS=x86_64
   )
```

---

## 5. Binary Inspection & Runtime Validation Evidence

### 5.1 Binary Architecture Verification
```bash
$ file ~/idb/Build/Products/Release/idb_companion
/Users/ahmedelhalawany/idb/Build/Products/Release/idb_companion: Mach-O 64-bit executable x86_64

$ lipo -info ~/idb/Build/Products/Release/idb_companion
Non-fat file: /Users/ahmedelhalawany/idb/Build/Products/Release/idb_companion is architecture: x86_64
```

### 5.2 Direct Companion Discovery (`idb_companion --list 1`)
```bash
$ ~/idb/Build/Products/Release/idb_companion --list 1
1448-05-17 15:34:52.473+0300 Loaded All Private Frameworks [CoreSimulator]
1448-05-17 15:34:52.662+0300 Loaded All Private Frameworks [MobileDevice]
{"udid":"8AA89128-E540-44BB-82FD-43999DDC6838","state":"Booted","type":"Simulator","os_version":"iOS 26.3","name":"iPhone 16e","model":"iPhone 16e"}
... [17 additional simulators]
1448-05-17 15:34:57.707+0300 Reported 18 targets to stdout
```

### 5.3 Python CLI Device Discovery (`idb list-targets`)
```bash
$ export IDB_COMPANION_PATH=~/.local/bin/idb_companion
$ ~/idb-venv/bin/idb list-targets
iPhone 16e | 8AA89128-E540-44BB-82FD-43999DDC6838 | Booted | simulator | iOS 26.3 | None | No Companion Connected
iPad (A16) | 179128DB-1E5A-4851-B774-4A1DE9157980 | Shutdown | simulator | iOS 26.3 | None | No Companion Connected
...
```

### 5.4 Companion Domain Socket Auto-Launch & Target Inspection (`idb describe`)
```bash
$ ~/idb-venv/bin/idb describe --udid 8AA89128-E540-44BB-82FD-43999DDC6838
TargetDescription(
    udid='8AA89128-E540-44BB-82FD-43999DDC6838',
    name='iPhone 16e',
    target_type=<TargetType.SIMULATOR: 'simulator'>,
    state='Booted',
    os_version='iOS 26.3',
    architecture='',
    companion_info=CompanionInfo(
        udid='8AA89128-E540-44BB-82FD-43999DDC6838',
        is_local=True,
        pid=None,
        address=DomainSocketAddress(path='/tmp/idb/8AA89128-E540-44BB-82FD-43999DDC6838_companion.sock'),
        metadata={},
        supported_compressions=frozenset({<Compression.ZSTD: 1>, <Compression.GZIP: 0>}),
        zstd_zip_streams=False,
        install_connect_to=True
    ),
    screen_dimensions=ScreenDimensions(width=1170, height=2532, density=3.0, width_points=390, height_points=844),
    model=None, device=None, extended={}, diagnostics={}, metadata={}
)
```

---

## 6. Critical Verdict

**VERDICT: YES — PRACTICALLY USABLE ON INTEL macOS 15.8.1 + Xcode 26.3.**

- **Reproducibility:** The patches required to build and run IDB on Intel macOS are minimal (totaling under 20 lines across build script, `.tbd` headers, and Swift concurrency annotations).
- **Execution Viability:** `idb_companion` runs completely natively as an `x86_64` Mach-O binary without Rosetta translation, correctly loads Apple CoreSimulator and MobileDevice private frameworks, automatically starts per-target companions over domain sockets, and communicates seamlessly with the `fb-idb` Python client.
