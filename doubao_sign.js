// doubao_sign.js —— 豆包「浏览器实时签名」常驻服务（本机 Windows 运行）
//
// 原理：豆包写接口(landing/checkin)强制要求 a_bogus 签名，该签名由豆包前端
// 把 window.fetch 包了一层自动算出来的（closure 内，无法直接调用）。本服务用
// Playwright 驱动【系统 Edge】打开豆包页面，复用登录态(cookie/profile)，在页面内
// 直接 fetch 签到接口 —— App 的包装层会自动加 a_bogus，于是服务端成功代签。
//
// 接口：
//   GET  /health           健康检查
//   POST /sign             执行一次豆包签到（返回豆包原始 JSON）
//   GET  /                服务信息
// 同时内建每日定时：到 SETTINGS 里的时刻自动签一次（与 112 签到中心错峰）。
//
// 部署：本机常驻（与 doubao_capture.js 同机）。网页端「一键签到」直接 fetch
//       http://127.0.0.1:8791/doubao/sign 即可触发（已开 CORS）。
// 启动： node doubao_sign.js   或   doubao_signer.bat

const { chromium } = require('C:/Users/54004/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROFILE    = 'E:/workspace/workbuddy-signin/doubao_profile';
const COOKIE_TXT = 'E:/workspace/workbuddy-signin/doubao_cookie.txt';
const PORT       = 8791;
const ORIGIN     = 'https://bjzjsf.asia';
const SCENE      = 'pc_incentive_task_mvp_v3';
const QP = 'version_code=20800&language=zh&device_platform=pc&doubao_device_platform=pc&aid=497858&real_aid=497858&pkg_type=release_version&samantha_web=0&web_platform=pc&runtime=pc';
const LOG = 'E:/workspace/workbuddy-signin/doubao_sign.log';
function dlog(s){ try { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + s + '\n'); } catch (e) {} }

function loadCookieHeader() {
  try {
    const raw = fs.readFileSync(COOKIE_TXT, 'utf-8').trim();
    if (!raw) return null;
    if (/^[\da-f]{20,}$/i.test(raw)) return 'sessionid=' + raw + '; sessionid_ss=' + raw;
    return raw;
  } catch (e) { return null; }
}

// 浏览器单例（懒启动 + 串行锁）
let _browserPromise = null;
let _signing = false;

async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = chromium.launchPersistentContext(PROFILE, {
      channel: 'msedge',
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    });
  }
  return _browserPromise;
}

// 方案二支持：把当前浏览器里的豆包登录态(cookie)推送到 112，供服务器签名器代签。
// 上传失败不影响本机签到（可忽略，下次重试）。
async function uploadCookiesToServer() {
  try {
    const ctx = await getBrowser();
    const cookies = await ctx.cookies();
    if (!cookies || !cookies.length) return;
    const r = await fetch('https://bjzjsf.asia/checkin/api/doubao/upload-cookie?k=' + encodeURIComponent(RELAY_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cookies),
    });
    const j = await r.json().catch(() => ({}));
    dlog('[cookie-sync] 已推送 ' + cookies.length + ' 条 cookie -> ' + JSON.stringify(j).slice(0, 120));
  } catch (e) {
    dlog('[cookie-sync] 推送失败(可忽略): ' + e);
  }
}

