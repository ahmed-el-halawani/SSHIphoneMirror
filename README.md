# iPhone Mirror — Electron desktop app

Open **Start-App.cmd**, or the packaged **release/win-unpacked/iPhone Mirror.exe**.

## Device selection and running simulators — version 0.3.1

Connecting to the Mac discovers devices and leaves **Choose device…** selected. It does not open or boot a simulator or attach a real phone. Select a device yourself to open its viewer.

The dropdown groups **Real iPhones**, **Running simulators**, and **Stopped simulators**. The currently attached device is marked **Viewing**; duplicate names include a short identifier. Switching between running simulators keeps the previous simulator running, so you can select it again later.

Use **Device > Shut down selected simulator**, or the matching button in connection settings, to power off only that simulator without erasing its data. Other simulators stay running. **Disconnect viewer** closes the stream; it leaves the simulator running.

The refresh icon beside the device selector reloads the list. The list also updates about every 15 seconds while idle, including changes made on the Mac. Refreshing preserves your selection and never opens a device.


## Real iPhone support — version 0.3

Connect your iPhone to the Mac by USB, trust the Mac, enable Developer Mode / UI automation, and keep it unlocked during setup. Connect the Mac in this app, then choose your phone under **Real iPhones** in the top device selector. Simulators remain in their own group.

The app installs its own Appium 3.8.0 and XCUITest driver 12.20.0 under `~/.local/share/iphone-mirror-tools/`. It finds the existing Apple Development identity/team, asks Xcode to manage provisioning, signs and installs WebDriverAgent, starts it, and opens SSH tunnels for screen streaming and controls. SSH Resource Manager's configured signing runner unlocks the keychain inside the signing session; credentials and private keys are not copied into the application. With manual SSH, the Mac's signing keychain must already be accessible to that SSH session; use the manager's signing mode for unattended unlock.

Full Xcode, a valid development account/identity, provisioning access, and Node.js 24+ on the Mac are prerequisites. macOS/iOS approvals and Apple account sign-in must be handled on their devices. Multiple different signing teams require a deliberate team choice; this MVP automatically selects only a unique team.

Real-device video uses an MJPEG screenshot stream, and commands use Appium/XCUITest over SSH. Appium on the Mac and WebDriverAgent on the phone bind to loopback; USB forwarding carries the phone connection. It does not use the public SimBeam broker. Tap, swipe, typing, Home, screenshots, reconnect, and switching back to simulators are supported. Shake is disabled for real phones. Input is serialized and mapped to the phone's current screen dimensions, including orientation. This testing connection can respond more slowly than simulator streaming.

Closing or disconnecting the real-phone viewer ends its Appium session and closes the SSH tunnel. The installed helper and the local Appium service remain on the Mac for later use. Logs are in `~/.local/share/iphone-mirror-tools/appium.log` with user-only permissions. Do not run multiple real-device sessions from this app on the same Mac; the first version owns one dedicated Appium instance there.

Verified on the connected iPhone 16 Pro Max running iOS 27.0: automatic signing/install/start, 440×956 point coordinates, screen stream through SSH, opening Settings by mouse, typing into its search field, swiping results, and returning Home. The simulator path also reconnected successfully. Fourteen automated tests cover input validation, point conversion, SSH authentication/forwarding, and simulator behavior.

Version 0.2 uses a narrow, dark simulator window inspired by the supplied viewer screenshots. Use **Attach simulator** to connect the imported Mac. The connection icon in the bottom toolbar opens SSH/MCP settings inside the same window; the activity icon opens the setup log. The top selector switches simulators, and the bottom toolbar provides Home, reconnect, PNG screenshot capture, Shake, connection settings, and activity. Edit / Device / View menus include disconnect, stop streaming, zoom, and always-on-top. Drag the top menu bar to move the window; resize its edges as needed.

