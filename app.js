/* ============================================================
 * 词海征服 · 背单词应用
 * 极简两板斧：学新词 + 复习（认识即毕业，不认识/记错次日再复习）
 * ============================================================ */

"use strict";

/* ============ 常量 ============ */
// 单词状态：新词 / 待复习 / 已毕业（废弃艾宾浩斯多级间隔，简化为「毕业」与「次日复习」两态）
const STATUS = { NEW: "new", REVIEW: "review", MASTERED: "mastered" };
const STATUS_LABEL = { new: "未学习", review: "待复习", mastered: "已掌握" };
const STORE_KEY = "vocab_conqueror_data_v1";
const ROUND_SIZE = 15; // 每轮学习的单词数
const APP_VERSION = "v6.5"; // 应用版本号（显示在页脚，用于确认更新是否生效）

// 复习安排在「第二天 00:00」（本地时间）——符合「记不住就明天再来」的朴素节奏
function nextDayStart() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ============ 版本热更新：检测到新版本时自动刷新一次 ============ */
(function () {
  try {
    var seen = localStorage.getItem("vc_seen_ver");
    if (seen && seen !== APP_VERSION) {
      localStorage.setItem("vc_seen_ver", APP_VERSION);
      location.reload(true); // 强制从网络重新加载，应用最新资源
      return;
    }
    localStorage.setItem("vc_seen_ver", APP_VERSION);
  } catch (e) { /* 隐私模式等场景忽略 */ }
})();

/* ============ IndexedDB 存储层（大容量，根治 localStorage 配额溢出） ============ */
const IDB_NAME = "vocab_conqueror_db";
const IDB_STORE = "kv";
const IDB_KEY = "main";
const HISTORY_LIMIT = 50; // 每个单词最多保留最近 50 条学习历史，防止无限膨胀撑爆存储
const idbSupported = (typeof indexedDB !== "undefined");
let idbPromise = null;

/* ============ 数据层 ============ */
let db = null;

function defaultDB() {
  return {
    version: 1,
    words: [],       // [{id, word, meaning, status, stage, nextReview, lastReview, views, correct, wrong, history:[{t, r, dur}]}]
    stats: {
      startDay: todayKey(),
      days: {},        // { "2025-01-01": {learned:0, review:0, answers:0} }
    },
    settings: {
      shuffle: true,   // 乱序出题（默认开启）
    },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      db = JSON.parse(raw);
      // 兼容性检查
      if (!db.words || !db.stats) db = defaultDB();
      if (!db.settings) db.settings = { shuffle: true };
      migrateStatus(); // 旧版（艾宾浩斯）状态迁移
    } else {
      db = defaultDB();
    }
  } catch (e) {
    console.error("数据加载失败", e);
    db = defaultDB();
  }
}

// 把旧版多级状态机迁移到新版两板斧：learning / reviewing → review，并清除废弃的 stage 字段
function migrateStatus() {
  if (!db || !db.words) return;
  db.words.forEach(function (w) {
    if (w.status === "learning" || w.status === "reviewing") w.status = STATUS.REVIEW;
    delete w.stage;
  });
}

/* ============ IndexedDB 封装 ============ */
function openIDB() {
  if (!idbSupported) return Promise.reject(new Error("no indexedDB"));
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const dbh = req.result;
      if (!dbh.objectStoreNames.contains(IDB_STORE)) dbh.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}
