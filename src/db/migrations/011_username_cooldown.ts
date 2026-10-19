export const createUsernameCooldownSql = `
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "usernameChangedAt" TIMESTAMP;
`;
