import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProgress } from '../supabase-sync.js';
import { STORAGE_KEY, SESSION_STORAGE_KEY, BACKUP_KEY, backupBeforeUpgrade, loadSavedProgress, exportSnapshot } from '../progress-storage.mjs';

function storage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
const event = (n, correct = true) => ({ at: new Date(Date.UTC(2026, 8, n)).toISOString(), answer: correct ? 'B' : 'A', correct, confidence: correct ? 'low' : 'high' });
const profile = (attempts = {}) => ({ version: 1, attempts, daily: { '2026-10-12': { ids: ['old-id'] } }, mockHistory: [], settings: { dailyTarget: 150 }, updatedAt: '2026-10-12T00:00:00Z' });

test('upgrade snapshot preserves exact bytes, active answer and original progress; never overwrites snapshot', () => {
  const raw = JSON.stringify(profile({ old: { attempts: 2, wrong: 1, notes: '历史备注', history: [event(1, false), event(2)] } }), null, 2);
  const active = JSON.stringify({ queue: ['old', 'next'], queueIndex: 1, selected: ['C'], confidence: 'low', submitted: false, session: { mode: 'daily' } });
  const store = storage({ [STORAGE_KEY]: raw, [SESSION_STORAGE_KEY]: active });
  assert.deepEqual(loadSavedProgress(store), JSON.parse(raw));
  const backup = store.getItem(BACKUP_KEY);
  assert.equal(JSON.parse(backup).progress, raw);
  assert.equal(JSON.parse(backup).activeSession, active);
  assert.equal(store.getItem(STORAGE_KEY), raw);
  assert.equal(store.getItem(SESSION_STORAGE_KEY), active);
  store.setItem(STORAGE_KEY, JSON.stringify(profile()));
  backupBeforeUpgrade(store);
  assert.equal(store.getItem(BACKUP_KEY), backup);
  assert.equal(exportSnapshot(store).beforeUpgrade, backup);
});

test('corrupt/unknown data and a full disk stop loading without clearing original records', () => {
  for (const raw of ['{broken', JSON.stringify({ ...profile(), version: 2 })]) {
    const store = storage({ [STORAGE_KEY]: raw });
    assert.throws(() => loadSavedProgress(store));
    assert.equal(store.getItem(STORAGE_KEY), raw);
    assert.equal(JSON.parse(store.getItem(BACKUP_KEY)).progress, raw);
  }
  const raw = JSON.stringify(profile());
  const store = storage({ [STORAGE_KEY]: raw });
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => loadSavedProgress(store), /QuotaExceededError/);
  assert.equal(store.getItem(STORAGE_KEY), raw);
});

test('merging old/new device data retains all IDs, histories, notes, flags and daily unions', () => {
  const cloud = profile({ duplicateOriginal: { attempts: 2, correct: 1, wrong: 1, flagged: true, flaggedAt: event(1).at, history: [event(1, false), event(2)], notes: '不能丢', updatedAt: event(2).at }, onlyCloud: { attempts: 1 } });
  const local = profile({ duplicateOriginal: { attempts: 2, correct: 2, wrong: 0, flagged: false, flaggedAt: null, history: [event(2), event(3)], confidence: 'high', lastCorrect: true, updatedAt: event(3).at }, onlyLocal: { attempts: 1 } });
  local.daily['2026-10-12'].ids.push('new-id');
  cloud.extraLegacyField = { keep: true };
  const before = structuredClone([local, cloud]);
  const merged = mergeProgress(local, cloud);
  assert.deepEqual(Object.keys(merged.attempts).sort(), ['duplicateOriginal', 'onlyCloud', 'onlyLocal']);
  const attempt = merged.attempts.duplicateOriginal;
  assert.equal(attempt.history.length, 3);
  assert.equal(attempt.wrong, 1);
  assert.equal(attempt.correct, 2);
  assert.equal(attempt.attempts, 3);
  assert.equal(attempt.notes, '不能丢');
  assert.equal(attempt.flagged, true);
  assert.equal(attempt.flaggedAt, event(1).at);
  assert.equal(attempt.confidence, 'high');
  assert.deepEqual(merged.daily['2026-10-12'].ids.sort(), ['new-id', 'old-id']);
  assert.equal(merged.settings.dailyTarget, 150);
  assert.deepEqual(merged.extraLegacyField, { keep: true });
  assert.deepEqual(mergeProgress(merged, cloud).attempts, merged.attempts);
  assert.deepEqual([local, cloud], before);
});

test('no 12-event or 100-mock truncation; legacy lifetime counts never decrease', () => {
  const history = Array.from({ length: 30 }, (_, i) => event(i + 1));
  const local = profile({ q: { attempts: 60, correct: 60, wrong: 0, history, updatedAt: event(30).at } });
  const cloud = profile({ q: { attempts: 59, correct: 59, wrong: 0, history: history.slice(17, 29), updatedAt: event(29).at } });
  local.mockHistory = Array.from({ length: 130 }, (_, i) => ({ at: new Date(i * 86400000).toISOString(), subject: '基础知识' }));
  cloud.mockHistory = local.mockHistory.slice(0, 10);
  const merged = mergeProgress(local, cloud);
  assert.equal(merged.attempts.q.history.length, 30);
  assert.equal(merged.attempts.q.attempts, 60);
  assert.equal(merged.mockHistory.length, 130);
});