function idbGet() {
  return openIDB().then(dbh => new Promise((resolve, reject) => {
    const tx = dbh.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result ? req.result.data : null);
    req.onerror = () => reject(req.error);
  }));
}
function idbSet(obj) {
  return openIDB().then(dbh => new Promise((resolve, reject) => {
    const tx = dbh.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ data: obj, ts: Date.now() }, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// 异步水合：优先用 IndexedDB 中的权威数据；若 IndexedDB 为空而 localStorage 有旧数据，则迁移过去并清理 localStorage
async function hydrateFromIDB() {
  if (!idbSupported) return false;
  try {
    const data = await idbGet();
    if (data && data.words && Array.isArray(data.words) && data.words.length) {
      db = data;
      migrateStatus(); // 旧版状态迁移
      if (!db.settings) db.settings = { shuffle: true };
      if (!db.stats) db.stats = { startDay: todayKey(), days: {} };
      return true;
    }
    // IndexedDB 为空：把旧 localStorage 数据迁过去，腾出 localStorage 配额
    if (db && db.words && db.words.length) {
      await idbSet(db);
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    }
    return false;
  } catch (e) {
    console.warn("IndexedDB 读取失败，沿用 localStorage:", e);
    return false;
  }
}

function save() {
  // 优先写入 IndexedDB（容量大，背多少词都不爆）；失败或环境不支持时回退 localStorage
  if (idbSupported) {
    idbSet(db).catch(err => {
      console.warn("IndexedDB 保存失败，回退 localStorage:", err);
      fallbackLocalSave();
    });
    return;
  }
  fallbackLocalSave();
}

// localStorage 回退 + 三级降级容错（旧浏览器 / 隐私模式 / 不支持 IndexedDB 的环境）
function fallbackLocalSave() {
  var json = JSON.stringify(db);
  try {
    localStorage.setItem(STORE_KEY, json);
  } catch (e) {
    // 判断是否真的是存储空间不足
    var name = e && (e.name || e.code || "");
    var isQuota = name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || e && e.code === 22;
    if (isQuota) {
      // 尝试压缩：去掉已掌握单词的 history 数组
      var saved = 0;
      db.words.forEach(function (w) {
        if (w.status === STATUS.MASTERED && w.history && w.history.length) {
          w.history = [];
          saved++;
        }
      });
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(db));
        toast("⚠️ 存储空间紧张，已压缩 " + saved + " 个已掌握单词的记录。建议导出备份后清空部分词库。");
        return;
      } catch (e2) {
        // 仍然失败 → 尝试只保留核心数据
        var minimal = { words: [], stats: db.stats, version: db.version };
        db.words.forEach(function (w) {
          minimal.words.push({
            id: w.id, word: w.word, meaning: w.meaning,
            status: w.status,
            nextReview: w.nextReview, lastReview: w.lastReview,
            views: w.views, correct: w.correct, wrong: w.wrong,
            history: []
          });
        });
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(minimal));
          db = minimal;
          toast("⚠️ 存储空间严重不足，已切换精简模式。请尽快导出备份！");
          return;
        } catch (e3) {
          toast("❌ 存储空间已满，无法保存。请导出备份后清空部分词库！");
        }
      }
    } else {
      // 不是空间问题（可能是 Safari 隐私模式）
      console.error("保存失败:", e);
      toast("⚠️ 保存失败：" + (e && e.message ? e.message : "未知错误") + "（如使用隐私模式请切换为正常模式）");
    }
  }
}

// 一键压缩：清空全部学习历史，立即释放存储（急救用）
function compactStorage() {
  if (!db || !db.words.length) { toast("词库是空的，无需压缩"); return; }
  var freed = 0;
  db.words.forEach(function (w) {
    if (w.history && w.history.length) { freed += w.history.length; w.history = []; }
  });
  save();
  toast("🧹 已清理 " + freed + " 条学习历史，存储已释放！");
  refreshHome();
}

function todayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayStats() {
  const k = todayKey();
  if (!db.stats.days[k]) db.stats.days[k] = { learned: 0, review: 0, answers: 0 };
  return db.stats.days[k];
}

/* ============ 单词调度（艾宾浩斯） ============ */

// 生成唯一 id
let idCounter = 0;
function genId() {
  return Date.now().toString(36) + "_" + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
}

// 添加单词（去重）
function addWord(word, meaning) {
  const w = word.trim().toLowerCase();
  const m = meaning.trim();
  if (!w || !m) return false;
  // 已存在则更新释义
  const exist = db.words.find(x => x.word.toLowerCase() === w);
  if (exist) {
    exist.meaning = m;
    return false;
  }
  db.words.push({
    id: genId(), word: w, meaning: m,
    status: STATUS.NEW,
    nextReview: 0, lastReview: 0,
    views: 0, correct: 0, wrong: 0,
    history: [],
  });
  return true;
}

// 获取待学习的新词（乱序模式下随机抽取）
function getNewWords(n) {
  const pool = db.words.filter(x => x.status === STATUS.NEW);
  if (db.settings && db.settings.shuffle) {
    return shuffle(pool).slice(0, n);
  }
  return pool.slice(0, n);
}

// 获取到期待复习的单词（按到期时间升序）
function getDueReviews(now = Date.now()) {
  return db.words
    .filter(x => x.status === STATUS.REVIEW && x.nextReview > 0 && x.nextReview <= now)
    .sort((a, b) => a.nextReview - b.nextReview);
}

// 学习/复习完成后的调度（极简两板斧）
// result: true=记住(认识且记对) → 毕业；false=没记住/记错 → 次日再复习
function scheduleWord(item, result, durationMs) {
  const now = Date.now();
  item.views += 1;
  item.lastReview = now;
  item.history.push({ t: now, r: result ? 1 : 0, dur: Math.round(durationMs / 1000) });
  if (item.history.length > HISTORY_LIMIT) item.history = item.history.slice(-HISTORY_LIMIT);

  if (result) {
    // 认识且记对 → 直接毕业，永不进复习
    item.correct += 1;
    item.status = STATUS.MASTERED;
    item.nextReview = 0;
  } else {
    // 不认识 / 记错 → 安排到第二天再次复习
    item.wrong += 1;
    item.status = STATUS.REVIEW;
    item.nextReview = nextDayStart();
  }
  save();
}

