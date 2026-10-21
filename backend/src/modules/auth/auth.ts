import { betterAuth } from 'better-auth';
import { bearer, emailOTP, jwt } from 'better-auth/plugins';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { sendOtpEmail } from '../mail/mail.js';

export const auth = betterAuth({
  database: pool,
  secret: env.authSecret,
  baseURL: env.authUrl,
  trustedOrigins: [...new Set([env.authUrl, ...env.corsOrigins, 'adda://', 'exp://'])],
  advanced: {
    disableCSRFCheck: true,
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: false,
  },
  emailVerification: {
    autoSignInAfterVerification: true,
  },
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
  plugins: [
    jwt({ jwt: { expirationTime: '15m' } }),
    bearer(),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        await sendOtpEmail({ email, otp, type });
      },
      otpLength: 6,
      expiresIn: 300,
      sendVerificationOnSignUp: true,
      allowedAttempts: 5,
      resendStrategy: 'rotate',
      rateLimit: {
        window: 60,
        max: 5,
      },
    }),
  ],
  rateLimit: { enabled: true, window: 60, max: 100 },
});

