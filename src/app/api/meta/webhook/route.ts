import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

// ============================================================
// /api/meta/webhook — inbound Messenger + Instagram messages.
//
// Deliberately NOT a branch inside the WhatsApp webhook. Meta uses a
// completely different envelope for these products: WhatsApp arrives
// as `entry[].changes[].value.messages[]`, while Messenger and
// Instagram arrive as `entry[].messaging[]` with no `changes` key at
// all. Feeding one into the other's parser is a TypeError, not a
// graceful miss.
//
// Both products share this route because their payloads are identical
// apart from the top-level `object` discriminator and which id
// `entry[].id` carries (Page id vs Instagram account id).
// ============================================================

export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaChannel = 'messenger' | 'instagram';

interface MessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    /** True when the Page itself sent this — including sends we made.
     *  Must be skipped or every outbound message boomerangs back in. */
    is_echo?: boolean;
    attachments?: Array<{
      type: string;
      payload?: { url?: string };
    }>;
  };
  postback?: {
    mid?: string;
    title?: string;
    payload?: string;
  };
}

interface MetaEntry {
  id: string;
  time?: number;
  messaging?: MessagingEvent[];
}

interface MetaWebhookBody {
  object?: string;
  entry?: MetaEntry[];
}

// ============================================================
// GET — webhook verification
//
// Unlike WhatsApp (where each account stores its own verify token in
// `whatsapp_config`), Messenger/Instagram subscribe at the APP level:
// there is one webhook config for the whole app, so one shared token
// from the environment is the correct shape here.
// ============================================================
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const challenge = searchParams.get('hub.challenge');
  const token = searchParams.get('hub.verify_token');

  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected) {
    console.error('[meta/webhook] META_WEBHOOK_VERIFY_TOKEN is not set');
    return NextResponse.json({ error: 'Not configured' }, { status: 500 });
  }

  if (mode !== 'subscribe' || !challenge || token !== expected) {
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
  }

  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ============================================================
