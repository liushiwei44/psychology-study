import { createCloudSync } from './supabase-sync.js?v=20261013';
import { normalizeLegacyReviewState, planReview } from './study-rules.mjs';
import { buildQuestionIndex, buildPracticeQueue, questionId, isUsable, isDueForReview, selectDueQuestions, selectNewQuestions } from './study-queues.mjs?v=20261109a';
import { STORAGE_KEY, SESSION_STORAGE_KEY, BACKUP_KEY, FEATURE_BACKUP_KEY, loadSavedProgress, exportSnapshot } from './progress-storage.mjs?v=20261103a';
import { PRACTICE_TYPES, flattenCases, selectSpecialtyQuestions, buildExamPaper, gradeExam } from './exam-engine.mjs?v=20261109a';
const DAILY_DEFAULT = 50;
const EXAM_DATE = new Date('2026-12-05T00:00:00');

const app = document.querySelector('#app-view');
const viewLabel = document.querySelector('#view-label');
const navWrongCount = document.querySelector('#nav-wrong-count');
const daysLeftEl = document.querySelector('#days-left');
const toast = document.querySelector('#toast');
const sidebar = document.querySelector('#sidebar');
const menuButton = document.querySelector('#menu-button');
const sidebarScrim = document.querySelector('#sidebar-scrim');
const syncStatusEl = document.querySelector('#sync-status');
const authButton = document.querySelector('#auth-button');

let cloudSync = null;
let cloudUser = null;
let syncState = 'local';

function setSidebarOpen(open) {
  sidebar.classList.toggle('open', open);
  document.body.classList.toggle('menu-open', open);
  menuButton?.setAttribute('aria-expanded', String(open));
  menuButton?.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
}

function scrollToTop() {
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  window.setTimeout(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, 60);
}

const state = {
  questions: [],
  questionIndex: null,
  report: null,
  examConfig: null,
  progress: null,
  view: 'dashboard',
  queue: [],
  queueIndex: 0,
  selected: new Set(),
  confidence: 'high',
  submitted: false,
  session: null,
  timerId: null,
  timerSeconds: 0,
  filters: { wrongType: 'all', wrongStatus: 'all', specialtyScope: 'new' },
};

const labels = {
  dashboard: '今日计划',
  practice: '刷题与专项',
  wrong: '错题本',
  mock: '分科模拟',
  stats: '学习统计',
};

function loadProgress() {
  const saved = loadSavedProgress(localStorage);
  if (saved) {
    return {
      ...saved,
      attempts: saved.attempts || {},
      daily: saved.daily || {},
      mockHistory: saved.mockHistory || [],
      settings: { dailyTarget: DAILY_DEFAULT, ...(saved.settings || {}) },
      updatedAt: saved.updatedAt || new Date().toISOString(),
    };
  }
  return {
    version: 1,
    attempts: {},
    daily: {},
    mockHistory: [],
    settings: { dailyTarget: DAILY_DEFAULT },
    updatedAt: new Date().toISOString(),
  };
}

function saveProgress() {
  state.progress.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
  } catch (error) {
    toastMessage('本机保存失败，请保留此页面并在学习统计中导出记录备份。');
    throw error;
  }
  cloudSync?.schedule();
  updateShellStats();
}

function applyCloudProgress(progress) {
  const previous = JSON.stringify({
    attempts: state.progress.attempts,
    daily: state.progress.daily,
    mockHistory: state.progress.mockHistory,
    settings: state.progress.settings,
  });
  state.progress = progress;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  const next = JSON.stringify({
    attempts: progress.attempts,
    daily: progress.daily,
    mockHistory: progress.mockHistory,
    settings: progress.settings,
  });
  // Avoid a second full-page animation when sync only refreshes metadata.
  if (state.questions.length && previous !== next) {
    // Cloud reconciliation can happen while a practice round is open. The
    // generic renderer would replace the question screen with the launcher,
    // which looks like the session randomly exited. Keep the active round on
    // screen and only refresh its data underneath.
    if (state.view === 'practice' && state.session && state.queue.length) renderPractice();
    else if (state.session?.mode === 'mock-summary' && state.view === 'mock') renderMockSummary(state.session.result);
    else render({ animate: false });
  }
}

function saveActiveSession() {
  if (!state.session || !state.queue.length) return;
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    savedAt: Date.now(),
    session: state.session,
    queue: state.queue,
    queueIndex: state.queueIndex,
    selected: [...state.selected],
    confidence: state.confidence,
    submitted: state.submitted,
    timerSeconds: state.timerSeconds,
  }));
}

function clearActiveSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

function restoreActiveSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || 'null');
    if (!saved) return false;
    if (!saved.session || !Array.isArray(saved.queue) || !saved.queue.length) throw new Error('活动轮次格式异常');
    if (!saved.queue.every((id) => state.questions.some((q) => questionId(q) === id))) {
      throw new Error('活动轮次包含暂未加载的题目');
    }
    state.session = saved.session;
    state.queue = saved.queue;
    state.queueIndex = Math.min(Math.max(Number(saved.queueIndex) || 0, 0), state.queue.length - 1);
    state.selected = new Set(Array.isArray(saved.selected) ? saved.selected : []);
    state.confidence = saved.confidence || 'high';
    state.submitted = Boolean(saved.submitted);
    state.view = 'practice';
    if (state.session.mode === 'mock') {
      const elapsed = Math.max(0, Math.floor((Date.now() - Number(saved.savedAt || Date.now())) / 1000));
      startTimer(Math.max(0, (Number(saved.timerSeconds) || 0) - elapsed));
    }
    return true;
  } catch (error) {
    throw new Error(`${error.message}；已停止恢复，原始轮次未清空，请先导出学习记录。`);
  }
}

function updateSyncShell() {
  if (!syncStatusEl || !authButton) return;
  const labelsByState = {
    local: cloudSync?.configured ? '云同步未登录' : '仅保存在本机',
    syncing: '正在同步…',
    synced: '云端已同步',
    error: '同步暂不可用 · 已存本机',
  };
  syncStatusEl.innerHTML = `<i></i> ${labelsByState[syncState] || labelsByState.local}`;
  syncStatusEl.dataset.state = syncState;
  authButton.textContent = cloudUser?.displayName
    || (syncState === 'error' ? '同步不可用' : cloudSync?.configured ? '登录同步' : '配置同步');
  authButton.title = cloudUser ? '点击退出云同步账号' : '使用 GitHub 登录并同步学习记录';
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function todayKey() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function daysLeft() {
  return Math.max(0, Math.ceil((EXAM_DATE - new Date()) / 86400000));
}

function getAttempt(q) {
  const id = questionId(q);
  const saved = state.progress.attempts[id] || {};
  return normalizeLegacyReviewState({
    attempts: 0,
    correct: 0,
    wrong: 0,
    lastAnswer: '',
    lastCorrect: null,
    confidence: null,
    reviewPending: null,
    status: 'new',
    dueAt: null,
    history: [],
    flagged: false,
    flaggedAt: null,
    updatedAt: null,
    ...saved,
    history: saved.history || [],
  });
}

function isWrongBookEntry(attempt) {
  return attempt.wrong > 0 || attempt.flagged === true;
}

function wrongBookReason(attempt) {
  if (attempt.wrong > 0) return `错 ${attempt.wrong} 次`;
  return '手动加入';
}

function typeLabel(type) {
  return ({ single: '单选题', multiple: '多选题', judgment: '判断题', case_single: '案例摘要单选', case_multiple: '案例分析（不定项）' })[type] || type;
}

function typeShort(type) {
  return ({ single: '单选', multiple: '多选', judgment: '判断', case_single: '案例单选', case_multiple: '案例不定项' })[type] || type;
}

function questionReference(q) {
  return `${typeShort(q.type)} · ${q.case_id ? '案例题号' : '原题号'} ${q.source_question_no}`;
}

function reviewTypeSummary(questions) {
  return PRACTICE_TYPES.map((type) => {
    const count = questions.filter((q) => q.type === type).length;
    return count ? `${typeShort(type)} ${count} 道` : '';
  }).filter(Boolean).join(' · ') || '暂无到期题';
}

function formatDate(value) {
  if (!value) return '尚未安排';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value));
}

function formatReviewTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function formatSeconds(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function normalizeAnswer(value) {
  return String(value || '').replace(/[^A-D]/g, '').split('').sort().join('');
}

function getCorrectKeys(q) {
  if (q.type === 'judgment') return [q.answer];
  return normalizeAnswer(q.answer).split('');
}

function isCorrect(q, selected) {
  if (q.type === 'judgment') return selected.has(q.answer);
  const actual = [...selected].sort().join('');
  return actual === normalizeAnswer(q.answer);
}

function currentQuestion() {
  return state.questions.find((q) => questionId(q) === state.queue[state.queueIndex]);
}

function relevantQuestions() {
  return state.questions.filter((q) => isUsable(q) && (q.type === 'single' || q.type === 'multiple'));
}

function dueQuestions() {
  return selectDueQuestions(state.questions, getAttempt);
}

function coreGroups() {
  return state.questionIndex.groups.filter((group) => ['single', 'multiple'].includes(group[0].type));
}

function uniqueCoverage() {
  const groups = coreGroups();
  return { total: groups.length, covered: groups.filter((g) => g.some((q) => getAttempt(q).attempts > 0)).length };
}

function reviewStatus(attempt) {
  if (attempt.status === 'mastered') return '已掌握';
  if (attempt.lastCorrect === true && attempt.confidence === 'high') return '有把握 · 暂缓复习';
  if (isDueForReview(attempt)) return attempt.dueAt ? `已到期 · ${formatReviewTime(attempt.dueAt)}` : '已到期';
  if (!attempt.dueAt) return '尚未安排';
  return `下次 ${formatReviewTime(attempt.dueAt)}`;
}

function dueWrongBookQuestions() {
  return dueQuestions().filter((q) => isWrongBookEntry(getAttempt(q)));
}

function updateShellStats() {
  const wrong = state.questions.filter((q) => {
    const a = getAttempt(q);
    return isWrongBookEntry(a) && a.status !== 'mastered';
  }).length;
  navWrongCount.textContent = wrong;
  daysLeftEl.textContent = daysLeft();
  updateSyncShell();
}

function toastMessage(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastMessage.timer);
  toastMessage.timer = window.setTimeout(() => toast.classList.remove('show'), 2200);
}

