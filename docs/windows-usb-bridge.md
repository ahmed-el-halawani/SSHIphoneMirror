# Windows USB iPhone bridge — experimental

Connect an iPhone to Windows and make its developer connection available to a remote Mac over the app's existing SSH configuration. Windows and the Mac can be on different networks. The Mac helper runs under the SSH user and needs no USB kernel extension or administrator installation.

## Run

1. Install Apple Mobile Device Support on Windows. On the development PC, version 19.4.0.10 was installed with `winget install --id Apple.AppleMobileDeviceSupport --source winget`. It provides Apple's USB service; the Store Apple Devices app alone did not start that service in our test.
2. Keep the existing VPN and SSH connection available. Save the Mac in SSH Resource Manager.
3. Connect the iPhone, unlock it, accept Trust if asked, and enable Developer Mode. The current prototype also needs the Apple USB Ethernet adapter and a reachable developer endpoint on it; Personal Hotspot/USB tethering may be needed. A CoreDeviceProxy-only device without that adapter is not supported yet.
4. In iPhone Mirror's connection settings, enable **Share USB iPhones with this Mac**, then connect to the Mac. The preference is remembered. Sharing starts with that Mac connection, follows Mac changes, and stops when disabled or when the app quits. The Windows helper requires `uv` and downloads the pinned device library on first use. It is unpacked beside the packaged app so Python can read it.
5. With more than one saved Mac or connected phone, select them explicitly:

   ```powershell
   node scripts/usb-mac-bridge.cjs --host YOUR_SAVED_HOST_ID --udid YOUR_PHONE_UDID
   ```

6. Refresh the device list and choose the real iPhone. Xcode sees the bridged transport as a network connection. USB sharing does not automatically open a viewer or boot a simulator.

For a standalone source-checkout session, `Start-USB-Bridge.cmd` remains available. Keep it running; Ctrl+C stops its owned connection, relays, and Bonjour advertisement. Do not run the standalone bridge and app-managed sharing against the same Mac simultaneously. Neither path installs a Windows startup service.

## First-time setup and limits

- Each phone must trust Windows and have a valid pairing with the intended Mac. New Mac–phone pairing still needs Apple's approval flow; the bridge does not create or transfer that trust.
- The bundled WDA profile covers only its registered phone. Another phone needs an appropriately provisioned WDA package before the existing viewer can control it.
- This prototype forwards TCP developer traffic. It does not forward arbitrary USB devices, UDP, or the phone's internet connection.
- The Mac's default interface needs IPv4. Relays bind that address but reject clients whose source is not the Mac itself. The Windows side opens connections only to the verified phone's USB Ethernet address, developer ports 49152–65535, and that phone's specifically advertised MobileDevice service port. All bridge traffic between computers travels inside SSH.
- No pairing private keys are copied to the Mac or written to this repository. Discovery checks the TCP endpoint against the USB phone using the existing Windows pairing record. Discovery metadata is sent through the authenticated SSH channel.
- Verified Bonjour metadata is cached per phone under `%USERPROFILE%/.iphone-mirror/usb-bridge/`. Reconnection can reuse it when a sleeping phone stops advertising; the endpoint's device identity is verified again before use. The active connection monitor checks USB presence rather than tearing down a healthy tunnel when Bonjour is briefly unavailable.
- The direct native-screen experiment failed on the current phone: its developer services did not expose `com.apple.coredevice.displayservice`. That viewer path is not shipped here.

## Validation on 10 November 2026

Windows identified the USB iPhone and opened its CoreDeviceProxy tunnel. The custom TCP/Bonjour bridge then made the phone **available (paired)** on the remote Intel Mac running macOS 15.8.1 / Xcode 26.3. `devicectl device info details` succeeded and reported `transportType: localNetwork`, `tunnelTransportProtocol: tcp`, and an active CoreDevice tunnel.

On the unlocked phone, Xcode launched the signed WDA runner through the bridge. Appium attached with an explicit WDA URL and reported 440×956 point screen dimensions. A screenshot transferred to Windows (2,044,436 bytes) and was visually inspected; Home also succeeded. The screenshot was slow enough to exceed the original 30-second read deadline, so desktop screenshot requests now allow 90 seconds.

Appium's legacy device enumeration did not list the phone even though `xctrace` did. Shared real-device startup now falls back to `xcodebuild test-without-building` and an explicit WDA URL only after that specific, pre-launch discovery failure on a network device. Other failures are not retried. The existing private MJPEG relay owns video forwarding in this fallback. Owned native-runner processes are included in cancellation and replacement cleanup.

The integrated startup subsequently passed Home, swipe, and keyboard commands. An MJPEG frame (280,621 bytes) transferred through the existing private video relay and was visually inspected: the typed `usb` text was visible on the phone. Home was sent again after the test. This verifies a real video frame and input, not sustained frame rate or latency.

The packaged Windows app was launched with an isolated test profile. Its USB sharing option was enabled, it connected to the saved Mac, and the activity log confirmed phone sharing and both CoreDevice/MobileDevice listeners. Disabling the option completed successfully; the isolated app then exited. The packaged Python helper was present outside app.asar and ran successfully through uv.

Physical cable replug, VPN interruption, a second phone, and sustained video performance remain unverified. The current phone's USB Ethernet endpoint and existing Mac pairing are prerequisites of the tested path.

Automated tests cover USB selection, ambiguous devices, device compatibility, destination/port limits (including the observed MobileDevice port), the socket-close race, and the WDA fallback's refusal to retry unrelated/unknown failures.