async function doSign() {
  if (_signing) return { ok: false, error: '已有签到任务进行中' };
  _signing = true;
  let ctx;
  try {
    ctx = await getBrowser();
    const page = await ctx.newPage();
    const cookie = loadCookieHeader();
    if (cookie) {
      const sid = (cookie.match(/sessionid=([^;]+)/) || [])[1];
      if (sid) {
        await ctx.addCookies([
          { name: 'sessionid', value: sid, domain: '.doubao.com', path: '/' },
          { name: 'sessionid_ss', value: sid, domain: '.doubao.com', path: '/' },
        ]).catch(() => {});
      }
    }
    await page.goto('https://www.doubao.com/pc/agent-explore', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // 等 byted_acrawler / App 包装的 fetch 就绪
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => typeof window.byted_acrawler !== 'undefined').catch(() => false)) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2500);

    const result = await page.evaluate(async (arg) => {
      const { SCENE, QP } = arg;
      const base = 'https://www.doubao.com';
      const headers = { 'Content-Type': 'application/json', 'Referer': base + '/pc/agent-explore', 'Origin': base };
      const post = async (p, body) => {
        const r = await fetch(base + p + '?' + QP, { method: 'POST', headers, body: JSON.stringify(body) });
        const t = await r.text();
        try { return JSON.parse(t); } catch (e) { return { __raw: t.slice(0, 300) }; }
      };
      const out = {};
      out.get = await post('/alice/ug/campaign/landing/get', { scene: SCENE });
      out.checkin = await post('/alice/ug/campaign/landing/checkin', { scene: SCENE, biz_params: {} });
      return out;
    }, { SCENE, QP });

    await page.close();
    uploadCookiesToServer();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    _signing = false;
  }
}

// 一键完成任务 + 领积分：在页面内拉任务列表，对可领任务逐个 item/reward/claim。
// 写接口需要 a_bogus，必须走真实浏览器（fetch 包装层自动加签）。
async function doTasks() {
  if (_signing) return { ok: false, error: '已有签到任务进行中' };
  _signing = true;
  let ctx;
  try {
    ctx = await getBrowser();
    const page = await ctx.newPage();
    const cookie = loadCookieHeader();
    if (cookie) {
      const sid = (cookie.match(/sessionid=([^;]+)/) || [])[1];
      if (sid) {
        await ctx.addCookies([
          { name: 'sessionid', value: sid, domain: '.doubao.com', path: '/' },
          { name: 'sessionid_ss', value: sid, domain: '.doubao.com', path: '/' },
        ]).catch(() => {});
      }
    }
    await page.goto('https://www.doubao.com/pc/agent-explore', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => typeof window.byted_acrawler !== 'undefined').catch(() => false)) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2500);

    const result = await page.evaluate(async (arg) => {
      const { SCENE, QP } = arg;
      const base = 'https://www.doubao.com';
      const headers = { 'Content-Type': 'application/json', 'Referer': base + '/pc/agent-explore', 'Origin': base };
      const post = async (p, body) => {
        const r = await fetch(base + p + '?' + QP, { method: 'POST', headers, body: JSON.stringify(body) });
        const t = await r.text();
        try { return JSON.parse(t); } catch (e) { return { __raw: t.slice(0, 300) }; }
      };
      // 1) 拉任务列表（优先 v3/detail，空则回退 landing/get）
      let detail = await post('/alice/ug/campaign/v3/detail/', { campaign_group_code: SCENE });
      let tasks = (detail.data && detail.data.tasks) || [];
      if (!tasks.length) {
        const lg = await post('/alice/ug/campaign/landing/get', { scene: SCENE });
        tasks = (lg.data && (lg.data.tasks || lg.data.task_list || [])) || [];
      }
      const out = { detail_code: detail.code, task_count: tasks.length, tasks: [], claimed: 0, failed: 0, skipped: 0 };
      dlog('TASKS_RAW ' + JSON.stringify(tasks).slice(0, 12000));
      for (const t of tasks) {
        // 跳过「每日签到」（由 /sign 处理）
        const isSignin = (t.campaign_code === 'daily_signin' || t.task_kind === 'daily_signin');
        if (isSignin) continue;
        const rw = (Array.isArray(t.reward_summaries) && t.reward_summaries.length)
          ? t.reward_summaries.reduce((s, x) => s + (x.reward_amount || 0), 0)
          : (typeof t.reward_amount === 'number' ? t.reward_amount
            : (t.daily_checkin && t.daily_checkin.reward && typeof t.daily_checkin.reward.reward_amount === 'number') ? t.daily_checkin.reward.reward_amount : 0);
        const claimed = !!(t.claimed || t.is_claimed || t.reward_status === 3
          || [3, 'claimed', 'received', 'done', 'finished'].includes(t.task_status));
        const done = (t.task_status === 3 || t.task_status === 2
          || ['claimed','done','completed','can_claim'].includes(String(t.task_status).toLowerCase()));
        if (claimed) { out.skipped++; out.tasks.push({ title: t.title || t.subtitle || t.campaign_code, status: 'already_claimed' }); continue; }
        if (!done) { out.skipped++; out.tasks.push({ title: t.title || t.subtitle || t.campaign_code, status: 'need_complete', task_status: t.task_status }); continue; }
        if (!rw || rw <= 0) { out.skipped++; out.tasks.push({ title: t.title || t.subtitle || t.campaign_code, status: 'no_reward' }); continue; }
        const campaign_code = t.campaign_code;
        const campaign_group_code = t.campaign_group_code ?? SCENE;
        if (!campaign_code) { out.skipped++; out.tasks.push({ title: t.title || t.subtitle, status: 'skip_no_code' }); continue; }
        // claim 用真实字段：campaign_code + campaign_group_code（真实任务对象里没有 task_id / campaign_item_code）
        const body = { campaign_code, campaign_group_code, AgwCommonParam: {} };
        const r = await post('/alice/ug/campaign/item/reward/claim/', body);
        const ok = r && r.code === 0;
        dlog('CLAIM ' + JSON.stringify({ title: t.title || t.subtitle || campaign_code, body, resp: r }));
        if (ok) out.claimed++; else out.failed++;
        out.tasks.push({ title: t.title || t.subtitle || campaign_code, status: ok ? 'claimed' : ('fail:' + (r && r.code)), code: r && r.code, msg: (r && (r.msg || r.message)) || '' });
      }
      return out;
    }, { SCENE, QP });

    await page.close();
    uploadCookiesToServer();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    _signing = false;
  }
}

