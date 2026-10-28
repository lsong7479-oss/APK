/* 简记 —— 分级便签 */
'use strict';

const KEY = 'jianji_data';
const KEY_BACKUP = 'jianji_backup';
const $ = (s) => document.querySelector(s);
const PLUGINS = (() => {
  const g = (name, key) => { try { return window[name] && window[name][key]; } catch (e) { return undefined; } };
  return {
    Filesystem: g('capacitorFilesystemPluginCapacitor', 'Filesystem'),
    Share: g('capacitorShare', 'Share'),
    Preferences: g('capacitorPreferences', 'Preferences'),
    App: g('capacitorApp', 'App'),
  };
})();
const P = () => PLUGINS;
const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/* ---------------- 数据 ---------------- */
let db = null;            // { app, version, root, settings }
let path = ['root'];      // 当前所在位置（从根到当前条目的 id 列表）
let outline = false;      // 是否展开全部层级
let saveTimer = null;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function newNode(title = '', content = '') { return { id: uid(), title, content, children: [], updated: Date.now() }; }
function freshDb() {
  return { app: 'jianji', version: 1, root: { id: 'root', title: '全部', content: '', children: [] }, settings: { fontScale: 1 } };
}

async function storeGet(key) {
  try { if (P().Preferences) { const r = await P().Preferences.get({ key }); return r.value; } } catch (e) {}
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
async function storeSet(key, value) {
  try { if (P().Preferences) { await P().Preferences.set({ key, value }); return; } } catch (e) {}
  try { localStorage.setItem(key, value); } catch (e) {}
}

async function load() {
  const raw = await storeGet(KEY);
  try { db = raw ? JSON.parse(raw) : freshDb(); } catch (e) { db = freshDb(); }
  if (!db.root) db = freshDb();
  if (!db.settings) db.settings = { fontScale: 1 };
}
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
async function saveNow() { clearTimeout(saveTimer); saveTimer = null; await storeSet(KEY, JSON.stringify(db)); }

function find(id, node = db.root, parent = null) {
  if (node.id === id) return { node, parent };
  for (const c of node.children) { const r = find(id, c, node); if (r) return r; }
  return null;
}
function cur() { return find(path[path.length - 1]).node; }
function countAll(n) { return n.children.reduce((s, c) => s + 1 + countAll(c), 0); }

/* ---------------- 渲染 ---------------- */
function render() {
  // 当前路径失效时（如被删除）回退
  while (path.length > 1 && !find(path[path.length - 1])) path.pop();
  const node = cur();
  const atRoot = path.length === 1;

  $('#btnBack').classList.toggle('hide', atRoot);

  // 面包屑
  const crumbs = $('#crumbs'); crumbs.innerHTML = '';
  path.forEach((id, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; crumbs.appendChild(s); }
    const n = find(id).node;
    const b = document.createElement('button');
    b.className = 'c' + (i === path.length - 1 ? ' cur' : '');
    b.textContent = id === 'root' ? '全部' : (n.title || '无标题');
    b.onclick = () => go(path.slice(0, i + 1));
    crumbs.appendChild(b);
  });
  requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });

  // 编辑区
  $('#editor').hidden = atRoot;
  if (!atRoot) {
    if (document.activeElement !== $('#title')) $('#title').value = node.title;
    if (document.activeElement !== $('#content')) $('#content').value = node.content;
    autoGrow();
  }

  // 搜索（仅主页）
  $('#searchBox').hidden = !atRoot;
  const q = atRoot ? $('#search').value.trim() : '';
  const list = $('#list'); list.innerHTML = '';
  if (q) {
    const res = searchAll(q);
    $('#childLabel').textContent = `搜索结果（${res.length}）`;
    $('#btnOutline').hidden = true;
    res.forEach(r => list.appendChild(resultEl(r, q)));
    $('#empty').textContent = '没有找到匹配的内容';
    $('#empty').hidden = res.length > 0;
    $('#childHead').hidden = false;
    return;
  }
  $('#empty').textContent = '还没有内容，点右下角 ＋ 新建';

  // 子条目
  $('#childLabel').textContent = atRoot ? `全部条目（${countAll(node)}）` : `子条目（${node.children.length}）`;
  $('#btnOutline').textContent = outline ? '只看本层' : '展开全部';
  $('#btnOutline').hidden = !node.children.some(c => c.children.length);
  const walk = (arr, lv) => arr.forEach(c => {
    list.appendChild(itemEl(c, lv));
    if (outline) walk(c.children, lv + 1);
  });
  walk(node.children, 0);
  $('#empty').hidden = node.children.length > 0 || !atRoot;
  $('#childHead').hidden = !atRoot && node.children.length === 0;
}

