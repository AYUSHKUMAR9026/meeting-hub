-- Repair older local installations whose original room receipt table lacked scope columns.
-- Preserve historical receipts; their session cannot be inferred from an event ID.
ALTER TABLE room_webhook_receipts ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE room_webhook_receipts ADD COLUMN IF NOT EXISTS meeting_id uuid;
ALTER TABLE room_webhook_receipts ADD COLUMN IF NOT EXISTS workspace_id uuid;
