import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

export const musicRoutes = Router();

const tracksPath = path.join(process.cwd(), 'src/modules/music/tracks.json');
let cachedTracks: { id: string; title: string; byline: string; label: string }[] = [];

try {
  if (fs.existsSync(tracksPath)) {
    cachedTracks = JSON.parse(fs.readFileSync(tracksPath, 'utf8'));
  }
} catch (e) {
  console.warn('[ADDA Backend] Failed to load tracks.json', e);
}

musicRoutes.get('/tracks', (_req, res) => {
  res.json({ ok: true, tracks: cachedTracks });
});
