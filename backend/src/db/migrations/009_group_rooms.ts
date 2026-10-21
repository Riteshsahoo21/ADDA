export const createGroupRoomsSql = `
CREATE TABLE IF NOT EXISTS "group_room" (
  "id" TEXT PRIMARY KEY,
  "groupId" TEXT NOT NULL REFERENCES "chat_group"("id") ON DELETE CASCADE,
  "roomKind" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_group_room_group_active" ON "group_room" ("groupId", "isActive");
CREATE INDEX IF NOT EXISTS "idx_group_room_active" ON "group_room" ("isActive");

CREATE TABLE IF NOT EXISTS "room_invite" (
  "id" TEXT PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL REFERENCES "chat_group"("id") ON DELETE CASCADE,
  "inviterId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "inviteeId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "roomKind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_room_invite_user" ON "room_invite" ("inviteeId", "status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_room_invite_room" ON "room_invite" ("roomId");
`;