function itemEl(n, lv) {
  const li = document.createElement('li');
  li.className = 'item lv' + lv;
  const body = document.createElement('div'); body.className = 'body';
  const t = document.createElement('div'); t.className = 't' + (n.title ? '' : ' untitled'); t.textContent = n.title || '无标题';
  body.appendChild(t);
  const first = (n.content || '').split('\n').find(l => l.trim());
  if (first) { const p = document.createElement('div'); p.className = 'p'; p.textContent = first.trim(); body.appendChild(p); }
  if (n.children.length) { const c = document.createElement('div'); c.className = 'n'; c.textContent = `${n.children.length} 个子条目`; body.appendChild(c); }
  body.onclick = () => go(pathTo(n.id));
  const more = document.createElement('button'); more.className = 'more'; more.textContent = '⋮'; more.setAttribute('aria-label', '操作');
  more.onclick = (e) => { e.stopPropagation(); itemMenu(n); };
  li.append(body, more);
  return li;
}

/* ---------------- 搜索 ---------------- */
// 在所有层级里搜标题和正文；空格分隔多个词时要求全部命中
function searchAll(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const res = [];
  const walk = (n, trail) => n.children.forEach(c => {
    const hay = (c.title + '\n' + c.content).toLowerCase();
    if (words.every(w => hay.includes(w))) res.push({ n: c, trail });
    walk(c, [...trail, c.title || '无标题']);
  });
  walk(db.root, []);
  return res;
}
function highlight(text, q) {
  const words = q.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return esc(text);
  const re = new RegExp('(' + words.join('|') + ')', 'gi');
  return text.split(re).map((s, i) => i % 2 ? `<mark>${esc(s)}</mark>` : esc(s)).join('');
}
function snippet(content, q) {
  const flat = (content || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const lower = flat.toLowerCase();
  let at = -1;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) { at = lower.indexOf(w); if (at >= 0) break; }
  if (at < 0) return flat.slice(0, 60);
  const start = Math.max(0, at - 12);
  return (start > 0 ? '…' : '') + flat.slice(start, start + 60);
}
function resultEl(r, q) {
  const n = r.n;
  const li = document.createElement('li'); li.className = 'item lv0';
  const body = document.createElement('div'); body.className = 'body';
  const t = document.createElement('div'); t.className = 't' + (n.title ? '' : ' untitled');
  t.innerHTML = n.title ? highlight(n.title, q) : '无标题';
  body.appendChild(t);
  if (r.trail.length) { const pa = document.createElement('div'); pa.className = 'path'; pa.textContent = r.trail.join(' › '); body.appendChild(pa); }
  const sn = snippet(n.content, q);
  if (sn) { const p = document.createElement('div'); p.className = 'p'; p.innerHTML = highlight(sn, q); body.appendChild(p); }
  body.onclick = () => { $('#search').blur(); go(pathTo(n.id)); };
  const more = document.createElement('button'); more.className = 'more'; more.textContent = '⋮'; more.setAttribute('aria-label', '操作');
  more.onclick = (e) => { e.stopPropagation(); itemMenu(n); };
  li.append(body, more);
  return li;
}

function pathTo(id) {
  const out = [];
  const dfs = (node) => {
    out.push(node.id);
    if (node.id === id) return true;
    for (const c of node.children) if (dfs(c)) return true;
    out.pop(); return false;
  };
  dfs(db.root); return out;
}

function go(newPath) {
  cleanupEmpty();
  path = newPath;
  window.scrollTo(0, 0);
  render();
}
function goUp() { if (path.length > 1) go(path.slice(0, -1)); }

