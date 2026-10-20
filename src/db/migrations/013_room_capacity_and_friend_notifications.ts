export const createRoomCapacityAndFriendNotificationsSql = `
-- 1. Add dismissedBySender column to friend_request so senders can view and dismiss acceptance notifications
ALTER TABLE "friend_request" ADD COLUMN IF NOT EXISTS "dismissedBySender" BOOLEAN NOT NULL DEFAULT false;

-- 2. Add maxPlayers capacity column to group_room (capped between 2 and 10, default 10)
ALTER TABLE "group_room" ADD COLUMN IF NOT EXISTS "maxPlayers" INT NOT NULL DEFAULT 10;

-- 3. Index for querying active accepted friend requests for senders
CREATE INDEX IF NOT EXISTS "idx_friend_request_sender_accepted" ON "friend_request" ("senderId", "status", "dismissedBySender", "updatedAt" DESC);
`;
