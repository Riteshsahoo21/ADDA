export const createEncryptedChatTablesSql = `
CREATE TABLE IF NOT EXISTS chat_device (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "publicKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "revokedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS chat_device_user_active_idx ON chat_device ("userId") WHERE "revokedAt" IS NULL;

-- The encrypted body is stored once even when a group has many recipients.
CREATE TABLE IF NOT EXISTS chat_pending_payload (
  "messageId" TEXT PRIMARY KEY,
  "senderId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "senderDeviceId" TEXT NOT NULL REFERENCES chat_device(id),
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  "targetId" TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_pending_payload_target_idx ON chat_pending_payload (kind, "targetId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS chat_pending_key (
  id TEXT PRIMARY KEY,
  "messageId" TEXT NOT NULL REFERENCES chat_pending_payload("messageId") ON DELETE CASCADE,
  "recipientId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "recipientDeviceId" TEXT NOT NULL REFERENCES chat_device(id),
  "wrappedKey" TEXT NOT NULL,
  "wrapNonce" TEXT NOT NULL,
  UNIQUE ("messageId", "recipientDeviceId")
);
CREATE INDEX IF NOT EXISTS chat_pending_key_device_idx ON chat_pending_key ("recipientDeviceId", id);

-- A compact ID prevents a delayed HTTP retry from recreating a delivered message.
CREATE TABLE IF NOT EXISTS chat_sent_id (
  "messageId" TEXT PRIMARY KEY,
  "senderId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_sent_id_rate_idx ON chat_sent_id ("senderId", "createdAt" DESC);

-- Receipt metadata stays small; encrypted payloads are deleted after device ACK.
CREATE TABLE IF NOT EXISTS chat_delivery_state (
  "messageId" TEXT NOT NULL REFERENCES chat_sent_id("messageId") ON DELETE CASCADE,
  "senderId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "recipientId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "deliveredAt" TIMESTAMPTZ,
  "readAt" TIMESTAMPTZ,
  PRIMARY KEY ("messageId", "recipientId")
);

CREATE TABLE IF NOT EXISTS chat_receipt_event (
  id TEXT PRIMARY KEY,
  "messageId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "recipientDeviceId" TEXT NOT NULL REFERENCES chat_device(id),
  "actorId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('delivered', 'read')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("messageId", "recipientDeviceId", "actorId", kind)
);
CREATE INDEX IF NOT EXISTS chat_receipt_event_device_idx ON chat_receipt_event ("recipientDeviceId", "createdAt", id);

CREATE TABLE IF NOT EXISTS chat_media (
  id TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  "targetId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL UNIQUE,
  "contentLength" BIGINT NOT NULL,
  "mediaKind" TEXT NOT NULL CHECK ("mediaKind" IN ('image', 'video')),
  "messageId" TEXT REFERENCES chat_sent_id("messageId") ON DELETE SET NULL,
  confirmed BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_media_message_idx ON chat_media ("messageId") WHERE "messageId" IS NOT NULL;
`;