// 离开一个完全空白（无标题、无正文、无子条目）的条目时自动删除
function cleanupEmpty() {
  const id = path[path.length - 1];
  if (id === 'root') return;
  const r = find(id); if (!r) return;
  const n = r.node;
  if (!n.title.trim() && !n.content.trim() && !n.children.length) {
    r.parent.children = r.parent.children.filter(c => c !== n);
    saveSoon();
  }
}

// 正文框随内容增高。测量时先锁住页面高度，避免文本框临时缩短导致页面被拉回顶部
function autoGrow() {
  const t = $('#content');
  const doc = document.documentElement;
  const y = window.scrollY;
  doc.style.minHeight = doc.scrollHeight + 'px';
  t.style.height = 'auto';
  t.style.height = Math.max(t.scrollHeight, window.innerHeight * 0.3) + 'px';
  doc.style.minHeight = '';
  if (window.scrollY !== y) window.scrollTo(0, y);
}

/* ---------------- 编辑 ---------------- */
function bindEditor() {
  $('#title').addEventListener('input', (e) => {
    const n = cur(); n.title = e.target.value; n.updated = Date.now(); saveSoon();
    const c = $('#crumbs .c.cur'); if (c) c.textContent = n.title || '无标题';
  });
  $('#content').addEventListener('input', (e) => {
    const n = cur(); n.content = e.target.value; n.updated = Date.now(); saveSoon(); autoGrow();
  });
  $('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#content').focus(); } });
}

function addChild() {
  const n = newNode();
  cur().children.push(n);
  saveSoon();
  path = [...path, n.id];
  window.scrollTo(0, 0);
  render();
  setTimeout(() => $('#title').focus(), 50);
}

/* ---------------- 条目操作 ---------------- */
function itemMenu(n) {
  const { parent } = find(n.id);
  const sib = parent.children; const i = sib.indexOf(n);
  const rows = [
    { label: '上移', hide: i === 0, fn: () => { sib.splice(i, 1); sib.splice(i - 1, 0, n); } },
    { label: '下移', hide: i === sib.length - 1, fn: () => { sib.splice(i, 1); sib.splice(i + 1, 0, n); } },
    { label: '降一级', sub: '变成上一个条目的子条目', hide: i === 0, fn: () => { sib.splice(i, 1); sib[i - 1].children.push(n); } },
    { label: '升一级', sub: '移到上一层，排在原上级后面', hide: parent.id === 'root', fn: () => {
        const gp = find(parent.id).parent; sib.splice(i, 1);
        gp.children.splice(gp.children.indexOf(parent) + 1, 0, n);
      } },
    { label: '导出为图片', sub: '含它的所有子条目', fn: () => exportImage(n), keep: true },
    { label: '导出为文本', sub: 'Markdown，含所有子条目', fn: () => exportText(n), keep: true },
    { label: '删除', danger: true, fn: async () => {
        const total = countAll(n);
        const ok = await dialog('删除条目', `确定删除「${esc(n.title || '无标题')}」${total ? `及其 ${total} 个子条目` : ''}？`,
          [{ label: '取消', value: false }, { label: '删除', value: true, cls: 'danger' }]);
        if (ok) { sib.splice(sib.indexOf(n), 1); saveSoon(); render(); toast('已删除'); }
      }, keep: true },
  ];
  openSheet(n.title || '无标题', rows.filter(r => !r.hide).map(r => ({
    ...r, fn: () => { r.fn(); if (!r.keep) { saveSoon(); render(); } }
  })));
}

