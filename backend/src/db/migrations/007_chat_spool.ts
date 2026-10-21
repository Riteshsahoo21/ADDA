export const createChatSpoolTableSql = `
CREATE TABLE IF NOT EXISTS chat_spool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "messageId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "senderDeviceId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "recipientDeviceId" TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  "targetId" TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  "wrappedKey" TEXT NOT NULL,
  "wrapNonce" TEXT NOT NULL,
  "senderPublicKey" TEXT NOT NULL,
  "senderName" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_spool_recipient ON chat_spool ("recipientDeviceId", "createdAt" ASC);
CREATE INDEX IF NOT EXISTS idx_chat_spool_msg_recip ON chat_spool ("messageId", "recipientId");
CREATE INDEX IF NOT EXISTS idx_chat_spool_expiry ON chat_spool ("createdAt");
`;
