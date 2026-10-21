export const createGroupEnhancementsSql = `
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "about" TEXT DEFAULT 'Hey there! I am using ADDA.';
ALTER TABLE "chat_group" ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL DEFAULT '';
ALTER TABLE "chat_group" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "chat_group_member" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'member';

-- Set all existing group creators as admin
UPDATE "chat_group_member" m 
SET "role" = 'admin' 
FROM "chat_group" g 
WHERE m."groupId" = g.id AND m."userId" = g."ownerId";
`;