function mainMenu() {
  const n = cur(); const atRoot = path.length === 1;
  const scale = Math.round((db.settings.fontScale || 1) * 100);
  const sheet = $('#sheet');
  openSheet(null, [
    { html: `<div class="zoom"><button data-z="-1">A−</button><span>字号 ${scale}%</span><button data-z="1">A+</button></div>` },
    { sep: true },
    { label: atRoot ? '导出全部为图片' : '导出当前条目为图片', sub: '长图，含子条目', fn: () => exportImage(n) },
    { label: '整体导出（给 AI 整理）', sub: 'Markdown 文本：分享 / 保存 / 复制', fn: () => exportText(db.root) },
    { label: '完整备份', sub: 'JSON 文件，可原样恢复', fn: () => exportJson() },
    { sep: true },
    { label: '导入文件', sub: '.md / .txt / .json', fn: () => $('#filePick').click() },
    { label: '粘贴文本导入', sub: '把 AI 整理好的内容粘贴进来', fn: () => pasteImport() },
    { label: '恢复导入前的数据', sub: '撤销上一次导入', fn: () => restoreBackup() },
    { sep: true },
    { label: '使用说明', fn: () => help() },
  ]);
  sheet.querySelectorAll('[data-z]').forEach(b => b.onclick = () => {
    setScale((db.settings.fontScale || 1) + Number(b.dataset.z) * 0.1);
    sheet.querySelector('.zoom span').textContent = `字号 ${Math.round(db.settings.fontScale * 100)}%`;
  });
}

function openSheet(title, rows) {
  const sh = $('#sheet'); sh.innerHTML = '';
  if (title) { const t = document.createElement('div'); t.className = 'sh-title'; t.textContent = title; sh.appendChild(t); }
  rows.forEach(r => {
    if (r.sep) { sh.appendChild(document.createElement('hr')); return; }
    if (r.html) { const d = document.createElement('div'); d.innerHTML = r.html; sh.appendChild(d.firstChild); return; }
    const b = document.createElement('button'); b.className = 'row' + (r.danger ? ' danger' : '');
    b.textContent = r.label;
    if (r.sub) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = r.sub; b.appendChild(s); }
    b.onclick = () => { closeSheet(); r.fn(); };
    sh.appendChild(b);
  });
  $('#sheetMask').hidden = false; sh.hidden = false;
}
function closeSheet() { $('#sheetMask').hidden = true; $('#sheet').hidden = true; }

/* ---------------- 缩放（字号） ---------------- */
function setScale(v) {
  v = Math.min(2.2, Math.max(0.7, Math.round(v * 100) / 100));
  db.settings.fontScale = v;
  document.documentElement.style.setProperty('--fs', v);
  autoGrow(); saveSoon();
}
function bindPinch() {
  let d0 = 0, s0 = 1;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { d0 = dist(e.touches); s0 = db.settings.fontScale || 1; }
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && d0) {
      e.preventDefault();
      const v = Math.min(2.2, Math.max(0.7, s0 * dist(e.touches) / d0));
      document.documentElement.style.setProperty('--fs', v);
      db.settings.fontScale = v;
    }
  }, { passive: false });
  document.addEventListener('touchend', (e) => {
    if (d0 && e.touches.length < 2) { d0 = 0; setScale(db.settings.fontScale); toast(`字号 ${Math.round(db.settings.fontScale * 100)}%`); }
  });
}

/* ---------------- 导出 ---------------- */
const MD_HEAD = '<!-- 简记导出。格式：每个条目是一行标题，开头 # 的个数表示层级（# 第一层，## 第二层，### 第三层……可以超过 6 个）；标题下面到下一个标题之前的文字是该条目的正文。正文里以 # 开头的行前面加了反斜杠 \\。整理时请保持这个格式，整理后的结果可以直接导回简记。 -->';

