import { createCloudSync } from './supabase-sync.js';

const STORAGE_KEY = 'psychology-study-progress-v1';
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
  report: null,
  progress: loadProgress(),
  view: 'dashboard',
  queue: [],
  queueIndex: 0,
  selected: new Set(),
  confidence: 'medium',
  submitted: false,
  session: null,
  timerId: null,
  timerSeconds: 0,
  filters: { wrongType: 'all', wrongStatus: 'all' },
};

const labels = {
  dashboard: '今日计划',
  practice: '开始刷题',
  wrong: '错题本',
  mock: '全真模拟',
  stats: '学习统计',
};

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.version === 1) {
      return {
        ...saved,
        attempts: saved.attempts || {},
        daily: saved.daily || {},
        mockHistory: saved.mockHistory || [],
        settings: { dailyTarget: DAILY_DEFAULT, ...(saved.settings || {}) },
        updatedAt: saved.updatedAt || new Date().toISOString(),
      };
    }
  } catch (_) { /* use a clean local profile */ }
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
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
  if (state.questions.length && previous !== next) render({ animate: false });
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

function questionId(q) {
  return `${q.source_file}::${q.source_question_no}`;
}

function getAttempt(q) {
  const id = questionId(q);
  const saved = state.progress.attempts[id] || {};
  return {
    attempts: 0,
    correct: 0,
    wrong: 0,
    lastAnswer: '',
    lastCorrect: null,
    confidence: null,
    status: 'new',
    dueAt: null,
    history: [],
    flagged: false,
    flaggedAt: null,
    updatedAt: null,
    ...saved,
    history: saved.history || [],
  };
}

function isWrongBookEntry(attempt) {
  return attempt.wrong > 0 || attempt.flagged === true;
}

function isReviewCandidate(attempt) {
  return isWrongBookEntry(attempt)
    || (attempt.attempts > 0 && (attempt.confidence === 'medium' || attempt.confidence === 'low'));
}

function wrongBookReason(attempt) {
  if (attempt.wrong > 0) return `错 ${attempt.wrong} 次`;
  return '手动加入';
}

function typeLabel(type) {
  return ({ single: '单选题', multiple: '多选题', judgment: '判断题' })[type] || type;
}

function typeShort(type) {
  return ({ single: '单选', multiple: '多选', judgment: '判断' })[type] || type;
}

function formatDate(value) {
  if (!value) return '尚未安排';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value));
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

const HARD_PARSE_WARNINGS = new Set([
  'missing_stem',
  'missing_answer',
  'too_few_options',
  'option_count_not_4',
  'duplicate_option_key',
  'answer_refers_to_missing_option',
]);

function isUsable(q) {
  return !(q.parse_warnings || []).some((warning) => HARD_PARSE_WARNINGS.has(warning));
}

function relevantQuestions() {
  return state.questions.filter((q) => isUsable(q) && (q.type === 'single' || q.type === 'multiple'));
}

