/* 离线校验：语法 / 标签 / 引用 / 端到端跑一遍（Node 内迷你 DOM 桩） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const FILE = path.join(__dirname, 'index.html');
const src = fs.readFileSync(FILE, 'utf8');
const fail = [];
const ok = [];
const A = (cond, msg) => (cond ? ok.push(msg) : fail.push(msg));

/* ---------- 1. 抽取 ---------- */
const styleBlock = (src.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const scriptBlock = (src.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];
const bodyBlock = src.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
A(scriptBlock.length > 8000, `script 抽取成功（${scriptBlock.length} 字符）`);

/* ---------- 2. 语法 ---------- */
try { new vm.Script(scriptBlock, { filename: 'app.js' }); ok.push('JS 语法检查通过'); }
catch (e) { fail.push('JS 语法错误: ' + e.message); }

/* ---------- 3. 静态 HTML 标签配平 ---------- */
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
function tagCheck(html, label) {
  const bad = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, , selfClose] = m;
    const t = tag.toLowerCase();
    if (VOID.has(t) || selfClose) continue;
    if (!close) stack.push(t);
    else {
      if (!stack.length) { bad.push(`多余的 </${t}>`); continue; }
      const top = stack.pop();
      if (top !== t) bad.push(`</${t}> 对不上 <${top}>`);
    }
  }
  if (stack.length) bad.push('未闭合: ' + stack.join(','));
  return bad;
}
const bodyBad = tagCheck(bodyBlock.replace(/<!--[\s\S]*?-->/g, ''), 'body');
A(bodyBad.length === 0, 'HTML 标签配平' + (bodyBad.length ? '：' + bodyBad.slice(0, 5).join(' | ') : ''));

/* ---------- 4. id / 引用一致性 ---------- */
const ids = new Set([...src.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const usedIds = [...scriptBlock.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]);
const missingIds = [...new Set(usedIds)].filter(i => !ids.has(i));
A(missingIds.length === 0, `脚本引用的 id 全部存在${missingIds.length ? '（缺：' + missingIds.join(',') + '）' : ''}`);

/* ---------- 5. 迷你 DOM ---------- */
const HTML_LOG = [];
function mkEl(tag = 'div') {
  const kids = [];
  const sel = new Map();
  const e = {
    tagName: tag, children: kids, style: {}, dataset: {}, className: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(x) { return this._s.has(x); },
      toggle() {}
    },
    appendChild(c) { kids.push(c); c._parent = e; return c; },
    removeChild(c) { const i = kids.indexOf(c); if (i >= 0) kids.splice(i, 1); },
    remove() { const p = e._parent; if (p) { const i = p.children.indexOf(e); if (i >= 0) p.children.splice(i, 1); } },
    insertAdjacentHTML() {},
    get firstElementChild() { return kids[0] || null; },
    get lastElementChild() { return kids[kids.length - 1] || null; },
    querySelector(s) { if (!sel.has(s)) sel.set(s, mkEl()); return sel.get(s); },
    querySelectorAll() { return []; },
    isConnected: true, offsetWidth: 1, scrollTop: 0, scrollHeight: 0,
    content: null
  };
  Object.defineProperty(e, 'innerHTML', {
    get() { return e._h || ''; },
    set(v) { e._h = String(v); HTML_LOG.push(String(v)); if (String(v).trim() === '') kids.length = 0; }
  });
  Object.defineProperty(e, 'textContent', {
    get() { return e._t || ''; },
    set(v) { e._t = String(v); HTML_LOG.push(String(v)); }
  });
  return e;
}
const registry = new Map();
const doc = {
  createElement(tag) {
    const t = mkEl(tag);
    const frag = mkEl('fragment');
    frag.appendChild(mkEl());
    t.content = frag;
    return t;
  },
  querySelector(s) { if (!registry.has(s)) registry.set(s, mkEl()); return registry.get(s); },
  querySelectorAll() { return []; },
  addEventListener() {}
};