function toMarkdown(node) {
  const out = [MD_HEAD, ''];
  const put = (n, lv) => {
    out.push('#'.repeat(lv) + ' ' + (n.title.trim() || '无标题'));
    const body = (n.content || '').replace(/\s+$/, '');
    if (body) out.push(body.split('\n').map(l => /^\s*#/.test(l) ? '\\' + l : l).join('\n'));
    out.push('');
    n.children.forEach(c => put(c, lv + 1));
  };
  if (node.id === 'root') node.children.forEach(c => put(c, 1)); else put(node, 1);
  return out.join('\n');
}

function stamp() {
  const d = new Date(); const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function safeName(s) { return (s || '无标题').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30); }

async function exportText(node) {
  const md = toMarkdown(node);
  const name = `简记-${node.id === 'root' ? '全部' : safeName(node.title)}-${stamp()}.md`;
  const how = await dialog('导出文本', `共 ${node.id === 'root' ? countAll(node) : countAll(node) + 1} 个条目，${md.length} 字符。<br>交给 AI 整理时，直接把文字粘贴给它，或者发送文件都可以。`,
    [{ label: '取消', value: null }, { label: '保存到手机', value: 'save' }, { label: '分享', value: 'share' }, { label: '复制', value: 'copy', cls: 'primary' }]);
  if (how === 'copy') { await copyText(md) ? toast('已复制，可直接粘贴给 AI') : toast('复制失败，请改用分享'); }
  else if (how) await outputFile(name, md, 'text/markdown', how);
}

async function exportJson() {
  const json = JSON.stringify(db, null, 1);
  const how = await dialog('完整备份', '保存一个 JSON 备份文件，以后可以通过「导入文件」原样恢复。',
    [{ label: '取消', value: null }, { label: '分享', value: 'share' }, { label: '保存到手机', value: 'save', cls: 'primary' }]);
  if (how) await outputFile(`简记备份-${stamp()}.json`, json, 'application/json', how);
}

async function exportImage(node) {
  toast('正在生成图片…');
  const box = $('#render'); box.innerHTML = '';
  const rd = document.createElement('div'); rd.className = 'rd';
  const isRoot = node.id === 'root';
  if (!isRoot) {
    const t = document.createElement('div'); t.className = 'rt'; t.textContent = node.title || '无标题'; rd.appendChild(t);
    if (node.content.trim()) { const c = document.createElement('div'); c.className = 'rc'; c.textContent = node.content.replace(/\s+$/, ''); rd.appendChild(c); }
  } else {
    const t = document.createElement('div'); t.className = 'rt'; t.textContent = '简记'; rd.appendChild(t);
  }
  const walk = (arr, parentEl) => arr.forEach(n => {
    const w = document.createElement('div'); w.className = 'rn';
    const h = document.createElement('div'); h.className = 'rh'; h.textContent = n.title || '无标题'; w.appendChild(h);
    if (n.content.trim()) { const c = document.createElement('div'); c.className = 'rc'; c.textContent = n.content.replace(/\s+$/, ''); w.appendChild(c); }
    walk(n.children, w);
    parentEl.appendChild(w);
  });
  walk(node.children, rd);
  const f = document.createElement('div'); f.className = 'foot'; f.textContent = new Date().toLocaleDateString('zh-CN'); rd.appendChild(f);
  box.appendChild(rd);
  try {
    await new Promise(r => setTimeout(r, 30));
    const h = rd.offsetHeight;
    const scale = Math.max(0.5, Math.min(2, 30000 / h)); // 防止超长图超出画布上限
    const canvas = await html2canvas(rd, { scale, backgroundColor: '#fbfaf6', logging: false });
    const dataUrl = canvas.toDataURL('image/png');
    box.innerHTML = '';
    const how = await dialog('图片已生成', `<img src="${dataUrl}" style="width:100%;max-height:42vh;object-fit:contain;object-position:top;border-radius:8px;border:1px solid var(--line)">`,
      [{ label: '取消', value: null }, { label: '分享', value: 'share' }, { label: '保存到手机', value: 'save', cls: 'primary' }]);
    if (how) await outputFile(`简记-${isRoot ? '全部' : safeName(node.title)}-${stamp()}.png`, dataUrl.split(',')[1], 'image/png', how, true);
  } catch (e) {
    box.innerHTML = ''; toast('生成图片失败：' + (e.message || e));
  }
}

// 输出文件：save = 存到手机「Documents/简记」，share = 系统分享（可发微信 / 存网盘等）
async function outputFile(name, data, mime, how, isBase64 = false) {
  const { Filesystem, Share } = P();
  if (!isNative() || !Filesystem) { // 浏览器里直接下载
    const blob = isBase64 ? new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: mime }) : new Blob([data], { type: mime });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    return;
  }
  const opts = { path: name, data, recursive: true };
  if (!isBase64) opts.encoding = 'utf8';
  try {
    if (how === 'save') {
      try {
        await Filesystem.writeFile({ ...opts, path: '简记/' + name, directory: 'DOCUMENTS' });
        toast('已保存到 手机存储/Documents/简记');
        return;
      } catch (e) {
        toast('无法直接保存，改用分享，可选「保存到文件」');
      }
    }
    const r = await Filesystem.writeFile({ ...opts, directory: 'CACHE' });
    await Share.share({ title: name, files: [r.uri] });
  } catch (e) {
    if (!String(e && e.message).match(/cancel/i)) toast('导出失败：' + (e.message || e));
  }
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch (e) {}
  try {
    const t = document.createElement('textarea'); t.value = s; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok;
  } catch (e) { return false; }
}

