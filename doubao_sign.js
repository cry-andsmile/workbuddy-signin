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
      for (const t of tasks) {
        // 跳过「每日签到」（由 /sign 处理）
        const isSignin = (t.campaign_code === 'daily_signin' || t.task_kind === 'daily_signin');
        if (isSignin) continue;
        const rw = (typeof t.reward_amount === 'number') ? t.reward_amount
                 : (t.reward && typeof t.reward.reward_amount === 'number') ? t.reward.reward_amount
                 : (typeof t.bonus === 'number') ? t.bonus
                 : (t.reward && typeof t.reward.amount === 'number') ? t.reward.amount : 0;
        const claimed = !!(t.claimed || t.is_claimed
          || ['claimed', 'received', 'done', 'finished', '3'].includes(String(t.status).toLowerCase()));
        if (claimed) { out.skipped++; out.tasks.push({ title: t.title || t.name || t.task_id || t.id, status: 'already_claimed' }); continue; }
        if (!rw || rw <= 0) { out.skipped++; out.tasks.push({ title: t.title || t.name || t.task_id || t.id, status: 'no_reward' }); continue; }
        const task_id = t.task_id ?? t.id ?? t.item_id;
        const campaign_group_code = t.campaign_group_code ?? SCENE;
        const campaign_item_code = t.campaign_item_code ?? t.item_code ?? t.code ?? t.campaign_item_code;
        const AgwCommonParam = t.AgwCommonParam ?? t.agw_common_param ?? {};
        if (!task_id || !campaign_item_code) {
          out.skipped++; out.tasks.push({ title: t.title || t.name || task_id, status: 'skip_no_params', task_id, campaign_item_code });
          continue;
        }
        const r = await post('/alice/ug/campaign/item/reward/claim/', { task_id, campaign_group_code, campaign_item_code, AgwCommonParam });
        const ok = r && r.code === 0;
        if (ok) out.claimed++; else out.failed++;
        out.tasks.push({ title: t.title || t.name || task_id, status: ok ? 'claimed' : ('fail:' + (r && r.code)), code: r && r.code, msg: (r && (r.msg || r.message)) || '' });
      }
      return out;
    }, { SCENE, QP });

    await page.close();
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
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'doubao-sign', ts: Date.now() }));
    return;
  }
  if (url === '/' ) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'doubao-sign', endpoints: ['GET /health', 'POST /sign'], note: '签到中心网页直接调用 /sign' }));
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

// ---- 每日定时自动签（与主签到中心错峰，默认 08:25）----
const SCHED_HH = 8, SCHED_MM = 25;
function scheduleDaily() {
  const now = new Date();
  let next = new Date(now);
  next.setHours(SCHED_HH, SCHED_MM, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    console.log('[doubao-sign] 定时自动签到触发 ...');
    const r = await doSign();
    console.log('[doubao-sign] 自动签到结果:', JSON.stringify(r).slice(0, 300));
    scheduleDaily();
  }, delay);
  console.log(`[doubao-sign] 下次自动签到: ${next.toLocaleString()}`);
}
scheduleDaily();

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

process.on('SIGINT', async () => {
  console.log('[doubao-sign] 正在关闭 ...');
  if (_browserPromise) { try { (await _browserPromise).close(); } catch (e) {} }
  process.exit(0);
});