function dueQuestions() {
  const now = Date.now();
  return state.questions.filter((q) => {
    if (!isUsable(q)) return false;
    const attempt = getAttempt(q);
    return isReviewCandidate(attempt) && (!attempt.dueAt || new Date(attempt.dueAt).getTime() <= now) && attempt.status !== 'mastered';
  });
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
  const attempts = core.filter((q) => getAttempt(q).attempts > 0).length;
  const today = state.progress.daily[todayKey()] || { ids: [] };
  const target = state.progress.settings.dailyTarget || DAILY_DEFAULT;
  const todayDone = today.ids.length;
  const due = dueQuestions().length;
  const correct = core.reduce((sum, q) => sum + getAttempt(q).correct, 0);
  const totalAttempts = core.reduce((sum, q) => sum + getAttempt(q).attempts, 0);
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
        <div class="daily-meta"><div class="progress-ring" style="--progress:${dailyProgress}%"><span>${dailyProgress}%</span></div><p><strong>${due} 道</strong>到期复习<br />完成后再去拿新的题。</p></div>
        <div><button class="btn btn-primary" data-action="start-daily">开始今日刷题 →</button></div>
      </article>
      <article class="panel card-pad stat-card"><span class="label">首刷覆盖 / core bank</span><div class="stat-number">${attempts.toLocaleString()}<small> / ${core.length.toLocaleString()}</small></div><div><p class="stat-detail">已覆盖 ${progress}% 核心客观题</p><div class="accent-line"></div></div></article>
      <article class="panel card-pad stat-card"><span class="label">作答准确率 / all attempts</span><div class="stat-number">${accuracy}<small>%</small></div><div><p class="stat-detail">基于 ${totalAttempts.toLocaleString()} 次作答</p><div class="accent-line" style="background:var(--sage)"></div></div></article>
    </div>

    <div class="section-heading"><h3>题库的骨架</h3><button data-action="go-stats">查看完整统计 ↗</button></div>
    <div class="grid topic-grid">
      ${topicCard('单项选择', singleCount, parsedSingle, singleCount === parsedSingle ? '考试核心' : `${parsedSingle - singleCount} 道待确认`, 'orange')}
      ${topicCard('多项选择', multipleCount, parsedMultiple, multipleCount === parsedMultiple ? '考试核心' : `${parsedMultiple - multipleCount} 道待确认`, 'sage')}
      ${topicCard('判断辨析', judgmentCount, parsedJudgment, '辅助训练', 'ink')}
      ${topicCard('案例分析', 0, 1, '待补充', 'muted')}
    </div>

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
      return `<div class="queue-item"><span class="queue-index">0${index + 1}</span><div class="queue-info"><strong>${escapeHtml(q.stem)}</strong><span>${typeLabel(q.type)} · ${a.lastCorrect ? '已答对' : '待复习'}</span></div><span class="pill ${a.lastCorrect ? '' : 'warning'}">${a.lastCorrect ? 'OK' : '复习'}</span></div>`;
    }).join('');
  return recent || '<div class="empty-state" style="padding:30px"><div class="empty-symbol">○</div><p>还没有作答记录，今天从第一题开始。</p></div>';
}

function renderPracticeLauncher() {
  const due = dueQuestions().length;
  const target = state.progress.settings.dailyTarget || DAILY_DEFAULT;
  app.innerHTML = `
    <section class="hero-row"><div><p class="kicker">Practice room / 02</p><h2 class="page-title">把答案留到<br /><em>提交之后。</em></h2><p class="hero-copy">首刷模式优先推送还没做过的单选和多选题。你可以放心猜，系统会把犹豫和错误都留下来。</p></div><div class="date-stamp"><strong>${target} 题</strong>今日首刷目标</div></section>
    <div class="grid mock-grid">
      <article class="panel mock-card"><span class="mock-badge">FIRST PASS / 首刷</span><h3>今日新题</h3><p>不看答案，完成一轮真实选择。提交后再读解析，错题会自动被收进复习队列。</p><div class="mock-meta"><div><strong>${target}</strong><span>今日目标</span></div><div><strong>${relevantQuestions().filter((q) => getAttempt(q).attempts === 0).length.toLocaleString()}</strong><span>尚未首刷</span></div></div><button class="btn btn-primary" data-action="start-daily">开始首刷 →</button></article>
      <article class="panel mock-card"><span class="mock-badge">RETURN / 回看</span><h3>到期复习</h3><p>把已经忘记边缘的题重新捞出来。做对不代表结束，连续稳定做对才算掌握。</p><div class="mock-meta"><div><strong>${due}</strong><span>当前到期</span></div><div><strong>1·3·7</strong><span>复习间隔</span></div></div><button class="btn btn-ghost" data-action="start-wrong">进入复习 →</button></article>
    </div>
    <div class="tip-box" style="margin-top:18px"><strong>首刷小规则</strong>如果题目会做但没有把握，提交后把信心标成“模糊”；它也会被安排回来。判断题目前作为概念辨析，不计入正式模拟。</div>
  `;
}

