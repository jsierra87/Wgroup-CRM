import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/whatsapp/encryption';
import { STATE_COOKIE, metaRedirectUri } from '../connect/route';

// ============================================================
// GET /api/meta/callback — finish Facebook Login.
//
// Meta redirects here with `?code=...&state=...`. We:
//   1. verify `state` against the httpOnly cookie (CSRF),
//   2. exchange the code for a short-lived user token,
//   3. upgrade it to a long-lived user token,
//   4. list the Pages the user granted,
//   5. subscribe the chosen Page to our webhook,
//   6. store the Page token (encrypted) in `meta_connections`.
//
// Every failure path redirects back to the settings panel with a
// `?meta_error=` code rather than rendering JSON — the user started
// this from a settings screen and should land back on one.
// ============================================================

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Webhook fields we need on the Page. `messages` covers both
 *  Messenger and Instagram inbound; postbacks cover button taps. */
const SUBSCRIBED_FIELDS = ['messages', 'messaging_postbacks'].join(',');

interface MetaPage {
  id: string;
  name?: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

function back(request: Request, error?: string) {
  const url = new URL('/settings?tab=meta', request.url);
  if (error) url.searchParams.set('meta_error', error);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  // The user hit "Cancel" on Facebook's dialog. Not an error worth
  // shouting about — just take them back.
  if (searchParams.get('error')) return back(request);

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  // Always clear it: a nonce is single-use whether or not it matched.
  cookieStore.delete(STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    console.warn('[meta/callback] state mismatch or missing code');
    return back(request, 'state_mismatch');
  }

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  // Same secret the WhatsApp webhook already verifies signatures with —
  // one Meta app, one secret. Rename here if yours differs.
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('[meta/callback] missing META app credentials');
    return back(request, 'not_configured');
  }

  // ---- caller + account ---------------------------------------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', request.url));

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!profile?.account_id) return back(request, 'no_account');
  if (profile.account_role !== 'owner' && profile.account_role !== 'admin') {
    return back(request, 'forbidden');
  }

  try {
    // ---- 1. code → short-lived user token ---------------------
    const tokenUrl = new URL(`${GRAPH}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', appId);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('redirect_uri', metaRedirectUri(request.url));
    tokenUrl.searchParams.set('code', code);

    const tokenRes = await fetch(tokenUrl.toString());
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error('[meta/callback] code exchange failed:', tokenJson);
      return back(request, 'token_exchange_failed');
    }

    // ---- 2. short-lived → long-lived --------------------------
    // Matters more than it looks: Page tokens derived from a
    // SHORT-lived user token also expire in ~1 hour. Derived from a
    // long-lived one they don't expire at all, which is what we want
    // for a background webhook that must keep working unattended.
    const llUrl = new URL(`${GRAPH}/oauth/access_token`);
    llUrl.searchParams.set('grant_type', 'fb_exchange_token');
    llUrl.searchParams.set('client_id', appId);
    llUrl.searchParams.set('client_secret', appSecret);
    llUrl.searchParams.set('fb_exchange_token', tokenJson.access_token);

    const llRes = await fetch(llUrl.toString());
    const llJson = await llRes.json();
    const userToken: string = llJson.access_token ?? tokenJson.access_token;

    // ---- 3. list granted Pages --------------------------------
    const pagesUrl = new URL(`${GRAPH}/me/accounts`);
    pagesUrl.searchParams.set(
      'fields',
      'id,name,access_token,instagram_business_account{id,username}',
    );
    pagesUrl.searchParams.set('access_token', userToken);

    const pagesRes = await fetch(pagesUrl.toString());
    const pagesJson = await pagesRes.json();
    const pages: MetaPage[] = pagesJson.data ?? [];

    if (pages.length === 0) return back(request, 'no_pages');

    // KNOWN LIMITATION: we connect the single granted Page. If the
    // user grants several there's no way to know which one they meant,
    // and silently picking the first would quietly wire the wrong
    // inbox. Sending them back to grant one is blunt but not wrong.
    // Upgrade path: render a picker instead of redirecting.
    if (pages.length > 1) return back(request, 'multiple_pages');

    const page = pages[0];

    // ---- 4. subscribe the Page to our webhook -----------------
    // Without this Meta accepts the connection but never delivers a
    // single message — the most common "it saved but nothing arrives"
    // failure in this integration.
    const subUrl = new URL(`${GRAPH}/${page.id}/subscribed_apps`);
    subUrl.searchParams.set('subscribed_fields', SUBSCRIBED_FIELDS);
    subUrl.searchParams.set('access_token', page.access_token);

    const subRes = await fetch(subUrl.toString(), { method: 'POST' });
    const subJson = await subRes.json();
    if (!subRes.ok || !subJson.success) {
      console.error('[meta/callback] page subscribe failed:', subJson);
      return back(request, 'subscribe_failed');
    }

    // ---- 5. persist -------------------------------------------
    // RLS (migration 040) restricts INSERT/UPDATE to admins; we've
    // already checked the role above so this is belt-and-suspenders.
    const row = {
      account_id: profile.account_id,
      user_id: user.id,
      page_id: page.id,
      page_name: page.name ?? null,
      instagram_account_id: page.instagram_business_account?.id ?? null,
      instagram_username: page.instagram_business_account?.username ?? null,
      page_access_token: encrypt(page.access_token),
      status: 'connected' as const,
      last_error: null,
      connected_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('meta_connections')
      .upsert(row, { onConflict: 'page_id' });

    if (upsertErr) {
      // 23505 on page_id means another ACCOUNT already owns this Page.
      // The upsert can't resolve that (RLS hides the conflicting row),
      // so surface it as its own case rather than a generic failure.
      if (upsertErr.code === '23505') {
        return back(request, 'page_taken');
      }
      console.error('[meta/callback] persist failed:', upsertErr);
      return back(request, 'save_failed');
    }

    return back(request);
  } catch (err) {
    console.error('[meta/callback] unexpected error:', err);
    return back(request, 'unexpected');
  }
}
