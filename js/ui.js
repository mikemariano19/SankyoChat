/* Sankyo Chat — UI helpers (DOM builder, icons, dialogs, formatting) and the setup screens. */
(function (root) {
  'use strict';
  const SC = root.SC;
  const U = SC.util, A = SC.account;
  /** @namespace SC.ui */
  const UI = {};

  /* ---------- icons (inline SVG, stroke = currentColor) ---------- */
  const ICONS = {
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
    file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    bold: '<path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z"/>',
    italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>',
    bellOff: '<path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.89 17.89 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M1 1l22 22"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l5.36 4.64A9 9 0 0 0 20.49 15"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    userX: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="m18 8 5 5M23 8l-5 5"/>',
    archive: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    status: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    pin: '<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    poll: '<path d="M3 3v18h18"/><path d="M8 16v-5M13 16V7M18 16v-3"/>',
    zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
    zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1M11.5 12h1"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
    place: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    boardBell: '<rect x="3" y="4" width="13" height="13" rx="2"/><path d="M7.5 4v13M11.5 4v8"/><path d="M19 13.5a3 3 0 0 0-3 3V19h6v-2.5a3 3 0 0 0-3-3zM18 21h2"/>',
  };
  /** @param {string} name */
  UI.icon = function (name, cls) {
    const s = document.createElement('span');
    s.className = 'icon' + (cls ? ' ' + cls : '');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg viewBox="0 0 24 24">' + (ICONS[name] || '') + '</svg>';
    return s;
  };

  /* ---------- DOM builder ---------- */
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false || k === true) continue;
      if (Array.isArray(k)) append(el, k);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  /** h('div', {class:'x', onclick: fn}, ...children) */
  const h = UI.h = function (tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, kids);
    return el;
  };
  UI.append = append;
  /** Replace an element's children. Unlike el.replaceChildren(), skips null/false
   *  (replaceChildren would print them as the text "null"). */
  UI.set = function (el, ...kids) { el.replaceChildren(); append(el, kids); return el; };
  /** Replace the whole app view. */
  UI.mount = function (node) {
    UI.closeAll();
    const app = document.getElementById('app');
    UI.set(app, node);
  };

  /* ---------- avatars & presence ---------- */
  UI.avatar = function (user, size = 36) {
    const s = h('span', { class: 'avatar', 'aria-hidden': 'true' }, user ? user.animal : '?');
    Object.assign(s.style, {
      width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.58) + 'px',
      borderRadius: Math.round(size * 0.26) + 'px', background: user ? A.avatarColor(user.color) : '#E2E8F0',
    });
    return s;
  };
  UI.dot = state => h('span', { class: 'dot ' + state, 'aria-hidden': 'true' });
  UI.stateLabel = s => ({ online: 'Online', away: 'Away', offline: 'Offline' }[s] || 'Offline');

  /* ---------- toasts ---------- */
  UI.toast = function (msg, kind) {
    let box = document.querySelector('.toasts');
    if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(box); }
    const t = h('div', { class: 'toast' + (kind ? ' ' + kind : '') }, kind === 'error' ? UI.icon('alert') : kind === 'ok' ? UI.icon('check') : null, msg);
    box.appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
  };

  /* ---------- dialogs ---------- */
  const stack = [];
  /**
   * @param {{title?:string, body:any, foot?:any, cls?:string, onClose?:Function, bare?:boolean}} o
   * @returns {{el:HTMLElement, close:Function, body:HTMLElement}}
   */
  UI.modal = function (o) {
    const prevFocus = document.activeElement;
    const titleId = 'dlg' + U.rand(5);
    const body = h('div', { class: 'dialog-body' }, o.body);
    const dlg = h('div', { class: 'dialog ' + (o.cls || ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': o.title ? titleId : null, 'aria-label': o.title ? null : (o.label || 'Dialog') },
      o.bare ? o.body : [
        o.title ? h('div', { class: 'dialog-head' }, h('h2', { id: titleId }, o.title),
          h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, UI.icon('x'))) : null,
        body,
        o.foot ? h('div', { class: 'dialog-foot' }, o.foot) : null,
      ]);
    const ov = h('div', { class: 'overlay', onmousedown: e => { if (e.target === ov) close(); } }, dlg);
    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      ov.remove();
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      if (o.onClose) o.onClose(result);
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
    }
    const api = { el: dlg, body, close };
    stack.push(api);
    document.body.appendChild(ov);
    setTimeout(() => {
      const f = dlg.querySelector('[autofocus], input:not([type=hidden]):not([type=checkbox]), textarea, select, button.btn-primary');
      if (f) f.focus();
    }, 0);
    return api;
  };
  UI.closeTop = function () {
    if (UI.closePopover()) return true;
    const top = stack[stack.length - 1];
    if (top) { top.close(); return true; }
    return false;
  };
  UI.closeAll = function () { UI.closePopover(); while (stack.length) stack[stack.length - 1].close(); };
  UI.dialogOpen = () => stack.length > 0;

  UI.confirm = function ({ title, text, ok = 'OK', danger = false }) {
    return new Promise(resolve => {
      let result = false;
      const m = UI.modal({
        title, body: h('p', null, text), onClose: () => resolve(result),
        foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
          h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), onclick: () => { result = true; m.close(); } }, ok)],
      });
    });
  };
  /** Single-field prompt. `onOk` may throw to show an error. */
  UI.prompt = function ({ title, label, value = '', ok = 'Save', type = 'text', hint, maxlength, onOk }) {
    return new Promise(resolve => {
      let result = null;
      const input = h('input', { class: 'input', type, value, maxlength, autofocus: true });
      const err = h('div', { class: 'form-error hidden', role: 'alert' });
      const okBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, ok);
      const form = h('form', { onsubmit: async e => {
        e.preventDefault();
        err.classList.add('hidden');
        try {
          okBtn.disabled = true;
          if (onOk) await onOk(input.value);
          result = input.value;
          m.close();
        } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); } finally { okBtn.disabled = false; }
      } }, err, h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null));
      const m = UI.modal({ title, body: form, onClose: () => resolve(result),
        foot: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), okBtn] });
      okBtn.addEventListener('click', () => form.requestSubmit());
    });
  };

  /* ---------- popovers ---------- */
  let pop = null;
  UI.closePopover = function () {
    if (!pop) return false;
    const p = pop; pop = null;
    p.el.remove();
    document.removeEventListener('mousedown', p.outside, true);
    if (p.onClose) p.onClose();
    return true;
  };
  /** Show `content` next to `anchor`. placement: 'top' | 'bottom' | 'right-up' */
  UI.popover = function (anchor, content, { placement = 'bottom', cls = '', onClose, label } = {}) {
    UI.closePopover();
    const el = h('div', { class: 'popover ' + cls, role: 'dialog', 'aria-label': label || 'Menu' }, content);
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, ht = el.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = placement === 'top' || placement === 'right-up' ? r.top - ht - 6 : r.bottom + 6;
    if (placement === 'right-up') { left = Math.min(r.right + 8, window.innerWidth - w - 8); top = r.bottom - ht; }
    if (top < 8) top = Math.min(r.bottom + 6, window.innerHeight - ht - 8);
    if (top + ht > window.innerHeight - 8) top = Math.max(8, r.top - ht - 6);
    el.style.left = left + 'px'; el.style.top = top + 'px';
    const outside = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) UI.closePopover(); };
    document.addEventListener('mousedown', outside, true);
    pop = { el, outside, onClose };
    const f = el.querySelector('input, [autofocus]');
    if (f) setTimeout(() => f.focus(), 0);
    return { el, close: UI.closePopover };
  };

  /** Emoji picker popover. */
  UI.emojiPicker = function (anchor, onPick, placement = 'top') {
    const scroll = h('div', { class: 'emoji-scroll' });
    const input = h('input', { class: 'input', placeholder: 'Search emoji', 'aria-label': 'Search emoji' });
    function grid(items) {
      return h('div', { class: 'emoji-grid' }, items.map(it => h('button', { type: 'button', title: it.k, 'aria-label': it.k.split(' ')[0], onclick: () => { UI.closePopover(); onPick(it.e); } }, it.e)));
    }
    function draw() {
      const q = input.value.trim();
      if (q) {
        const r = SC.emoji.search(q);
        UI.set(scroll, r.length ? grid(r) : h('div', { class: 'emoji-cat' }, 'No emoji found'));
      } else UI.set(scroll, ...SC.emoji.list.map(c => [h('div', { class: 'emoji-cat' }, c.category), grid(c.items)]).flat());
    }
    input.addEventListener('input', draw);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const r = SC.emoji.search(input.value); if (r[0]) { UI.closePopover(); onPick(r[0].e); } }
    });
    draw();
    return UI.popover(anchor, [input, scroll], { placement, cls: 'emoji-pop', label: 'Emoji picker' });
  };

  /* ---------- message formatting ---------- */
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function inline(seg, mentionIds) {
    const tokens = [];
    const keep = html => { tokens.push(html); return '\u0000' + (tokens.length - 1) + '\u0000'; };
    let s = U.escapeHtml(seg.replace(/[\u0000\u0001]/g, ''));
    s = s.replace(/`([^`\n]+)`/g, (_, c) => keep('<code class="inline">' + c + '</code>'));
    const meId = A.me && A.me.id;
    const names = (mentionIds || []).map(id => id === 'channel' ? { n: 'channel', me: true } : (A.users.get(id) ? { n: A.users.get(id).name, me: id === meId } : null))
      .filter(Boolean).sort((a, b) => b.n.length - a.n.length);
    for (const x of names) {
      const re = new RegExp(reEsc(U.escapeHtml('@' + x.n)) + '(?![\\p{L}\\p{N}])', 'giu');
      s = s.replace(re, m => keep('<span class="mention">' + m + '</span>'));
    }
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\n/g, '<br>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
  }
  /** Safe HTML for message text: **bold**, *italic*, `code`, ```blocks```, @mentions. Links stay plain text. */
  UI.formatText = function (text, mentionIds) {
    const parts = String(text).split('```');
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1 && i < parts.length - 1) {
        html += '<pre class="code-block"><code>' + U.escapeHtml(parts[i].replace(/^\n/, '').replace(/\n$/, '')) + '</code></pre>';
      } else html += inline(i % 2 === 1 ? '```' + parts[i] : parts[i], mentionIds);
    }
    return html;
  };
  UI.isBigEmoji = t => t.length <= 24 && /\p{Extended_Pictographic}/u.test(t) && /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(t);

  /** Copy text, with a fallback for locked-down browsers. */
  UI.copy = async function (text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  };

  /** Disable a button while an async action runs; errors go to `errEl`. */
  UI.busy = async function (btn, label, fn, errEl) {
    const old = Array.from(btn.childNodes);
    btn.disabled = true;
    if (label) UI.set(btn, h('span', { class: 'spinner', style: { width: '16px', height: '16px', borderWidth: '2px' } }), label);
    if (errEl) errEl.classList.add('hidden');
    try { return await fn(); } catch (e) {
      if (errEl) { errEl.textContent = e.message || String(e); errEl.classList.remove('hidden'); } else UI.toast(e.message || String(e), 'error');
      return undefined;
    } finally { btn.disabled = false; UI.set(btn, ...old); }
  };

  /* ================= setup screens ================= */

  const brand = (title, sub) => h('div', { class: 'brand' },
    h('div', { class: 'brand-logo' }, UI.icon('message')),
    h('div', null, h('h1', null, title), h('p', null, sub)));
  const screen = (...kids) => h('div', { class: 'screen-center' }, h('div', { class: 'card' }, kids));
  const errBox = () => h('div', { class: 'form-error hidden', role: 'alert' });
  const b = t => h('b', null, t);

  UI.screenLoading = function (text) {
    UI.mount(h('div', { class: 'screen-center' }, h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text || 'Loading…')));
  };

  UI.screenUnsupported = function (reason) {
    UI.mount(screen(brand('Sankyo Chat', 'Team chat over the office shared drive.'),
      h('div', { class: 'note note-warn', style: { marginTop: 0 } }, UI.icon('alert'),
        h('div', null, h('b', null, 'This browser can’t run Sankyo Chat. '), reason ||
          'Open the desktop shortcut in Microsoft Edge or Google Chrome (version 110 or newer). Firefox and Internet Explorer are not supported.')),
      h('div', { class: 'card-foot' }, h('span', null, 'Need help? Ask your admin.'), h('a', { href: 'check.html' }, 'Run compatibility check'))));
  };

  /** FR-01: first launch. */
  UI.screenConnect = function ({ path, error, onConnect }) {
    const err = errBox();
    if (error) { err.textContent = error; err.classList.remove('hidden'); }
    const copyBtn = h('button', { class: 'btn btn-sm', type: 'button' }, UI.icon('copy'), 'Copy');
    copyBtn.addEventListener('click', async () => {
      if (await UI.copy(path)) { UI.set(copyBtn, UI.icon('check'), 'Copied'); setTimeout(() => UI.set(copyBtn, UI.icon('copy'), 'Copy'), 2500); }
      else UI.toast('Couldn’t copy. Select the path and press Ctrl+C.', 'error');
    });
    const connectBtn = h('button', { class: 'btn btn-primary btn-lg' }, UI.icon('folder'), 'Connect shared folder');
    connectBtn.addEventListener('click', () => UI.busy(connectBtn, null, onConnect, err));
    UI.mount(screen(
      brand('Sankyo Chat', 'Team chat over the office shared drive. No internet needed.'),
      err,
      h('p', { class: 'section-title' }, 'Connect once to get started'),
      path ? h('div', { class: 'path-box' }, h('code', { 'aria-label': 'Shared folder path' }, path), copyBtn) : null,
      h('ol', { class: 'steps' },
        h('li', null, h('span', { class: 'num' }, '1'), h('span', { class: 'txt' }, path ? ['Click ', b('Copy'), ' above, then ', b('Connect shared folder'), ' below.'] : ['Click ', b('Connect shared folder'), ' below.'])),
        h('li', null, h('span', { class: 'num' }, '2'), h('span', { class: 'txt' }, path ? ['In the folder window, click the address bar, paste the path (', b('Ctrl+V'), ') and press ', b('Enter'), '.'] : ['Go to the ', b('SankyoChat'), ' folder on the shared drive.'])),
        h('li', null, h('span', { class: 'num' }, '3'), h('span', { class: 'txt' }, ['Make sure you are in the ', b('data'), ' folder, then click ', b('Select folder'), '.'])),
        h('li', null, h('span', { class: 'num' }, '4'), h('span', { class: 'txt' }, ['When the browser asks to view and edit files, choose ', b('Allow on every visit'), ' (or ', b('Edit files'), ').']))),
      connectBtn,
      h('div', { class: 'card-foot' }, h('span', null, 'Works in Microsoft Edge or Google Chrome'), h('a', { href: 'check.html' }, 'Run compatibility check')),
      h('div', { class: 'note note-info' }, UI.icon('lock'), h('div', null,
        'Direct messages are end-to-end encrypted. Channel messages are stored as files on the shared drive, so anyone with access to that folder could open them: don’t post passwords or confidential data in channels.'))));
  };

  /** FR-02: one-click reconnect. */
  UI.screenReconnect = function ({ name, onReconnect, onChoose }) {
    const err = errBox();
    const btn = h('button', { class: 'btn btn-primary btn-lg' }, UI.icon('refresh'), 'Reconnect');
    btn.addEventListener('click', () => UI.busy(btn, null, onReconnect, err));
    UI.mount(screen(brand('Sankyo Chat', 'Team chat over the office shared drive.'),
      h('h2', null, 'Reconnect to the shared folder'),
      h('p', { class: 'sub' }, ['The browser needs your OK to open the ', b(name || 'data'), ' folder again. Choose ', b('Allow on every visit'), ' so it stops asking.']),
      err, btn,
      h('div', { class: 'card-foot' }, h('span', null, 'Wrong folder?'), h('button', { class: 'link-btn', onclick: onChoose }, 'Choose a different folder'))));
  };

  UI.screenProblem = function ({ title, text, actions }) {
    UI.mount(screen(brand('Sankyo Chat', 'Team chat over the office shared drive.'),
      h('div', { class: 'note note-warn', style: { marginTop: 0, marginBottom: '22px' } }, UI.icon('alert'), h('div', null, h('b', null, title), h('div', null, text))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'wrap' } }, actions)));
  };

  function strengthMeter(input) {
    const bar = h('i');
    const label = h('span');
    const colors = ['#DC2626', '#DC2626', '#F59E0B', '#16A34A', '#16A34A'];
    const words = ['Too weak', 'Weak', 'OK', 'Strong', 'Very strong'];
    const upd = () => {
      const v = input.value;
      const s = A.passwordStrength(v);
      bar.style.width = v ? ((s + 1) * 20) + '%' : '0';
      bar.style.background = colors[s];
      label.textContent = v ? words[s] + (v.length < A.MIN_PASSWORD ? ` · at least ${A.MIN_PASSWORD} characters` : '') : `At least ${A.MIN_PASSWORD} characters. A short sentence is easy to remember and hard to guess.`;
    };
    input.addEventListener('input', upd);
    upd();
    return [h('div', { class: 'strength', 'aria-hidden': 'true' }, bar), h('div', { class: 'hint' }, label)];
  }

  /** Profile form used for "create workspace" and "create profile". */
  function profileForm({ withWorkspace, submitLabel, onSubmit, connected, footer }) {
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const state = { animal: pick(A.ANIMALS)[0], color: pick(A.COLORS) };
    const err = errBox();
    const wsName = h('input', { class: 'input', value: 'Sankyo Chat', maxlength: 40, id: 'f-ws' });
    const name = h('input', { class: 'input', maxlength: 32, id: 'f-name', autocomplete: 'off', autofocus: true });
    const realName = h('input', { class: 'input', maxlength: 60, id: 'f-real', autocomplete: 'name', placeholder: 'e.g. Maria Santos' });
    const pw = h('input', { class: 'input', type: 'password', id: 'f-pw', autocomplete: 'new-password' });
    const pw2 = h('input', { class: 'input', type: 'password', id: 'f-pw2', autocomplete: 'new-password' });
    const question = h('input', { class: 'input', id: 'f-q', maxlength: 120, autocomplete: 'off', placeholder: 'e.g. What was the name of my first manager?' });
    const answer = h('input', { class: 'input', type: 'password', id: 'f-a', autocomplete: 'off' });
    const keep = h('input', { type: 'checkbox' });
    const teamField = UI.teamInput('f-team');
    const pvAvatar = h('span');
    const pvName = h('span', { class: 'name' });
    const drawPreview = () => {
      UI.set(pvAvatar, UI.avatar({ animal: state.animal, color: state.color }, 60));
      pvName.textContent = name.value.trim() || 'Your name';
    };
    name.addEventListener('input', drawPreview);
    const animals = h('div', { class: 'animal-grid', role: 'radiogroup', 'aria-label': 'Avatar' }, A.ANIMALS.map(([e, n]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(e === state.animal), 'aria-label': n, title: n, onclick: ev => {
        state.animal = e;
        animals.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === ev.currentTarget)));
        drawPreview();
      } }, e)));
    const colors = h('div', { class: 'color-row', role: 'radiogroup', 'aria-label': 'Background colour' }, A.COLORS.map((c, i) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(c === state.color), 'aria-label': 'Colour ' + (i + 1), style: { background: c }, onclick: ev => {
        state.color = c;
        colors.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === ev.currentTarget)));
        drawPreview();
      } })));
    drawPreview();
    const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, submitLabel);
    const form = h('form', { onsubmit: e => {
      e.preventDefault();
      UI.busy(submit, 'Creating your security keys…', () => onSubmit({
        wsName: wsName.value, name: name.value, animal: state.animal, color: state.color, team: teamField.input.value, realName: realName.value, password: pw.value, password2: pw2.value, question: question.value, answer: answer.value, keep: keep.checked,
      }), err);
    } },
      connected ? h('div', { class: 'note note-ok top' }, UI.icon('check'), h('div', null, 'Connected to ', b(connected))) : null,
      h('h2', null, withWorkspace ? 'Set up your workspace' : 'Set up your profile'),
      h('p', { class: 'sub' }, withWorkspace ? 'This folder is new. You’ll be the admin of this workspace.' : 'This is how your teammates will see you.'),
      h('div', { class: 'preview' }, pvAvatar, h('div', null, pvName, h('div', { class: 'status' }, UI.dot('online'), 'Online')), h('span', { class: 'tag' }, 'Preview')),
      err,
      withWorkspace ? h('div', { class: 'field' }, h('label', { for: 'f-ws' }, 'Workspace name'), wsName) : null,
      h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Display name'), name, h('div', { class: 'hint' }, '2–32 characters. Must be unique in this workspace.')),
      h('div', { class: 'field' }, h('label', { for: 'f-real' }, 'Real name'), realName,
        h('div', { class: 'hint' }, 'Required. Only admins and the super admin can see it. It’s encrypted for them; everyone else sees your display name.')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Group'), teamField.el,
        h('div', { class: 'hint' }, withWorkspace
          ? 'Required. As the super admin, yours is accepted straight away.'
          : 'Required, and permanent: only an admin can change it later. An admin checks it before group-only messages reach you.')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Avatar'), animals),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Background colour'), colors),
      h('div', { class: 'field' }, h('label', { for: 'f-pw' }, 'Password'), pw, strengthMeter(pw)),
      h('div', { class: 'field' }, h('label', { for: 'f-pw2' }, 'Confirm password'), pw2,
        h('div', { class: 'hint' }, withWorkspace
          ? 'Your password protects your security keys. If you forget it, your security question below is the only way back in.'
          : 'Your password protects your security keys. If you forget it, your security question below gets you back in with all your messages. Admins can’t recover it for you.')),
      h('div', { class: 'field' }, h('label', { for: 'f-q' }, 'Security question'), question,
        h('div', { class: 'hint' }, 'Used only if you forget your password: “Forgot password?” on the sign-in screen. Pick something coworkers couldn’t guess or look up.')),
      h('div', { class: 'field' }, h('label', { for: 'f-a' }, 'Answer'), answer,
        h('div', { class: 'hint' }, `At least ${A.MIN_ANSWER} characters. Capitals and extra spaces don’t matter. Anyone with the answer can get into your account, so treat it like a second password.`)),
      h('div', { class: 'field' }, h('label', { class: 'check' }, keep, h('span', null, 'Keep me signed in on this PC', h('div', { class: 'hint' }, 'Only tick this on a PC nobody else uses.')))),
      submit,
      footer);
    return form;
  }

  /** The two groups as two big choices (no typing). `.input.value` is the chosen group's id ('' if none). */
  UI.teamInput = function (id, value) {
    let chosen = value || '';
    const box = h('div', { class: 'team-pick', role: 'radiogroup', id, 'aria-label': 'Group' });
    const draw = () => UI.set(box, A.teamList().map(t => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(t.id === chosen), onclick: () => { chosen = t.id; draw(); },
    }, h('span', { class: 'team-radio' }), h('b', null, t.name))));
    draw();
    return { input: { get value() { return chosen; } }, el: box };
  };

  UI.screenCreateWorkspace = function ({ connected, onSubmit, onBack }) {
    UI.mount(screen(profileForm({ withWorkspace: true, submitLabel: 'Create workspace', connected, onSubmit,
      footer: h('div', { class: 'card-foot' }, h('span', null, 'Not the right folder?'), h('button', { class: 'link-btn', type: 'button', onclick: onBack }, 'Choose a different folder')) })));
  };

  UI.screenCreateProfile = function ({ connected, onSubmit, onHaveProfile }) {
    UI.mount(screen(profileForm({ submitLabel: 'Join workspace', connected, onSubmit,
      footer: onHaveProfile ? h('div', { style: { textAlign: 'center', marginTop: '18px' } }, h('button', { class: 'link-btn', type: 'button', onclick: onHaveProfile }, 'I already have a profile on this workspace')) : null })));
  };

  /** FR-04: pick your name, enter your password. */
  /** @returns {{setUsers: Function, alive: Function}} so the list can be refreshed while the screen is open */
  UI.screenSignIn = function ({ wsName, users, preselect, onSubmit, onCreate, onChangeFolder, onRecover }) {
    let selected = users.find(u => u.id === preselect) ? preselect : (users.length === 1 ? users[0].id : null);
    const err = errBox();
    const pw = h('input', { class: 'input', type: 'password', id: 's-pw', autocomplete: 'current-password' });
    const keep = h('input', { type: 'checkbox', checked: A.keepSignedIn() });
    const list = h('div', { class: 'user-pick', role: 'radiogroup', 'aria-label': 'Who are you?' });
    const filter = users.length > 8 ? h('input', { class: 'input', placeholder: 'Type to find your name', 'aria-label': 'Find your name', style: { marginBottom: '8px' } }) : null;
    function draw() {
      const q = filter ? filter.value.trim().toLowerCase() : '';
      UI.set(list, ...users.filter(u => !q || u.name.toLowerCase().includes(q)).map(u =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(u.id === selected), onclick: () => { selected = u.id; draw(); pw.focus(); } },
          UI.avatar(u, 32), h('span', { class: 'nm' }, u.name), A.roleLabel(u.id) ? h('span', { class: 'pill grey', style: { marginLeft: 'auto' } }, A.roleLabel(u.id)) : null)));
    }
    if (filter) filter.addEventListener('input', draw);
    draw();
    const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Sign in');
    const forgot = h('button', { class: 'link-btn', type: 'button', onclick: () => {
      const showErr = t => { err.textContent = t; err.classList.remove('hidden'); };
      if (!selected) return showErr('Pick your name first.');
      if (!onRecover) return showErr('Ask your admin to reset your password.');
      UI.busy(forgot, null, () => onRecover(selected), err);
    } }, 'Forgot password?');
    const form = h('form', { onsubmit: e => {
      e.preventDefault();
      if (!selected) { err.textContent = 'Pick your name first.'; err.classList.remove('hidden'); return; }
      if (!pw.value) { err.textContent = 'Enter your password.'; err.classList.remove('hidden'); pw.focus(); return; }
      UI.busy(submit, 'Unlocking…', async () => {
        try { await onSubmit({ userId: selected, password: pw.value, keep: keep.checked }); } catch (ex) {
          if (ex.code === 'BAD_PASSWORD') { pw.select(); throw new Error('That password isn’t right. Try again, or ask your admin to reset it.'); }
          throw ex;
        }
      }, err);
    } },
      brand(wsName, 'Sign in to continue'),
      err,
      h('span', { class: 'label', style: { display: 'block', marginBottom: '8px' } }, 'Who are you?'),
      filter, list,
      h('div', { class: 'field' }, h('label', { for: 's-pw' }, 'Password'), pw),
      h('div', { class: 'field' }, h('label', { class: 'check' }, keep, h('span', null, 'Keep me signed in on this PC', h('div', { class: 'hint' }, 'Only on a PC nobody else uses. Otherwise the app locks after a while.')))),
      submit,
      h('div', { class: 'card-foot' }, forgot,
        h('span', { class: 'row' }, h('button', { class: 'link-btn', type: 'button', onclick: onCreate }, 'New here? Create a profile'))),
      onChangeFolder ? h('div', { style: { textAlign: 'right', marginTop: '8px', fontSize: '13px' } }, h('button', { class: 'link-btn', type: 'button', onclick: onChangeFolder }, 'Use a different folder')) : null);
    UI.mount(screen(form));
    setTimeout(() => (selected ? pw : (filter || list.querySelector('button') || pw)).focus(), 0);
    return {
      alive: () => document.contains(form),
      setUsers(next) {
        const sig = l => l.map(u => u.id + ':' + u.name + ':' + u.animal + ':' + u.color + ':' + A.roleLabel(u.id)).join('|');
        if (sig(next) === sig(users)) return;
        users = next;
        if (selected && !users.some(u => u.id === selected)) selected = null;
        const hadFocus = list.contains(document.activeElement);
        draw();
        if (hadFocus) { const b = list.querySelector('[aria-checked="true"]') || list.querySelector('button'); if (b) b.focus(); }
      },
    };
  };

  /** Forgot password: answer your security question, choose a new password. Keeps every message. */
  UI.screenRecover = function ({ name, question, onSubmit, onCancel }) {
    const err = errBox();
    const ans = h('input', { class: 'input', type: 'password', id: 'r-a', autocomplete: 'off', autofocus: true });
    const pw = h('input', { class: 'input', type: 'password', id: 'r-pw', autocomplete: 'new-password' });
    const pw2 = h('input', { class: 'input', type: 'password', id: 'r-pw2', autocomplete: 'new-password' });
    const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Reset password');
    UI.mount(screen(h('form', { onsubmit: e => { e.preventDefault(); UI.busy(submit, 'Checking…', () => onSubmit({ answer: ans.value, pw: pw.value, pw2: pw2.value }), err); } },
      brand('Forgot password', name),
      h('p', { class: 'sub' }, 'Answer your security question to choose a new password. Your messages stay readable.'),
      err,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Security question'), h('div', null, b(question))),
      h('div', { class: 'field' }, h('label', { for: 'r-a' }, 'Answer'), ans),
      h('div', { class: 'field' }, h('label', { for: 'r-pw' }, 'New password'), pw, strengthMeter(pw)),
      h('div', { class: 'field' }, h('label', { for: 'r-pw2' }, 'Confirm new password'), pw2),
      submit,
      h('div', { class: 'card-foot' }, h('span'), h('button', { class: 'link-btn', type: 'button', onclick: onCancel }, 'Back to sign in')))));
    setTimeout(() => ans.focus(), 0);
  };

  /** After an admin reset: choose a new password. */
  UI.screenForceChange = function ({ onSubmit, onCancel }) {
    const err = errBox();
    const cur = h('input', { class: 'input', type: 'password', id: 'c-cur', autocomplete: 'current-password', autofocus: true });
    const pw = h('input', { class: 'input', type: 'password', id: 'c-pw', autocomplete: 'new-password' });
    const pw2 = h('input', { class: 'input', type: 'password', id: 'c-pw2', autocomplete: 'new-password' });
    const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Save new password');
    UI.mount(screen(h('form', { onsubmit: e => { e.preventDefault(); UI.busy(submit, 'Saving…', () => onSubmit({ old: cur.value, pw: pw.value, pw2: pw2.value }), err); } },
      brand('Choose a new password', 'Your admin reset your password.'),
      h('p', { class: 'sub' }, 'Pick a new password that only you know. Direct messages from before the reset can’t be opened any more.'),
      err,
      h('div', { class: 'field' }, h('label', { for: 'c-cur' }, 'Temporary password from your admin'), cur),
      h('div', { class: 'field' }, h('label', { for: 'c-pw' }, 'New password'), pw, strengthMeter(pw)),
      h('div', { class: 'field' }, h('label', { for: 'c-pw2' }, 'Confirm new password'), pw2),
      submit,
      h('div', { class: 'card-foot' }, h('span'), h('button', { class: 'link-btn', type: 'button', onclick: onCancel }, 'Sign out')))));
  };

  UI.strengthMeter = strengthMeter;
  SC.ui = UI;
})(window);
