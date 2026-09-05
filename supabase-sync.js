import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';

const TABLE_NAME = 'study_states';
const SUPABASE_ESM_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

function latestAttemptTime(attempt) {
  const history = attempt?.history || [];
  const value = attempt?.updatedAt || history.at(-1)?.at || '';
  return value ? new Date(value).getTime() : 0;
}

export function mergeProgress(localValue, cloudValue) {
  const local = localValue || {};
  const cloud = cloudValue || {};
  const attempts = { ...(cloud.attempts || {}) };

  Object.entries(local.attempts || {}).forEach(([id, attempt]) => {
    const cloudAttempt = attempts[id];
    if (!cloudAttempt || latestAttemptTime(attempt) >= latestAttemptTime(cloudAttempt)) {
      attempts[id] = attempt;
    }
  });

  const daily = { ...(cloud.daily || {}) };
  Object.entries(local.daily || {}).forEach(([date, entry]) => {
    const ids = new Set([...(daily[date]?.ids || []), ...(entry?.ids || [])]);
    daily[date] = { ...(daily[date] || {}), ...(entry || {}), ids: [...ids] };
  });

  const mockMap = new Map();
  [...(cloud.mockHistory || []), ...(local.mockHistory || [])].forEach((item) => {
    mockMap.set(`${item.at || ''}::${item.subject || ''}`, item);
  });
  const mockHistory = [...mockMap.values()]
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))
    .slice(-100);

  const localUpdated = new Date(local.updatedAt || 0).getTime();
  const cloudUpdated = new Date(cloud.updatedAt || 0).getTime();
  const settings = localUpdated >= cloudUpdated
    ? { ...(cloud.settings || {}), ...(local.settings || {}) }
    : { ...(local.settings || {}), ...(cloud.settings || {}) };

  return {
    version: Math.max(Number(local.version || 1), Number(cloud.version || 1)),
    attempts,
    daily,
    mockHistory,
    settings: { dailyTarget: 50, ...settings },
    updatedAt: new Date().toISOString(),
  };
}

function displayName(user) {
  return user?.user_metadata?.user_name
    || user?.user_metadata?.preferred_username
    || user?.email?.split('@')[0]
    || '已登录';
}

export async function createCloudSync({ getProgress, setProgress, onAuth, onStatus }) {
  const configured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
  if (!configured) {
    onStatus?.('local');
    onAuth?.(null);
    return {
      configured: false,
      getUser: () => null,
      schedule: () => {},
      signInWithGitHub: async () => { throw new Error('请先填写 config.js 中的 Supabase 配置。'); },
      signOut: async () => {},
      syncNow: async () => {},
    };
  }

  const { createClient } = await import(SUPABASE_ESM_URL);
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let user = null;
  let uploadTimer = null;
  let syncing = false;
  let rerunRequested = false;

  async function pushMergedState() {
    if (!user) return;
    if (syncing) {
      rerunRequested = true;
      return;
    }
    syncing = true;
    onStatus?.('syncing');
    try {
      const { data, error: readError } = await client
        .from(TABLE_NAME)
        .select('progress, updated_at')
        .eq('user_id', user.id)
        .maybeSingle();
      if (readError) throw readError;

      const merged = mergeProgress(getProgress(), data?.progress);
      const { error: writeError } = await client
        .from(TABLE_NAME)
        .upsert({ user_id: user.id, progress: merged, updated_at: merged.updatedAt }, { onConflict: 'user_id' });
      if (writeError) throw writeError;

      setProgress(merged);
      onStatus?.('synced');
    } catch (error) {
      console.error('Cloud sync failed:', error);
      onStatus?.('error', error);
    } finally {
      syncing = false;
      if (rerunRequested) {
        rerunRequested = false;
        window.setTimeout(pushMergedState, 0);
      }
    }
  }

  function schedule() {
    if (!user) return;
    window.clearTimeout(uploadTimer);
    uploadTimer = window.setTimeout(pushMergedState, 900);
  }

  function applySession(session) {
    user = session?.user || null;
    onAuth?.(user ? { ...user, displayName: displayName(user) } : null);
    if (user) window.setTimeout(pushMergedState, 0);
    else onStatus?.('local');
  }

  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) onStatus?.('error', sessionError);
  applySession(sessionData?.session || null);

  client.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => applySession(session), 0);
  });

  return {
    configured: true,
    getUser: () => user,
    schedule,
    syncNow: pushMergedState,
    async signInWithGitHub() {
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const { error } = await client.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo },
      });
      if (error) throw error;
    },
    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    },
  };
}
