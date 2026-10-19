# ADDA backend

Node.js, Express, PostgreSQL, and Better Auth backend for the ADDA app.

## Structure

```text
src/
  config/env.ts             Environment configuration
  db/pool.ts                Shared PostgreSQL connection pool
  db/migrate.ts             Database migration command
  db/migrations/001_auth.ts  Auth schema
  db/migrations/002_social.ts  Profiles, contacts, groups, and messages
  db/migrations/003_realtime.ts  Idempotent chat message keys
  db/seed.ts                Idempotent demo-account seed
  modules/auth/auth.ts      Better Auth configuration
  modules/social/routes.ts  Authenticated social API
  modules/social/profile.ts Profile initialization and validation
  modules/health/routes.ts  Health route
  modules/realtime/         Socket.IO chat, calls, and mediasoup room media
  app.ts                    Express middleware and routes
  index.ts                  Server startup and shutdown
```

## Run locally

1. Create a PostgreSQL database. Copy `.env.example` to `.env` and set `DATABASE_URL` and `BETTER_AUTH_SECRET`.
2. Install dependencies with `npm install`.
3. Run `npm run migrate` to create the auth and social tables.
4. Run `npm run seed` to create six demo accounts. Newly generated login credentials are written to the gitignored `seed-credentials.json`.
5. Run `npm run dev` to start the server.

`GET /api/health` checks that the HTTP server is responding. `POST /api/auth/*` is handled by Better Auth. `npm start` runs the TypeScript source. For production, run `npm run build` followed by `npm run start:prod`; the generated JavaScript in `dist/` is ignored by Git.

The authenticated `/api/me`, `/api/contacts`, `/api/people`, `/api/groups`, and `/api/chats` routes require Better Auth's bearer session token. A user's QR encodes only `adda:friend:v1:<random code>`. The server resolves that code when a signed-in user scans it; email and other private profile fields are never included in the QR or public contact responses.

## Realtime and calls

Socket.IO uses the same Better Auth bearer token as REST. Typing events are temporary and only reach members who joined that conversation.

## Room movement

Room movement uses a versioned, compact Socket.IO packet (19 bytes per player update before transport overhead). The phone sends velocity and pose changes plus occasional position anchors. The server validates speed and room membership, batches updates every 100 ms, and reduces updates for distant players. Phones predict movement between packets and smooth corrections each render frame. Joining with `motionProtocol: 2` enables this path; older clients continue receiving `room:peer` events. The motion relay is process-local, so running multiple backend instances for the same shard requires a shared room routing layer.

## Encrypted chat v1

The app creates a separate Curve25519 device key pair per phone. Its private key stays in Android/iOS SecureStore. Message content uses a fresh authenticated secretbox key, wrapped separately for each recipient device. PostgreSQL keeps only encrypted pending envelopes and small routing/receipt metadata. A phone verifies and saves each message in a SQLCipher database before it acknowledges delivery; the backend then removes that device's pending envelope. The shared ciphertext is deleted after every addressed device acknowledges. There is no time-based deletion of pending messages. Users can remove lost devices from Profile; that explicitly discards those devices' pending copies.

One grey tick means server accepted the message; two grey ticks mean all recipient accounts delivered it; two blue ticks mean all recipient accounts opened it. Socket.IO wakes connected phones, and FCM sends a generic notification to background phones. A new phone cannot recover old messages without a separately designed encrypted backup/key transfer.

Encrypted photos and videos are uploaded to a private Cloudflare R2 bucket. The phone encrypts before upload, and recipients verify and save the encrypted blob locally before delivery ACK. R2 deletes a blob after the last addressed device acknowledges. Set `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in `.env`; uploads return 503 until these are configured. Limit: 25 MB per file. R2 credentials are server-only. Never put them in the Expo app.

This is an E2EE prototype, **not a Signal protocol implementation**. It does not provide Double Ratchet forward secrecy, key transparency, or encrypted cloud recovery. A new device key is trusted on first use; users should compare the key code shown in a chat through another trusted channel. Earlier messages in the legacy `chat_message` table remain plaintext and are not imported or automatically deleted. Coordinate the backend and new native app release because legacy plaintext send endpoints now reject sends.

Direct voice/video calls use WebRTC with Socket.IO signaling. `/api/calls/ice` supplies STUN and optional time-limited TURN credentials. Set `TURN_URL` and `TURN_SHARED_SECRET` to match a reachable coturn server for networks where direct peer connection fails. Group calls use the mediasoup SFU. Room voice uses the SFU too, and the server forwards audio only to peers within eight scene units. The client reports avatar position four times a second.

Set `MEDIA_ANNOUNCED_ADDRESS` to the address that phones can reach, and allow TCP and UDP ports 40000-49999 on the SFU host. Android needs a new development build after adding `react-native-webrtc`; Expo Go cannot run call media. Foreground call invitations work over Socket.IO; background/offline call notifications are not configured. This server keeps call and media state in one process. Multi-instance deployment needs shared call state and a Socket.IO adapter before load balancing.
