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
const KEY_VER = 'jianji_versions';
let versions = {};        // { 条目id: [{ t, title, content }] } 每条最近 20 个历史版本
let enteredId = null;     // 当前打开的条目（用于进入时存一个版本）
let archOpen = false;     // 「已归档」区是否展开
let suppressClick = 0;    // 拖动刚结束时屏蔽一次点击

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
  fixDb();
  try { versions = JSON.parse(await storeGet(KEY_VER) || '{}') || {}; } catch (e) { versions = {}; }
  purgeTrash();
}
function fixDb() {
  if (!db.settings) db.settings = { fontScale: 1 };
  if (!Array.isArray(db.trash)) db.trash = [];
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
function liveKids(n) { return n.children.filter(c => !c.archived); }
function countLive(n) { return liveKids(n).reduce((s, c) => s + 1 + countLive(c), 0); }
function charCount(s) { return (s || '').replace(/\s/g, '').length; }
function charsAll(n) { return charCount(n.title) + charCount(n.content) + n.children.reduce((s, c) => s + charsAll(c), 0); }

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
    syncHist();
    if (enteredId !== node.id) { enteredId = node.id; snapVersion(node); }
    updWC();
  } else enteredId = null;
  updUR();

  // 搜索（仅主页）
  $('#searchBox').hidden = !atRoot;
  const q = atRoot ? $('#search').value.trim() : '';
  const list = $('#list'); list.innerHTML = '';
  $('#archBox').hidden = true;
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

  // 子条目（归档的收进底部「已归档」区）
  const live = liveKids(node), arch = node.children.filter(c => c.archived);
  $('#childLabel').textContent = atRoot ? `全部条目（${countAll(node)}）` : `子条目（${live.length}）`;
  $('#btnOutline').textContent = outline ? '只看本层' : '展开全部';
  $('#btnOutline').hidden = !live.some(c => liveKids(c).length);
  const walk = (arr, lv) => arr.forEach(c => {
    list.appendChild(itemEl(c, lv));
    if (outline) walk(liveKids(c), lv + 1);
  });
  walk(live, 0);
  $('#archBox').hidden = !arch.length;
  $('#archHead').textContent = `${archOpen ? '▾' : '▸'} 已归档（${arch.length}）`;
  const al = $('#archList'); al.innerHTML = ''; al.hidden = !archOpen;
  if (archOpen) arch.forEach(c => al.appendChild(itemEl(c, 0)));
  $('#empty').hidden = node.children.length > 0 || !atRoot;
  $('#childHead').hidden = !atRoot && live.length === 0;
}

function itemEl(n, lv) {
  const li = document.createElement('li');
  li.className = 'item lv' + lv + (n.archived ? ' archived' : '');
  li.dataset.id = n.id;
  const body = document.createElement('div'); body.className = 'body';
  const t = document.createElement('div'); t.className = 't' + (n.title ? '' : ' untitled'); t.textContent = n.title || '无标题';
  body.appendChild(t);
  const first = (n.content || '').split('\n').find(l => l.trim());
  if (first) { const p = document.createElement('div'); p.className = 'p'; p.textContent = first.trim(); body.appendChild(p); }
  const kl = liveKids(n).length, ka = n.children.length - kl;
  if (n.children.length) {
    const c = document.createElement('div'); c.className = 'n';
    c.textContent = kl ? `${kl} 个子条目${ka ? `（另有 ${ka} 个已归档）` : ''}` : `${ka} 个已归档子条目`;
    body.appendChild(c);
  }
  body.onclick = () => { if (Date.now() - suppressClick < 350) return; go(pathTo(n.id)); };
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
  const walk = (n, trail, inArch) => n.children.forEach(c => {
    const arch = inArch || !!c.archived;
    const hay = (c.title + '\n' + c.content).toLowerCase();
    if (words.every(w => hay.includes(w))) res.push({ n: c, trail, arch });
    walk(c, [...trail, c.title || '无标题'], arch);
  });
  walk(db.root, [], false);
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
  t.innerHTML = (n.title ? highlight(n.title, q) : '无标题') + (r.arch ? '<span class="tag">已归档</span>' : '');
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
  const r = find(curId()); if (r && curId() !== 'root') snapVersion(r.node);
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
    recordEdit(e); updWC();
  });
  $('#content').addEventListener('input', (e) => {
    const n = cur(); n.content = e.target.value; n.updated = Date.now(); saveSoon(); autoGrow();
    recordEdit(e); updWC();
  });
  $('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#content').focus(); } });
  // 实体键盘快捷键：Ctrl+Z 撤回，Ctrl+Y / Ctrl+Shift+Z 取消撤回
  ['#title', '#content'].forEach(s => $(s).addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  }));
  // 记录编辑框失焦，点撤回按钮时把焦点还回去，键盘不收起
  ['#title', '#content'].forEach(s => $(s).addEventListener('blur', (e) => { lastBlur = { el: e.target, at: Date.now() }; }));
}

