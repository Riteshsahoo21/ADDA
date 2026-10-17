export const createFriendRequestTablesSql = `
CREATE TABLE IF NOT EXISTS "friend_request" (
  "id" TEXT PRIMARY KEY,
  "senderId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "recipientId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'accepted', 'declined')),
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK ("senderId" <> "recipientId"),
  UNIQUE ("senderId", "recipientId")
);
CREATE INDEX IF NOT EXISTS "idx_friend_request_recipient" ON "friend_request" ("recipientId", "status", "createdAt" DESC);
`;
