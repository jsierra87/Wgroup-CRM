import { randomBytes } from 'crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';

// ============================================================
// GET /api/meta/connect — start Facebook Login.
//
// Builds the OAuth dialog URL and redirects. Deliberately server-side
// rather than assembled in the browser: the `state` nonce is the only
// thing standing between us and a CSRF that would attach an attacker's
// Facebook Page to the victim's account, and a client-built nonce is a
// nonce the attacker controls.
//
// The nonce is mirrored into an httpOnly cookie; the callback refuses
// to proceed unless Meta echoes back a `state` that matches it.
// ============================================================

// Keep in sync with the version used in src/lib/whatsapp/meta-api.ts.
// Meta deprecates versions on a ~2-year clock; running two different
// versions in one app is legal but makes debugging needlessly odd.
const GRAPH_VERSION = 'v21.0';

export const STATE_COOKIE = 'meta_oauth_state';

/**
 * Permissions requested. All four require App Review before they work
 * for anyone outside the app's own testers:
 *   pages_show_list          — enumerate the Pages the user admins
 *   pages_messaging          — send/receive Messenger messages
 *   pages_manage_metadata    — subscribe the Page to our webhook
 *   instagram_basic          — read the linked IG account
 *   instagram_manage_messages— send/receive Instagram DMs
 */
const SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_manage_messages',
].join(',');

/**
 * Absolute redirect URI. Meta matches this against the app's allowlist
 * byte-for-byte — a trailing slash or an http/https mismatch is enough
 * to fail. Prefer the explicit env var so preview deploys (which get a
 * random Vercel hostname) don't silently produce an unregistered URI.
 */
export function metaRedirectUri(requestUrl: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? new URL(requestUrl).origin;
  return `${base.replace(/\/$/, '')}/api/meta/callback`;
}

export async function GET(request: Request) {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  if (!appId) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_META_APP_ID is not configured' },
      { status: 500 },
    );
  }

  // Gate on role here, not only in RLS. RLS would reject the eventual
  // INSERT, but by then the user has already been bounced through
  // Facebook, granted permissions, and burned a code — failing at the
  // last step with a database error is a terrible way to say
  // "you're not an admin".
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!profile?.account_id) {
    return NextResponse.json({ error: 'No account found' }, { status: 403 });
  }
  if (profile.account_role !== 'owner' && profile.account_role !== 'admin') {
    return NextResponse.json(
      { error: 'Only admins can connect a Facebook Page' },
      { status: 403 },
    );
  }

  const state = randomBytes(32).toString('hex');

  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // `lax` (not `strict`): the callback arrives as a top-level GET
    // navigation from facebook.com, and `strict` would withhold the
    // cookie on that cross-site hop — the callback would then see no
    // state at all and reject every legitimate connection.
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes — long enough to click through, short
    // enough that a stale nonce can't be replayed later.
  });

  const dialog = new URL(
    `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
  );
  dialog.searchParams.set('client_id', appId);
  dialog.searchParams.set('redirect_uri', metaRedirectUri(request.url));
  dialog.searchParams.set('state', state);
  dialog.searchParams.set('scope', SCOPES);
  dialog.searchParams.set('response_type', 'code');

  return NextResponse.redirect(dialog.toString());
}
