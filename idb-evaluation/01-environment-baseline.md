# Phase 1: Environment and Baseline Report

## Executive Summary
This document establishes the verified hardware, operating system, developer toolchain, device availability, network transport, and baseline automation state for evaluating Facebook IDB against the existing `SSHIphoneMirror` stack.

---

## 1. Host Architecture & Operating System

| Property | Value | Verification Method |
|---|---|---|
| **Host Name** | `ahmeds-MacBook-Pro.local` | `uname -a` |
| **CPU Architecture** | `x86_64` (Intel 64-bit) | `uname -m` |
| **CPU Model** | Intel(R) Core(TM) i5-8365U CPU @ 1.60GHz | `sysctl -n machdep.cpu.brand_string` |
| **Logical Cores** | 8 | `sysctl -n hw.ncpu` |
| **Physical Memory (RAM)** | 16.00 GB (17,179,869,184 bytes) | `sysctl -n hw.memsize` |
| **Disk Space** | 931 GiB APFS volume, 777 GiB available (2% used) | `df -h /` |
| **macOS Product Name** | macOS | `sw_vers -productName` |
| **macOS Version** | 15.8.1 | `sw_vers -productVersion` |
| **macOS Build** | 24H32 | `sw_vers -buildVersion` |
| **Darwin Kernel** | Darwin Kernel Version 24.6.0 (RELEASE_X86_64) | `uname -v` |

---

## 2. Developer Toolchain & Dependencies

| Tool / Dependency | Installed Version | Path | Status |
|---|---|---|---|
| **Xcode** | Xcode 26.3 (Build 17C529) | `/Applications/Xcode.app/Contents/Developer` | Active developer dir |
| **Swift Compiler** | Swift 6.2.4 (swiftlang-6.2.4.1.4 clang-1700.6.4.2) | Target: `x86_64-apple-macosx15.0` | Functional |
| **CoreSimulator simctl** | Part of Xcode 26.3 | `/Applications/Xcode.app/Contents/Developer/usr/bin/simctl` | Functional |
| **CoreDevice devicectl** | Part of Xcode 26.3 | `/Library/Developer/CommandLineTools/usr/bin/devicectl` | Functional |
| **macOS Python (System)** | Python 3.9.6 | `/usr/bin/python3` | Functional |
| **MacPorts Python** | Python 3.14.9 | `/opt/local/bin/python3` | Functional |
| **Pip** | pip 21.2.4 | `/usr/bin/pip3` | Functional |
| **Node.js (Remote Mac)** | v24.22.1 | `/Users/ahmedelhalawany/Documents/Codex/developer-tools/node/bin/node` | Functional |
| **npm (Remote Mac)** | 11.19.1 | `/Users/ahmedelhalawany/Documents/Codex/developer-tools/node/bin/npm` | Functional |
| **Node.js (Local Host)** | v25.2.1 | Local Windows host | Functional |
| **Git (Remote Mac)** | 2.50.1 (Apple Git-155) | `/usr/bin/git` | Functional |
| **MacPorts** | 2.12.7 | `/opt/local/bin/port` | Functional |
| **Homebrew** | Not installed | N/A | Missing (ARM64 brew bottles unavailable) |
| **XcodeGen** | Not installed in default PATH | N/A | Requires source build or binary drop |
| **Protobuf / protoc** | Not installed in system PATH | N/A | To be verified during Phase 2 |
| **SimBeam Daemon (`simbeamd`)** | 0.23.0 (x86_64 Mach-O) | `/Users/ahmedelhalawany/.local/bin/simbeamd` | Active background daemon |
| **SimBeam Control (`simbeam-control`)** | Protocol 3 (Universal x86_64 + arm64) | `/Users/ahmedelhalawany/.local/bin/simbeam-control` | Functional |
| **AXe CLI** | 0.x (x86_64) | `/Users/ahmedelhalawany/Documents/Codex/developer-tools/axe/axe` | Functional |
| **Appium** | Not installed globally in default PATH | N/A | Real device uses WDA tunnel |

---

