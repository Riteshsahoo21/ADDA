export const createSocialTablesSql = `
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "username" TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "friendCode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_username" ON "user" (LOWER("username")) WHERE "username" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_friend_code" ON "user" ("friendCode") WHERE "friendCode" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "contact" (
  "userA" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "userB" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("userA", "userB"),
  CHECK ("userA" < "userB")
);
CREATE INDEX IF NOT EXISTS "idx_contact_user_b" ON "contact" ("userB");

CREATE TABLE IF NOT EXISTS "chat_group" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "chat_group_member" (
  "groupId" TEXT NOT NULL REFERENCES "chat_group"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "joinedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("groupId", "userId")
);
CREATE INDEX IF NOT EXISTS "idx_group_member_user" ON "chat_group_member" ("userId");

CREATE TABLE IF NOT EXISTS "chat_message" (
  "id" TEXT PRIMARY KEY,
  "senderId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "recipientId" TEXT REFERENCES "user"("id") ON DELETE CASCADE,
  "groupId" TEXT REFERENCES "chat_group"("id") ON DELETE CASCADE,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (("recipientId" IS NOT NULL) <> ("groupId" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "idx_message_direct" ON "chat_message" ("senderId", "recipientId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_message_group" ON "chat_message" ("groupId", "createdAt" DESC);
`;