/* ---------------- 撤回 / 取消撤回 ---------------- */
// 每个条目各自一份编辑历史（本次打开 App 期间有效）。连续打字合并成一步，
// 停顿超过 1.2 秒、一次改动很多字（全选删除、粘贴）、在打字和删除之间切换，都会分成新的一步。
const hist = new Map();
let lastBlur = { el: null, at: 0 };
function curId() { return path[path.length - 1]; }
function H() {
  const id = curId();
  if (!hist.has(id)) { const n = cur(); hist.set(id, { undo: [], redo: [], last: { title: n.title, content: n.content }, at: 0, start: 0, kind: '', force: false }); }
  return hist.get(id);
}
function syncHist() { // 进入条目时，如果内容被别处改过（导入、恢复），以当前内容为准
  const h = H(), n = cur();
  if (h.last.title !== n.title || h.last.content !== n.content) { h.last = { title: n.title, content: n.content }; h.at = 0; }
}
function recordEdit(e) {
  const h = H(), now = Date.now();
  const st = { title: $('#title').value, content: $('#content').value };
  const prev = h.last;
  const type = (e && e.inputType) || '';
  const kind = type.startsWith('delete') ? 'del' : 'ins';
  const diff = Math.abs((st.title.length + st.content.length) - (prev.title.length + prev.content.length));
  const big = diff > 12 || /paste|drop|cut|replacement/i.test(type);
  const field = st.title !== prev.title ? 'title' : 'content';
  if (!h.undo.length || h.force || big || now - h.at > 1200 || now - h.start > 5000 || kind !== h.kind || field !== h.field) {
    h.undo.push(prev); if (h.undo.length > 300) h.undo.shift();
    h.start = now;
  }
  // 历史版本：一次改动很多字之前先存一版；连续编辑时每 3 分钟存一版
  const id = curId();
  if (big && diff > 30) snapVersion({ id, ...prev });
  if (now - (verAt[id] || 0) > 180000) { snapVersion({ id, ...st }); }
  h.force = big; h.at = now; h.kind = kind; h.field = field; h.last = st; h.redo = [];
  updUR();
}

/* ---------------- 字数 ---------------- */
function updWC() {
  const n = cur();
  const self = charCount(n.title) + charCount(n.content);
  $('#wc').textContent = n.children.length ? `本条 ${self} 字 · 含子条目共 ${charsAll(n)} 字` : `${self} 字`;
}