// 读取任务列表（含每日签到），用于弹窗展示「当前有哪几个任务、各自状态」。
// 必须在真实浏览器内拉（登录态 + a_bogus），故与签到/领取同源。
async function getTaskList() {
  if (_signing) return { ok: false, error: '浏览器忙，请稍候' };
  _signing = true;
  let ctx;
  try {
    ctx = await getBrowser();
    const page = await ctx.newPage();
    const cookie = loadCookieHeader();
    if (cookie) {
      const sid = (cookie.match(/sessionid=([^;]+)/) || [])[1];
      if (sid) {
        await ctx.addCookies([
          { name: 'sessionid', value: sid, domain: '.doubao.com', path: '/' },
          { name: 'sessionid_ss', value: sid, domain: '.doubao.com', path: '/' },
        ]).catch(() => {});
      }
    }
    await page.goto('https://www.doubao.com/pc/agent-explore', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => typeof window.byted_acrawler !== 'undefined').catch(() => false)) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2500);

    const result = await page.evaluate(async (arg) => {
      const { SCENE, QP } = arg;
      const base = 'https://www.doubao.com';
      const headers = { 'Content-Type': 'application/json', 'Referer': base + '/pc/agent-explore', 'Origin': base };
      const post = async (p, body) => {
        const r = await fetch(base + p + '?' + QP, { method: 'POST', headers, body: JSON.stringify(body) });
        const t = await r.text();
        try { return JSON.parse(t); } catch (e) { return { __raw: t.slice(0, 300) }; }
      };
      let detail = await post('/alice/ug/campaign/v3/detail/', { campaign_group_code: SCENE });
      let tasks = (detail.data && detail.data.tasks) || [];
      if (!tasks.length) {
        const lg = await post('/alice/ug/campaign/landing/get', { scene: SCENE });
        tasks = (lg.data && (lg.data.tasks || lg.data.task_list || [])) || [];
      }
      const rewardOf = (t) => {
        // 真实字段：chat_activity 奖励在 reward_summaries 数组；daily_signin 在 daily_checkin.reward.reward_amount
        if (Array.isArray(t.reward_summaries) && t.reward_summaries.length) {
          return t.reward_summaries.reduce((s, x) => s + (x.reward_amount || 0), 0);
        }
        if (t.daily_checkin && t.daily_checkin.reward && typeof t.daily_checkin.reward.reward_amount === 'number') return t.daily_checkin.reward.reward_amount;
        if (typeof t.reward_amount === 'number') return t.reward_amount;
        if (t.reward && typeof t.reward.reward_amount === 'number') return t.reward.reward_amount;
        return 0;
      };
      const claimedOf = (t) => !!(t.claimed || t.is_claimed || t.reward_status === 3
        || [3, 'claimed', 'received', 'done', 'finished'].includes(t.task_status)
        || [3, 'claimed'].includes(t.reward_status));
      const isDone = (t) => {
        const s = t.task_status;
        return s === 3 || s === 2 || ['claimed','done','completed','can_claim'].includes(String(s).toLowerCase());
      };
      const list = tasks.map((t) => {
        const isSignin = (t.campaign_code === 'daily_signin' || t.task_kind === 'daily_signin');
        const rw = rewardOf(t);
        const claimed = claimedOf(t);
        const done = isDone(t);
        const campaign_code = t.campaign_code;
        const campaign_group_code = t.campaign_group_code ?? SCENE;
        return {
          title: t.title || t.subtitle || campaign_code,
          kind: isSignin ? 'daily_signin' : (t.campaign_type || t.task_kind || ''),
          status_raw: t.task_status,
          claimed: claimed,
          reward: rw,
          claimable: (!isSignin && !claimed && done && rw > 0),
          task_id: campaign_code,
          campaign_code: campaign_code,
          campaign_group_code: campaign_group_code,
        };
      });
      return { detail_code: detail.code, list, raw: tasks };
    }, { SCENE, QP });

    await page.close();
    uploadCookiesToServer();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    _signing = false;
  }
}

