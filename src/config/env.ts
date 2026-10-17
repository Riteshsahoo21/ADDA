import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Set it in backend/.env.`);
  return value;
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
export const env = {
  port,
  host: process.env.HOST?.trim() || '0.0.0.0',
  databaseUrl: required('DATABASE_URL'),
  authSecret: required('BETTER_AUTH_SECRET'),
  authUrl: process.env.BETTER_AUTH_URL?.trim() || `http://localhost:${port}`,
  googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || '',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:8081')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  stunUrl: process.env.STUN_URL?.trim() || 'stun:stun.l.google.com:19302',
  turnUrl: process.env.TURN_URL?.trim() || '',
  turnSharedSecret: process.env.TURN_SHARED_SECRET?.trim() || '',
  mediaAnnouncedAddress: process.env.MEDIA_ANNOUNCED_ADDRESS?.trim() || '',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || '',
  r2AccountId: process.env.R2_ACCOUNT_ID?.trim() || '',
  r2Bucket: process.env.R2_BUCKET?.trim() || '',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || '',
};