// POST — inbound events
// ============================================================
export async function POST(request: Request) {
  // Raw body first: request.json() re-encodes and would break the HMAC.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[meta/webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Same reasoning as the WhatsApp route: ack inside Meta's ~20s window
  // (a slow ack triggers retries and duplicate inserts) but use
  // `after()` rather than a floating promise, or the serverless runtime
  // may freeze the function mid-write and silently drop messages.
  after(async () => {
    try {
      await processMetaWebhook(body);
    } catch (error) {
      console.error('[meta/webhook] processing error:', error);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processMetaWebhook(body: MetaWebhookBody) {
  // `object` is the only reliable discriminator between the two
  // products — the event shapes below are otherwise identical.
  const channel: MetaChannel | null =
    body.object === 'page'
      ? 'messenger'
      : body.object === 'instagram'
        ? 'instagram'
        : null;

  if (!channel) {
    console.warn('[meta/webhook] unknown object type:', body.object);
    return;
  }
  if (!body.entry) return;

  for (const entry of body.entry) {
    if (!entry.messaging) continue;

    // For Messenger, entry.id is the Page id. For Instagram it's the
    // IG business account id. Both are unique across accounts (see the
    // indexes in migration 040), so either resolves to one connection.
    const connection = await findConnection(channel, entry.id);
    if (!connection) {
      console.error(
        `[meta/webhook] no connection for ${channel} id ${entry.id}`,
      );
      continue;
    }

    // Per-channel kill switch from the settings panel. The Page stays
    // subscribed on Meta's side; we just stop ingesting.
    const enabled =
      channel === 'messenger'
        ? connection.messenger_enabled
        : connection.instagram_enabled;
    if (!enabled) continue;

    let pageToken: string;
    try {
      pageToken = decrypt(connection.page_access_token);
    } catch (err) {
      console.error('[meta/webhook] token decrypt failed:', err);
      continue;
    }

    for (const event of entry.messaging) {
      await processMessagingEvent(event, channel, connection, pageToken);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findConnection(channel: MetaChannel, entryId: string): Promise<any> {
  const column =
    channel === 'messenger' ? 'page_id' : 'instagram_account_id';

  const { data, error } = await supabaseAdmin()
    .from('meta_connections')
    .select('*')
    .eq(column, entryId)
    .limit(1);

  if (error) {
    console.error('[meta/webhook] connection lookup failed:', error);
    return null;
  }
  return data && data.length > 0 ? data[0] : null;
}

async function processMessagingEvent(
  event: MessagingEvent,
  channel: MetaChannel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any,
  pageToken: string,
) {
  // Echoes are our OWN outbound messages reflected back. Ingesting
  // them would duplicate every reply an agent sends and, worse, would
  // credit them to the customer.
  if (event.message?.is_echo) return;

  const externalId = event.sender.id;
  if (!externalId) return;

  const { contentText, mediaUrl, contentType, metaMessageId } =
    parseEvent(event);

  // Nothing actionable — a delivery receipt, a read receipt, or an
  // event type we don't handle yet.
  if (!metaMessageId) return;

  const contact = await findOrCreateContact(
    connection.account_id,
    connection.user_id,
    channel,
    externalId,
    pageToken,
  );
  if (!contact) return;

  const conversationId = await findOrCreateConversation(
    connection.account_id,
    connection.user_id,
    contact.id,
    channel,
  );
  if (!conversationId) return;

  const createdAt = new Date(event.timestamp || Date.now()).toISOString();

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    // Meta's `mid`. Stored in the same column as WhatsApp's wamid so
    // dedupe-on-replay works identically across channels.
    message_id: metaMessageId,
    status: 'delivered',
    created_at: createdAt,
  });

  if (msgError) {
    // Meta retries on any non-200, and our ack can race a slow write.
    // A duplicate mid is the expected shape of that race, not a bug.
    if (isUniqueViolation(msgError)) return;
    console.error('[meta/webhook] message insert failed:', msgError);
    return;
  }

  // Conversation preview + unread badge. Read-modify-write on
  // unread_count would race with concurrent inbound events; if you have
  // an increment RPC for the WhatsApp path, use it here too.
  const { data: convRow } = await supabaseAdmin()
    .from('conversations')
    .select('unread_count')
    .eq('id', conversationId)
    .maybeSingle();

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText ?? `[${contentType}]`,
      last_message_at: createdAt,
      unread_count: (convRow?.unread_count ?? 0) + 1,
      status: 'open',
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
}

/**
 * Flatten a messaging event into the columns `messages` expects.
 * `content_type` must stay inside the CHECK constraint from migration
 * 001 (widened in 010) — anything unrecognised degrades to 'text'
 * rather than failing the insert.
 */
function parseEvent(event: MessagingEvent): {
  contentText: string | null;
  mediaUrl: string | null;
  contentType: string;
  metaMessageId: string | null;
} {
  if (event.postback) {
    return {
      contentText: event.postback.title ?? event.postback.payload ?? null,
      mediaUrl: null,
      contentType: 'interactive',
      metaMessageId: event.postback.mid ?? null,
    };
  }

  const message = event.message;
  if (!message) {
    return { contentText: null, mediaUrl: null, contentType: 'text', metaMessageId: null };
  }

  const attachment = message.attachments?.[0];
  if (attachment) {
    const map: Record<string, string> = {
      image: 'image',
      video: 'video',
      audio: 'audio',
      file: 'document',
    };
    return {
      contentText: message.text ?? null,
      // NOTE: this is Meta's CDN URL and it EXPIRES. Attachments will
      // 404 within days. The WhatsApp path solves this with
      // mirrorInboundMedia(); wiring the same mirror here is the
      // obvious follow-up.
      mediaUrl: attachment.payload?.url ?? null,
      contentType: map[attachment.type] ?? 'document',
      metaMessageId: message.mid,
    };
  }

  return {
    contentText: message.text ?? null,
    mediaUrl: null,
    contentType: 'text',
    metaMessageId: message.mid,
  };
}

/**
 * Find or create the contact for `(account, channel, external_id)`.
 * Per migration 040 the same human on two channels is two contacts,
 * so identity is the PSID/IGSID — never the phone number.
 */
async function findOrCreateContact(
  accountId: string,
  auditUserId: string,
  channel: MetaChannel,
  externalId: string,
  pageToken: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { data: existing } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', channel)
    .eq('external_id', externalId)
    .limit(1);

  if (existing && existing.length > 0) return existing[0];

  // Resolve a human-readable name. Worth the extra round trip only on
  // first contact: an inbox full of 17-digit PSIDs is unusable, and
  // agents can't be expected to guess who they're talking to.
  const profile = await fetchMetaProfile(externalId, pageToken, channel);

  const { data: created, error } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      // No logged-in human exists at webhook time; attribute to the
      // admin who connected the Page, matching the WhatsApp convention.
      user_id: auditUserId,
      channel,
      external_id: externalId,
      // Nullable since migration 040 — Meta never gives us a number.
      phone: null,
      name: profile?.name ?? `${channel}:${externalId.slice(-6)}`,
      avatar_url: profile?.avatarUrl ?? null,
    })
    .select()
    .single();

  if (error) {
    // Concurrent delivery won the race against the partial unique
    // index; re-resolve rather than dropping the message.
    if (isUniqueViolation(error)) {
      const { data: raced } = await supabaseAdmin()
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .eq('channel', channel)
        .eq('external_id', externalId)
        .limit(1);
      if (raced && raced.length > 0) return raced[0];
    }
    console.error('[meta/webhook] contact create failed:', error);
    return null;
  }

  return created;
}

async function fetchMetaProfile(
  externalId: string,
  pageToken: string,
  channel: MetaChannel,
): Promise<{ name: string | null; avatarUrl: string | null } | null> {
  try {
    const url = new URL(`${GRAPH}/${externalId}`);
    url.searchParams.set(
      'fields',
      channel === 'instagram' ? 'name,username,profile_pic' : 'name,profile_pic',
    );
    url.searchParams.set('access_token', pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const json = await res.json();
    return {
      name: json.name ?? json.username ?? null,
      avatarUrl: json.profile_pic ?? null,
    };
  } catch (err) {
    // A missing name is cosmetic — never let it cost us the message.
    console.warn('[meta/webhook] profile fetch failed:', err);
    return null;
  }
}

async function findOrCreateConversation(
  accountId: string,
  auditUserId: string,
  contactId: string,
  channel: MetaChannel,
): Promise<string | null> {
  const { data: existing } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (existing && existing.length > 0) return existing[0].id;

  const { data: created, error } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      contact_id: contactId,
      // Denormalised from the contact so the outbound send path can
      // pick an API without joining (migration 040).
      channel,
      status: 'open',
    })
    .select('id')
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) return raced[0].id;
    }
    console.error('[meta/webhook] conversation create failed:', error);
    return null;
  }

  return created.id;
}
