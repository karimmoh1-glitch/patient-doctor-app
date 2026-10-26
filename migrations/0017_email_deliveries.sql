-- Evidence of what happened to each email, as reported by the provider.
--
-- A row is written when the provider ACCEPTS a message (status 'accepted': it has it, nothing more). The provider's signed
-- webhook later moves it to 'delivered', 'delayed', 'bounced', 'complained' or 'failed'. Nothing else may claim delivery.
-- No address and no message text is stored: only the provider's message id, why we sent it, and a keyed hash of the address
-- (so repeated bounces for one recipient can be counted without keeping the address). System-only: a person's own request
-- can never read this table.

CREATE TABLE IF NOT EXISTS email_deliveries (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'resend',
  provider_message_id text NOT NULL,
  purpose text NOT NULL,
  recipient_hash text NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','delayed','delivered','bounced','complained','failed')),
  status_detail text,
  last_event_id text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  status_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id)
);
CREATE INDEX IF NOT EXISTS email_deliveries_status_idx ON email_deliveries (status, accepted_at);
CREATE INDEX IF NOT EXISTS email_deliveries_recipient_idx ON email_deliveries (recipient_hash, accepted_at);

-- Webhook event ids already applied, so a redelivered event changes nothing.
CREATE TABLE IF NOT EXISTS email_webhook_events (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avela_email_deliveries ON email_deliveries;
DROP POLICY IF EXISTS avela_email_webhook_events ON email_webhook_events;
CREATE POLICY avela_email_deliveries ON email_deliveries FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY avela_email_webhook_events ON email_webhook_events FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

SELECT avela_apply_grants();
