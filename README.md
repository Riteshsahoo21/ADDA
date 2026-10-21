# ADDA

ADDA is a real-time social hangout and communication platform featuring 3D spatial hangouts, WebRTC direct P2P audio/video calls, group calling via MiroTalk, end-to-end encrypted messaging, and synchronized music playback.

## Monorepo Architecture

```
ADDA/
├── app/        # React Native / Expo mobile application (Android & iOS)
│   ├── assets/ # Bundled 3D runtime models (.glb) and native textures (.rgba)
│   ├── src/    # Application screens, Three.js 3D engine, and WebRTC stack
│   └── scripts/# Offline build, 3D model decimation, and asset verification
└── backend/    # Node.js / TypeScript realtime API server
    ├── src/    # Socket.io realtime events, PostgreSQL database, and MiroTalk bridge
    └── db/     # Database migrations and seed utilities
```

## Quick Start

### Backend

```bash
cd backend
npm install
npm run build
npm start
```

### Mobile App

```bash
cd app
npm install
npx expo run:android --variant release
```