// ---- HTTP 服务 ----
const server = http.createServer(async (req, res) => {
  // CORS：本机签名服务只允许从本机访问，但签到中心网页(https://bjzjsf.asia)从浏览器跨域调用，
  // 故放行其 Origin；同时兜底回显请求方 Origin，保证本地直连也能用。
  const reqOrigin = req.headers.origin || ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', reqOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];
  if (url === '/sync-cookie') {
    // 方案二：手动触发一次把本机 cookie 推送到 112（浏览器访问 http://127.0.0.1:8791/sync-cookie 即可）
    uploadCookiesToServer().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: 'cookie 推送已触发，详见 doubao_sign.log' }));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'doubao-sign', ts: Date.now() }));
    return;
  }
  if (url === '/' ) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'doubao-sign', endpoints: ['GET /health', 'POST /sign', 'GET /tasks', 'POST /tasks'], note: '签到中心网页直接调用 /sign 或 /tasks' }));
    return;
  }
  if (url === '/tasks' && req.method === 'GET') {
    // 读取任务列表（用于弹窗展示），不含领取动作
    const r = await getTaskList();
    res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (url === '/sign' && req.method === 'POST') {
    const r = await doSign();
    res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (url === '/tasks' && req.method === 'POST') {
    const r = await doTasks();
    res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[doubao-sign] 服务已启动: http://127.0.0.1:${PORT}  (CORS origin=${ORIGIN})`);
});

// ---- 每日定时：自动签到 + 自动领积分（无需人工干预）----
// 豆包任务本身需王大少在电脑版真实完成（平台校验真实使用），本服务只负责：
//   1) 每日 08:25 自动签到
//   2) 每日 08:30 / 20:00 自动领取「已完成任务」的积分（无需开网页）
function scheduleAt(hh, mm, fn, label) {
  const now = new Date();
  let next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    try {
      console.log('[doubao-sign] 定时任务触发: ' + label);
      const r = await fn();
      console.log('[doubao-sign] ' + label + ' 结果:', JSON.stringify(r && r.result ? r.result : r).slice(0, 400));
    } catch (e) {
      console.error('[doubao-sign] ' + label + ' 出错:', e);
    }
    scheduleAt(hh, mm, fn, label);
  }, delay);
  console.log(`[doubao-sign] 下次${label}: ${next.toLocaleString()}`);
}
scheduleAt(8, 25, doSign, '自动签到');
scheduleAt(8, 30, doTasks, '自动领积分(晨)');
scheduleAt(20, 0, doTasks, '自动领积分(晚)');