/* ---------------- 历史版本 ---------------- */
const verAt = {};
let verTimer = null;
function snapVersion(n) {
  const title = n.title || '', content = n.content || '';
  if (!title.trim() && !content.trim()) return;
  const arr = versions[n.id] || (versions[n.id] = []);
  const last = arr[arr.length - 1];
  verAt[n.id] = Date.now();
  if (last && last.title === title && last.content === content) return;
  arr.push({ t: Date.now(), title, content });
  if (arr.length > 20) arr.shift();
  clearTimeout(verTimer); verTimer = setTimeout(saveVersions, 800);
}
function saveVersions() { clearTimeout(verTimer); verTimer = null; return storeSet(KEY_VER, JSON.stringify(versions)); }
function fmtTime(t) {
  const d = new Date(t), p = (x) => String(x).padStart(2, '0');
  const today = new Date(); const sameDay = d.toDateString() === today.toDateString();
  return (sameDay ? '今天 ' : `${d.getMonth() + 1}月${d.getDate()}日 `) + `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function versionsView(n) {
  if (curId() === n.id) snapVersion(n);
  const arr = (versions[n.id] || []).slice().reverse();
  if (!arr.length) { toast('这个条目还没有历史版本'); return; }
  openSheet(`「${n.title || '无标题'}」的历史版本（最近 ${arr.length} 个）`, arr.map((v, i) => ({
    label: fmtTime(v.t) + (i === 0 && v.title === n.title && v.content === n.content ? '（当前）' : ''),
    sub: `${charCount(v.title) + charCount(v.content)} 字 · ${(v.title || '无标题')}｜${(v.content.split('\n').find(l => l.trim()) || '').trim().slice(0, 30)}`,
    fn: () => previewVersion(n, v),
  })));
}
async function previewVersion(n, v) {
  const ok = await dialog(fmtTime(v.t) + ' 的版本', `<div class="prev"><b>${esc(v.title || '无标题')}</b>${esc(v.content)}</div>`,
    [{ label: '返回', value: false }, { label: '恢复这个版本', value: true, cls: 'primary' }]);
  if (!ok) { versionsView(n); return; }
  if (!find(n.id)) { toast('这个条目已不存在'); return; }
  snapVersion(n); // 恢复前先把现在的内容存一版
  if (curId() !== n.id) go(pathTo(n.id));
  const h = H(); h.undo.push(h.last); h.redo = [];
  applyState({ title: v.title, content: v.content });
  snapVersion(cur()); saveNow();
  toast('已恢复，点撤回可以换回去');
}
function undo() { const h = H(); if (h.undo.length) { h.redo.push(h.last); applyState(h.undo.pop()); } }
function redo() { const h = H(); if (h.redo.length) { h.undo.push(h.last); applyState(h.redo.pop()); } }

function applyState(st) {
  const h = H(), n = cur();
  const t = $('#title'), c = $('#content');
  // 焦点被按钮抢走时还回去（键盘保持打开）
  let active = document.activeElement;
  if (active !== t && active !== c && lastBlur.el && Date.now() - lastBlur.at < 500) { lastBlur.el.focus(); active = document.activeElement; }
  const typing = active === t || active === c;
  // 光标放到改动处的末尾，不选中文字
  const field = st.content !== c.value ? c : (st.title !== t.value ? t : null);
  let caret = null;
  if (field) {
    const a = field.value, b = field === c ? st.content : st.title;
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    caret = b.length - s;
  }
  t.value = n.title = st.title;
  c.value = n.content = st.content;
  n.updated = Date.now(); saveSoon(); autoGrow();
  const cc = $('#crumbs .c.cur'); if (cc) cc.textContent = n.title || '无标题';
  h.last = st; h.at = 0; h.kind = ''; h.force = false;
  if (field) {
    if (typing) { if (document.activeElement !== field) field.focus(); field.setSelectionRange(caret, caret); }
    if (field === c) scrollToCaret(caret);
  }
  updUR();
}
// 改动处不在屏幕内时，把页面滚过去
function scrollToCaret(pos) {
  const c = $('#content'), cs = getComputedStyle(c);
  const m = document.createElement('div');
  m.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;width:${c.clientWidth}px;font:${cs.font};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};padding:0;`;
  m.textContent = c.value.slice(0, pos) + '​';
  document.body.appendChild(m);
  const y = c.getBoundingClientRect().top + window.scrollY + m.offsetHeight;
  m.remove();
  const top = window.scrollY + 70, bottom = window.scrollY + window.innerHeight - 40;
  if (y < top || y > bottom) window.scrollTo(0, Math.max(0, y - window.innerHeight / 3));
}
function updUR() {
  const inNote = path.length > 1;
  $('#btnUndo').hidden = $('#btnRedo').hidden = !inNote;
  if (!inNote) return;
  const h = H();
  $('#btnUndo').disabled = !h.undo.length;
  $('#btnRedo').disabled = !h.redo.length;
}

