import cors from 'cors';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { env } from './config/env.js';
import { auth } from './modules/auth/auth.js';
import { healthRoutes } from './modules/health/routes.js';
import { socialRoutes } from './modules/social/routes.js';
import { chatRoutes } from './modules/chat/routes.js';

import path from 'node:path';
import { musicRoutes } from './modules/music/routes.js';

export const app = express();
const allowedOrigins = new Set(env.corsOrigins);

app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
  }),
);

// Better Auth reads the raw request body, so mount it before express.json().
app.all('/api/auth/*', toNodeHandler(auth));
app.use(express.json({ limit: '2mb' }));
app.use('/music', express.static(path.join(process.cwd(), 'public/music')));
app.use('/api/health', healthRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/music', musicRoutes);
app.use('/api', socialRoutes);

app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});
