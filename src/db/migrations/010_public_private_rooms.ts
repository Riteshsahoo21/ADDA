export const createPublicPrivateRoomsSql = `
DO $$
BEGIN
  -- 1. Allow groupId to be nullable in group_room for standalone public/private servers
  ALTER TABLE "group_room" ALTER COLUMN "groupId" DROP NOT NULL;
EXCEPTION
  WHEN others THEN NULL;
END $$;

ALTER TABLE "group_room" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT 'ADDA Server 1#1000';
ALTER TABLE "group_room" ADD COLUMN IF NOT EXISTS "isPrivate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "group_room" ADD COLUMN IF NOT EXISTS "code" TEXT NOT NULL DEFAULT '1000';
ALTER TABLE "group_room" ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  -- 2. Allow groupId and inviteeId to be nullable in room_invite
  ALTER TABLE "room_invite" ALTER COLUMN "groupId" DROP NOT NULL;
  ALTER TABLE "room_invite" ALTER COLUMN "inviteeId" DROP NOT NULL;
EXCEPTION
  WHEN others THEN NULL;
END $$;

ALTER TABLE "room_invite" ADD COLUMN IF NOT EXISTS "roomName" TEXT;
ALTER TABLE "room_invite" ADD COLUMN IF NOT EXISTS "isPrivate" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "idx_group_room_public_active" ON "group_room" ("isActive", "isPrivate");
`;