/* ---------------- 打字时隐藏新建按钮 ---------------- */
let maxH = window.innerHeight, kbSeen = false;
function updKeyboard() {
  const vh = window.visualViewport ? Math.min(window.visualViewport.height, window.innerHeight) : window.innerHeight;
  maxH = Math.max(maxH, window.innerHeight);
  const shrunk = vh < maxH - 120;          // 可视区域明显变矮 = 键盘弹出
  if (shrunk) kbSeen = true;
  const a = document.activeElement;
  const editing = !!a && a.matches && a.matches('input:not([type=file]), textarea');
  // 编辑框有焦点就隐藏；如果能检测到键盘高度变化，键盘收起后（焦点还在）恢复显示
  document.body.classList.toggle('kb', editing && (shrunk || !kbSeen));
}
function bindKeyboard() {
  document.addEventListener('focusin', updKeyboard);
  document.addEventListener('focusout', () => setTimeout(updKeyboard, 0));
  window.addEventListener('resize', updKeyboard);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', updKeyboard);
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
  const sib = parent.children;
  const live = liveKids(parent); const i = live.indexOf(n);
  const swap = (a, b) => { const x = sib.indexOf(a), y = sib.indexOf(b); sib[x] = b; sib[y] = a; };
  const arch = !!n.archived;
  const rows = [
    { label: '上移', hide: arch || i <= 0, fn: () => swap(n, live[i - 1]) },
    { label: '下移', hide: arch || i === live.length - 1, fn: () => swap(n, live[i + 1]) },
    { label: '降一级', sub: '变成上一个条目的子条目', hide: arch || i <= 0, fn: () => { sib.splice(sib.indexOf(n), 1); live[i - 1].children.push(n); } },
    { label: '升一级', sub: '移到上一层，排在原上级后面', hide: arch || parent.id === 'root', fn: () => {
        const gp = find(parent.id).parent; sib.splice(sib.indexOf(n), 1);
        gp.children.splice(gp.children.indexOf(parent) + 1, 0, n);
      } },
    { label: arch ? '取消归档' : '归档', sub: arch ? '放回列表' : '收进本层底部的「已归档」，导出给 AI 时不包含',
      fn: () => {
        if (arch) { delete n.archived; sib.splice(sib.indexOf(n), 1); sib.push(n); toast('已取消归档'); }
        else { n.archived = true; toast('已归档，在列表底部「已归档」里'); }
      } },
    { label: '历史版本', sub: '查看并恢复这一条以前的内容', fn: () => versionsView(n), keep: true },
    { label: '导出为图片', sub: '含子条目（不含已归档）', fn: () => exportImage(n), keep: true },
    { label: '导出为文本 / 给 AI 整理', sub: 'Markdown，含子条目（不含已归档）', fn: () => exportText(n), keep: true },
    { label: '删除', sub: '移到回收站，30 天内可以还原', danger: true, fn: () => {
        moveToTrash(n, parent); render(); toast('已移到回收站，可在菜单里还原');
      }, keep: true },
  ];
  openSheet((n.title || '无标题') + (arch ? '（已归档）' : ''), rows.filter(r => !r.hide).map(r => ({
    ...r, fn: () => { r.fn(); if (!r.keep) { saveSoon(); render(); } }
  })));
}