/* ---------- 6. 在 vm 里跑整个脚本 ---------- */
const errors = [];
const ctx = {
  document: doc,
  location: { hash: '' },
  console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
  setTimeout: (fn) => { try { fn(); } catch (err) { errors.push('timer: ' + err.message); } return 0; },
  clearTimeout() {},
  performance: (() => { let t = 0; return { now: () => (t += 50) }; })(),
  requestAnimationFrame: (fn) => { try { fn(Date.now()); } catch (err) { errors.push('raf: ' + err.message); } return 0; }
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

let tail = '';
try {
  vm.runInContext(scriptBlock + '\n;globalThis.__T={VIEW,META,SPECS,SCENES,TURNS,CTRL,P,send,jump};', ctx, { filename: 'app.js', timeout: 20000 });
  ok.push('脚本求值无异常');
} catch (e) {
  fail.push('脚本求值抛错: ' + e.message + '\n' + String(e.stack).split('\n').slice(0, 4).join('\n'));
}
const T = ctx.__T || {};

/* ---------- 7. 视图 / 元数据 / 规格 对齐 ---------- */
if (T.VIEW) {
  const vk = Object.keys(T.VIEW), mk = Object.keys(T.META), sk = Object.keys(T.SPECS);
  A(vk.length === 8, `视图数量 = ${vk.length}`);
  A(mk.length === vk.length && mk.every(k => vk.includes(k)), 'META 与 VIEW 一一对应');
  A(sk.length === vk.length && sk.every(k => vk.includes(k)), 'SPECS 与 VIEW 一一对应');

  const shown = new Set([...scriptBlock.matchAll(/h\.show\('([\w-]+)'\)/g)].map(m => m[1]));
  A([...shown].every(k => vk.includes(k)), `ACTS 调用的视图都实现（${[...shown].join(',')}）`);
  A(shown.size === 8, `8 个视图全部被剧本用到（用到 ${shown.size} 个）`);

  // 逐个构造，检查标签配平与空值
  Object.entries(T.VIEW).forEach(([k, fn]) => {
    let h;
    try { h = fn(); } catch (e) { fail.push(`VIEW.${k}() 抛错: ${e.message}`); return; }
    if (typeof h !== 'string') { fail.push(`VIEW.${k}() 未返回字符串`); return; }
    const bad = tagCheck(h, k);
    if (bad.length) fail.push(`VIEW.${k} 标签问题: ${bad.slice(0, 4).join(' | ')}`);
    if (/undefined|NaN/.test(h)) fail.push(`VIEW.${k} 输出含 undefined/NaN`);
    A(h.length > 400, `VIEW.${k} 有内容（${h.length} 字符）`);
  });

  // data-tone 主题是否都有 CSS
  const tones = new Set([...scriptBlock.matchAll(/tone:\s*'(\w+)'/g)].map(m => m[1]));
  [...tones].forEach(t => {
    if (!styleBlock.includes(`data-tone="${t}"`)) fail.push(`缺少主题样式: data-tone="${t}"`);
  });
  A(tones.size >= 5, `主题色 ${tones.size} 套，均有 CSS`);
}

/* ---------- 8. 端到端：一条条「发」完整部剧 ---------- */
(async () => {
if (T.CTRL) {
  T.CTRL.speed = 5000;            // 时间加速
  const feedEl = doc.querySelector('#feed');
  const stageEl = doc.querySelector('#stage');

  A(T.SCENES && T.SCENES.length === 8, `剧本幕数 = ${T.SCENES ? T.SCENES.length : '?'}`);
  A(T.TURNS && T.TURNS.length === 15, `用户可发送的轮数 = ${T.TURNS ? T.TURNS.length : '?'}`);
  A(T.TURNS.every(t => typeof t.me === 'string' && t.me.length > 0), '每一轮都有唯一的用户话术');
  A(T.TURNS.filter(t => t.first).length === 8, '每一幕都有开场轮');

  // 初始态：输入框里就是第一条，且还没有任何气泡
  const cmp0 = doc.querySelector('#cmpText').textContent;
  A(cmp0 === T.TURNS[0].me, `初始输入框 = "${cmp0}"`);
  A(feedEl.children.length === 0, '初始对话为空（等你自己发）');

  let guard = 0;
  try { while (!T.P.done && guard++ < 40) await T.send(); }
  catch (e) { errors.push('send: ' + e.message); }

  A(T.P.done === true, `发送 ${guard} 轮后结束`);
  const userMsgs = HTML_LOG.filter(x => x.includes('class="msg me"')).length;
  A(userMsgs === 15, `对话里 ${userMsgs} 条用户消息（一人一轮）`);

  const log = HTML_LOG.join('\n');
  const must = ['今天需要你决定的事', 'MOSFET 驱动 IC', '未来 14 天现金流', 'PR-5512 采购审批',
                'SO-2036 良率归因', 'crm_liyang', '按毛利率重排的提案', '你今天留下了什么',
                '320 万', '8,412', '9.1 个点'];
  const lost = must.filter(s => !log.includes(s));
  A(lost.length === 0, `8 幕关键内容全部渲染${lost.length ? '（缺：' + lost.join(' / ') + '）' : ''}`);
  const surfaces = HTML_LOG.filter(x => x.includes('class="surface"')).length;
  A(surfaces >= 8, `画布渲染次数 = ${surfaces}`);
  A(stageEl.children.length === 1, '画布同时只保留一个视图（不堆叠）');
  A(!/\*\*/.test(log), '没有残留的 markdown 星号');
  A(!/undefined|\[object Object\]/.test(HTML_LOG.filter(x => x.includes('class="surface"')).join('')), '画布输出无 undefined');

  const railEl = doc.querySelector('#rail');
  A(railEl.children.length === 8, `进度轨 = ${railEl.children.length} 段`);
  A(doc.querySelector('#cmpText').textContent.includes('演示结束'), '结束后输入框给出重播提示');
}

if (errors.length) fail.push('运行时错误: ' + errors.slice(0, 5).join(' | '));

/* ---------- 9. 报告 ---------- */
console.log('\n通过 ' + ok.length + ' 项：');
ok.forEach(o => console.log('  ✓ ' + o));
if (fail.length) {
  console.log('\n失败 ' + fail.length + ' 项：');
  fail.forEach(f => console.log('  ✗ ' + f));
  console.log('\nRESULT: FAILED');
  process.exit(1);
}
console.log('\nRESULT: ALL PASSED');
})();
