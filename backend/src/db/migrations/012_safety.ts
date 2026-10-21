export const createSafetyTablesSql = `
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "policyAcceptedAt" TIMESTAMPTZ;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "policyVersion" TEXT;
ALTER TABLE chat_sent_id ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE chat_sent_id ADD COLUMN IF NOT EXISTS "targetId" TEXT;

CREATE TABLE IF NOT EXISTS user_block (
  "blockerId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "blockedId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("blockerId", "blockedId"),
  CHECK ("blockerId" <> "blockedId")
);
CREATE INDEX IF NOT EXISTS user_block_blocked_idx ON user_block ("blockedId", "blockerId");

CREATE TABLE IF NOT EXISTS user_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reporterId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "reportedUserId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'message', 'room')),
  reason TEXT NOT NULL CHECK (reason IN ('harassment', 'hate', 'sexual', 'child_safety', 'violence', 'spam', 'other')),
  "messageId" TEXT,
  "roomId" TEXT,
  details TEXT NOT NULL DEFAULT '',
  "evidenceText" TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_report_pending_idx ON user_report (status, "createdAt");
CREATE INDEX IF NOT EXISTS user_report_reporter_idx ON user_report ("reporterId", "createdAt");

CREATE TABLE IF NOT EXISTS account_deletion_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  "ipHash" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'completed')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_deletion_request_pending_idx ON account_deletion_request (status, "createdAt");
CREATE INDEX IF NOT EXISTS account_deletion_request_email_idx ON account_deletion_request (LOWER(email), "createdAt");

-- R2 objects are removed asynchronously after the account row is gone.
CREATE TABLE IF NOT EXISTS media_object_deletion (
  "objectKey" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