/* ---------------- 回收站 ---------------- */
const TRASH_DAYS = 30;
function moveToTrash(n, parent) {
  const sib = parent.children;
  db.trash.unshift({ node: n, parentId: parent.id, index: sib.indexOf(n), at: Date.now() });
  sib.splice(sib.indexOf(n), 1);
  hist.delete(n.id);
  saveSoon();
}
function purgeTrash() {
  const limit = Date.now() - TRASH_DAYS * 86400000;
  const gone = db.trash.filter(e => e.at < limit);
  if (!gone.length) return;
  db.trash = db.trash.filter(e => e.at >= limit);
  const drop = (n) => { delete versions[n.id]; n.children.forEach(drop); };
  gone.forEach(e => drop(e.node));
  saveSoon(); saveVersions();
}
function trashView() {
  purgeTrash();
  if (!db.trash.length) { toast('回收站是空的'); return; }
  const rows = db.trash.map(e => {
    const days = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - e.at) / 86400000));
    const kids = countAll(e.node);
    return { label: e.node.title || '无标题', sub: `${fmtTime(e.at)} 删除${kids ? ` · 含 ${kids} 个子条目` : ''} · ${days} 天后彻底删除`, fn: () => trashItem(e) };
  });
  rows.push({ sep: true }, { label: '清空回收站', danger: true, fn: async () => {
    const ok = await dialog('清空回收站', `彻底删除回收站里的 ${db.trash.length} 个条目？之后无法恢复。`, [{ label: '取消', value: false }, { label: '彻底删除', value: true, cls: 'danger' }]);
    if (ok) { const drop = (n) => { delete versions[n.id]; n.children.forEach(drop); }; db.trash.forEach(e => drop(e.node)); db.trash = []; saveSoon(); saveVersions(); toast('回收站已清空'); }
  } });
  openSheet(`回收站（删除 ${TRASH_DAYS} 天后自动彻底删除）`, rows);
}
async function trashItem(e) {
  const n = e.node, kids = countAll(n);
  const how = await dialog('回收站', `<div class="prev"><b>${esc(n.title || '无标题')}</b>${esc(n.content || '')}${kids ? `\n\n<span class="muted">另有 ${kids} 个子条目</span>` : ''}</div>`,
    [{ label: '返回', value: 'back' }, { label: '彻底删除', value: 'del', cls: 'danger' }, { label: '还原', value: 'restore', cls: 'primary' }]);
  if (how === 'back' || !how) { trashView(); return; }
  db.trash.splice(db.trash.indexOf(e), 1);
  if (how === 'del') {
    const drop = (x) => { delete versions[x.id]; x.children.forEach(drop); }; drop(n); saveVersions();
    saveSoon(); toast('已彻底删除'); return;
  }
  const r = find(e.parentId); const parent = r ? r.node : db.root;
  parent.children.splice(Math.min(e.index, parent.children.length), 0, n);
  saveSoon(); render();
  toast(`已还原到「${parent.id === 'root' ? '全部' : (parent.title || '无标题')}」`);
}