The compact UI was checked with live simulator video, opening/closing its connection panel, and fitting the manual SSH form at the default 376×850 window size. The camera action saved a verified 584×1266 PNG (the current stream resolution). Ten automated tests pass, including compact viewer bounds. The 0.2.0 EXE and installer were rebuilt; bundled files were checked against the source.

The desktop app supports:

- **SSH Resource Manager:** imports Mac hosts through its real MCP stdio server, using the `ssh-resource-manager` entry in `%USERPROFILE%/.codex/config.toml` (or `$CODEX_HOME/config.toml`). It requests an OpenSSH connection recipe and lets the manager's askpass helper supply credentials. It does not read the manager's password database.
- **Manual SSH:** hostname/IP, port, username, password or private key/passphrase. Passwords stay in memory unless you check **Remember password**, which uses Electron safeStorage / Windows encryption. Verify a new Mac's SSH fingerprint against the Mac itself; a changed saved fingerprint is rejected.
- **Connect & set up:** checks macOS and full Xcode, installs missing SimBeam binaries from verified releases, prepares an iOS runtime/device if missing, boots an iPhone, starts the daemon, opens a one-time pairing window over SSH, and connects the bundled viewer automatically.
- **Simulator selection:** switch among available iPhone simulators, use the mouse and keyboard, and press Home or Shake.
- **Disconnect viewer:** closes this viewer without stopping the Mac service. **Stop on Mac:** also stops this experiment's daemon and keeps the simulator open. Closing the desktop app disconnects its viewer but leaves the Mac service available.

Full Xcode must already be installed and opened once on the Mac, with its license accepted. Apple ID sign-in, protected installers, permissions, or Windows Firewall prompts can require local action. The app explains a missing Xcode setup; it does not silently accept Apple licenses. A missing iOS runtime can require a multi-GB download via `xcodebuild -downloadPlatform iOS`.

The viewer is bundled from the Apache-licensed SimBeam v0.23.0 reference client. It runs in its own sandboxed Electron session with no Node integration or desktop preload. It retains Ed25519 pairing and signed WebRTC answer verification. The local app shell has a narrow IPC API; remote content has no access to SSH credentials. See **THIRD-PARTY-NOTICES.md** and **vendor/simbeam/LICENSE**.

The public `signal.simbeam.dev` broker still coordinates simulator connections. This is not fully offline or a video stream inside SSH. Same-network P2P is the target for this MVP; cross-network access may require a suitable VPN or relay. The polished `simbeam-web` frontend is not included.

## Development

```powershell
npm install
npm test
npm start
npm run pack
npm run dist
```

Connection metadata is stored in Electron's user data directory (`%APPDATA%/iPhone Mirror/connections.json`), separately from the source. SimBeam's viewer identity uses its separate persistent session. No password belongs in source control. The original PowerShell MVP remains available below.

## Desktop validation — 24 October 2026

- Electron 44.9.3, Windows x64. Both the unpacked EXE and NSIS installer were built successfully; the packaged EXE launches, imports the real Mac through MCP, and displays live simulator video.
- The desktop viewer connected to the existing Hackintosh's iPhone 16e and displayed Quran Coach. Home, opening Settings by mouse, and typing into Settings search were verified visually.
- Nine automated tests pass, including actual SSH password authentication against a local test SSH server and refusal of an untrusted host key. `npm audit` reports zero known vulnerabilities.
- The installed Mac helpers and Xcode were reused. The original MVP tested the upstream helper installer, but the full desktop provisioning flow has not been tested on a clean Mac or with a missing runtime. Manual SSH authentication was tested against the local server, not with a second real Mac. The NSIS installer was built but not run to install over your system.
- The application is unsigned and may need a Windows Firewall approval for direct WebRTC networking. Do not move only the unpacked EXE: keep its `resources/`, DLLs, and other sibling files together, or use the installer.

# تجربة PowerShell الأصلية

افتح `Start-Mirror.cmd` بالضغط مرتين. بيستخدم بيانات الماك المحفوظة في SSH Resource Manager؛ مفيش باسورد محفوظ في المشروع.

