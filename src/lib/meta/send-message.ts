// ============================================================
// Outbound send for Messenger + Instagram.
//
// Sibling of `@/lib/whatsapp/send-message`, not an extension of it.
// The two share almost nothing at the transport layer: different
// endpoint, different recipient identifier (PSID/IGSID vs E.164),
// different auth (Page Access Token vs WABA token), and a different
// message envelope. Threading all of that through the WhatsApp core
// as conditionals would put ~300 lines of working code at risk to
// serve a path that reuses none of it.
//
// What they DO share is the tail: persist to `messages`, update the
// conversation preview, pause any active Flow run. That's duplicated
// deliberately — it's ~40 lines, and hoisting it would couple the two
// send paths right where they're most likely to diverge next.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { supabaseAdmin } from '@/lib/flows/admin-client';

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type MetaChannel = 'messenger' | 'instagram';

/** Message types Meta's Send API accepts on these channels. */
const SUPPORTED_TYPES = ['text', 'image', 'video', 'audio', 'document'] as const;

interface MetaSendParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
}

export interface MetaSendResult {
  messageId: string;
  metaMessageId: string;
}

/**
 * Send to a Messenger or Instagram conversation.
 *
 * Mirrors `sendMessageToConversation`'s contract — same `db` +
 * `accountId` shape, same `SendMessageError` family — so callers can
 * branch on channel without learning a second error vocabulary.
 */
export async function sendMetaMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  channel: MetaChannel,
  params: MetaSendParams,
): Promise<MetaSendResult> {
  const { conversationId, messageType, contentText, mediaUrl } = params;

  // ---- validation ---------------------------------------------
  // Templates and interactive messages are WhatsApp-only. Meta has
  // rough analogues (message tags, quick replies) but they are NOT
  // drop-in equivalents: tags are a closed, audited list and quick
  // replies expire with the conversation. Failing loudly here beats
  // silently sending something that doesn't mean what the caller
  // intended.
  if (!(SUPPORTED_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'unsupported_on_channel',
      `'${messageType}' messages are not supported on ${channel}. Use text or media.`,
      400,
    );
  }

  if (messageType === 'text' && !contentText?.trim()) {
    throw new SendMessageError('bad_request', 'content_text is required', 400);
  }
  if (messageType !== 'text' && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400,
    );
  }

  // ---- conversation + contact ---------------------------------
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.external_id) {
    // Shouldn't happen — migration 040's CHECK requires an external_id
    // on every non-WhatsApp contact. If it does, the row predates the
    // constraint or was written by something bypassing it.
    throw new SendMessageError(
      'bad_request',
      'Contact has no Meta identifier',
      400,
    );
  }

  // ---- connection ---------------------------------------------
  const { data: rows, error: connError } = await db
    .from('meta_connections')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1);

  const connection = rows?.[0];
  if (connError || !connection) {
    throw new SendMessageError(
      'meta_not_configured',
      'No Facebook Page connected. Connect one in Settings first.',
      400,
    );
  }

  const enabled =
    channel === 'messenger'
      ? connection.messenger_enabled
      : connection.instagram_enabled;
  if (!enabled) {
    throw new SendMessageError(
      'channel_disabled',
      `${channel} is turned off for this account.`,
      400,
    );
  }

  if (channel === 'instagram' && !connection.instagram_account_id) {
    throw new SendMessageError(
      'meta_not_configured',
      'No Instagram account is linked to the connected Page.',
      400,
    );
  }

  let pageToken: string;
  try {
    pageToken = decrypt(connection.page_access_token);
  } catch {
    throw new SendMessageError(
      'token_corrupted',
      'Stored Page token could not be decrypted. Reconnect the Page.',
      500,
    );
  }

  // ---- send ----------------------------------------------------
  // Instagram sends go through the IG account id, Messenger through
  // the Page id. Both authenticate with the same Page token.
  const senderId =
    channel === 'instagram'
      ? connection.instagram_account_id
      : connection.page_id;

  const messageBody =
    messageType === 'text'
      ? { text: contentText }
      : {
          attachment: {
            type: messageType === 'document' ? 'file' : messageType,
            // is_reusable lets Meta cache the upload; without it every
            // resend re-fetches the URL from our storage.
            payload: { url: mediaUrl, is_reusable: true },
          },
        };

  const res = await fetch(`${GRAPH}/${senderId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: contact.external_id },
      message: messageBody,
      // RESPONSE = replying inside the 24-hour window. Anything outside
      // it needs a message tag, which is a separate (audited) feature.
      messaging_type: 'RESPONSE',
      access_token: pageToken,
    }),
  });

  const json = await res.json();

  if (!res.ok || json.error) {
    const metaError = json.error ?? {};
    // Code 10 / subcode 2018278 is "outside the 24-hour window" — by
    // far the most common failure here, and one agents will hit daily.
    // A generic "send failed" leaves them retrying forever, so name it.
    const outsideWindow =
      metaError.code === 10 || metaError.error_subcode === 2018278;

    if (outsideWindow) {
      throw new SendMessageError(
        'outside_messaging_window',
        'More than 24 hours have passed since this person last messaged you. Meta does not allow a reply until they write again.',
        400,
      );
    }

    console.error('[meta-send] Meta rejected the send:', metaError);
    throw new SendMessageError(
      'meta_api_error',
      metaError.message ?? 'Meta rejected the message',
      502,
    );
  }

  const metaMessageId: string = json.message_id;

  // ---- persist -------------------------------------------------
  const persistedText = contentText ?? null;

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      message_id: metaMessageId,
      status: 'sent',
    })
    .select()
    .single();

  if (msgError) {
    console.error('[meta-send] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500,
    );
  }

  await db
    .from('conversations')
    .update({
      last_message_text: persistedText || `[${messageType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Same "human stepped in" signal the WhatsApp path emits. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err,
    );
  }

  return { messageId: messageRecord.id, metaMessageId };
}