/* ---------------- 长按拖动排序 ---------------- */
let drag = null;
function canDrag() { return !outline && !(path.length === 1 && $('#search').value.trim()); }
function bindDrag() {
  const list = $('#list');
  list.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !canDrag()) return;
    const li = e.target.closest('.item'); if (!li || e.target.closest('.more')) return;
    const t = e.touches[0];
    drag = { li, x: t.clientX, y: t.clientY, fy: t.clientY, active: false, timer: setTimeout(startDrag, 420) };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const t = e.touches[0];
    if (!drag.active) { if (e.touches.length > 1 || Math.hypot(t.clientX - drag.x, t.clientY - drag.y) > 8) cancelDrag(); return; }
    e.preventDefault();
    drag.fy = t.clientY; moveDrag();
  }, { passive: false });
  document.addEventListener('touchend', endDrag);
  document.addEventListener('touchcancel', endDrag);
  list.addEventListener('contextmenu', (e) => e.preventDefault());
}
function startDrag() {
  const d = drag; if (!d) return;
  d.active = true;
  d.startDocY = d.y + window.scrollY;
  d.elStartTop = d.li.getBoundingClientRect().top + window.scrollY;
  d.li.classList.add('dragging');
  document.body.classList.add('dragmode');
  try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
  d.raf = requestAnimationFrame(tickDrag);
}
function moveDrag() {
  const d = drag, li = d.li;
  const want = d.elStartTop + (d.fy + window.scrollY - d.startDocY);   // 条目应该在的位置（跟着手指）
  li.style.transform = '';
  const mid = want + li.offsetHeight / 2;
  const midOf = (el) => el.getBoundingClientRect().top + window.scrollY + el.offsetHeight / 2;
  let prev = li.previousElementSibling, next = li.nextElementSibling;
  while (prev && mid < midOf(prev)) { li.parentNode.insertBefore(li, prev); prev = li.previousElementSibling; }
  while (next && mid > midOf(next)) { li.parentNode.insertBefore(next, li); next = li.nextElementSibling; }
  li.style.transform = `translateY(${want - (li.getBoundingClientRect().top + window.scrollY)}px)`;
}
function tickDrag() { // 拖到屏幕上下边缘时自动滚动
  if (!drag || !drag.active) return;
  const y = drag.fy, edge = 90;
  let dy = 0;
  if (y < edge + 52) dy = -Math.ceil((edge + 52 - y) / 7);
  else if (y > window.innerHeight - edge) dy = Math.ceil((y - window.innerHeight + edge) / 7);
  if (dy) { window.scrollBy(0, dy); moveDrag(); }
  drag.raf = requestAnimationFrame(tickDrag);
}
function cancelDrag() { if (drag) { clearTimeout(drag.timer); drag = null; } }
function endDrag() {
  const d = drag; if (!d) return;
  clearTimeout(d.timer); drag = null;
  if (!d.active) return;
  cancelAnimationFrame(d.raf);
  suppressClick = Date.now();
  d.li.classList.remove('dragging'); d.li.style.transform = '';
  document.body.classList.remove('dragmode');
  const node = cur();
  const before = liveKids(node);
  const order = [...$('#list').children].map(li => before.find(c => c.id === li.dataset.id)).filter(Boolean);
  if (order.length === before.length && order.some((c, i) => c !== before[i])) {
    node.children = [...order, ...node.children.filter(c => c.archived)];
    saveSoon();
  }
  render();
}