function renderPractice() {
  const q = currentQuestion();
  if (!q) { renderPracticeLauncher(); return; }
  const total = state.queue.length;
  const index = state.queueIndex + 1;
  const attempt = getAttempt(q);
  const sessionLabel = state.session?.mode === 'mock' ? `${state.session.subject} · 模拟` : state.session?.mode === 'wrong' || state.session?.mode === 'wrong-book' ? '错题复习' : '今日首刷';
  const isMock = state.session?.mode === 'mock';
  const selectedAnswer = [...state.selected].sort().join('');
  const correctKeys = getCorrectKeys(q);
  const optionsHtml = q.options.map((option) => {
    const selected = state.selected.has(option.key);
    const correct = state.submitted && correctKeys.includes(option.key);
    const incorrect = state.submitted && selected && !correct;
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
  const explanation = state.submitted ? `<div class="explanation" role="status" aria-live="polite"><span class="answer-chip">正确答案 · ${escapeHtml(q.answer)}</span><h4>${result ? '这一题，稳稳拿下。' : '这道题先留下，下一轮再见。'}</h4><p>${escapeHtml(q.explanation || '这道题暂时没有解析，请在复习时补充自己的理解。')}</p></div>` : '';

  app.innerHTML = `
    <div class="practice-top"><span class="session-tag">${escapeHtml(sessionLabel)} / ${typeShort(q.type)}</span><span class="session-progress">${index} / ${total}${isMock ? ` · <b id="session-timer">${formatSeconds(state.timerSeconds)}</b>` : ''}</span></div>
    <div class="question-layout">
      <article class="panel question-card">
        <span class="question-no">Q${String(q.source_question_no).padStart(4, '0')} · ${escapeHtml(q.source_file.replace('.pdf', ''))}</span>
        <h2 class="question-stem">${escapeHtml(q.stem)}</h2>
        <div class="options">${optionsHtml}</div>
        ${explanation}
        <div class="question-actions">
          ${!state.submitted ? `<div class="confidence-row"><span>我的把握</span>${['high','medium','low'].map((level) => `<button class="${state.confidence === level ? 'active' : ''}" data-confidence="${level}">${level === 'high' ? '有把握' : level === 'medium' ? '模糊' : '蒙的'}</button>`).join('')}</div>` : `<div class="confidence-row"><span>${result ? '已记录正确' : '已进入错题本'}</span></div>`}
          <div class="action-cluster">${!state.submitted ? `${isMock ? '<button class="btn btn-ghost" data-action="finish-mock">提前交卷</button>' : '<button class="btn btn-ghost" data-action="quit-session">退出</button>'}<button class="btn btn-primary" data-action="submit-answer" ${state.selected.size ? '' : 'disabled'}>提交答案 ↗</button>` : `${wrongBookButton}<button class="btn btn-primary" data-action="next-question">下一题 →</button>`}</div>
        </div>
      </article>
      <aside class="side-stack"><div class="panel side-panel"><h4>这次作答</h4><div class="tiny-row"><span>选择</span><strong>${selectedAnswer || '—'}</strong></div><div class="tiny-row"><span>题型</span><strong>${typeShort(q.type)}</strong></div><div class="tiny-row"><span>历史作答</span><strong>${attempt.attempts} 次</strong></div><div class="tiny-row"><span>下次复习</span><strong>${formatDate(attempt.dueAt)}</strong></div></div><div class="tip-box"><strong>给自己留一行</strong>错题不是惩罚，是下一次检索记忆的入口。提交后可以在错题本里写下“我为什么会选错”。</div></aside>
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
    <section class="hero-row"><div><p class="kicker">Recovery room / 03</p><h2 class="page-title">错题会回来，<br /><em>你也会更稳。</em></h2><p class="hero-copy">这里收着答错和手动加入的题。一次做对不算离开，连续做对才会毕业。</p></div><div class="date-stamp"><strong>${activeWrongCount}</strong>道未掌握题</div></section>
    <div class="toolbar"><select class="select-like" id="wrong-type-filter" aria-label="按题型筛选"><option value="all">全部题型</option><option value="single">单选题</option><option value="multiple">多选题</option><option value="judgment">判断题</option></select><select class="select-like" id="wrong-status-filter" aria-label="按状态筛选"><option value="all">全部状态</option><option value="new">待复习</option><option value="reviewing">复习中</option><option value="mastered">已掌握</option></select>${dueCount ? `<button class="btn btn-primary" data-action="start-wrong-book">复习到期错题（${dueCount}）→</button>` : ''}</div>
    <div class="panel">${wrong.length ? wrong.map((q) => { const a = getAttempt(q); return `<div class="wrong-row"><span class="number">Q${String(q.source_question_no).padStart(4, '0')}</span><div class="stem-mini">${escapeHtml(q.stem)}</div><small>${typeShort(q.type)} · ${wrongBookReason(a)}</small><span class="pill ${a.status === 'mastered' ? '' : 'warning'}">${a.status === 'mastered' ? '已掌握' : `下次 ${formatDate(a.dueAt)}`}</span></div>`; }).join('') : '<div class="empty-state"><div class="empty-symbol">✓</div><h3>错题本还是空的</h3><p>答错或手动加入的题，会保留在这里。</p></div>'}</div>
  `;
  document.querySelector('#wrong-type-filter').value = state.filters.wrongType;
  document.querySelector('#wrong-status-filter').value = state.filters.wrongStatus;
}

function renderMock() {
  const history = state.progress.mockHistory || [];
  app.innerHTML = `
    <section class="hero-row"><div><p class="kicker">Simulation desk / 04</p><h2 class="page-title">把两小时，<br /><em>练成自己的节奏。</em></h2><p class="hero-copy">正式考试的题型比例仍以官方大纲/准考证为准。MVP 先提供可配置的 120 分钟训练场，交卷后才揭示结果。</p></div><div class="date-stamp"><strong>120:00</strong>每科建议时长</div></section>
    <div class="grid mock-grid"><article class="panel mock-card"><span class="mock-badge">SUBJECT A / 基础</span><h3>基础知识</h3><p>单选 + 多选客观题训练。判断题默认不计入正式模拟，案例题模块将在下一版补齐。</p><div class="mock-meta"><div><strong>120</strong><span>分钟</span></div><div><strong>60</strong><span>题 · MVP</span></div></div><button class="btn btn-primary" data-action="start-mock" data-subject="基础知识">开始模拟 →</button></article><article class="panel mock-card"><span class="mock-badge">SUBJECT B / 实务</span><h3>专业技能</h3><p>更偏咨询关系、伦理、评估与干预。先用现有单选/多选训练，案例分析题可手工加入。</p><div class="mock-meta"><div><strong>120</strong><span>分钟</span></div><div><strong>60</strong><span>题 · MVP</span></div></div><button class="btn btn-ghost" data-action="start-mock" data-subject="专业技能">开始模拟 →</button></article></div>
    <div class="section-heading"><h3>最近模拟</h3><span class="label">${history.length ? `${history.length} 次记录` : '还没有记录'}</span></div>
    <div class="panel card-pad">${history.length ? history.slice().reverse().slice(0, 5).map((item) => `<div class="queue-item"><span class="queue-index">${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(item.at))}</span><div class="queue-info"><strong>${escapeHtml(item.subject)} · ${item.correct}/${item.total} 题正确</strong><span>等权估算 ${item.score} 分 · ${item.duration} 分钟</span></div><span class="pill ${item.score >= 60 ? '' : 'warning'}">${item.score >= 60 ? '通过线以上' : '继续训练'}</span></div>`).join('') : '<div class="empty-state" style="padding:35px"><div class="empty-symbol">∿</div><p>先完成一次模拟，这里会留下你的节奏曲线。</p></div>'}</div>
    <div class="tip-box" style="margin-top:18px"><strong>关于题量</strong>当前公开通知列出单选、多选和案例分析，但没有公开每类题目的确切数量与分值。MVP 的 60 题是训练模板，不等同于最终官方组卷。</div>
  `;
}

function renderStats() {
  const allCore = relevantQuestions();
  const practiced = allCore.filter((q) => getAttempt(q).attempts > 0).length;
  const correct = allCore.reduce((sum, q) => sum + getAttempt(q).correct, 0);
  const total = allCore.reduce((sum, q) => sum + getAttempt(q).attempts, 0);
  const accuracy = total ? Math.round((correct / total) * 100) : 0;
  const byType = ['single', 'multiple', 'judgment'].map((type) => {
    const list = state.questions.filter((q) => q.type === type && isUsable(q));
    const attempts = list.reduce((sum, q) => sum + getAttempt(q).attempts, 0);
    const correctType = list.reduce((sum, q) => sum + getAttempt(q).correct, 0);
    return { type, count: list.length, practiced: list.filter((q) => getAttempt(q).attempts).length, accuracy: attempts ? Math.round((correctType / attempts) * 100) : 0 };
  });
  const qualityIssues = state.report?.quality_issues || [];
  const max = Math.max(...byType.map((x) => x.count), 1);
  app.innerHTML = `
    <section class="hero-row"><div><p class="kicker">Learning ledger / 05</p><h2 class="page-title">不是分数，<br /><em>是可见的进步。</em></h2><p class="hero-copy">首刷覆盖告诉你走了多远，准确率告诉你哪里还需要回来。案例分析和知识点标签会在题库富化后接入。</p></div><div class="date-stamp"><strong>${practiced.toLocaleString()} / ${allCore.length.toLocaleString()}</strong>核心题已首刷</div></section>
    <div class="grid stats-grid"><article class="panel radial-stat"><span class="label">CORE COVERAGE / 首刷覆盖</span><div class="big-percent">${allCore.length ? Math.round(practiced / allCore.length * 100) : 0}<small>%</small></div><h3>${practiced.toLocaleString()} 道已留下痕迹</h3></article><article class="panel radial-stat"><span class="label">ACCURACY / 作答准确率</span><div class="big-percent" style="color:var(--sage)">${accuracy}<small>%</small></div><h3>基于 ${total.toLocaleString()} 次作答</h3></article></div>
    <div class="section-heading"><h3>按题型看进度</h3><span class="label">MVP live data</span></div>
    <div class="panel bar-chart"><h3>每一种题型，都有自己的节奏</h3>${byType.map((x) => `<div class="bar"><span>${typeLabel(x.type)}</span><div class="bar-track"><span style="width:${Math.round(x.count / max * 100)}%;background:${x.type === 'multiple' ? 'var(--sage)' : x.type === 'judgment' ? 'var(--ink)' : 'var(--orange)'}"></span></div><em>${x.practiced}/${x.count}</em></div><div class="bar" style="margin-top:-5px"><span style="font-size:9px;color:#99a2a5">准确率</span><div class="bar-track" style="height:4px"><span style="width:${x.accuracy}%;background:#9aa6a5"></span></div><em>${x.accuracy}%</em></div>`).join('')}</div>
    <div class="section-heading"><h3>本地数据</h3><span class="label">不会上传</span></div>
    <div class="panel card-pad"><div class="tiny-row"><span>PDF 实际解析</span><strong>${state.questions.length.toLocaleString()}</strong></div><div class="tiny-row"><span>可进入练习</span><strong>${state.questions.filter(isUsable).length.toLocaleString()}</strong></div><div class="tiny-row"><span>待人工确认</span><strong>${state.report?.quality_issue_count || 0}</strong></div><div class="tiny-row"><span>当前错题</span><strong>${dueQuestions().length}</strong></div><div class="tiny-row"><span>模拟次数</span><strong>${(state.progress.mockHistory || []).length}</strong></div><div class="tiny-row"><span>今日目标</span><strong>${state.progress.settings.dailyTarget || DAILY_DEFAULT} 题</strong></div><div style="margin-top:18px"><label class="label" for="daily-target">调整每日首刷目标</label><div style="display:flex;gap:9px;margin-top:8px"><input id="daily-target" class="input-like" name="dailyTarget" type="number" inputmode="numeric" autocomplete="off" min="10" max="300" value="${state.progress.settings.dailyTarget || DAILY_DEFAULT}" /><button class="btn btn-ghost" data-action="save-target">保存目标</button></div></div><div style="margin-top:18px;padding-top:15px;border-top:1px solid var(--line)"><button class="btn btn-ghost" data-action="reset-progress">清空本机学习记录</button></div></div>
    ${qualityIssues.length ? `<div class="section-heading"><h3>待人工确认的源题</h3><span class="label">不会静默修补</span></div><div class="panel card-pad">${qualityIssues.map((item) => `<div class="queue-item"><span class="queue-index">Q${String(item.source_question_no).padStart(4, '0')}</span><div class="queue-info"><strong>${escapeHtml(item.stem)}</strong><span>${typeLabel(item.type)} · ${escapeHtml(item.warnings.join('、'))}</span></div><span class="pill warning">暂不练习</span></div>`).join('')}</div>` : ''}
  `;
}

function buildDailyQueue() {
  const target = state.progress.settings.dailyTarget || DAILY_DEFAULT;
  const today = state.progress.daily[todayKey()] || { ids: [] };
  const already = new Set(today.ids);
  const untouched = relevantQuestions().filter((q) => !getAttempt(q).attempts && !already.has(questionId(q)));
  const due = dueQuestions().filter((q) => !already.has(questionId(q)));
  const pool = [...due.slice(0, Math.min(10, target)), ...untouched];
  const unique = [...new Map(pool.map((q) => [questionId(q), q])).values()];
  return unique.slice(0, target).map(questionId);
}

function buildWrongQueue() {
  return dueQuestions().sort((a, b) => getAttempt(b).wrong - getAttempt(a).wrong).slice(0, state.progress.settings.dailyTarget || DAILY_DEFAULT).map(questionId);
}

function buildWrongBookQueue() {
  return dueWrongBookQuestions().sort((a, b) => getAttempt(b).wrong - getAttempt(a).wrong).slice(0, state.progress.settings.dailyTarget || DAILY_DEFAULT).map(questionId);
}

function buildMockQueue() {
  const singles = relevantQuestions().filter((q) => q.type === 'single');
  const multiples = relevantQuestions().filter((q) => q.type === 'multiple');
  const take = (list, count) => list.slice().sort(() => Math.random() - 0.5).slice(0, count);
  return [...take(singles, 36), ...take(multiples, 24)].sort(() => Math.random() - 0.5).map(questionId);
}

function startSession(mode, subject = '') {
  stopTimer();
  state.session = { mode, subject, startedAt: Date.now(), answers: {} };
  state.queue = mode === 'daily' ? buildDailyQueue() : mode === 'wrong' ? buildWrongQueue() : mode === 'wrong-book' ? buildWrongBookQueue() : buildMockQueue();
  state.queueIndex = 0;
  state.selected = new Set();
  state.confidence = 'medium';
  state.submitted = false;
  state.view = 'practice';
  setSidebarOpen(false);
  if (mode === 'mock') startTimer(120 * 60);
  renderPractice();
  scrollToTop();
  if (!state.queue.length) toastMessage(mode === 'wrong' || mode === 'wrong-book' ? '当前没有到期错题。' : '这一轮没有可用的新题了。');
}

function resetQuestion() {
  state.selected = new Set();
  state.confidence = 'medium';
  state.submitted = false;
}

function recordAnswer() {
  const q = currentQuestion();
  if (!q || state.submitted) return;
  const id = questionId(q);
  const correct = isCorrect(q, state.selected);
  const previous = getAttempt(q);
  const now = new Date().toISOString();
  const next = {
    ...previous,
    attempts: previous.attempts + 1,
    correct: previous.correct + (correct ? 1 : 0),
    wrong: previous.wrong + (correct ? 0 : 1),
    lastAnswer: q.type === 'judgment' ? [...state.selected][0] || '' : [...state.selected].sort().join(''),
    lastCorrect: correct,
    confidence: state.confidence,
    status: correct && state.confidence === 'high' && previous.correct > 0 ? 'mastered' : correct ? 'reviewing' : 'new',
    dueAt: correct && state.confidence === 'high' ? new Date(Date.now() + 7 * 86400000).toISOString() : new Date(Date.now() + (correct ? 3 : 1) * 86400000).toISOString(),
    history: [...(previous.history || []), { at: now, answer: q.type === 'judgment' ? [...state.selected][0] || '' : [...state.selected].sort().join(''), correct, confidence: state.confidence }].slice(-12),
    updatedAt: now,
  };
  state.progress.attempts[id] = next;
  if (state.session?.mode === 'mock') {
    state.session.answers[id] = { answered: true, correct };
  }
  if (state.session?.mode === 'daily') {
    const key = todayKey();
    state.progress.daily[key] ||= { ids: [] };
    if (!state.progress.daily[key].ids.includes(id)) state.progress.daily[key].ids.push(id);
  }
  saveProgress();
  state.submitted = true;
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
  renderPractice();
  toastMessage('已加入错题本，左侧数量已更新。');
}

function nextQuestion() {
  if (state.queueIndex >= state.queue.length - 1) {
    if (state.session?.mode === 'mock') return finalizeMock();
    stopTimer();
    toastMessage('这一轮完成，做得漂亮。');
    state.session = null;
    state.queue = [];
    state.view = 'dashboard';
    render();
    return;
  }
  state.queueIndex += 1;
  resetQuestion();
  renderPractice();
  scrollToTop();
}

function finalizeMock() {
  if (!state.session || state.session.mode !== 'mock') return;
  // If the user is on an unanswered question, leave it blank rather than inventing a choice.
  const current = currentQuestion();
  if (current && state.selected.size) recordAnswer();
  stopTimer();
  const rows = state.queue.map((id) => ({
    q: state.questions.find((item) => questionId(item) === id),
    correct: state.session.answers[id]?.correct === true,
  }));
  const correct = rows.filter((row) => row.correct).length;
  const duration = Math.max(1, Math.round((Date.now() - state.session.startedAt) / 60000));
  const result = { at: new Date().toISOString(), subject: state.session.subject, correct, total: rows.length, score: Math.round(correct / Math.max(1, rows.length) * 100), duration };
  state.progress.mockHistory ||= [];
  state.progress.mockHistory.push(result);
  saveProgress();
  state.session = { ...state.session, mode: 'mock-summary', result };
  state.queue = [];
  state.submitted = true;
  renderMockSummary(result);
}

function renderMockSummary(result) {
  state.view = 'mock';
  app.innerHTML = `<section class="hero-row"><div><p class="kicker">Simulation report / complete</p><h2 class="page-title">这一次，<br /><em>你看见了自己的节奏。</em></h2><p class="hero-copy">这是 MVP 的等权训练分，不等同于最终官方计分。真正的价值在于知道哪些题型和知识点需要下一次再来。</p></div><div class="date-stamp"><strong>${result.score} 分</strong>${escapeHtml(result.subject)}</div></section><div class="grid stats-grid"><article class="panel radial-stat"><span class="label">SCORE / 等权估算</span><div class="big-percent">${result.score}<small>分</small></div><h3>${result.correct} / ${result.total} 题正确</h3></article><article class="panel radial-stat"><span class="label">TIME / 用时</span><div class="big-percent" style="color:var(--sage)">${result.duration}<small> min</small></div><h3>下一次，练习更稳定的节奏</h3></article></div><div class="toolbar" style="margin-top:22px"><button class="btn btn-primary" data-action="go-mock">回到模拟中心 →</button><button class="btn btn-ghost" data-action="go-wrong">去看错题本</button></div>`;
}

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-view]');
  if (nav) {
    stopTimer();
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
    if (q?.type === 'single' || q?.type === 'judgment') state.selected = new Set([option.dataset.option]);
    else if (state.selected.has(option.dataset.option)) state.selected.delete(option.dataset.option);
    else state.selected.add(option.dataset.option);
    renderPractice();
    return;
  }
  const confidence = event.target.closest('[data-confidence]');
  if (confidence && !state.submitted) {
    state.confidence = confidence.dataset.confidence;
    renderPractice();
    return;
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const name = action.dataset.action;
  if (name === 'start-daily') startSession('daily');
  if (name === 'start-wrong') startSession('wrong');
  if (name === 'start-wrong-book') startSession('wrong-book');
  if (name === 'start-mock') startSession('mock', action.dataset.subject || '基础知识');
  if (name === 'submit-answer') { recordAnswer(); renderPractice(); }
  if (name === 'next-question') nextQuestion();
  if (name === 'quit-session') { stopTimer(); state.session = null; state.queue = []; state.view = 'dashboard'; render(); }
  if (name === 'finish-mock') finalizeMock();
  if (name === 'flag-question') flagCurrentQuestion();
  if (name === 'go-wrong') { state.view = 'wrong'; render(); }
  if (name === 'go-stats') { state.view = 'stats'; render(); }
  if (name === 'go-mock') { state.view = 'mock'; state.session = null; render(); }
  if (name === 'save-target') {
    const value = Math.max(10, Math.min(300, Number(document.querySelector('#daily-target')?.value || DAILY_DEFAULT)));
    state.progress.settings.dailyTarget = value;
    saveProgress(); toastMessage(`每日首刷目标已设为 ${value} 题。`); render();
  }
  if (name === 'reset-progress') {
    if (window.confirm('确定清空本机的作答、错题和模拟记录吗？题库文件不会被删除。')) {
      state.progress = { version: 1, attempts: {}, daily: {}, mockHistory: [], settings: { dailyTarget: DAILY_DEFAULT } };
      saveProgress(); toastMessage('学习记录已清空。'); render();
    }
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'wrong-type-filter') { state.filters.wrongType = event.target.value; renderWrong(); }
  if (event.target.id === 'wrong-status-filter') { state.filters.wrongStatus = event.target.value; renderWrong(); }
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
    const [questionsResponse, reportResponse] = await Promise.all([fetch('./data/questions.json'), fetch('./data/import_report.json')]);
    state.questions = await questionsResponse.json();
    state.report = await reportResponse.json();
    render();
  } catch (error) {
    app.innerHTML = `<div class="panel empty-state"><div class="empty-symbol">!</div><h3>题库还没有加载成功</h3><p>请在项目目录启动本地静态服务器后访问页面，例如 <code>python3 -m http.server 4173</code>。</p><p class="mono">${escapeHtml(error.message)}</p></div>`;
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
