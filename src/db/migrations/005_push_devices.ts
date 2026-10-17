export const createPushDevicesSql = `
CREATE TABLE IF NOT EXISTS push_device (
  token TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_device_user_idx ON push_device ("userId");
`;