function mainMenu() {
  const n = cur(); const atRoot = path.length === 1;
  const scale = Math.round((db.settings.fontScale || 1) * 100);
  const sheet = $('#sheet');
  const ab = db.settings.autoBackupError ? `上次失败：${db.settings.autoBackupError}`
    : (db.settings.lastAutoBackup ? `每天自动存一份，最近一次 ${db.settings.lastAutoBackup}` : '每天自动存一份到 Documents/简记/自动备份');
  openSheet(null, [
    { html: `<div class="zoom"><button data-z="-1">A−</button><span>字号 ${scale}%</span><button data-z="1">A+</button></div>` },
    { sep: true },
    { label: '本条历史版本', sub: '查看并恢复这一条以前的内容', hide: atRoot, fn: () => versionsView(n) },
    { label: atRoot ? '导出全部为图片' : '导出当前条目为图片', sub: '长图，含子条目（不含已归档）', fn: () => exportImage(n) },
    { label: '导出当前条目给 AI', sub: '整理好后用「粘贴文本导入 → 替换当前条目」导回', hide: atRoot, fn: () => exportText(n) },
    { label: '整体导出（给 AI 整理）', sub: 'Markdown 文本，不含已归档', fn: () => exportText(db.root) },
    { label: '完整备份', sub: 'JSON 文件，含全部内容，可原样恢复', fn: () => exportJson() },
    { label: '立即自动备份', sub: ab, hide: !isNative(), fn: () => autoBackup(true) },
    { sep: true },
    { label: '导入文件', sub: '.md / .txt / .json', fn: () => $('#filePick').click() },
    { label: '粘贴文本导入', sub: '把 AI 整理好的内容粘贴进来', fn: () => pasteImport() },
    { label: '恢复导入前的数据', sub: '撤销上一次导入', fn: () => restoreBackup() },
    { label: `回收站（${db.trash.length}）`, sub: `删除的条目保留 ${TRASH_DAYS} 天`, fn: () => trashView() },
    { sep: true },
    { label: '使用说明', fn: () => help() },
  ].filter(r => !r.hide));
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
    liveKids(n).forEach(c => put(c, lv + 1));
  };
  if (node.id === 'root') liveKids(node).forEach(c => put(c, 1)); else put(node, 1);
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
  const nLive = countLive(node) + (node.id === 'root' ? 0 : 1);
  const nArch = countAll(node) - countLive(node);
  const back = node.id === 'root' ? '整理好后：菜单 →「粘贴文本导入」→「替换全部」。'
    : '整理好后：进入这个条目，菜单 →「粘贴文本导入」→「替换当前条目」，其他内容不受影响。';
  const how = await dialog('导出文本', `共 ${nLive} 个条目，${md.length} 字符${nArch ? `（已归档的 ${nArch} 个条目不包含在内）` : ''}。<br>交给 AI 整理时，直接把文字粘贴给它，或者发送文件都可以。<br>${back}`,
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
    walk(liveKids(n), w);
    parentEl.appendChild(w);
  });
  walk(liveKids(node), rd);
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
  const btns = [{ label: '取消', value: null }, { label: '替换全部', value: 'replace', cls: 'danger' }];
  if (!atRoot && !parsed.full) btns.push({ label: '替换当前条目', value: 'replaceNode', cls: 'primary' });
  btns.push({ label: atRoot ? '追加' : '追加到当前条目下', value: 'append', cls: atRoot || parsed.full ? 'primary' : '' });
  const tip = atRoot ? '' : `<br>「替换当前条目」只换掉「${esc(here.title || '无标题')}」和它的子条目（已归档的子条目保留），其他内容不受影响。`;
  const how = await dialog('导入', `识别到 ${total} 个条目（第一层 ${nodes.length} 个）。<br>「替换全部」会清空现有内容。${tip}<br>替换前都会自动保留备份：可用菜单里的「恢复导入前的数据」，被换掉的旧内容也会放进回收站。`, btns);
  if (!how) return;
  await storeSet(KEY_BACKUP, JSON.stringify(db));
  if (how === 'replace') {
    if (parsed.full) { db = parsed.full; fixDb(); }
    else db.root.children = nodes;
    path = ['root']; hist.clear();
  } else if (how === 'replaceNode') {
    const r = find(here.id);
    // 旧内容的副本放进回收站，随时可以找回
    const copy = reId(JSON.parse(JSON.stringify(here)));
    copy.title = (here.title || '无标题') + '（替换前）';
    db.trash.unshift({ node: copy, parentId: r.parent.id, index: r.parent.children.indexOf(here) + 1, at: Date.now() });
    snapVersion(here);
    const keepArch = here.children.filter(c => c.archived);
    if (nodes.length === 1) {
      const src = nodes[0];
      here.title = src.title; here.content = src.content;
      here.children = [...src.children.map(reId), ...keepArch];
    } else { // AI 拆成了多个第一层条目：都放到当前条目下面，正文清空
      here.content = '';
      here.children = [...nodes.map(reId), ...keepArch];
    }
    here.updated = Date.now();
    hist.delete(here.id); enteredId = null;
    window.scrollTo(0, 0);
  } else {
    here.children.push(...nodes.map(reId));
  }
  document.documentElement.style.setProperty('--fs', db.settings.fontScale || 1);
  await saveNow(); render(); toast(how === 'replaceNode' ? '已替换当前条目，旧内容在回收站' : `已导入 ${total} 个条目`);
}

