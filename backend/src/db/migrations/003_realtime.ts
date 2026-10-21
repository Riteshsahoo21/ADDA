export const createRealtimeTablesSql = `
ALTER TABLE "chat_message" ADD COLUMN IF NOT EXISTS "clientId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_message_client_id" ON "chat_message" ("senderId", "clientId") WHERE "clientId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_message_direct_reverse" ON "chat_message" ("recipientId", "senderId", "createdAt" DESC);
`;