/* ============ 学习流程 ============ */
let study = {
  queue: [],        // 本轮队列 [{item, isNew}]
  index: 0,
  phase: "word",    // word | meaning | done
  current: null,
  currentIsNew: false,
  cardShownAt: 0,   // 当前卡片展示时间（计时用）
  sessionStart: 0,
  timerId: null,
  roundStats: { learned: 0, reviewed: 0, wrong: 0 },
  recent: [],       // 本轮最近结果
};

function startStudy(mode) {
  mode = mode || "all"; // all | new | review
  const now = Date.now();
  let due = [], fresh = [];

  if (mode !== "new") due = getDueReviews(now);
  if (mode !== "review") fresh = getNewWords(ROUND_SIZE);

  // 按模式裁剪数量
  if (mode === "new") fresh = fresh.slice(0, ROUND_SIZE);
  else if (mode === "review") due = due.slice(0, ROUND_SIZE);
  else fresh = fresh.slice(0, Math.max(0, ROUND_SIZE - due.length)); // all：新词补足到 ROUND_SIZE

  if (due.length === 0 && fresh.length === 0) {
    // 没有任务
    const future = db.words
      .filter(x => x.status === STATUS.REVIEW && x.nextReview > now)
      .sort((a, b) => a.nextReview - b.nextReview)[0];
    let msg = "当前没有待学习的任务！";
    if (mode === "review") msg = "暂时没有待复习的单词，明天再来看看吧！";
    else if (mode === "new") msg = "新词都学完啦，去复习或导入更多词书吧！";
    if (future && mode !== "new") msg = `下一批复习在 ${fmtWait(future.nextReview - now)} 后到来`;
    else if (db.words.length === 0) msg = "词库是空的，先去导入词书吧！";
    toast(msg);
    if (db.words.length === 0) go("import");
    return;
  }

  // 复习优先，穿插新词
  study.queue = [];
  const maxDue = due.slice(0, ROUND_SIZE);
  // 乱序模式下，复习队列也打乱（只打乱同一批次内的顺序）
  const orderedDue = (db.settings && db.settings.shuffle) ? shuffle(maxDue) : maxDue;
  orderedDue.forEach(x => study.queue.push({ item: x, isNew: false }));
  fresh.forEach(x => study.queue.push({ item: x, isNew: true }));
  // 简单交错：复习2个插1个新词（仅 all 模式需要穿插）
  if (mode === "all") interleave();

  study.index = 0;
  study.phase = "word";
  study.sessionStart = Date.now();
  study.roundStats = { learned: 0, reviewed: 0, wrong: 0 };
  study.recent = [];

  go("study");
  startTimer();
  showCard();
}

function interleave() {
  const reviews = study.queue.filter(q => !q.isNew);
  const news = study.queue.filter(q => q.isNew);
  const out = [];
  let ri = 0, ni = 0;
  while (ri < reviews.length || ni < news.length) {
    if (ri < reviews.length) out.push(reviews[ri++]);
    if (ri < reviews.length) out.push(reviews[ri++]);
    if (ni < news.length) out.push(news[ni++]);
  }
  study.queue = out;
}

function showCard() {
  if (study.index >= study.queue.length) { finishRound(); return; }
  const entry = study.queue[study.index];
  study.current = entry.item;
  study.currentIsNew = entry.isNew;
  study.phase = "word";
  showConfirmButtons();          // 复位释义页按钮，保证每次都是「记错/记对」初始态
  study.cardShownAt = Date.now();

  const st = $("#stageWord"), sm = $("#stageMeaning"), sd = $("#stageDone");
  st.classList.remove("hidden"); sm.classList.add("hidden"); sd.classList.add("hidden");

  $("#wordEn").textContent = study.current.word;
  const tag = entry.isNew ? "🆕 新词" : "🔁 复习";
  const tagEl = $("#wordTag");
  tagEl.textContent = tag;
  tagEl.className = "word-tag " + (entry.isNew ? "t-new" : (study.current.wrong > 0 ? "t-wrong" : "t-review"));

  updateStudyProgress();
}

// 用户点击 认识/不认识
function answer(known) {
  if (study.phase !== "word") return;
  const dur = Date.now() - study.cardShownAt;
  study._firstAnswer = known;
  study._firstDur = dur;

  if (!known) {
    // 不认识 → 直接记入明天复习队列，展示「下一词」反馈，不再二次确认记错/记对
    scheduleWord(study.current, false, dur);
    pushRecent(study.current.word, "review");
    showSkipFeedback();
    return;
  }

  // 认识 → 显示释义，二次确认记对/记错
  study.phase = "meaning";
  $("#stageWord").classList.add("hidden");
  const sm = $("#stageMeaning");
  sm.classList.remove("hidden");
  sm.style.animation = "none"; void sm.offsetWidth; sm.style.animation = "";
  $("#wordEn2").textContent = study.current.word;
  $("#wordCn").textContent = study.current.meaning;
  showConfirmButtons();
  const tagEl = $("#wordTag2");
  if (study.currentIsNew) { tagEl.textContent = "🆕 新词"; tagEl.className = "word-tag t-new"; }
  else { tagEl.textContent = "🔁 复习"; tagEl.className = "word-tag t-review"; }
}