// ---- 中继通道：轮询 112 上的待处理请求（解决 HTTPS 页无法直接 fetch 本机 http 服务）----
const RELAY_KEY = '19921010';
function startRelay() {
  // 签到请求轮询
  setInterval(async () => {
    try {
      const r = await fetch('https://bjzjsf.asia/checkin/api/doubao/poll?k=' + encodeURIComponent(RELAY_KEY), { method: 'GET' });
      const j = await r.json();
      if (j && j.ok && j.pending) {
        console.log('[doubao-sign] relay: 收到网页签到请求，执行本机浏览器签名...');
        const res = await doSign();
        console.log('[doubao-sign] relay sign result:', JSON.stringify(res).slice(0, 200));
      }
    } catch (e) { /* 网络抖动忽略 */ }
  }, 15000);
  // 完成任务请求轮询
  setInterval(async () => {
    try {
      const r = await fetch('https://bjzjsf.asia/checkin/api/doubao/poll-tasks?k=' + encodeURIComponent(RELAY_KEY), { method: 'GET' });
      const j = await r.json();
      if (j && j.ok && j.pending) {
        console.log('[doubao-sign] relay: 收到网页「完成任务」请求，执行本机浏览器领取...');
        const res = await doTasks();
        console.log('[doubao-sign] relay tasks result:', JSON.stringify(res).slice(0, 300));
      }
    } catch (e) { /* 网络抖动忽略 */ }
  }, 15000);
}
startRelay();

// ---- 防漏签：启动补签 + 每 20 分钟保活（覆盖电脑睡眠错过 08:25 定时 / 进程重启遗漏）----
const SIGN_STATE = path.join(__dirname, 'doubao_signed_today.json');
function signedTodayFlag() {
  try {
    const d = JSON.parse(fs.readFileSync(SIGN_STATE, 'utf-8'));
    return d.date === new Date().toISOString().slice(0, 10);
  } catch (e) { return false; }
}
function markSignedToday() {
  try { fs.writeFileSync(SIGN_STATE, JSON.stringify({ date: new Date().toISOString().slice(0, 10), ts: Date.now() })); } catch (e) {}
}
async function ensureSignedToday() {
  if (signedTodayFlag()) { dlog('[doubao-sign] 今日已签到，保活跳过'); return; }
  dlog('[doubao-sign] 保活补签：今日尚未签到，尝试...');
  try {
    const r = await doSign();
    if (r && r.ok) markSignedToday();
    dlog('[doubao-sign] 保活补签结果: ' + JSON.stringify(r && r.result ? r.result : r).slice(0, 200));
  } catch (e) { dlog('[doubao-sign] 保活补签出错: ' + e); }
}
// 启动后 15s 补签一次（覆盖「刚启动服务、今天还没签」场景）；之后每 20 分钟保活
setTimeout(() => ensureSignedToday(), 15000);
setInterval(() => ensureSignedToday(), 20 * 60 * 1000);

// 方案二：每 30 分钟把本机 cookie 推送到 112（若浏览器已预热），保证服务器侧登录态常新。
// 王少电脑开机期间会自动续 cookie；关机后服务器用最后一次同步的 cookie 继续代签。
setInterval(() => uploadCookiesToServer(), 30 * 60 * 1000);

process.on('SIGINT', async () => {
  console.log('[doubao-sign] 正在关闭 ...');
  if (_browserPromise) { try { (await _browserPromise).close(); } catch (e) {} }
  process.exit(0);
});
