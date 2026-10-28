# SimBeam reference viewer and Mac installer

The files in `vendor/simbeam/` come from https://github.com/kei-sidorov/simbeam, tag v0.23.0.
Copyright and license notices are retained in `vendor/simbeam/LICENSE` (Apache License 2.0).

`client.html` and its extracted `client.js` are modified for iPhone Mirror: desktop styling, automatic enrollment following an explicit connection action, direct attachment to the simulator selected and booted over SSH, connection status, and a restrictive network policy. Control messages use a reliable ordered channel. Unused subscription emulation is removed. The WebRTC authentication, answer signature verification, and device input protocol remain from the upstream reference implementation.

`install.sh` is the unmodified upstream installer. It downloads official SimBeam and simbeam-control releases and checks their SHA-256 release manifests. It does not install a launch-at-login service in this app's setup flow.

The separate `simbeam-web` frontend is not copied or distributed. The default public signaling service is still used. iPhone Mirror is an independent desktop wrapper and is not an official SimBeam product.

## Real-device tools

Real-device support installs Appium and its XCUITest driver on the user's Mac from the npm registry. WebDriverAgent is supplied by the driver and built/signed locally using Xcode. These tools retain their upstream licenses in their installed packages; their source and binaries are not bundled into this Windows app. Projects: https://github.com/appium/appium and https://github.com/appium/appium-xcuitest-driver . Real-device streaming uses SSH rather than the SimBeam signaling service.

The real-device installer applies a narrowly checked IPv6 URL-normalization fix to the pinned Appium/WDA build files on the Mac. Modified files retain upstream notices and receive an iPhone Mirror modification marker. The fix permits Mac-private CoreDevice tunnel endpoints without exposing a plain LAN relay.

## IDB compatibility patch

`installers/mac-idb/patches/intel-xcode26.patch` contains modifications to Meta's IDB source at commit `1387b360a9dcad34573cb1d9f277e5a0eacfd804`. IDB is MIT licensed; its license and copyright notice are retained in `installers/mac-idb/LICENSE`. The bundled Simulator archive contains the patched IDB native companion and CLI built from that commit, with its MIT license. Apple private frameworks are supplied by the target Mac/Xcode and are not redistributed. The maintainer build workflow preserves upstream notices. Upstream: https://github.com/facebook/idb .

The MCP SDK, Zod and SSH dependencies retain their upstream license files in their packaged npm directories.

## Portable Simulator runtime

`vendor/idb/simulator-runtime-x86_64.tar.gz` includes Astral python-build-standalone CPython 3.14.10 (20261026 Intel macOS stripped install-only distribution), checksum pinned in `installers/mac-idb/build-runtime.py`. Source: https://github.com/astral-sh/python-build-standalone . Python and bundled component notices are retained inside its `python/` tree and installed package metadata. IDB, gRPC, protobuf and Python dependency licenses remain in the archive. Archive and manifest checksums, source commit and qualified environment are recorded in `vendor/idb/catalog.json` and the archive's `compatibility.json`.