// 不认识后的反馈页：显示释义 + 单一「下一词」按钮
function showSkipFeedback() {
  study.phase = "meaning";
  $("#stageWord").classList.add("hidden");
  const sm = $("#stageMeaning");
  sm.classList.remove("hidden");
  sm.style.animation = "none"; void sm.offsetWidth; sm.style.animation = "";
  $("#wordEn2").textContent = study.current.word;
  $("#wordCn").textContent = study.current.meaning;
  $("#meaningHint").textContent = "不认识也没关系，已记入明天复习 💪";
  const tagEl = $("#wordTag2");
  tagEl.textContent = "🤔 不认识";
  tagEl.className = "word-tag t-wrong";
  // 切换到「下一词」按钮（隐藏记错/记对）
  $("#btnWrong").classList.add("hidden");
  $("#btnRight").classList.add("hidden");
  $("#btnNext").classList.remove("hidden");
}

// 恢复为「记错/记对」二次确认按钮
function showConfirmButtons() {
  $("#meaningHint").textContent = "刚才记对了吗？";
  $("#btnWrong").classList.remove("hidden");
  $("#btnRight").classList.remove("hidden");
  $("#btnNext").classList.add("hidden");
}

// 不认识路径：进入下一词
function nextWord() {
  if (study.phase !== "meaning") return;
  showConfirmButtons();          // 复位按钮，供下一张卡片使用
  study.index += 1;
  setTimeout(showCard, 120);
}

// 二次确认：记对了 / 记错了
function confirmResult(correct) {
  if (study.phase !== "meaning") return;
  const item = study.current;
  const totalDur = study._firstDur + (Date.now() - study.cardShownAt - study._firstDur);

  // 最终结果：
  // 不认识 → 错（直接调度）
  // 认识 + 记对了 → 对
  // 认识 + 记错了 → 错
  const finalResult = study._firstAnswer && correct;

  // 更新统计
  const ds = dayStats();
  if (study.currentIsNew) {
    ds.learned += 1;
    study.roundStats.learned += 1;
  } else {
    ds.review += 1;
    study.roundStats.reviewed += 1;
  }
  ds.answers += 1;
  if (!finalResult) study.roundStats.wrong += 1;

  scheduleWord(item, finalResult, totalDur);
  pushRecent(item.word, finalResult ? "mastered" : "review");

  study.index += 1;
  setTimeout(showCard, 120);
}

function finishRound() {
  study.phase = "done";
  stopTimer();
  $("#stageWord").classList.add("hidden");
  $("#stageMeaning").classList.add("hidden");
  $("#stageDone").classList.remove("hidden");
  const s = study.roundStats;
  $("#doneSummary").textContent =
    `新学 ${s.learned} 词 · 复习 ${s.reviewed} 词 · 出错 ${s.wrong} 词 · 用时 ${fmtClock(Date.now() - study.sessionStart)}`;
  refreshHome();
}

function endStudy(silent) {
  stopTimer();
  if (!silent && study.phase !== "done" && study.index > 0) {
    toast("进度已保存，随时回来继续！");
  }
  go("home");
}

function startTimer() {
  stopTimer();
  study.timerId = setInterval(() => {
    if (study.sessionStart) {
      $("#studyTimer").textContent = fmtClock(Date.now() - study.sessionStart);
    }
  }, 1000);
}
function stopTimer() {
  if (study.timerId) { clearInterval(study.timerId); study.timerId = null; }
}

function updateStudyProgress() {
  const total = study.queue.length;
  const done = study.index;
  $("#studyCount").textContent = `${done} / ${total}`;
  $("#studyProgress").style.width = total ? ((done / total) * 100) + "%" : "0%";
}

// 记录本轮某词的去向（毕业 / 明天复习），并刷新底部清单
function pushRecent(word, fate) {
  study.recent.unshift({ word: word, fate: fate });
  study.recent = study.recent.slice(0, 12);
  renderRecent();
}

function renderRecent() {
  const el = $("#recentWords");
  if (!study.recent.length) { el.innerHTML = ""; return; }
  el.innerHTML =
    `<div class="recent-title">本轮去向` +
    `<span class="recent-legend"><i class="lg ok">✓</i>毕业&nbsp;<i class="lg re">↻</i>明天复习</span></div>` +
    `<div class="recent-list">` +
    study.recent.map(r => {
      if (r.fate === "mastered") return `<span class="recent-chip ok">${escapeHtml(r.word)}<i class="fate">✓毕业</i></span>`;
      return `<span class="recent-chip wrong">${escapeHtml(r.word)}<i class="fate">↻复习</i></span>`;
    }).join("") +
    `</div>`;
}

