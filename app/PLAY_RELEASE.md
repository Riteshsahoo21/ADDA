# ADDA Play release handoff

## Built locally

- The Android release uses a separate upload key. Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-play-aab.ps1` to build `android/app/build/outputs/bundle/release/app-release.aab`.
- Back up `release/adda-upload.jks` and `.play-signing.properties` together in a secure location. They are ignored by Git. Do not send them in chat or commit them.
- For a new machine, restore both files, update the keystore path in `.play-signing.properties`, then build again. Never generate a second key for the same Play listing without completing Google's upload-key reset process.
- Get the upload key SHA-1 with `keytool -list -v -keystore release/adda-upload.jks -alias adda-upload`. Register it for Android OAuth. After the first Play upload, also register the **Play App Signing** SHA-1 from Play Console; Google re-signs delivered APKs.
- Current upload certificate SHA-1: `21:D2:D4:BB:32:34:AA:1C:03:71:A8:67:E3:DB:E2:2D:DF:48:D1:B1`. Check it against the bundle before registering it.

## Required before public release

- Replace the provisional ADDA operator name and publish a monitored support and child-safety contact address on `/privacy`, `/terms`, `/community-guidelines`, and the Play listing. This is especially important because teens may use the app.
- Assign a person to review `user_report` and `account_deletion_request` records, verify web deletion requests, respond to urgent child-safety reports, and document actions. Merely saving reports is not a moderation process.
- Deploy backend migration 012 and the new backend code before distributing the new app. Then verify the live HTTPS pages `/terms`, `/privacy`, `/community-guidelines`, and `/account-deletion`. Enter the last URL in Play Console's account deletion field.
- Complete Play Console Data safety, content rating, target audience, child safety, and app access declarations using the actual production behavior. Include Google/Firebase sign-in and push, encrypted chat, media storage, calls, reports, and 3D rooms.
- Configure `TURN_URL` and `TURN_SHARED_SECRET` with a reachable TURN service, and test direct calls on two different cellular networks. Verify the configured mediasoup UDP range on the VPS firewall with an actual group/room call.
- Test sign-in with a Play-delivered build, account deletion, blocking, reporting, notifications, media, direct calls, group calls, and room voice on separate accounts and networks.

The app bundle and code checks alone cannot establish Play policy approval or production call reliability.