/* ---------------- 每日自动备份 ---------------- */
// 每天第一次打开时，在 手机存储/Documents/简记/自动备份 里存一份完整备份，保留最近 7 份
async function autoBackup(manual = false) {
  const { Filesystem } = P();
  if (!isNative() || !Filesystem) return;
  const today = stamp().slice(0, 8);
  if (!manual && db.settings.lastAutoBackup && db.settings.lastAutoBackup.replace(/-/g, '') === today) return;
  if (!manual && !countAll(db.root)) return;
  const dir = '简记/自动备份';
  try {
    try { const p = await Filesystem.checkPermissions(); if (p.publicStorage !== 'granted') await Filesystem.requestPermissions(); } catch (e) {}
    await Filesystem.writeFile({ path: `${dir}/简记自动备份-${stamp()}.json`, data: JSON.stringify(db), directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
    db.settings.lastAutoBackup = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}`;
    delete db.settings.autoBackupError;
    saveSoon();
    try {
      const r = await Filesystem.readdir({ path: dir, directory: 'DOCUMENTS' });
      const names = r.files.map(f => typeof f === 'string' ? f : f.name).filter(x => /^简记自动备份-.*\.json$/.test(x)).sort();
      for (const x of names.slice(0, Math.max(0, names.length - 7))) {
        try { await Filesystem.deleteFile({ path: `${dir}/${x}`, directory: 'DOCUMENTS' }); } catch (e) {}
      }
    } catch (e) {}
    if (manual) toast('已备份到 手机存储/Documents/简记/自动备份');
  } catch (e) {
    db.settings.autoBackupError = String((e && e.message) || e).slice(0, 60); saveSoon();
    if (manual) toast('备份失败：' + db.settings.autoBackupError);
  }
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
  db = JSON.parse(raw); fixDb(); await storeSet(KEY_BACKUP, now);
  path = ['root']; hist.clear(); document.documentElement.style.setProperty('--fs', db.settings.fontScale || 1);
  await saveNow(); render(); toast('已恢复（再点一次可以换回来）');
}

function help() {
  dialog('使用说明', `
  <b>分级</b>：每个条目都可以有子条目。点条目进入，在里面点 ＋ 新建下一级；条目右侧 ⋮ 可以升级、降级。<br>
  <b>排序</b>：长按条目，浮起来后拖到想要的位置松手。<br>
  <b>归档</b>：⋮ →「归档」，条目收进本层底部的「已归档」，导出给 AI 时不包含，搜索时仍能搜到。<br>
  <b>撤回</b>：编辑时顶栏的 ↶ ↷。<b>历史版本</b>：⋮ 或菜单里「历史版本」，每条保留最近 20 个版本。<br>
  <b>回收站</b>：删除的条目保留 30 天，菜单 →「回收站」可以还原。<br>
  <b>自动备份</b>：每天第一次打开时，自动存一份到 手机存储/Documents/简记/自动备份，保留最近 7 份；用「导入文件」选它就能恢复。<br>
  <b>缩放</b>：两指捏合调整字号，菜单里也有 A− / A+。<br>
  <b>交给 AI 整理</b>：整体：菜单 →「整体导出」→ 复制给 AI，整理后「粘贴文本导入」→「替换全部」。单条：进入条目，菜单 →「导出当前条目给 AI」，整理后在同一条目里「粘贴文本导入」→「替换当前条目」。<br>
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
  bindEditor(); bindPinch(); bindFilePick(); bindKeyboard(); bindDrag();
  $('#archHead').onclick = () => { archOpen = !archOpen; render(); };
  $('#btnBack').onclick = goUp;
  ['#btnUndo', '#btnRedo'].forEach(s => $(s).addEventListener('mousedown', (e) => e.preventDefault())); // 点按钮不抢输入框焦点
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnMenu').onclick = mainMenu;
  $('#fab').onclick = addChild;
  $('#btnOutline').onclick = () => { outline = !outline; render(); };
  $('#search').addEventListener('input', render);
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#search').blur(); });
  $('#sheetMask').onclick = closeSheet;
  $('#dlgMask').addEventListener('click', (e) => { if (e.target.id === 'dlgMask' && dlgResolve) dlgResolve(); });
  window.addEventListener('resize', autoGrow);
  const onLeave = () => { if (curId() !== 'root') snapVersion(cur()); saveNow(); saveVersions(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) onLeave(); });
  const A = P().App;
  if (A) {
    A.addListener('backButton', handleBack);
    A.addListener('pause', onLeave);
  }
  render();
  setTimeout(() => autoBackup(false), 1500);
}

window.jianji = { parseMarkdown, toMarkdown, parseAny, get db() { return db; } }; // 方便调试
init();
