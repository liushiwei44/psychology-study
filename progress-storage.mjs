export const STORAGE_KEY = 'psychology-study-progress-v1';
export const SESSION_STORAGE_KEY = 'psychology-active-session-v1';
export const BACKUP_KEY = 'psychology-study-backup-before-20261013';
export const FEATURE_BACKUP_KEY = 'psychology-study-backup-before-20261103';

export function backupBeforeUpgrade(storage) {
  const progress = storage.getItem(STORAGE_KEY);
  const activeSession = storage.getItem(SESSION_STORAGE_KEY);
  for (const key of [BACKUP_KEY, FEATURE_BACKUP_KEY]) {
    if (!(progress || activeSession) || storage.getItem(key)) continue;
    const snapshot = JSON.stringify({ savedAt: new Date().toISOString(), progress, activeSession });
    // Fail before any progress write if storage is full or unavailable.
    storage.setItem(key, snapshot);
    if (storage.getItem(key) !== snapshot) throw new Error('升级前备份未能保存');
  }
}

export function loadSavedProgress(storage) {
  backupBeforeUpgrade(storage);
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const saved = JSON.parse(raw);
  if (!saved || saved.version !== 1 || !saved.attempts || typeof saved.attempts !== 'object'
      || Array.isArray(saved.attempts)) {
    throw new Error('学习记录格式暂不支持，原数据已保留');
  }
  return saved;
}

export function exportSnapshot(storage) {
  return {
    exportedAt: new Date().toISOString(),
    progress: storage.getItem(STORAGE_KEY),
    activeSession: storage.getItem(SESSION_STORAGE_KEY),
    beforeUpgrade: storage.getItem(BACKUP_KEY),
    beforeSpecialtyUpgrade: storage.getItem(FEATURE_BACKUP_KEY),
  };
}
