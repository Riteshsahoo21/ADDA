import { betterAuth } from 'better-auth';
import { bearer, jwt } from 'better-auth/plugins';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';

export const auth = betterAuth({
  database: pool,
  secret: env.authSecret,
  baseURL: env.authUrl,
  trustedOrigins: [...new Set([env.authUrl, ...env.corsOrigins, 'adda://', 'exp://'])],
  emailAndPassword: { enabled: true, autoSignIn: true },
  socialProviders:
    env.googleClientId && env.googleClientSecret
      ? { google: { clientId: env.googleClientId, clientSecret: env.googleClientSecret } }
      : {},
  user: {
    additionalFields: {
      avatar: { type: 'string', defaultValue: 'man', required: false },
      currentRoom: { type: 'string', defaultValue: 'loft', required: false },
    },
  },
  plugins: [jwt({ jwt: { expirationTime: '15m' } }), bearer()],
  rateLimit: { enabled: true, window: 60, max: 100 },
});
