import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';

const TABLE_NAME = 'study_states';
const SUPABASE_ESM_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

function latestAttemptTime(attempt) {
  const history = attempt?.history || [];
  const value = attempt?.updatedAt || history.at(-1)?.at || '';
  return value ? new Date(value).getTime() : 0;
}

function mergeAttempt(local, cloud) {
  if (!local || !cloud) return local || cloud;
  if (JSON.stringify(local) === JSON.stringify(cloud)) return local;
  const newer = latestAttemptTime(local) >= latestAttemptTime(cloud) ? local : cloud;
  const older = newer === local ? cloud : local;
  const events = new Map();
  for (const event of [...(older.history || []), ...(newer.history || [])]) {
    const key = JSON.stringify([event.at, event.answer, event.correct, event.confidence]);
    events.set(key, { ...events.get(key), ...event });
  }
  const history = [...events.values()].sort((a, b) => new Date(a.at) - new Date(b.at));
  const correct = Math.max(local.correct || 0, cloud.correct || 0, history.filter((e) => e.correct === true).length);
  const wrong = Math.max(local.wrong || 0, cloud.wrong || 0, history.filter((e) => e.correct === false).length);
  return {
    ...older,
    ...newer,
    // Legacy clients retained only 12 events. Keep their lifetime counts as
    // lower bounds, and retain every event still available on either device.
    attempts: Math.max(local.attempts || 0, cloud.attempts || 0, history.length, correct + wrong),
    correct,
    wrong,
    flagged: local.flagged === true || cloud.flagged === true,
    flaggedAt: newer.flaggedAt || older.flaggedAt || null,
    history,
  };
}

export function mergeProgress(localValue, cloudValue) {
  const local = localValue || {};
  const cloud = cloudValue || {};
  const attempts = { ...(cloud.attempts || {}) };

  Object.entries(local.attempts || {}).forEach(([id, attempt]) => {
    attempts[id] = mergeAttempt(attempt, attempts[id]);
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
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

  const localUpdated = new Date(local.updatedAt || 0).getTime();
  const cloudUpdated = new Date(cloud.updatedAt || 0).getTime();
  const settings = localUpdated >= cloudUpdated
    ? { ...(cloud.settings || {}), ...(local.settings || {}) }
    : { ...(local.settings || {}), ...(cloud.settings || {}) };

  return {
    ...cloud,
    ...local,
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

      const localAtRead = JSON.stringify(getProgress());
      const merged = mergeProgress(JSON.parse(localAtRead), data?.progress);
      const { error: writeError } = await client
        .from(TABLE_NAME)
        .upsert({ user_id: user.id, progress: merged, updated_at: merged.updatedAt }, { onConflict: 'user_id' });
      if (writeError) throw writeError;

      // Answers can be submitted while the upload is in flight. Reconcile
      // against the live local state again before applying the response.
      const live = getProgress();
      if (JSON.stringify(live) !== localAtRead) rerunRequested = true;
      setProgress(mergeProgress(live, merged));
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