function downloadProgress(upgradeOnly = false) {
  const snapshot = exportSnapshot(localStorage);
  if (state.progress && JSON.stringify(state.progress) !== snapshot.progress) snapshot.inMemoryProgress = state.progress;
  const saved = upgradeOnly ? localStorage.getItem(FEATURE_BACKUP_KEY) || localStorage.getItem(BACKUP_KEY) : JSON.stringify(snapshot, null, 2);
  if (!saved) { toastMessage('本机没有升级前记录；当前记录可用另一个按钮导出。'); return; }
  const url = URL.createObjectURL(new Blob([saved], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `psychology-${upgradeOnly ? 'before-upgrade' : 'progress'}-${todayKey()}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function startTimer(seconds) {
  window.clearInterval(state.timerId);
  state.timerSeconds = seconds;
  state.timerId = window.setInterval(() => {
    if (state.timerSeconds > 0) {
      state.timerSeconds -= 1;
      const timer = document.querySelector('#session-timer');
      if (timer) timer.textContent = formatSeconds(state.timerSeconds);
    }
    if (state.timerSeconds === 0 && state.session?.mode === 'mock') {
      window.clearInterval(state.timerId);
      toastMessage('时间到，模拟已自动交卷。');
      finalizeMock();
    }
  }, 1000);
}

function stopTimer() {
  window.clearInterval(state.timerId);
  state.timerId = null;
}

function render({ animate = true } = {}) {
  app.classList.toggle('no-animate', !animate);
  viewLabel.textContent = labels[state.view] || '';
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === state.view));
  if (state.view === 'dashboard') renderDashboard();
  if (state.view === 'practice') renderPracticeLauncher();
  if (state.view === 'wrong') renderWrong();
  if (state.view === 'mock') renderMock();
  if (state.view === 'stats') renderStats();
  updateShellStats();
}

function renderDashboard() {
  const core = relevantQuestions();
  const coverage = uniqueCoverage();
  const attempts = core.filter((q) => getAttempt(q).attempts > 0).length;
  const today = state.progress.daily[todayKey()] || { ids: [] };
  const target = state.progress.settings.dailyTarget || DAILY_DEFAULT;
  const todayDone = today.ids.length;
  const dueList = dueQuestions();
  const due = dueList.length;
  const correct = Object.values(state.progress.attempts).reduce((sum, a) => sum + (a.correct || 0), 0);
  const totalAttempts = Object.values(state.progress.attempts).reduce((sum, a) => sum + (a.attempts || 0), 0);
  const accuracy = totalAttempts ? Math.round((correct / totalAttempts) * 100) : 0;
  const progress = core.length ? Math.round((attempts / core.length) * 100) : 0;
  const dailyProgress = target ? Math.min(100, Math.round((todayDone / target) * 100)) : 0;
  const reportSources = state.report?.sources || {};
  const singleCount = core.filter((q) => q.type === 'single').length;
  const judgmentCount = state.questions.filter((q) => isUsable(q) && q.type === 'judgment').length;
  const multipleCount = core.filter((q) => q.type === 'multiple').length;
  const parsedSingle = reportSources['最新版【单选题+判断题】.pdf']?.type_counts?.single || singleCount;
  const parsedJudgment = reportSources['最新版【单选题+判断题】.pdf']?.type_counts?.judgment || judgmentCount;
  const parsedMultiple = reportSources['最新版【多选题】.pdf']?.type_counts?.multiple || multipleCount;
  const qualityIssueCount = state.report?.quality_issue_count || 0;

  app.innerHTML = `
    <section class="hero-row">
      <div>
        <p class="kicker">Field notes / 01</p>
        <h2 class="page-title">今天，先把<strong>${target}</strong>道题<br /><em>变成自己的判断。</em></h2>
        <p class="hero-copy">这不是和答案赛跑的题库，而是一张会记住你犹豫过哪里的学习地图。先完成首刷，再让错题在需要的时候回来。</p>
      </div>
      <div class="date-stamp"><strong>${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</strong>距离考试 ${daysLeft()} 天</div>
    </section>

    <div class="grid dashboard-grid">
      <article class="panel daily-card">
        <div><p class="kicker">Daily dispatch</p><h2>今日计划<br /><em>${todayDone} / ${target}</em> 已完成</h2></div>
        <div class="daily-meta"><div class="progress-ring" style="--progress:${dailyProgress}%"><span>${dailyProgress}%</span></div><p><strong>${due} 道</strong>到期复习<br />为待复习总量，每轮最多 10 道。</p></div>
        <div><button class="btn btn-primary" data-action="start-daily">${todayDone >= target ? '再来一轮' : '开始今日刷题'} →</button><p class="stat-detail">每轮 ${target} 题，开头合计最多 10 道到期复习；同一复习优先级内按题型轮换，其余做新题。每天可连续多轮。</p><p class="stat-detail">到期分布：${reviewTypeSummary(dueList)}</p></div>
      </article>
      <article class="panel card-pad stat-card"><span class="label">首刷覆盖 / core bank</span><div class="stat-number">${attempts.toLocaleString()}<small> / ${core.length.toLocaleString()}</small></div><div><p class="stat-detail">已覆盖 ${progress}% 原题 · 历史口径保留</p><p class="stat-detail">去重后还需 ${coverage.total - coverage.covered} 道新题</p><div class="accent-line"></div></div></article>
      <article class="panel card-pad stat-card"><span class="label">作答准确率 / all attempts</span><div class="stat-number">${accuracy}<small>%</small></div><div><p class="stat-detail">基于 ${totalAttempts.toLocaleString()} 次作答</p><p class="stat-detail">全部题型累计已做 ${Object.values(state.progress.attempts).filter((a) => a.attempts > 0).length.toLocaleString()} 题 · 含案例与判断</p><div class="accent-line" style="background:var(--sage)"></div></div></article>
    </div>

    <div class="section-heading"><h3>题库的骨架</h3><button data-action="go-stats">查看完整统计 ↗</button></div>
    <div class="grid topic-grid">
      ${topicCard('单项选择', singleCount, parsedSingle, singleCount === parsedSingle ? '考试核心' : `${parsedSingle - singleCount} 道待确认`, 'orange')}
      ${topicCard('多项选择', multipleCount, parsedMultiple, multipleCount === parsedMultiple ? '考试核心' : `${parsedMultiple - multipleCount} 道待确认`, 'sage')}
      ${topicCard('判断辨析', judgmentCount, parsedJudgment, '辅助训练', 'ink')}
      ${topicCard('案例训练', state.questions.filter((q) => q.case_id).length, state.questions.filter((q) => q.case_id).length, '自编 · 非官方真题', 'sage')}
    </div>

    <div class="panel card-pad specialty-callout"><div><h3>换一种题型，继续积累</h3><p class="stat-detail">可直接练多选、案例摘要单选和案例不定项。新题计入累计与错题，原来的首刷进度继续保留。</p></div><button class="btn btn-primary" data-action="go-practice">选择专项 →</button></div>

    ${qualityIssueCount ? `<div class="tip-box" style="margin-top:18px"><strong>题库质检提醒</strong>${qualityIssueCount} 道题的 PDF 原文存在选项或答案异常，已暂不进入首刷/错题复习/模拟；系统保留原题号，待人工核对后再放开。</div>` : ''}

    <div class="section-heading"><h3>最近的学习痕迹</h3><button data-action="go-wrong">去错题本 ↗</button></div>
    <div class="panel card-pad"><div class="queue-list">${recentQueueHtml()}</div></div>
  `;
}

function topicCard(name, count, total, tag, tone) {
  const width = total ? Math.min(100, Math.round((count / total) * 100)) : 0;
  return `<article class="panel topic-card"><span class="topic-mark">${tone === 'muted' ? '—' : String(count).padStart(4, '0')}</span><h4>${name}</h4><p>${tag}</p><div class="topic-meter"><span style="width:${width}%;background:${tone === 'orange' ? 'var(--orange)' : tone === 'sage' ? 'var(--sage)' : tone === 'ink' ? 'var(--ink)' : '#c4cbc8'}"></span></div></article>`;
}

function recentQueueHtml() {
  const recent = Object.entries(state.progress.attempts)
    .filter(([, a]) => a.attempts)
    .sort((a, b) => new Date(b[1].history?.at(-1)?.at || 0) - new Date(a[1].history?.at(-1)?.at || 0))
    .slice(0, 4)
    .map(([id, a], index) => {
      const q = state.questions.find((item) => questionId(item) === id);
      if (!q) return '';
      return `<div class="queue-item"><span class="queue-index">0${index + 1}</span><div class="queue-info"><strong>${escapeHtml(q.stem)}</strong><span>${escapeHtml(questionReference(q))} · ${a.lastCorrect ? '已答对' : '待复习'}</span></div><span class="pill ${a.lastCorrect ? '' : 'warning'}">${a.lastCorrect ? 'OK' : '复习'}</span></div>`;
    }).join('');
  return recent || '<div class="empty-state" style="padding:30px"><div class="empty-symbol">○</div><p>还没有作答记录，今天从第一题开始。</p></div>';
}

function renderPracticeLauncher() {
  const dueList = dueQuestions();
  const due = dueList.length;
  const target = state.progress.settings.dailyTarget || DAILY_DEFAULT;
  app.innerHTML = `
    <section class="hero-row"><div><p class="kicker">Practice room / 02</p><h2 class="page-title">换一种题型，<br /><em>继续向前。</em></h2><p class="hero-copy">直接选择多选、案例单选或不定项。每次新作答都计入总进度，错题和把握程度继续积累。</p></div><div class="date-stamp"><strong>${target} 题</strong>每轮新题上限</div></section>
    ${specialtyHtml()}
    <div class="section-heading"><h3>继续综合首刷与复习</h3></div>
    <div class="grid mock-grid">
      <article class="panel mock-card"><span class="mock-badge">FIRST PASS / 首刷</span><h3>今日新题</h3><p>每轮最多 10 道到期复习，其余安排去重后的新题。达到今日目标仍可继续开下一轮。</p><div class="mock-meta"><div><strong>${target}</strong><span>今日目标</span></div><div><strong>${selectNewQuestions(state.questionIndex, getAttempt).length.toLocaleString()}</strong><span>去重后尚未首刷</span></div></div><button class="btn btn-primary" data-action="start-daily">开始首刷 →</button></article>
      <article class="panel mock-card"><span class="mock-badge">RETURN / 回看</span><h3>到期复习</h3><p>汇总所有专项的到期题，合计每轮最多10道。先错题、再蒙题、再模糊题；同一优先级内按题型轮流取题，不足由其他题型补足。</p><p class="stat-detail">${reviewTypeSummary(dueList)}</p><div class="mock-meta"><div><strong>${due}</strong><span>当前到期</span></div><div><strong>≤ 10</strong><span>每轮复习上限</span></div></div><button class="btn btn-ghost" data-action="start-wrong">进入复习 →</button></article>
    </div>
    <div class="tip-box" style="margin-top:18px"><strong>统一复习规则</strong>各专项错题答错后24小时到期；蒙对3天后、模糊答对7天后复查。到期后进入新开一轮的前面，所有题型合计最多10道；错题内按题型轮换，同题型仍优先多次答错、到期较早的题。已开始的一轮保持原顺序。判断题可进入日常复习，不计入两科模拟。</div>
  `;
}

function specialtyHtml() {
  const cards = [
    ['multiple', '多项选择专项', '直接从多选题开始，不必等单选做完。日常练习全选对才记正确。'],
    ['case_single', '案例摘要单选', '先读独立案例材料，再选择一个最佳答案。'],
    ['case_multiple', '案例分析 · 不定项', '一个案例带问题；每题可能有一个或多个正确选项。'],
    ['single', '单项选择专项', '继续原来的单选新题，保留全部历史题号。'],
    ['judgment', '判断辨析专项', '辅助巩固概念，不计入两科模拟卷。'],
  ];
  return `<div class="section-heading" id="specialty"><h3>按题型专项练习</h3><label class="label">练习范围 <select id="specialty-scope" class="select-like"><option value="new" ${state.filters.specialtyScope === 'new' ? 'selected' : ''}>优先未做 · 新题专项</option><option value="review" ${state.filters.specialtyScope === 'review' ? 'selected' : ''}>已做巩固 · 每轮最多10题</option></select></label></div>
    <div class="grid specialty-grid">${cards.map(([type, title, copy]) => {
      const groups = state.questionIndex.groups.filter((g) => g[0].type === type);
      const covered = groups.filter((g) => g.some((q) => getAttempt(q).attempts > 0)).length;
      const available = state.filters.specialtyScope === 'new' ? groups.length - covered : covered;
      return `<article class="panel mock-card"><span class="mock-badge">${type.startsWith('case_') ? '自编训练 · 非官方真题' : '原PDF题库'}</span><h3>${title}</h3><p>${copy}</p><p class="stat-detail">已覆盖 ${covered} / ${groups.length} 组 · 当前范围 ${available} 题</p><button class="btn ${type === 'multiple' ? 'btn-primary' : 'btn-ghost'}" data-action="start-specialty" data-type="${type}" ${available ? '' : 'disabled'}>${state.filters.specialtyScope === 'new' ? '开始新题' : '巩固已做'} →</button></article>`;
    }).join('')}</div><div class="tip-box" style="margin-top:18px"><strong>案例题来源</strong>新增18个自编案例、108道问题，含基础知识与专业技能。每道问题使用固定ID，专项与模拟共用同一份记录；材料与答案不是官方真题或官方样题。<p>备考建议：11月3日—20日优先多选，每天60—80道，再加10—20道案例；到期复习每轮最多10道。11月21日—12月4日穿插两科限时训练，依据错题补缺。可按自己的时间拆成多轮。</p></div>`;
}

function renderPractice() {
  const q = currentQuestion();
  if (!q) { renderPracticeLauncher(); return; }
  const total = state.queue.length;
  const index = state.queueIndex + 1;
  const attempt = getAttempt(q);
  const sessionLabel = state.session?.mode === 'mock' ? `${state.session.paper?.title || state.session.subject} · 模拟` : state.session?.mode === 'specialty' ? `${typeLabel(state.session.type)}专项` : state.session?.mode === 'wrong' || state.session?.mode === 'wrong-book' ? '错题复习' : '今日首刷';
  const isMock = state.session?.mode === 'mock';
  viewLabel.textContent = isMock ? labels.mock : labels.practice;
  const reveal = state.submitted && !isMock;
  const reviewIds = state.session?.reviewIds;
  const roundDetail = isMock ? '' : reviewIds
    ? `本轮 ${reviewIds.length} 道复习 · ${total - reviewIds.length} 道新题`
    : '已恢复升级前未完成的一轮；每轮最多 10 道复习从下一轮生效。';
  const questionKind = !isMock && reviewIds ? (reviewIds.includes(questionId(q)) ? '复习' : '新题') : '';
  const answerConflict = state.questionIndex.conflicts.some((group) => group.includes(q));
  const selectedAnswer = [...state.selected].sort().join('');
  const correctKeys = getCorrectKeys(q);
  const optionsHtml = q.options.map((option) => {
    const selected = state.selected.has(option.key);
    const correct = reveal && correctKeys.includes(option.key);
    const incorrect = reveal && selected && !correct;
    const classes = ['option'];
    if (selected) classes.push('selected');
    if (correct) classes.push('correct');
    if (incorrect) classes.push('incorrect');
    return `<button type="button" class="${classes.join(' ')}" data-option="${escapeHtml(option.key)}" aria-pressed="${selected}" ${state.submitted ? 'disabled' : ''}><span class="option-key" aria-hidden="true">${escapeHtml(option.key)}</span><span class="option-text">${escapeHtml(option.text)}</span></button>`;
  }).join('');
  const result = state.submitted ? isCorrect(q, state.selected) : null;
  const inWrongBook = isWrongBookEntry(attempt);
  const wrongBookButton = attempt.status === 'mastered'
    ? '<button class="btn btn-confirmed" type="button" disabled>✓ 已掌握</button>'
    : inWrongBook
      ? '<button class="btn btn-confirmed" type="button" disabled>✓ 已加入错题本</button>'
      : '<button class="btn btn-ghost" type="button" data-action="flag-question">加入错题本</button>';
  const explanation = reveal ? `<div class="explanation" role="status" aria-live="polite"><span class="answer-chip">正确答案 · ${escapeHtml(q.answer)}</span><h4>${result ? '这一题，稳稳拿下。' : '这道题先留下，下一轮再见。'}</h4><p>${escapeHtml(q.explanation || '这道题暂时没有解析，请在复习时补充自己的理解。')}</p></div>` : '';

  app.innerHTML = `
    <div class="practice-top"><span class="session-tag">${escapeHtml(sessionLabel)} / ${typeShort(q.type)}${questionKind ? ` · ${questionKind}` : ''}</span><span class="session-progress">${isMock ? '本卷' : '本轮'} ${index} / ${total} 题${isMock ? ` · <b id="session-timer">${formatSeconds(state.timerSeconds)}</b>` : ''}</span></div>
    ${roundDetail ? `<p class="stat-detail">${roundDetail}</p>` : ''}
    <div class="question-layout">
      <article class="panel question-card">
        <span class="question-no">${escapeHtml(questionReference(q))}</span><p class="question-source">来源：${escapeHtml(q.source_file)}</p>
        ${q.case_material ? `<section class="case-material" aria-label="案例材料"><span class="label">${escapeHtml(q.subject)} · ${escapeHtml(q.topic)} · 自编训练</span><h3>${escapeHtml(q.case_title)}</h3><p>${escapeHtml(q.case_material)}</p></section>` : ''}
        <h2 class="question-stem">${escapeHtml(q.stem)}</h2>
        <p class="stat-detail">${['single', 'case_single'].includes(q.type) ? '请选择一个最佳答案。' : q.type === 'case_multiple' ? '不定项：可能有一个或多个正确选项；全对得分，漏选、多选、错选均不得分。' : q.type === 'multiple' ? `请选择全部正确选项。${isMock && state.session.paper ? '本卷全对1分，漏选0.5分，错选0分。' : '日常练习全选对才记正确，漏选也进入错题本。'}` : '请选择正确或错误。'}</p>
        ${answerConflict ? '<p class="tip-box"><strong>待人工确认</strong>这道题与另一原题的选项一致、源答案不同。当前按本题原答案记录，核对结果前保留两题。</p>' : ''}
        <div class="options">${optionsHtml}</div>
        ${explanation}
        <div class="question-actions">
          ${!state.submitted ? `<div class="confidence-row"><span>我的把握</span>${['high','medium','low'].map((level) => `<button class="${state.confidence === level ? 'active' : ''}" data-confidence="${level}">${level === 'high' ? '有把握' : level === 'medium' ? '模糊' : '蒙的'}</button>`).join('')}</div>` : `<div class="confidence-row"><span>${isMock ? '本题已保存，交卷后统一评分' : result ? '已记录正确' : '已进入错题本'}</span></div>`}
          <div class="action-cluster">${!state.submitted ? `${isMock ? '<button class="btn btn-ghost" data-action="finish-mock">提前交卷</button><button class="btn btn-ghost" data-action="skip-mock">暂跳过</button>' : '<button class="btn btn-ghost" data-action="quit-session">退出</button>'}<button class="btn btn-primary" data-action="submit-answer" ${state.selected.size ? '' : 'disabled'}>${isMock ? '保存本题' : '提交答案'} ↗</button>` : `${isMock ? '' : wrongBookButton}<button class="btn btn-primary" data-action="next-question">${isMock && index === total ? '完成并交卷' : '下一题'} →</button>`}</div>
        </div>
      </article>
      <aside class="side-stack"><div class="panel side-panel"><h4>这次作答</h4><div class="tiny-row"><span>选择</span><strong>${selectedAnswer || '—'}</strong></div><div class="tiny-row"><span>题型</span><strong>${typeShort(q.type)}</strong></div>${isMock ? '<p class="stat-detail">答案、解析与历史错题在交卷前隐藏。刷新可继续，计时包含离开页面的时间。</p>' : `<div class="tiny-row"><span>历史作答</span><strong>${attempt.attempts} 次</strong></div><div class="tiny-row"><span>下次复习</span><strong>${escapeHtml(reviewStatus(attempt))}</strong></div>`}</div>${isMock && state.session.paper ? `<div class="panel side-panel"><h4>答题卡 · ${Object.keys(state.session.answers).length}/${total}</h4><div class="answer-grid">${state.queue.map((id, n) => `<button class="${state.session.answers[id] ? 'answered' : ''} ${n === state.queueIndex ? 'current' : ''}" data-action="jump-mock" data-index="${n}" aria-label="第${n + 1}题${state.session.answers[id] ? '已作答' : '未作答'}">${n + 1}</button>`).join('')}</div><button class="btn btn-ghost" data-action="finish-mock">交卷并查看解析</button></div>` : '<div class="tip-box"><strong>每种题型，一起积累</strong>专项练习与模拟沿用同一份作答、把握程度和永久错题记录。</div>'}</aside>
    </div>
  `;
}

function renderWrong() {
  const wrong = state.questions.filter((q) => {
    const a = getAttempt(q);
    const typeOk = state.filters.wrongType === 'all' || q.type === state.filters.wrongType;
    const statusOk = state.filters.wrongStatus === 'all' || a.status === state.filters.wrongStatus;
    return isWrongBookEntry(a) && typeOk && statusOk;
  }).sort((a, b) => getAttempt(b).wrong - getAttempt(a).wrong);
  const activeWrongCount = state.questions.filter((q) => {
    const attempt = getAttempt(q);
    return isWrongBookEntry(attempt) && attempt.status !== 'mastered';
  }).length;
  const dueCount = dueWrongBookQuestions().length;
  app.innerHTML = `
    <section class="hero-row"><div><p class="kicker">Recovery room / 03</p><h2 class="page-title">错题会回来，<br /><em>你也会更稳。</em></h2><p class="hero-copy">这里永久保留答错和手动加入的题，包括重复原题。答对且有把握的题暂缓自动复习，原状态和历史仍保留。</p></div><div class="date-stamp"><strong>${activeWrongCount}</strong>道未掌握题</div></section>
    <div class="toolbar"><select class="select-like" id="wrong-type-filter" aria-label="按题型筛选"><option value="all">全部题型</option><option value="single">单选题</option><option value="multiple">多选题</option><option value="judgment">判断题</option><option value="case_single">案例摘要单选</option><option value="case_multiple">案例分析（不定项）</option></select><select class="select-like" id="wrong-status-filter" aria-label="按状态筛选"><option value="all">全部状态</option><option value="new">待复习</option><option value="reviewing">复习中</option><option value="mastered">已掌握</option></select>${dueCount ? `<button class="btn btn-primary" data-action="start-wrong-book">复习到期错题（共 ${dueCount} 道，每轮最多 10 道）→</button>` : ''}</div>
    <div class="tip-box" style="margin-bottom:18px"><strong>题号怎么看</strong>单选和多选各自从1编号，判断题沿用原PDF的4001起始号；“本轮”是本次练习的位置。请结合题型与来源核对，同号的单选和多选分别记录。</div>
    <div class="panel">${wrong.length ? wrong.map((q) => { const a = getAttempt(q); return `<div class="wrong-row"><span class="number" title="${escapeHtml(questionReference(q))}"><span>${typeShort(q.type)}</span><strong>${q.case_id ? '案例' : '原题'} ${escapeHtml(q.source_question_no)}</strong></span><div class="stem-mini" title="${escapeHtml(q.stem)}">${escapeHtml(q.stem)}<span class="question-source">来源：${escapeHtml(q.source_file)}</span></div><small>${wrongBookReason(a)}</small><span class="pill ${a.status === 'mastered' ? '' : 'warning'}">${escapeHtml(reviewStatus(a))}</span></div>`; }).join('') : '<div class="empty-state"><div class="empty-symbol">✓</div><h3>错题本还是空的</h3><p>答错或手动加入的题，会保留在这里。</p></div>'}</div>
  `;
  document.querySelector('#wrong-type-filter').value = state.filters.wrongType;
  document.querySelector('#wrong-status-filter').value = state.filters.wrongStatus;
}

function renderMock() {
  const history = state.progress.mockHistory || [];
  app.innerHTML = `
    <section class="hero-row"><div><p class="kicker">Simulation desk / 04</p><h2 class="page-title">按科目练习，<br /><em>把两小时用好。</em></h2><p class="hero-copy">按你提供的题型截图准备两科各3套固定训练卷。每科120分钟、满分100分、60分通过训练线；交卷后统一评分。</p></div><div class="date-stamp"><strong>6 套</strong>基础95题 · 技能90题</div></section>
    <div class="tip-box"><strong>训练模板 · 题量分值待官方核验</strong>${escapeHtml(state.examConfig.notice)}</div>
    <div class="grid mock-grid" style="margin-top:20px">${state.examConfig.templates.map((template) => `<article class="panel mock-card"><span class="mock-badge">${template.subject === '基础知识' ? 'SUBJECT A' : 'SUBJECT B'} / 截图训练模板</span><h3>${template.subject}</h3><div class="blueprint">${template.sections.map((section) => `<div class="tiny-row"><span>${section.label}</span><strong>${section.count}题 × ${section.points}分</strong></div>`).join('')}</div><p>每套${template.sections.reduce((sum, section) => sum + section.count, 0)}题 · ${template.minutes}分钟 · 100分</p><div class="paper-actions">${Array.from({ length: template.sets }, (_, i) => `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-ghost'}" data-action="start-mock" data-template="${template.id}" data-set="${i + 1}">训练卷 ${i + 1} →</button>`).join('')}</div></article>`).join('')}</div>
    <div class="tip-box" style="margin-top:18px"><strong>计分与累计</strong>单选：全对1分；多选：全对1分、漏选0.5分、错选0分；案例不定项：全对2分，漏选/多选/错选0分。部分得分仍记为未完全答对并进入错题本。已作答题在交卷后计入今日与累计；未作答计0分但不算首刷。</div>
    <div class="section-heading"><h3>官方参考资料</h3><span class="label">核对于2026-11-03</span></div>
    <div class="panel card-pad resource-links">${state.examConfig.sources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)} ↗</a>`).join('')}<p class="stat-detail">本次检索未找到可直接下载的官方完整真题或模拟卷。大纲与公开课用于复习参考，不是本站自编题的官方背书。</p><a href="./data/exam-inventory.json" download>下载题库与训练考点盘点 ↗</a></div>
    <div class="section-heading"><h3>最近模拟</h3><span class="label">${history.length} 次记录</span></div>
    <div class="panel card-pad">${history.length ? history.slice().reverse().slice(0, 10).map((item) => `<div class="queue-item"><span class="queue-index">${formatDate(item.at)}</span><div class="queue-info"><strong>${escapeHtml(item.paperTitle || item.subject)} · ${item.correct}/${item.total}题全对</strong><span>${item.scoringVersion ? '按截图模板' : '旧版等权估算'} ${item.score}分 · ${item.duration}分钟</span></div>${item.scoringVersion ? `<button class="btn btn-ghost" data-action="view-mock-result" data-result="${escapeHtml(item.at)}">查看报告</button>` : ''}<span class="pill ${item.score >= 60 ? '' : 'warning'}">${item.score >= 60 ? '达到训练线' : '继续训练'}</span></div>`).join('') : '<p class="stat-detail">完成后保留成绩、逐题作答及分项报告。</p>'}</div>`;
}

function renderStats() {
  const allCore = relevantQuestions();
  const coverage = uniqueCoverage();
  const duplicateCount = allCore.length - coverage.total;
  const practiced = allCore.filter((q) => getAttempt(q).attempts > 0).length;
  const correct = Object.values(state.progress.attempts).reduce((sum, a) => sum + (a.correct || 0), 0);
  const total = Object.values(state.progress.attempts).reduce((sum, a) => sum + (a.attempts || 0), 0);
  const accuracy = total ? Math.round((correct / total) * 100) : 0;
  const byType = PRACTICE_TYPES.map((type) => {
    const list = state.questions.filter((q) => q.type === type && isUsable(q));
    const attempts = list.reduce((sum, q) => sum + getAttempt(q).attempts, 0);
    const correctType = list.reduce((sum, q) => sum + getAttempt(q).correct, 0);
    return { type, count: list.length, practiced: list.filter((q) => getAttempt(q).attempts).length, accuracy: attempts ? Math.round((correctType / attempts) * 100) : 0 };
  });
  const qualityIssues = state.report?.quality_issues || [];
  const max = Math.max(...byType.map((x) => x.count), 1);
  app.innerHTML = `
    <section class="hero-row"><div><p class="kicker">Learning ledger / 05</p><h2 class="page-title">不是分数，<br /><em>是可见的进步。</em></h2><p class="hero-copy">首刷覆盖告诉你走了多远，准确率告诉你哪里还需要回来。新增专项和案例与原记录一起累计；原PDF核心首刷口径保留，案例单独展示覆盖。</p></div><div class="date-stamp"><strong>${practiced.toLocaleString()} / ${allCore.length.toLocaleString()}</strong>核心题已首刷</div></section>
    <div class="grid stats-grid"><article class="panel radial-stat"><span class="label">CORE COVERAGE / 首刷覆盖</span><div class="big-percent">${allCore.length ? Math.round(practiced / allCore.length * 100) : 0}<small>%</small></div><h3>${practiced.toLocaleString()} 道已留下痕迹</h3></article><article class="panel radial-stat"><span class="label">ACCURACY / 作答准确率</span><div class="big-percent" style="color:var(--sage)">${accuracy}<small>%</small></div><h3>基于 ${total.toLocaleString()} 次作答</h3></article></div>
    <div class="section-heading"><h3>按题型看进度</h3><span class="label">MVP live data</span></div>
    <div class="panel bar-chart"><h3>每一种题型，都有自己的节奏</h3>${byType.map((x) => `<div class="bar"><span>${typeLabel(x.type)}</span><div class="bar-track"><span style="width:${Math.round(x.count / max * 100)}%;background:${x.type === 'multiple' ? 'var(--sage)' : x.type === 'judgment' ? 'var(--ink)' : 'var(--orange)'}"></span></div><em>${x.practiced}/${x.count}</em></div><div class="bar" style="margin-top:-5px"><span style="font-size:9px;color:#99a2a5">准确率</span><div class="bar-track" style="height:4px"><span style="width:${x.accuracy}%;background:#9aa6a5"></span></div><em>${x.accuracy}%</em></div>`).join('')}</div>
    <div class="section-heading"><h3>本地数据</h3><span class="label">本机优先 · 登录后同步</span></div>
    <div class="panel card-pad"><div class="tiny-row"><span>PDF 实际解析</span><strong>${state.report.total_parsed.toLocaleString()}</strong></div><div class="tiny-row"><span>全部累计已做题数（含案例/判断）</span><strong>${Object.values(state.progress.attempts).filter((a) => a.attempts > 0).length}</strong></div><div class="tiny-row"><span>自编案例问题数</span><strong>${state.questions.filter((q) => q.case_id).length}</strong></div><div class="tiny-row"><span>可进入练习（含案例）</span><strong>${state.questions.filter(isUsable).length.toLocaleString()}</strong></div><div class="tiny-row"><span>待人工确认</span><strong>${state.report?.quality_issue_count || 0}</strong></div><div class="tiny-row"><span>当前到期复习总量</span><strong>${dueQuestions().length}</strong></div><div class="tiny-row"><span>模拟次数</span><strong>${(state.progress.mockHistory || []).length}</strong></div><div class="tiny-row"><span>今日目标 / 每轮题量</span><strong>${state.progress.settings.dailyTarget || DAILY_DEFAULT} 题</strong></div><div style="margin-top:18px"><label class="label" for="daily-target">调整每日目标 / 每轮题量（达到目标后仍可继续）</label><div style="display:flex;gap:9px;margin-top:8px"><input id="daily-target" class="input-like" name="dailyTarget" type="number" inputmode="numeric" autocomplete="off" min="10" max="300" value="${state.progress.settings.dailyTarget || DAILY_DEFAULT}" /><button class="btn btn-ghost" data-action="save-target">保存目标</button></div></div><div style="margin-top:18px;padding-top:15px;border-top:1px solid var(--line)"><button class="btn btn-primary" data-action="export-progress">导出学习记录备份</button> <button class="btn btn-ghost" data-action="export-upgrade-backup">导出本次升级前备份</button></div></div>
    <div class="section-heading"><h3>题库去重核对</h3><a href="./data/duplicate_report.json" download>下载核对报告 ↗</a></div>
    <div class="panel card-pad"><div class="tiny-row"><span>核心题可练原题</span><strong>${allCore.length}</strong></div><div class="tiny-row"><span>首刷过滤的确认重复副本</span><strong>${duplicateCount}</strong></div><div class="tiny-row"><span>去重后核心题覆盖</span><strong>${coverage.covered} / ${coverage.total}</strong></div><p class="stat-detail">题型、题干、选项及正确答案内容一致才合并首刷。同组任意原题已做过，就不再安排同组新题；所有原题的错题、蒙题与作答记录仍分别保留。</p><p class="stat-detail">同题干但选项不同的题继续保留，不按字面相似擅自删除。</p>${state.questionIndex.conflicts.map((group) => `<div class="tip-box"><strong>答案冲突 · 待人工确认</strong>${escapeHtml(group[0].stem)}<p>${group.map((q) => `${typeShort(q.type)} Q${q.source_question_no}：${q.answer}`).join('；')}。原题均保留，暂未合并。</p></div>`).join('')}</div>
    ${qualityIssues.length ? `<div class="section-heading"><h3>待人工确认的源题</h3><span class="label">不会静默修补</span></div><div class="panel card-pad">${qualityIssues.map((item) => `<div class="queue-item"><span class="queue-index">Q${String(item.source_question_no).padStart(4, '0')}</span><div class="queue-info"><strong>${escapeHtml(item.stem)}</strong><span>${typeLabel(item.type)} · ${escapeHtml(item.warnings.join('、'))}</span></div><span class="pill warning">暂不练习</span></div>`).join('')}</div>` : ''}
  `;
}

function buildDailyQueue() {
  return buildPracticeQueue({
    index: state.questionIndex, getAttempt, due: dueQuestions(),
    todayIds: state.progress.daily[todayKey()]?.ids || [],
    target: state.progress.settings.dailyTarget || DAILY_DEFAULT,
  });
}

function buildWrongQueue() {
  return buildReviewQueue(dueQuestions());
}

function buildWrongBookQueue() {
  return buildReviewQueue(dueWrongBookQuestions());
}

function buildReviewQueue(due) {
  return buildPracticeQueue({
    index: state.questionIndex, getAttempt, due, reviewOnly: true,
    todayIds: state.progress.daily[todayKey()]?.ids || [],
    target: state.progress.settings.dailyTarget || DAILY_DEFAULT,
  });
}

function startSession(mode, subject = '', options = {}) {
  let paper = null;
  let template = null;
  let queue;
  try {
    if (mode === 'mock') {
      template = state.examConfig.templates.find((t) => t.id === options.templateId || (!options.templateId && t.subject === (subject || '基础知识')));
      if (!template) throw new Error('未找到考试训练模板。');
      paper = buildExamPaper(state.questionIndex, template, options.setNumber || 1);
      subject = template.subject;
      queue = paper.entries.map((entry) => entry.id);
    } else if (mode === 'specialty') {
      queue = selectSpecialtyQuestions(state.questionIndex, getAttempt, options.type, state.progress.settings.dailyTarget || DAILY_DEFAULT, state.filters.specialtyScope);
    } else queue = mode === 'daily' ? buildDailyQueue() : mode === 'wrong' ? buildWrongQueue() : buildWrongBookQueue();
  } catch (error) { toastMessage(error.message); return; }
  if (!queue.length) { toastMessage('当前范围没有可用题目，请选择其他题型或切换到已做巩固。'); return; }
  stopTimer();
  state.session = { mode, subject, type: options.type, startedAt: Date.now(), answers: {}, ...(paper ? { paper, template: JSON.parse(JSON.stringify(template)) } : {}) };
  state.queue = queue;
  if ((mode === 'wrong' || mode === 'wrong-book') && !state.queue.some((id) => state.progress.attempts[id]?.attempts > 0)) {
    state.session.mode = 'daily';
    toastMessage('当前无需复习，已为你安排新题。');
  }
  state.session.reviewIds = state.queue.filter((id) => state.progress.attempts[id]?.attempts > 0);
  state.queueIndex = 0;
  state.selected = new Set();
  state.confidence = 'high';
  state.submitted = false;
  state.view = 'practice';
  setSidebarOpen(false);
  if (mode === 'mock') startTimer(template.minutes * 60);
  saveActiveSession();
  renderPractice();
  scrollToTop();
}

function resetQuestion() {
  state.selected = new Set();
  state.confidence = 'high';
  state.submitted = false;
  saveActiveSession();
}

function appendAnswer(q, selected, confidence) {
  const id = questionId(q);
  const correct = isCorrect(q, selected);
  const previous = getAttempt(q);
  const now = new Date().toISOString();
  const reviewPlan = planReview(previous, { correct, confidence });
  const answer = q.type === 'judgment' ? [...selected][0] || '' : [...selected].sort().join('');
  state.progress.attempts[id] = {
    ...previous,
    attempts: previous.attempts + 1,
    correct: previous.correct + (correct ? 1 : 0),
    wrong: previous.wrong + (correct ? 0 : 1),
    lastAnswer: answer, lastCorrect: correct, confidence,
    status: reviewPlan.status, dueAt: reviewPlan.dueAt, reviewPending: reviewPlan.reviewPending,
    history: [...(previous.history || []), { at: now, answer, correct, confidence }],
    updatedAt: now,
  };
  const key = todayKey();
  state.progress.daily[key] ||= { ids: [] };
  if (!state.progress.daily[key].ids.includes(id)) state.progress.daily[key].ids.push(id);
  return correct;
}

function recordAnswer() {
  const q = currentQuestion();
  if (!q || state.submitted || !state.selected.size) return;
  const id = questionId(q);
  if (state.session?.mode === 'mock' && state.session.paper) {
    state.session.answers[id] = { selected: [...state.selected], confidence: state.confidence };
    state.submitted = true;
    saveActiveSession();
    return;
  }
  const correct = appendAnswer(q, state.selected, state.confidence);
  if (state.session?.mode === 'mock') state.session.answers[id] = { answered: true, correct };
  saveProgress();
  state.submitted = true;
  saveActiveSession();
}

function jumpMock(index) {
  if (state.session?.mode !== 'mock' || !state.session.paper || !Number.isInteger(index) || index < 0 || index >= state.queue.length) return;
  if (state.selected.size && !state.submitted) recordAnswer();
  else if (!state.submitted) delete state.session.answers[state.queue[state.queueIndex]];
  state.queueIndex = index;
  const answer = state.session.answers[state.queue[index]];
  state.selected = new Set(answer?.selected || []);
  state.confidence = answer?.confidence || 'high';
  state.submitted = false;
  saveActiveSession();
  renderPractice();
  scrollToTop();
}

function flagCurrentQuestion() {
  const q = currentQuestion();
  if (!q || !state.submitted) return;
  const id = questionId(q);
  const previous = getAttempt(q);
  if (isWrongBookEntry(previous)) {
    toastMessage('这道题已经在错题本里。');
    return;
  }
  const now = new Date().toISOString();
  state.progress.attempts[id] = {
    ...previous,
    flagged: true,
    flaggedAt: now,
    updatedAt: now,
    status: previous.status === 'mastered' ? 'reviewing' : previous.status,
    dueAt: now,
  };
  saveProgress();
  saveActiveSession();
  renderPractice();
  toastMessage('已加入错题本，左侧数量已更新。');
}

function nextQuestion() {
  if (state.queueIndex >= state.queue.length - 1) {
    if (state.session?.mode === 'mock') return finalizeMock();
    stopTimer();
    toastMessage('这一轮完成，做得漂亮。');
    clearActiveSession();
    state.session = null;
    state.queue = [];
    state.view = 'dashboard';
    render();
    return;
  }
  if (state.session?.mode === 'mock' && state.session.paper) { jumpMock(state.queueIndex + 1); return; }
  state.queueIndex += 1;
  resetQuestion();
  renderPractice();
  saveActiveSession();
  scrollToTop();
}

function finalizeMock() {
  if (!state.session || state.session.mode !== 'mock') return;
  const current = currentQuestion();
  if (current && state.selected.size) recordAnswer();
  else if (current && state.session.paper && !state.submitted) {
    delete state.session.answers[questionId(current)];
    saveActiveSession();
  }
  const duration = Math.max(1, Math.round((Date.now() - state.session.startedAt) / 60000));
  let result;
  if (state.session.paper) {
    const graded = gradeExam(state.session.paper.entries, state.questions, state.session.answers);
    result = { ...graded, at: new Date().toISOString(), subject: state.session.subject,
      paperTitle: state.session.paper.title, paperId: state.session.paper.id, scoringVersion: 'screenshot-20261103',
      template: state.session.template, passScore: state.session.template.passScore, duration };
  } else {
    // Legacy in-flight mocks already saved attempts per question. Never record them again.
    const correct = state.queue.filter((id) => state.session.answers[id]?.correct === true).length;
    result = { at: new Date().toISOString(), subject: state.session.subject, correct, total: state.queue.length,
      score: Math.round(correct / Math.max(1, state.queue.length) * 100), duration };
  }
  const before = state.progress;
  state.progress = JSON.parse(JSON.stringify(before));
  try {
    if (state.session.paper) {
      const byId = new Map(state.questions.map((q) => [questionId(q), q]));
      for (const row of result.rows.filter((r) => r.answered)) appendAnswer(byId.get(row.id), new Set(row.answer), row.confidence);
    }
    state.progress.mockHistory ||= [];
    state.progress.mockHistory.push(result);
    saveProgress();
  } catch (error) {
    state.progress = before;
    toastMessage('交卷保存失败，草稿仍保留；请导出备份后重试。');
    return;
  }
  stopTimer();
  clearActiveSession();
  state.session = { ...state.session, mode: 'mock-summary', result };
  state.queue = [];
  state.submitted = true;
  renderMockSummary(result);
}

function renderMockSummary(result) {
  state.view = 'mock';
  viewLabel.textContent = labels.mock;
  const table = (rows) => `<div class="report-table"><table><thead><tr><th>分类</th><th>全对 / 题量</th><th>得分 / 满分</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${r.correct} / ${r.total}</td><td>${r.score} / ${r.maxScore}</td></tr>`).join('')}</tbody></table></div>`;
  app.innerHTML = `<section class="hero-row"><div><p class="kicker">Simulation report / complete</p><h2 class="page-title">这一场，<br /><em>留下可复习的线索。</em></h2><p class="hero-copy">${result.scoringVersion ? `按用户截图训练模板计分，题量分值待官方核验。已作答题计入今日和累计，未全对题进入永久错题本。未作答${result.unanswered}题，计0分但不算首刷。` : '这是升级前的60题等权训练分，原记录继续保留。'}</p></div><div class="date-stamp"><strong>${result.score} 分</strong>${escapeHtml(result.paperTitle || result.subject)}</div></section><div class="grid stats-grid"><article class="panel radial-stat"><span class="label">SCORE / ${result.scoringVersion ? '截图训练模板' : '旧版等权估算'}</span><div class="big-percent">${result.score}<small>分</small></div><h3>${result.correct}/${result.total}题全对 · ${result.score >= (result.passScore || 60) ? '达到训练通过线' : '还需巩固'}</h3></article><article class="panel radial-stat"><span class="label">TIME / 用时</span><div class="big-percent" style="color:var(--sage)">${result.duration}<small> min</small></div><h3>单科训练线${result.passScore || 60}分；两科需分别达标</h3></article></div>
    ${result.sections ? `<div class="section-heading"><h3>按题型看得分</h3></div><div class="panel card-pad">${table(result.sections)}</div><div class="section-heading"><h3>训练考点</h3><span class="label">原题关键词粗分 · 非官方标签</span></div><div class="panel card-pad">${table(result.topics)}</div>` : ''}
    <div class="toolbar" style="margin-top:22px"><button class="btn btn-primary" data-action="go-mock">回到模拟中心 →</button><button class="btn btn-ghost" data-action="go-wrong">去看错题本</button></div>
    ${result.rows ? `<div class="section-heading"><h3>逐题答案与解析</h3><span class="label">全部${result.rows.length}题已保留</span></div><div class="panel card-pad">${result.rows.map((row, i) => {
      const q = state.questions.find((item) => questionId(item) === row.id);
      if (!q) return '';
      return `<details class="answer-review"><summary>${i + 1}. ${row.correct ? '✓' : row.answered ? '需复习' : '未作答'} · ${row.score}/${row.points}分 · ${escapeHtml(q.stem)}</summary>${q.case_material ? `<div class="case-material"><h4>${escapeHtml(q.case_title)}</h4><p>${escapeHtml(q.case_material)}</p></div>` : ''}<p>${q.options.map((o) => `${escapeHtml(o.key)}. ${escapeHtml(o.text)}`).join('<br>')}</p><p>你的答案：${escapeHtml(row.answer.join('') || '未作答')} · 正确答案：${escapeHtml(q.answer)}</p><p>${escapeHtml(q.explanation || '原题暂无解析。')}</p><small>${escapeHtml(questionReference(q))} · ${escapeHtml(q.source_file)}</small></details>`;
    }).join('')}</div>` : ''}`;
}

document.addEventListener('click', (event) => {
  const backupAction = event.target.closest('[data-action]')?.dataset.action;
  if (backupAction === 'export-progress' || backupAction === 'export-upgrade-backup') {
    downloadProgress(backupAction === 'export-upgrade-backup');
    return;
  }
  if (!state.progress || !state.questionIndex) return;
  const nav = event.target.closest('[data-view]');
  if (nav) {
    if (state.session?.mode === 'mock') { toastMessage('模拟期间请使用答题卡切题，交卷后再打开其他页面。'); return; }
    stopTimer();
    clearActiveSession();
    state.session = null;
    state.queue = [];
    state.view = nav.dataset.view;
    setSidebarOpen(false);
    render();
    scrollToTop();
    return;
  }
  const option = event.target.closest('[data-option]');
  if (option && !state.submitted) {
    const q = currentQuestion();
    if (['single', 'case_single', 'judgment'].includes(q?.type)) state.selected = new Set([option.dataset.option]);
    else if (state.selected.has(option.dataset.option)) state.selected.delete(option.dataset.option);
    else state.selected.add(option.dataset.option);
    saveActiveSession();
    renderPractice();
    return;
  }
  const confidence = event.target.closest('[data-confidence]');
  if (confidence && !state.submitted) {
    state.confidence = confidence.dataset.confidence;
    saveActiveSession();
    renderPractice();
    return;
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const name = action.dataset.action;
  if (name === 'start-daily') startSession('daily');
  if (name === 'start-wrong') startSession('wrong');
  if (name === 'start-wrong-book') startSession('wrong-book');
  if (name === 'start-specialty') startSession('specialty', '', { type: action.dataset.type });
  if (name === 'start-mock') startSession('mock', '', { templateId: action.dataset.template, setNumber: Number(action.dataset.set) });
  if (name === 'submit-answer') { recordAnswer(); renderPractice(); }
  if (name === 'next-question') nextQuestion();
  if (name === 'quit-session') { stopTimer(); clearActiveSession(); state.session = null; state.queue = []; state.view = 'dashboard'; render(); }
  if (name === 'finish-mock') finalizeMock();
  if (name === 'jump-mock') jumpMock(Number(action.dataset.index));
  if (name === 'skip-mock') jumpMock((state.queueIndex + 1) % state.queue.length);
  if (name === 'flag-question') flagCurrentQuestion();
  if (name === 'go-wrong') { state.view = 'wrong'; render(); }
  if (name === 'go-stats') { state.view = 'stats'; render(); }
  if (name === 'go-practice') { state.view = 'practice'; render(); }
  if (name === 'view-mock-result') {
    const result = state.progress.mockHistory.find((item) => item.at === action.dataset.result);
    if (result) renderMockSummary(result);
  }
  if (name === 'go-mock') { clearActiveSession(); state.view = 'mock'; state.session = null; render(); }
  if (name === 'save-target') {
    const value = Math.max(10, Math.min(300, Number(document.querySelector('#daily-target')?.value || DAILY_DEFAULT)));
    state.progress.settings.dailyTarget = value;
    saveProgress(); toastMessage(`每日目标和每轮题量已设为 ${value} 题，复习仍最多 10 道。`); render();
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'wrong-type-filter') { state.filters.wrongType = event.target.value; renderWrong(); }
  if (event.target.id === 'wrong-status-filter') { state.filters.wrongStatus = event.target.value; renderWrong(); }
  if (event.target.id === 'specialty-scope') { state.filters.specialtyScope = event.target.value; renderPracticeLauncher(); }
});

menuButton?.addEventListener('click', () => setSidebarOpen(!sidebar.classList.contains('open')));
sidebarScrim?.addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('click', (event) => {
  if (!sidebar.classList.contains('open')) return;
  if (sidebar.contains(event.target) || menuButton?.contains(event.target)) return;
  setSidebarOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidebar.classList.contains('open')) setSidebarOpen(false);
});

window.addEventListener('pagehide', saveActiveSession);
window.addEventListener('beforeunload', saveActiveSession);

authButton?.addEventListener('click', async () => {
  if (syncState === 'error' && !cloudSync) {
    toastMessage('云同步组件暂不可用，学习记录仍已安全保存在本机。');
    return;
  }
  if (!cloudSync?.configured) {
    toastMessage('请先在 config.js 填写 Supabase Project URL 和 publishable key。');
    return;
  }
  try {
    if (cloudUser) {
      if (!window.confirm(`确定退出账号 ${cloudUser.displayName} 吗？本机记录会继续保留。`)) return;
      await cloudSync.signOut();
      toastMessage('已退出云同步，本机记录仍然保留。');
    } else {
      await cloudSync.signInWithGitHub();
    }
  } catch (error) {
    toastMessage(`登录操作失败：${error.message}`);
  }
});

async function init() {
  try {
    state.progress = loadProgress();
  } catch (error) {
    app.innerHTML = `<div class="panel empty-state"><h3>已暂停加载以保护学习记录</h3><p>${escapeHtml(error.message)}</p><p>原始记录未清空。请先导出备份，再检查浏览器存储空间或联系维护者。</p><button class="btn btn-primary" data-action="export-progress">导出原始记录</button></div>`;
    return;
  }
  try {
    const responses = await Promise.all(['questions.json', 'import_report.json', 'case-exercises.json', 'exam-templates.json'].map((file) => fetch(`./data/${file}`)));
    if (responses.some((response) => response.ok === false)) throw new Error('题库文件未完整加载，请稍后刷新重试；学习记录未修改。');
    const [questions, report, cases, examConfig] = await Promise.all(responses.map((response) => response.json()));
    state.questions = [...questions, ...flattenCases(cases)];
    state.questionIndex = buildQuestionIndex(state.questions);
    state.report = report;
    state.examConfig = examConfig;
    if (restoreActiveSession()) {
      renderPractice();
      updateShellStats();
      toastMessage('已恢复上次未完成的刷题进度。');
    } else render();
  } catch (error) {
    app.innerHTML = `<div class="panel empty-state"><div class="empty-symbol">!</div><h3>加载未完成，学习记录已保留</h3><p>请稍后刷新重试。若仍无法恢复，请先导出原始记录备份。</p><p class="mono">${escapeHtml(error.message)}</p><button class="btn btn-primary" data-action="export-progress">导出原始记录</button></div>`;
    return;
  }

  try {
    cloudSync = await createCloudSync({
      getProgress: () => state.progress,
      setProgress: applyCloudProgress,
      onAuth: (user) => {
        const previousUserId = cloudUser?.id;
        cloudUser = user;
        updateSyncShell();
        if (user && previousUserId !== user.id) toastMessage('已登录，正在合并本机与云端学习记录。');
      },
      onStatus: (status) => {
        syncState = status;
        updateSyncShell();
      },
    });
    updateSyncShell();
  } catch (error) {
    console.error('Cloud sync initialization failed:', error);
    syncState = 'error';
    updateSyncShell();
    toastMessage('云同步暂不可用，已继续使用本机记录。');
  }
}

init();