## 3. Discovered iOS Simulator Runtimes and Devices

### Available Runtimes
- **iOS 26.3** (`26.3.1 - 23D8133`) — Identifier: `com.apple.CoreSimulator.SimRuntime.iOS-26-3`

### Booted Test Target
- **UDID**: `8AA89128-E540-44BB-82FD-43999DDC6838`
- **Device Type**: `iPhone 16e`
- **State**: `Booted`
- **Framebuffer Resolution**: `1170 x 2532` @ 8-bit/color RGBA

### Other Configured Simulator Devices (Shutdown)
- `iPhone 16e` (`DC5D15E7-ABA5-417A-863B-D67C3C2E4B7B`)
- `iPhone 17` (`326F7AB5-4F50-4A8B-BA7B-7E618E666902`, `3F1BDF2E-804A-47CD-AACC-55CABC26703E`)
- `iPhone 17 Pro` (`0D0A7A84-BE10-4D2D-9186-E20BB14D3AF0`, `BCA7F047-A5DD-4C66-A17E-D7483EEEF249`)
- `iPhone 17 Pro Max` (`7132193C-6E44-41C7-AE18-4D9BCA84C8CD`, `8036FDAA-3947-465A-910B-F9485B22029B`)
- `iPhone Air` (`2A91F909-D95F-4B96-9C2F-EDC2F98B25FC`, `294722A0-F307-4803-9C2F-1104932DF9ED`)
- `iPad Pro 13-inch (M5)`, `iPad Pro 11-inch (M5)`, `iPad mini (A17 Pro)`, `iPad (A16)`, `iPad Air 13-inch (M3)`, `iPad Air 11-inch (M3)`

### Discovered Physical Hardware
- **Model**: `iPhone 16 Pro Max (iPhone17,2)`
- **Name**: `Ahmed’s iPhone`
- **UDID**: `00008140-001645D80A10801C` (CoreDevice Identifier: `5D59F43E-B85F-5C0E-9842-B0CC97C1DE89`)
- **Transport**: `Wi-Fi` (Tunnel pairing state: `paired`, `available`)
- **OS Version**: iOS `27.0`

---

## 4. SSH & Security Configuration

- **Protocol**: SSH-2.0 via OpenSSH
- **Endpoint**: `ahmedelhalawany@192.168.0.145:22`
- **Authentication**: Dedicated ED25519 public key authentication (`361c730b-9d5c-43ed-9c59-d628329ca7e9_ed25519`)
- **Host Key Fingerprint**: `SHA256:oa8rhSHdxnZeK1uDDNdy2SOOSmywTnom6lqmcZq1d3E`
- **Environment Management**: Registry managed through `ssh-resource-manager` MCP.
- **Security Invariant**: No credentials, private keys, or passwords exposed in logs or test artifacts.

---

## 5. Existing SSHIphoneMirror Application Baseline

- **Repository Git Commit**: `020d71787a6cf631bf27859dc2ab1bd58483ee9a`
- **Working Tree State**: Clean (`git status`)
- **Existing Test Suite Execution**:
  - Command: `npm test` (`node --test tests/*.test.cjs`)
  - Total Tests: 26
  - Passed: 26 (100%)
  - Failed: 0
  - Duration: ~520 ms

### Baseline Mechanism Summary
1. **Device Discovery**:
   - Remote script (`remote.cjs`) queries `simctl` JSON for simulators and `devicectl` for physical iPhones.
2. **Simulator Streaming & Control**:
   - `simbeamd` (running at `127.0.0.1:18080`, control socket `127.0.0.1:50447`) streams H.264 video via WebRTC.
   - User inputs (taps, swipes, keypresses, hardware buttons) are serialized over a WebRTC DataChannel (`control`) to `simbeamd`.
3. **Screenshots**:
   - Captured client-side from the WebRTC video element canvas in Electron (`viewer.webContents.executeJavaScript`).
4. **Real Device Automation**:
   - Appium XCUITest / WebDriverAgent running on the Mac connected over loopback port-forwarded SSH tunnels.
