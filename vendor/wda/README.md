# Bundled WebDriverAgent

`WebDriverAgentRunner.ipa` is the existing development-signed WebDriverAgent 16.17.1 device build from the paired Mac's Xcode 26.3 output. It contains the standard `Payload/WebDriverAgentRunner-Runner.app` and a portable `WebDriverAgentRunner.xctestrun` launch description. The runner's original signature and nested XCTest dependencies are preserved. The launch description uses relative paths within this archive; the application sets the current private tunnel address and video port at startup.

`manifest.json` pins the complete archive's SHA-256 and records its signing team, registered device and provisioning expiry. This package covers the listed iPhone only. It is not a universally installable App Store IPA. No private signing key or keychain password is included.

The application streams the archive to the Mac, verifies its checksum and code signature, and caches the extracted package by checksum. It checks the embedded provisioning profile before stopping the existing Appium session. It installs the `.app` with `xcrun devicectl device install app` and launches it with Appium's `usePrebuiltWDA` and `useXctestrunFile` capabilities. Xcode executes `test-without-building`; it does not compile WDA. Full Xcode and on-device automation authorization remain required.

To replace this package, sign the existing runner and its nested test bundle with an appropriate valid development profile, retain the relative launch description, zip them in the same layout, and update the manifest's checksum and signing metadata. A different or renewed signing profile does not require rebuilding WDA source. Run `npm test` and `npm run dist -- --publish never` after replacing it.

The upstream BSD license is in `LICENSE`. Appium's supported launch modes are documented at https://github.com/appium/appium-xcuitest-driver/blob/master/docs/guides/run-preinstalled-wda.md . On iOS 27, the separate preinstalled/`devicectl` launch mode requires RemoteXPC; this package uses the supported XCTest launch mode instead.