1. المتصفح الافتراضي هيفتح SimBeam.
2. اضغط **Pair this Mac**. رابط الاقتران صالح خمس دقائق؛ لو انتهى، افتح ملف التشغيل تاني.
3. اختار **iPhone 16e** اللي حالته Booted. تقدر تختار محاكي تاني، لكن أول إقلاع ممكن ياخد وقت.
4. جرّب الضغط بالماوس، والسحب، والكتابة. التوافق والأداء بيتقاسوا بالتجربة على الماك.

للمتصفحات اللي اتربطت بالفعل، افتح https://app.simbeam.dev/ واختار الماك. الربط محفوظ في نفس المتصفح والبروفايل؛ متصفح Codex والمتصفح الافتراضي ليهم ربط منفصل.

## الإيقاف والفحص

`Stop-Mirror.cmd` بيوقف عملية البث الخاصة بالتجربة. المحاكي يفضل مفتوح. مفيش تشغيل تلقائي بعد إعادة تشغيل الماك.

```powershell
.\Start-Mirror.ps1 -Action Check
.\Start-Mirror.ps1 -SelfTest
```

## اللي اتثبت على الماك

- `~/.local/bin/simbeamd` إصدار 0.23.0.
- `~/.local/bin/simbeam-control` إصدار 0.6.0؛ البروتوكول 3.
- التثبيت من إصدارات المشروع الرسمية على GitHub، مع التحقق من SHA-256.
- مفاتيح الربط في `~/.simbeam/`، وسجل التشغيل في `/tmp/iphonemirror-simbeam.log`.

التشغيل والإيقاف عبر SSH. تنسيق الاتصال عبر `signal.simbeam.dev`، والواجهة من `app.simbeam.dev`، والفيديو والتحكم عبر WebRTC. التجربة تعتمد على خدمة التنسيق والاتصال بالشبكة؛ ليست بثًا كاملًا داخل نفق SSH. لم نفتح بورت خدمة HTTP على الشبكة: عنوانه على الماك `127.0.0.1:18080`، وواجهة التحكم الداخلية على loopback أيضًا.

لإلغاء وصول متصفح بعينه، استخدم `~/.local/bin/simbeamd unpair <clientPubKey>` على الماك. إيقاف البث لا يمسح مفاتيح الربط.

هذه نسخة تجريبية للـSimulator فقط. أداة الالتقاط تستخدم واجهات CoreSimulator خاصة؛ قد تتأثر بتحديثات Xcode.

## نتيجة الفحص على جهازك — 24 أكتوبر 2026

- macOS 15.8.1، معمارية x86_64، وXcode 26.3.
- iPhone 16e بدأ التشغيل بنجاح؛ الإقلاع أخذ حوالي 87 ثانية.
- اختبار أداة الالتقاط لمدة 12 ثانية أنتج 866235 بايت من فيديو H.264، وأعلن جاهزية الـencoder بأبعاد 584×1266 وإعداد 15 إطارًا/ثانية. هذا إعداد للالتقاط وليس قياسًا لمعدل الإطارات الفعلي في المتصفح.
- فحص PowerShell نجح: الاتصال بالماك، إصدارات الأدوات، قراءة المحاكي، وتحليل رابط الربط ورفض الروابط غير المتوقعة.
- تم التحقق من عرض الفيديو في متصفح Codex باتصال P2P، وفتح Settings بالماوس، وكتابة Battery في البحث من الكيبورد، والرجوع بزر Home، والسحب لتبديل صفحات الشاشة الرئيسية.
- لم نقس زمن التأخير أو معدل الإطارات الفعلي، ولم نختبر الآيفون الحقيقي أو الاتصال من خارج الشبكة.

متطلب Xcode المعلن للأداة أحدث من إصدار جهازك؛ نجاح اختبار الالتقاط هنا يثبت عمل هذا الجزء على الإعداد الحالي فقط.

المشروع الأصلي: https://github.com/kei-sidorov/simbeam
