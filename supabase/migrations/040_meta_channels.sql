-- ============================================================
-- 040_meta_channels.sql — Facebook Messenger + Instagram DMs
--
-- Adds a second family of inbound/outbound channels alongside
-- WhatsApp. Connections are stored separately from `whatsapp_config`
-- (a Page Access Token is a different credential with a different
-- lifecycle), but conversations and messages are SHARED — everything
-- lands in the same inbox.
--
-- Design decisions baked in here
--   * One contact row per (channel, external_id). The same human
--     writing from WhatsApp and Instagram is two contacts. Chosen
--     for simplicity; see "Unifying later" at the bottom for the
--     upgrade path if that changes.
--   * `contacts.phone` becomes nullable. A Messenger/Instagram user
--     has no phone number — Meta only exposes a page-scoped id
--     (PSID) or an Instagram-scoped id (IGSID). This is the single
--     constraint that blocks the whole feature today.
--   * One `meta_connections` row per Facebook Page. Instagram DMs
--     require a professional IG account linked to a Page, so a
--     single Facebook Login grants both — Messenger always, IG only
--     when `instagram_account_id` is populated.
--   * `channel` defaults to 'whatsapp' everywhere, so every existing
--     row is already correct and no backfill pass is needed.
--
-- Idempotent: new columns use IF NOT EXISTS, policies/triggers/
-- indexes are dropped before recreate (Postgres has no
-- CREATE POLICY IF NOT EXISTS).
-- ============================================================

-- ============================================================
-- CONTACTS — channel identity
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp',
  -- PSID (Messenger) or IGSID (Instagram). Opaque, page-scoped, and
  -- NOT portable across Meta apps — reconnecting under a different
  -- app issues different ids for the same humans.
  ADD COLUMN IF NOT EXISTS external_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_channel_check' AND conrelid = 'contacts'::regclass
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_channel_check
      CHECK (channel IN ('whatsapp', 'messenger', 'instagram'));
  END IF;
END $$;

-- The blocker: Messenger/Instagram contacts have no phone number.
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

-- ...but a contact still has to be reachable *somehow*. WhatsApp
-- rows need a phone; Meta rows need an external_id. This replaces the
-- guarantee the old NOT NULL gave us, without blocking the new rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_identity_check' AND conrelid = 'contacts'::regclass
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_identity_check
      CHECK (
        (channel = 'whatsapp' AND phone IS NOT NULL)
        OR (channel IN ('messenger', 'instagram') AND external_id IS NOT NULL)
      );
  END IF;
END $$;

-- Identity uniqueness for Meta contacts, mirroring what migration 022
-- does for phones. Partial (WHERE external_id IS NOT NULL) so the
-- millions of WhatsApp rows with a NULL external_id stay out of the
-- index entirely.
--
-- This index is what makes the webhook's find-or-create race-safe:
-- two concurrent inbound deliveries from the same PSID collide on a
-- 23505 that the handler re-resolves, exactly like the phone path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_channel_external
  ON contacts(account_id, channel, external_id)
  WHERE external_id IS NOT NULL;

-- ============================================================
-- CONVERSATIONS — which channel this thread belongs to
--
-- Denormalised from contacts.channel on purpose. The outbound send
-- path reads the conversation to decide which Meta API to call, and
-- joining to contacts on every send to answer "which channel?" is a
-- wasted round trip on the hot path.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_channel_check' AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('whatsapp', 'messenger', 'instagram'));
  END IF;
END $$;

-- Backs the inbox's per-channel filter chips.
CREATE INDEX IF NOT EXISTS idx_conversations_account_channel
  ON conversations(account_id, channel);

-- ============================================================
-- META_CONNECTIONS — one row per connected Facebook Page
--
-- Deliberately NOT an extension of `whatsapp_config`: the credential
-- is a Page Access Token (not a WABA token), it's obtained through
-- Facebook Login rather than pasted by hand, and it can cover two
-- channels at once. Keeping them apart means neither migration path
-- can break the other.
--
-- `page_access_token` is stored encrypted with the same AES-256-GCM
-- helper as `whatsapp_config.access_token` (src/lib/whatsapp/
-- encryption.ts) — never write a plaintext token to this column.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Audit / sender-of-record, matching the whatsapp_config convention:
  -- the admin who performed the connection. Inbound rows created by
  -- the webhook are attributed to this user (no logged-in human exists
  -- at webhook time).
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Facebook Page. `page_id` is what arrives as `entry[].id` on every
  -- inbound Messenger webhook, so this is the webhook's lookup key.
  page_id TEXT NOT NULL,
  page_name TEXT,

  -- Instagram professional account linked to the Page. NULL means the
  -- Page has no IG attached — Messenger works, Instagram doesn't.
  -- Arrives as `entry[].id` on Instagram webhooks.
  instagram_account_id TEXT,
  instagram_username TEXT,

  page_access_token TEXT NOT NULL,

  -- Per-channel kill switches. A user may want Messenger on and
  -- Instagram off (or vice versa) without disconnecting the Page and
  -- losing the token.
  messenger_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  instagram_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'disconnected', 'error')),
  -- Set when Meta rejects the token (expired, permissions revoked,
  -- Page unlinked). Surfaced in the settings card so the user knows
  -- to reconnect instead of wondering why messages stopped.
  last_error TEXT,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GLOBAL uniqueness, not per-account — same reasoning as migration 013
-- for phone_number_id. The webhook resolves an inbound event to an
-- account purely from the Page id, so if two accounts could claim the
-- same Page there'd be no way to know whose inbox the message belongs
-- in. The second account to connect gets a 23505, which the OAuth
-- callback should surface as "this Page is already connected
-- elsewhere" rather than a 500.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_connections_page
  ON meta_connections(page_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_connections_ig
  ON meta_connections(instagram_account_id)
  WHERE instagram_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meta_connections_account
  ON meta_connections(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON meta_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meta_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- RLS — settings-class table
--
-- Same shape as whatsapp_config's policies from 017: any member may
-- SELECT (the inbox needs to know a channel is connected), only
-- admins+ may write. The service-role webhook bypasses RLS entirely,
-- as it does for WhatsApp.
-- ============================================================

ALTER TABLE meta_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_connections_select ON meta_connections;
DROP POLICY IF EXISTS meta_connections_insert ON meta_connections;
DROP POLICY IF EXISTS meta_connections_update ON meta_connections;
DROP POLICY IF EXISTS meta_connections_delete ON meta_connections;

CREATE POLICY meta_connections_select ON meta_connections FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY meta_connections_insert ON meta_connections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY meta_connections_update ON meta_connections FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY meta_connections_delete ON meta_connections FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Unifying later
--
-- If "one human, many channels" ever becomes the requirement, the
-- upgrade is additive and does not invalidate anything above:
--   1. Add `contacts.merged_into UUID REFERENCES contacts(id)`.
--   2. Point the duplicate rows at a survivor and repoint their
--      conversations.
--   3. Teach the contact list to hide merged rows.
-- The per-channel identity stays the source of truth for routing,
-- which is what the webhook and send path actually need.
-- ============================================================