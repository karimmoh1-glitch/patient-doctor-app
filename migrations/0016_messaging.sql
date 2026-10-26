-- Reliable messaging.
--
-- A message has three honest states, each set only by something that actually happened:
--   sent       the server accepted and stored it                           (created_at)
--   delivered  the recipient's app fetched the conversation containing it  (delivered_at)
--   read       the recipient's app reported the conversation was opened    (read_at)
-- client_message_id makes a send idempotent: a retry after a dropped connection returns the original and never duplicates.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id varchar;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_idx ON messages (pairing_request_id, sender_user_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_unread_idx ON messages (pairing_request_id, sender_user_id) WHERE read_at IS NULL;

-- A person may choose not to tell the other side when they have read a message.
ALTER TABLE users ADD COLUMN IF NOT EXISTS read_receipts boolean NOT NULL DEFAULT true;

-- A sent message is never edited or deleted by the application. Only the receipt columns may change, and only the
-- operator's erasure script may replace the text, with exactly the marker "[erased]".
CREATE OR REPLACE FUNCTION avela_message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A message cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.pairing_request_id IS DISTINCT FROM OLD.pairing_request_id
     OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.client_message_id IS DISTINCT FROM OLD.client_message_id THEN
    RAISE EXCEPTION 'A message cannot be moved or re-attributed' USING ERRCODE = '42501';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body AND NEW.body <> '[erased]' THEN
    RAISE EXCEPTION 'A sent message cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
     OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'A receipt cannot be changed once recorded' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messages_guard ON messages;
CREATE TRIGGER messages_guard BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION avela_message_guard();

-- The recipient (not the sender) records receipts.
DROP POLICY IF EXISTS avela_messages_update ON messages;
CREATE POLICY avela_messages_update ON messages FOR UPDATE
  USING (app_is_system() OR (app_in_pairing(pairing_request_id) AND sender_user_id <> app_user_id()))
  WITH CHECK (app_is_system() OR (app_in_pairing(pairing_request_id) AND sender_user_id <> app_user_id()));

-- A report of abusive or unsafe behaviour. The reporter chooses whether to attach the text; administrators see only what
-- was attached, never the rest of a conversation.
CREATE TABLE IF NOT EXISTS message_reports (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id varchar NOT NULL REFERENCES users(id),
  pairing_request_id varchar NOT NULL REFERENCES pairing_requests(id),
  message_id varchar REFERENCES messages(id),
  reason varchar NOT NULL,
  details text,
  shared_text text,
  status varchar NOT NULL DEFAULT 'open',          -- open | resolved
  resolved_by_user_id varchar REFERENCES users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_reports_status_idx ON message_reports (status, created_at);

-- Blocking ends a connection and stops the same person from asking again.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id varchar NOT NULL REFERENCES users(id),
  blocked_user_id varchar NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);

ALTER TABLE message_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avela_message_reports_select ON message_reports;
DROP POLICY IF EXISTS avela_message_reports_insert ON message_reports;
DROP POLICY IF EXISTS avela_message_reports_system ON message_reports;
DROP POLICY IF EXISTS avela_user_blocks ON user_blocks;
CREATE POLICY avela_message_reports_select ON message_reports FOR SELECT USING (app_owns(reporter_user_id));
CREATE POLICY avela_message_reports_insert ON message_reports FOR INSERT WITH CHECK (app_owns(reporter_user_id) AND app_in_pairing(pairing_request_id));
CREATE POLICY avela_message_reports_system ON message_reports FOR UPDATE USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_user_blocks ON user_blocks FOR ALL USING (app_owns(blocker_user_id)) WITH CHECK (app_owns(blocker_user_id));

SELECT avela_apply_grants();
