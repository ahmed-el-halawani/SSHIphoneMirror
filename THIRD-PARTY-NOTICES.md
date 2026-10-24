# SimBeam reference viewer and Mac installer

The files in `vendor/simbeam/` come from https://github.com/kei-sidorov/simbeam, tag v0.23.0.
Copyright and license notices are retained in `vendor/simbeam/LICENSE` (Apache License 2.0).

`client.html` and its extracted `client.js` are modified for iPhone Mirror: desktop styling, automatic enrollment following an explicit connection action, direct attachment to the simulator selected and booted over SSH, connection status, and a restrictive network policy. Control messages use a reliable ordered channel. Unused subscription emulation is removed. The WebRTC authentication, answer signature verification, and device input protocol remain from the upstream reference implementation.

`install.sh` is the unmodified upstream installer. It downloads official SimBeam and simbeam-control releases and checks their SHA-256 release manifests. It does not install a launch-at-login service in this app's setup flow.

The separate `simbeam-web` frontend is not copied or distributed. The default public signaling service is still used. iPhone Mirror is an independent desktop wrapper and is not an official SimBeam product.

## Real-device tools

Real-device support installs Appium and its XCUITest driver on the user's Mac from the npm registry. WebDriverAgent is supplied by the driver and built/signed locally using Xcode. These tools retain their upstream licenses in their installed packages; their source and binaries are not bundled into this Windows app. Projects: https://github.com/appium/appium and https://github.com/appium/appium-xcuitest-driver . Real-device streaming uses SSH rather than the SimBeam signaling service.