/* ============ 导入功能 ============ */
function parseCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("文件为空");
  const rows = [];
  let startIdx = 0;
  // 检测并跳过表头
  const first = splitCSVLine(lines[0]);
  if (first.length >= 2 && !/[a-zA-Z]/.test(first[1] || "") && /word|单词|english/i.test(first[0] || "")) startIdx = 1;
  // 更通用的表头检测
  if (startIdx === 0) {
    const f = splitCSVLine(lines[0]).map(s => s.toLowerCase().trim());
    if (f.includes("word") || f.includes("单词") || f.includes("english")) startIdx = 1;
  }
  for (let i = startIdx; i < lines.length; i++) {
    const parts = splitCSVLine(lines[i]);
    if (parts.length < 2) continue;
    const word = parts[0].replace(/^["']|["']$/g, "").trim();
    const meaning = parts.slice(1).join(",").replace(/^["']|["']$/g, "").trim();
    if (word && meaning) rows.push({ word, meaning });
  }
  return rows;
}

// 处理带引号的 CSV 行
function splitCSVLine(line) {
  const out = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if ((ch === "," || ch === "\t") && !inQuote) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseJSON(text) {
  const data = JSON.parse(text);
  let arr = data;
  if (!Array.isArray(data)) {
    // 支持包一层的对象 {words: [...]} 或 {data: [...]}
    if (Array.isArray(data.words)) arr = data.words;
    else if (Array.isArray(data.data)) arr = data.data;
    else throw new Error("JSON 结构不符：需要数组或含 words/data 数组的对象");
  }
  const rows = [];
  for (const item of arr) {
    if (typeof item === "string") {
      // "word:meaning" 或 "word - meaning" 或 "word meaning"
      const m = item.split(/\s*[:：|]\s*/) ;
      if (m.length >= 2) rows.push({ word: m[0], meaning: m.slice(1).join(":") });
      continue;
    }
    if (item && typeof item === "object") {
      const word = item.word || item.en || item.english || item.w || item.term;
      const meaning = item.meaning || item.cn || item.chinese || item.translation || item["中文"] || item.def;
      if (word && meaning) rows.push({ word: String(word), meaning: String(meaning) });
    }
  }
  return rows;
}

function importRows(rows) {
  if (!rows.length) throw new Error("没有解析到有效的单词记录");
  let added = 0, updated = 0;
  for (const r of rows) {
    if (addWord(r.word, r.meaning)) added++;
    else updated++;
  }
  save();
  return { added, updated, total: rows.length };
}

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const resultEl = $("#importResult");
    try {
      let rows;
      if (/\.json$/i.test(file.name)) rows = parseJSON(text);
      else rows = parseCSV(text);
      const { added, updated, total } = importRows(rows);
      resultEl.className = "import-result";
      resultEl.innerHTML = `✅ 导入成功！共解析 <strong>${total}</strong> 条记录<br>新增 <strong>${added}</strong> 个单词${updated ? `，更新 ${updated} 个已有单词的释义` : ""}`;
      toast(`导入成功！新增 ${added} 个单词`);
      refreshHome();
    } catch (err) {
      resultEl.className = "import-result err";
      resultEl.innerHTML = `❌ 导入失败：${escapeHtml(err.message)}<br>请检查文件格式（CSV 两列或 JSON 数组）`;
    }
    resultEl.classList.remove("hidden");
  };
  reader.readAsText(file, "utf-8");
}

/* ============ 词库管理 ============ */
function renderLibrary() {
  const q = ($("#libSearch").value || "").trim().toLowerCase();
  const filter = $("#libFilter").value;
  const now = Date.now();
  let list = db.words;
  if (q) list = list.filter(x => x.word.includes(q) || x.meaning.toLowerCase().includes(q));
  if (filter !== "all") list = list.filter(x => x.status === filter);

  const el = $("#libList");
  if (!list.length) {
    el.innerHTML = `<p style="text-align:center;color:var(--text-faint);padding:30px 0">
      ${db.words.length === 0 ? "词库空空如也，先去导入词书吧 ⚔️" : "没有匹配的单词"}</p>`;
    return;
  }
  // 最多展示 500 条，避免卡顿
  const shown = list.slice(0, 500);
  el.innerHTML = shown.map(x => {
    let next = "";
    if (x.status === STATUS.MASTERED) next = "🏆 已毕业";
    else if (x.nextReview > 0) {
      if (x.nextReview <= now) next = "⏰ 待复习";
      else next = "📅 明天复习";
    }
    return `<div class="lib-item">
      <span class="lib-word">${escapeHtml(x.word)}</span>
      <span class="lib-meaning">${escapeHtml(x.meaning)}</span>
      <span class="lib-next">${next}</span>
      <span class="lib-status s-${x.status}">${STATUS_LABEL[x.status]}</span>
    </div>`;
  }).join("") + (list.length > 500 ? `<p style="text-align:center;color:var(--text-faint);padding:12px">仅显示前 500 条，共 ${list.length} 条</p>` : "");
}

function confirmClear() {
  if (!db.words.length) { toast("词库已经是空的了"); return; }
  showModal("清空词库", `确定要清空全部 ${db.words.length} 个单词及所有学习进度吗？此操作不可恢复！`, () => {
    db = defaultDB();
    save();
    renderLibrary();
    refreshHome();
    toast("词库已清空");
  });
}

/* ============ 首页渲染 ============ */
function refreshHome() {
  const now = Date.now();
  const due = getDueReviews(now);
  const newCount = db.words.filter(x => x.status === STATUS.NEW).length;
  const reviewTotal = db.words.filter(x => x.status === STATUS.REVIEW).length; // 待复习总数（含明天才到期的）
  const mastered = db.words.filter(x => x.status === STATUS.MASTERED).length;
  const learned = db.words.filter(x => x.status !== STATUS.NEW).length;

  $("#statNew").textContent = newCount;
  $("#statReview").textContent = reviewTotal;
  $("#statMastered").textContent = mastered;

  const ds = db.stats.days[todayKey()] || { learned: 0, review: 0 };
  let sub;
  if (due.length > 0) sub = `有 ${due.length} 个词今天到期要复习，还有 ${newCount} 个新词待学`;
  else if (reviewTotal > 0) sub = `已安排 ${reviewTotal} 个词明天复习 ↻，先学新词吧`;
  else if (newCount > 0) sub = `今日已学 ${ds.learned} 词、复习 ${ds.review} 词，还有 ${newCount} 个新词待学`;
  else sub = "今日任务已全部完成，好好休息！";
  $("#todaySummary").textContent = sub;

  $("#ovTotal").textContent = db.words.length;
  $("#ovToday").textContent = ds.learned + ds.review;
  $("#ovLearned").textContent = learned;
  $("#ovStreak").textContent = calcStreak() + " 天";

  renderHeatmap();
}

function calcStreak() {
  let streak = 0;
  const d = new Date();
  // 今天没学不打断连续（从昨天开始算），学了则从今天算
  if (!dayHasData(todayKey())) d.setDate(d.getDate() - 1);
  while (dayHasData(todayKey(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
function dayHasData(key) {
  const s = db.stats.days[key];
  return s && (s.learned > 0 || s.review > 0);
}

function renderHeatmap() {
  const el = $("#heatmap");
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const s = db.stats.days[todayKey(d)] || { learned: 0, review: 0 };
    days.push({ label: i === 0 ? "今天" : ["日", "一", "二", "三", "四", "五", "六"][d.getDay()], count: s.learned + s.review });
  }
  const max = Math.max(10, ...days.map(d => d.count));
  el.innerHTML = days.map(d => {
    const lv = d.count === 0 ? "" : d.count / max > 0.6 ? "lv3" : d.count / max > 0.25 ? "lv2" : "lv1";
    return `<div class="heat-col">
      <div class="heat-bar ${lv}">${d.count || "·"}</div>
      <span class="heat-label">${d.label}</span>
    </div>`;
  }).join("");
}

/* ============ 内置词书 ============ */
const BUILTIN_BOOKS = [
  {
    name: "大学英语四级 · 高频核心 60 词",
    desc: "精选四级高频词，快速上手试手感",
    words: [
      ["abandon", "v. 放弃，抛弃"], ["abstract", "adj. 抽象的 n. 摘要"], ["abundant", "adj. 丰富的，充裕的"],
      ["accelerate", "v. 加速，促进"], ["accessible", "adj. 可接近的，可进入的"], ["accompany", "v. 陪伴，伴随"],
      ["accomplish", "v. 完成，实现"], ["accumulate", "v. 积累，积聚"], ["accurate", "adj. 精确的，准确的"],
      ["acknowledge", "v. 承认；答谢"], ["acquire", "v. 获得，取得"], ["adapt", "v. 适应；改编"],
      ["adequate", "adj. 充足的，适当的"], ["advocate", "v. 提倡，主张 n. 拥护者"], ["aggressive", "adj. 侵略性的；有进取心的"],
      ["alternative", "n. 替代选择 adj. 供选择的"], ["ambitious", "adj. 有雄心的，野心勃勃的"], ["anticipate", "v. 预期，期望"],
      ["apparent", "adj. 明显的；表面的"], ["approach", "n. 方法 v. 接近"], ["appropriate", "adj. 适当的，恰当的"],
      ["approve", "v. 批准；赞成"], ["artificial", "adj. 人造的，人工的"], ["assess", "v. 评估，评定"],
      ["assume", "v. 假定，承担"], ["attract", "v. 吸引"], ["authentic", "adj. 真实的，可靠的"],
      ["average", "n. 平均数 adj. 平均的"], ["balance", "n. 平衡 v. 使平衡"], ["barrier", "n. 障碍，屏障"],
      ["benefit", "n. 利益 v. 有益于"], ["capacity", "n. 容量；能力"], ["challenge", "n. 挑战 v. 向…挑战"],
      ["circumstance", "n. 环境，情况"], ["commit", "v. 犯（罪）；承诺；致力于"], ["communicate", "v. 交流，沟通"],
      ["compare", "v. 比较"], ["compete", "v. 竞争，比赛"], ["concentrate", "v. 集中，专心"],
      ["consequence", "n. 结果，后果"], ["considerable", "adj. 相当大的，可观的"], ["consistent", "adj. 一致的，始终如一的"],
      ["constant", "adj. 持续的，不变的"], ["contribute", "v. 贡献，捐助；导致"], ["convenient", "adj. 方便的，便利的"],
      ["convince", "v. 使确信，说服"], ["critical", "adj. 批评的；关键的，危急的"], ["curious", "adj. 好奇的；奇怪的"],
      ["deliver", "v. 递送；发表；生（孩子）"], ["demonstrate", "v. 证明；演示；示威"], ["determine", "v. 决定；决心"],
      ["distinguish", "v. 区分，辨别"], ["efficient", "adj. 高效的"], ["emphasis", "n. 强调，重点"],
      ["essential", "adj. 必要的，本质的"], ["establish", "v. 建立，创立"], ["estimate", "v./n. 估计，估算"],
      ["eventually", "adv. 最终，终于"],
    ],
  },
  {
    name: "日常口语 · 实用 40 词",
    desc: "高频口语表达，聊天不再词穷",
    words: [
      ["awesome", "adj. 极好的，了不起的"], ["hang out", "闲逛，一起玩"], ["figure out", "弄明白，想清楚"],
      ["sort of", "有点儿，有几分"], ["kind of", "有点儿"], ["deal with", "处理，应付"],
      ["come up with", "想出（主意）"], ["look forward to", "期待，盼望"], ["get along", "相处融洽"],
      ["run out of", "用完，耗尽"], ["check out", "看看；结账离开"], ["give up", "放弃"],
      ["pick up", "捡起；接人；学会"], ["put off", "推迟，拖延"], ["turn out", "结果是，证明是"],
      ["catch up", "赶上，叙旧"], ["work out", "锻炼；解决；成功"], ["show up", "出现，露面"],
      ["chill", "v. 放松 n. 寒意"], ["whatever", "pron. 无论什么；随便"],
      ["seriously", "adv. 严肃地；当真地"], ["literally", "adv. 字面上地；确实"],
      ["obviously", "adv. 显然地"], ["apparently", "adv. 据说，看来"],
      ["honestly", "adv. 诚实地，说真的"], ["basically", "adv. 基本上，从根本上说"],
      ["definitely", "adv. 肯定地，绝对地"], ["probably", "adv. 大概，或许"],
      ["maybe", "adv. 也许，可能"], ["actually", "adv. 实际上，事实上"],
      ["gorgeous", "adj. 极美的，华丽的"], ["delicious", "adj. 美味的"],
      ["exhausted", "adj. 精疲力竭的"], ["thrilled", "adj. 非常兴奋的"],
      ["annoyed", "adj. 恼怒的，烦恼的"], ["confused", "adj. 困惑的"],
      ["impressed", "adj. 印象深刻的"], ["grateful", "adj. 感激的"],
      ["convenient", "adj. 方便的"], ["comfortable", "adj. 舒适的"],
    ],
  },
];

function renderBuiltinList() {
  const el = $("#builtinList");
  el.innerHTML = BUILTIN_BOOKS.map((b, i) => `
    <div class="builtin-item">
      <div><strong>${b.name}</strong><span>${b.desc} · ${b.words.length} 词</span></div>
      <button class="btn btn-primary btn-sm" onclick="loadBuiltin(${i})">装载</button>
    </div>`).join("");
}

function loadBuiltin(i) {
  const book = BUILTIN_BOOKS[i];
  const { added, updated } = importRows(book.words.map(([w, m]) => ({ word: w, meaning: m })));
  toast(`已装载「${book.name}」：新增 ${added} 词${updated ? `，更新 ${updated} 词` : ""}`);
  refreshHome();
}

/* ============ 数据备份（导出/导入） ============ */
function exportData() {
  const backup = {
    app: "词海征服",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: db,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vocab-backup-" + todayKey() + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("备份已导出到下载文件夹");
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    const resultEl = $("#backupResult");
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.data || !backup.data.words) throw new Error("文件格式不正确：缺少 data.words 字段");
      showModal("导入备份", "将恢复 " + backup.data.words.length + " 个单词的学习数据，当前数据将被覆盖。确定继续？", function () {
        db = backup.data;
        if (!db.stats) db.stats = { startDay: todayKey(), days: {} };
        save();
        refreshHome();
        renderLibrary();
        toast("数据恢复成功！");
        resultEl.className = "import-result";
        resultEl.innerHTML = "✅ 恢复成功！共 " + db.words.length + " 个单词";
        resultEl.classList.remove("hidden");
      });
    } catch (err) {
      resultEl.className = "import-result err";
      resultEl.innerHTML = "❌ 导入失败：" + escapeHtml(err.message);
      resultEl.classList.remove("hidden");
    }
  };
  reader.readAsText(file, "utf-8");
}

/* ============ 工具 ============ */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }

// Fisher-Yates 洗牌算法（不修改原数组）
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtWait(ms) {
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = min / 60;
  if (h < 24) return `${Math.ceil(h)} 小时`;
  return `${Math.ceil(h / 24)} 天`;
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function showModal(title, text, onOk) {
  $("#modalTitle").textContent = title;
  $("#modalText").textContent = text;
  $("#modalMask").classList.remove("hidden");
  $("#modalOk").onclick = () => { closeModal(); onOk && onOk(); };
}
function closeModal() { $("#modalMask").classList.add("hidden"); }

/* ============ 页面路由 ============ */
function go(page) {
  if (page !== "study") stopTimer();
  $all(".page").forEach(p => p.classList.remove("active"));
  $(`#page-${page}`).classList.add("active");
  $all(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  if (page === "home") refreshHome();
  if (page === "library") renderLibrary();
  if (page === "import") renderBuiltinList();
  window.scrollTo(0, 0);
}

/* ============ 初始化 ============ */
document.addEventListener("DOMContentLoaded", () => {
  load();                                  // 同步兜底：localStorage 旧数据 / 默认库，保证 db 立即可用
  hydrateFromIDB()                         // 异步：IndexedDB 有数据则覆盖为权威库；否则把旧 localStorage 迁过去
    .catch(err => console.warn("IndexedDB 读取失败，沿用 localStorage:", err))
    .finally(() => { initUI(); refreshHome(); });
});

function initUI() {
  // 拖拽导入
  const dz = $("#dropzone"), fi = $("#fileInput");
  dz.addEventListener("click", () => fi.click());
  fi.addEventListener("change", () => { if (fi.files.length) { handleFile(fi.files[0]); fi.value = ""; } });
  ["dragover", "dragenter"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("dragover"); }));
  dz.addEventListener("drop", e => { if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });

  // 备份导入
  const bi = $("#backupInput");
  if (bi) bi.addEventListener("change", function () { if (bi.files.length) { importData(bi.files[0]); bi.value = ""; } });

  // 乱序开关
  const st = $("#shuffleToggle");
  if (st) {
    st.checked = !!(db.settings && db.settings.shuffle);
    updateShuffleUI();
    st.addEventListener("change", function () {
      if (!db.settings) db.settings = {};
      db.settings.shuffle = st.checked;
      save();
      updateShuffleUI();
      toast(st.checked ? "🔀 乱序出题已开启" : "📋 已切换为顺序出题");
    });
  }

  // 快捷键：空格显示释义方向（预留）
  document.addEventListener("keydown", (e) => {
    if ($("#page-study").classList.contains("active")) {
      if (study.phase === "word") {
        if (e.key === "1" || e.key === "ArrowLeft") answer(false);
        if (e.key === "2" || e.key === "ArrowRight") answer(true);
      } else if (study.phase === "meaning") {
        if (e.key === "1" || e.key === "ArrowLeft") confirmResult(false);
        if (e.key === "2" || e.key === "ArrowRight") confirmResult(true);
      }
    }
  });

  // 问候语
  const h = new Date().getHours();
  $("#greeting").textContent = h < 6 ? "夜深了，征服者！" : h < 12 ? "早上好，征服者！" : h < 18 ? "下午好，征服者！" : "晚上好，征服者！";

  // 底部版本号（让用户一眼确认是否更新到最新版）
  const verEl = document.getElementById("appVersion");
  if (verEl) verEl.textContent = "词海征服 " + APP_VERSION;
}

// 暴露到全局（onclick 内联调用需要）
window.go = go;
window.startStudy = startStudy;
window.answer = answer;
window.confirmResult = confirmResult;
window.endStudy = endStudy;
window.renderLibrary = renderLibrary;
window.confirmClear = confirmClear;
window.loadBuiltin = loadBuiltin;
window.closeModal = closeModal;
window.exportData = exportData;
window.importData = importData;
window.compactStorage = compactStorage;
window.nextWord = nextWord;

// 更新乱序开关的视觉状态
function updateShuffleUI() {
  const st = $("#shuffleToggle");
  if (!st) return;
  const thumb = st.parentElement.querySelector(".slider-thumb");
  const track = st.parentElement.querySelector(".slider-track");
  if (st.checked) {
    if (thumb) thumb.style.transform = "translateX(22px)";
    if (track) track.style.background = "var(--accent, #E8915C)";
  } else {
    if (thumb) thumb.style.transform = "translateX(0)";
    if (track) track.style.background = "#ccc";
  }
}
