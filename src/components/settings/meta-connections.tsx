'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  AtSign,
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2Off,
  Loader2,
  MessageCircle,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';

// Row shape of `meta_connections` (migration 040). Kept local rather
// than added to @/types until the send/webhook paths need it too —
// at that point hoist it so server and client agree on one definition.
interface MetaConnection {
  id: string;
  account_id: string;
  page_id: string;
  page_name: string | null;
  instagram_account_id: string | null;
  instagram_username: string | null;
  messenger_enabled: boolean;
  instagram_enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
  last_error: string | null;
  connected_at: string | null;
}

// Meta's OAuth dialog needs a public App ID, so it must be exposed to
// the browser (NEXT_PUBLIC_). The App *Secret* stays server-side and is
// never referenced here. When the var is absent we render a setup
// notice instead of a dead button — clicking Connect without an App ID
// would bounce off Meta with an opaque error.
const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID;

export function MetaConnections() {
  const t = useTranslations('Settings.meta');
  const supabase = createClient();
  const {
    accountId,
    loading: authLoading,
    profileLoading,
    canEditSettings,
  } = useAuth();

  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<MetaConnection | null>(null);
  const [savingToggle, setSavingToggle] = useState<
    'messenger' | 'instagram' | null
  >(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Same guard as whatsapp-config: Supabase fires onAuthStateChange on
  // tab refocus, which re-runs the load effect with a fresh `user`
  // object. Without this the panel refetches (and flickers) on every
  // focus even though nothing about the account changed.
  const loadedAccountIdRef = useRef<string | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/meta/webhook`
      : '';

  const fetchConnection = useCallback(
    async (acctId: string) => {
      setLoading(true);
      try {
        // One Page per account in practice, but the table allows more
        // than one row, so order deterministically and take the first
        // rather than `.maybeSingle()` (which errors on ≥2 rows).
        const { data, error } = await supabase
          .from('meta_connections')
          .select('*')
          .eq('account_id', acctId)
          .order('created_at', { ascending: true })
          .limit(1);

        if (error) {
          console.error('[meta] failed to load connection:', error);
          toast.error(t('loadError'));
        }

        setConnection(data && data.length > 0 ? (data[0] as MetaConnection) : null);
      } finally {
        setLoading(false);
      }
    },
    [supabase, t],
  );

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!accountId) {
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConnection(accountId);
  }, [accountId, authLoading, profileLoading, fetchConnection]);

  // Kicks off Facebook Login. The server route owns the scope list and
  // the state nonce — building the dialog URL here would put the
  // CSRF-protection burden on the client, where it can be tampered with.
  const handleConnect = () => {
    window.location.href = '/api/meta/connect';
  };

  const handleToggle = async (
    channel: 'messenger' | 'instagram',
    next: boolean,
  ) => {
    if (!connection) return;
    setSavingToggle(channel);
    const column = channel === 'messenger' ? 'messenger_enabled' : 'instagram_enabled';

    // Optimistic — the switch should feel instant. Rolled back below
    // if the write is rejected (RLS restricts UPDATE to admins).
    const previous = connection;
    setConnection({ ...connection, [column]: next });

    const { error } = await supabase
      .from('meta_connections')
      .update({ [column]: next })
      .eq('id', connection.id);

    setSavingToggle(null);
    if (error) {
      console.error('[meta] toggle failed:', error);
      setConnection(previous);
      toast.error(t('toggleError'));
      return;
    }
    toast.success(next ? t('channelEnabled') : t('channelDisabled'));
  };

  const handleDisconnect = async () => {
    if (!connection) return;
    if (!window.confirm(t('disconnectConfirm'))) return;

    setDisconnecting(true);
    // Delete rather than flip status: the Page Access Token is the only
    // thing of value in the row, and keeping a revoked one around is a
    // liability. Conversations and contacts are untouched — history
    // stays in the inbox, it just can't be replied to until reconnect.
    const { error } = await supabase
      .from('meta_connections')
      .delete()
      .eq('id', connection.id);

    setDisconnecting(false);
    if (error) {
      console.error('[meta] disconnect failed:', error);
      toast.error(t('disconnectError'));
      return;
    }
    setConnection(null);
    toast.success(t('disconnected'));
  };

  const copyWebhookUrl = () => {
    void navigator.clipboard.writeText(webhookUrl);
    toast.success(t('copied'));
  };

  if (loading) {
    return (
      <section>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const igLinked = Boolean(connection?.instagram_account_id);

  return (
    <section className="space-y-4">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!META_APP_ID ? (
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertTitle>{t('setupTitle')}</AlertTitle>
          <AlertDescription>{t('setupDesc')}</AlertDescription>
        </Alert>
      ) : null}

      {connection?.status === 'error' && connection.last_error ? (
        <Alert variant="destructive">
          <XCircle className="size-4" />
          <AlertTitle>{t('errorTitle')}</AlertTitle>
          <AlertDescription>{connection.last_error}</AlertDescription>
        </Alert>
      ) : null}

      {!connection ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">
              {t('connectTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('connectDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
              <div className="flex items-start gap-2">
                <MessageCircle className="mt-0.5 size-4 shrink-0" />
                <span>{t('requirementPage')}</span>
              </div>
              <div className="flex items-start gap-2">
                <AtSign className="mt-0.5 size-4 shrink-0" />
                <span>{t('requirementInstagram')}</span>
              </div>
            </div>

            <Button
              onClick={handleConnect}
              disabled={!canEditSettings || !META_APP_ID}
              title={canEditSettings ? undefined : t('readOnly')}
            >
              <ExternalLink className="size-4" />
              {t('connectButton')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                {connection.status === 'connected' ? (
                  <CheckCircle2 className="size-4 text-primary" />
                ) : (
                  <XCircle className="size-4 text-red-400" />
                )}
                {connection.page_name || t('unnamedPage')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('pageIdLabel', { id: connection.page_id })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Messenger — always available once a Page is linked. */}
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <Label className="flex items-center gap-2 text-foreground">
                    <MessageCircle className="size-4" />
                    {t('messenger')}
                  </Label>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('messengerDesc')}
                  </p>
                </div>
                <Switch
                  checked={connection.messenger_enabled}
                  onCheckedChange={(v: boolean) => handleToggle('messenger', v)}
                  disabled={!canEditSettings || savingToggle === 'messenger'}
                />
              </div>

              {/* Instagram — only meaningful when a professional IG
                  account is linked to the Page. Meta gives us no way to
                  attach one from here, so we point the user at the Page
                  settings rather than showing a switch that can't work. */}
              <div className="flex items-center justify-between gap-4 border-t border-border pt-5">
                <div className="min-w-0">
                  <Label className="flex items-center gap-2 text-foreground">
                    <AtSign className="size-4" />
                    {t('instagram')}
                  </Label>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {igLinked
                      ? t('instagramLinked', {
                          username: connection.instagram_username ?? '—',
                        })
                      : t('instagramNotLinked')}
                  </p>
                </div>
                <Switch
                  checked={connection.instagram_enabled && igLinked}
                  onCheckedChange={(v: boolean) => handleToggle('instagram', v)}
                  disabled={
                    !canEditSettings || !igLinked || savingToggle === 'instagram'
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">
                {t('dangerTitle')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('dangerDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="destructive"
                onClick={handleDisconnect}
                disabled={!canEditSettings || disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Link2Off className="size-4" />
                )}
                {t('disconnectButton')}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('webhookTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('webhookDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
            <div className="flex gap-2">
              <Input readOnly value={webhookUrl} className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={copyWebhookUrl}>
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