/* ---------------- 导入 ---------------- */
function parseMarkdown(text, fallbackTitle = '导入的内容') {
  text = text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const top = { children: [] };
  const stack = [{ lv: 0, node: top }];
  let curNode = null, buf = [], fence = false, pre = [];
  const flush = () => {
    const body = buf.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (curNode) curNode.content = body; else if (body) pre.push(body);
    buf = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(/^(#+)(?:[ \t]+(.*))?$/);
    if (m && !/^#+[^#\s]/.test(line)) {
      flush();
      const lv = m[1].length;
      let title = (m[2] || '').trim(); if (title === '无标题') title = '';
      const n = newNode(title);
      while (stack.length > 1 && stack[stack.length - 1].lv >= lv) stack.pop();
      stack[stack.length - 1].node.children.push(n);
      stack.push({ lv, node: n });
      curNode = n;
    } else {
      buf.push(line.replace(/^(\s*)\\#/, '$1#'));
    }
  }
  flush();
  if (pre.length) top.children.unshift(newNode(fallbackTitle, pre.join('\n\n')));
  return top.children;
}

function parseAny(text, filename = '') {
  const s = text.trim();
  if (/\.json$/i.test(filename) || s.startsWith('{') || s.startsWith('[')) {
    try {
      const j = JSON.parse(s);
      if (j && j.root && Array.isArray(j.root.children)) return { full: j, nodes: j.root.children };
      if (Array.isArray(j)) return { nodes: j.map(normalize) };
      if (j && Array.isArray(j.children)) return { nodes: [normalize(j)] };
    } catch (e) { /* 不是 JSON，按文本处理 */ }
  }
  return { nodes: parseMarkdown(text, filename.replace(/\.[^.]+$/, '') || '导入的内容') };
}
function normalize(x) {
  return { id: uid(), title: String(x.title || ''), content: String(x.content || ''),
    children: Array.isArray(x.children) ? x.children.map(normalize) : [], updated: Date.now() };
}
function reId(n) { n.id = uid(); n.children.forEach(reId); return n; }

async function doImport(parsed) {
  const nodes = parsed.nodes || [];
  const total = nodes.reduce((s, n) => s + 1 + countAll(n), 0);
  if (!total) { toast('没有识别到内容'); return; }
  const here = cur(); const atRoot = path.length === 1;
  const btns = [{ label: '取消', value: null }, { label: '替换全部', value: 'replace', cls: 'danger' },
    { label: atRoot ? '追加' : '追加到当前条目下', value: 'append', cls: 'primary' }];
  const how = await dialog('导入', `识别到 ${total} 个条目（第一层 ${nodes.length} 个）。<br>「替换全部」会清空现有内容，但会自动保留一份导入前的备份，可在菜单里恢复。`, btns);
  if (!how) return;
  await storeSet(KEY_BACKUP, JSON.stringify(db));
  if (how === 'replace') {
    if (parsed.full) { db = parsed.full; if (!db.settings) db.settings = { fontScale: 1 }; }
    else db.root.children = nodes;
    path = ['root'];
  } else {
    here.children.push(...nodes.map(reId));
  }
  document.documentElement.style.setProperty('--fs', db.settings.fontScale || 1);
  await saveNow(); render(); toast(`已导入 ${total} 个条目`);
}

function bindFilePick() {
  $('#filePick').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { const text = await f.text(); await doImport(parseAny(text, f.name)); }
    catch (err) { toast('读取文件失败：' + (err.message || err)); }
  });
}

async function pasteImport() {
  const r = await dialog('粘贴文本导入',
    '长按下面的输入框粘贴。支持 AI 整理好的 Markdown（# 表示层级），也支持备份的 JSON。<textarea id="pasteBox" placeholder="在这里粘贴…"></textarea>',
    [{ label: '取消', value: null }, { label: '下一步', value: 'ok', cls: 'primary' }],
    () => document.getElementById('pasteBox').value);
  if (r && r.value === 'ok' && r.extra.trim()) await doImport(parseAny(r.extra));
}

async function restoreBackup() {
  const raw = await storeGet(KEY_BACKUP);
  if (!raw) { toast('没有可恢复的备份'); return; }
  const ok = await dialog('恢复导入前的数据', '会用上一次导入前的数据替换当前全部内容。', [{ label: '取消', value: false }, { label: '恢复', value: true, cls: 'primary' }]);
  if (!ok) return;
  const now = JSON.stringify(db);
  db = JSON.parse(raw); await storeSet(KEY_BACKUP, now);
  path = ['root']; document.documentElement.style.setProperty('--fs', db.settings.fontScale || 1);
  await saveNow(); render(); toast('已恢复（再点一次可以换回来）');
}

function help() {
  dialog('使用说明', `
  <b>分级</b>：每个条目都可以有子条目。点条目进入，在里面点 ＋ 新建下一级；条目右侧 ⋮ 可以上移、下移、升级、降级。<br>
  <b>缩放</b>：两指捏合调整字号，菜单里也有 A− / A+。「展开全部」可以一次看到所有层级。<br>
  <b>导出图片</b>：菜单或条目 ⋮ 里导出，会连同子条目生成一张长图。<br>
  <b>交给 AI 整理</b>：菜单 →「整体导出」→ 复制，粘贴给 AI，请它保持 # 层级格式整理；把结果复制回来，菜单 →「粘贴文本导入」→ 替换全部。导入前会自动备份，不满意可以恢复。<br>
  内容自动保存在本机。`, [{ label: '知道了', value: true, cls: 'primary' }]);
}

/* ---------------- 对话框 / 提示 ---------------- */
let dlgResolve = null;
function dialog(title, html, buttons, getExtra) {
  return new Promise(res => {
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = html;
    const bb = $('#dlgBtns'); bb.innerHTML = '';
    buttons.forEach(b => {
      const el = document.createElement('button'); el.textContent = b.label; if (b.cls) el.className = b.cls;
      el.onclick = () => {
        const extra = getExtra ? getExtra() : undefined;
        $('#dlgMask').hidden = true; dlgResolve = null;
        res(getExtra ? { value: b.value, extra } : b.value);
      };
      bb.appendChild(el);
    });
    dlgResolve = () => { $('#dlgMask').hidden = true; dlgResolve = null; res(getExtra ? { value: null } : null); };
    $('#dlgMask').hidden = false;
  });
}
let toastTimer = null;
function toast(s) {
  const t = $('#toast'); t.textContent = s; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------------- 返回键 / 生命周期 ---------------- */
function handleBack() {
  if (dlgResolve) { dlgResolve(); return; }
  if (!$('#sheet').hidden) { closeSheet(); return; }
  if (path.length > 1) { goUp(); return; }
  saveNow().then(() => { const A = P().App; if (A) A.exitApp(); });
}

async function init() {
  await load();
  document.documentElement.style.setProperty('--fs', db.settings.fontScale || 1);
  bindEditor(); bindPinch(); bindFilePick();
  $('#btnBack').onclick = goUp;
  $('#btnMenu').onclick = mainMenu;
  $('#fab').onclick = addChild;
  $('#btnOutline').onclick = () => { outline = !outline; render(); };
  $('#search').addEventListener('input', render);
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#search').blur(); });
  $('#sheetMask').onclick = closeSheet;
  $('#dlgMask').addEventListener('click', (e) => { if (e.target.id === 'dlgMask' && dlgResolve) dlgResolve(); });
  window.addEventListener('resize', autoGrow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  const A = P().App;
  if (A) {
    A.addListener('backButton', handleBack);
    A.addListener('pause', saveNow);
  }
  render();
}

window.jianji = { parseMarkdown, toMarkdown, parseAny, get db() { return db; } }; // 方便调试
init();
