/* Sankyo Chat — Admin settings → Roles (super admin only, 1.12).
 * Role overview cards, a permissions table (roles across, permissions down), a one-role view for narrow
 * screens, and the "New role" dialog. Changes collect in a draft shared with the People tab's role dropdowns;
 * nothing is written until "Review and save", which signs workspace.json once (A.saveRoles). */
(function (root) {
  'use strict';
  const SC = root.SC;
  const U = SC.util, A = SC.account, UI = SC.ui;
  const h = UI.h, icon = UI.icon;
  /** @namespace SC.rolesUI */
  const R = {};

  /* ---------- permission names, grouped (ids and tiers live in A.PERMS) ---------- */
  const CATS = [
    ['Announcements', [
      ['ann.post', 'Post announcements to everyone', 'Pop-up for all staff, kept for a year.'],
      ['ann.private', 'Send private announcements', 'To chosen people in their own group, encrypted.'],
      ['ann.withdraw', 'Withdraw any announcement', 'Removes it for everyone.'],
    ]],
    ['Channels', [
      ['ch.create', 'Create public channels', 'Everyone can read and post in them.'],
      ['ch.createPrivate', 'Create private channels', 'Invite-only and encrypted.'],
      ['ch.manage', 'Rename, describe, archive, export', 'Any public channel.'],
      ['ch.makePrivate', 'Make a public channel private', 'Creates a private copy and archives the public one.'],
    ]],
    ['Messages', [
      ['msg.hide', 'Hide messages in channels', 'Everyone sees “Message hidden”.'],
      ['msg.pin', 'Pin messages in channels', 'Shown in the bar at the top of the channel.'],
      ['msg.poll', 'Create polls', 'One vote per person.'],
    ]],
    ['Groups and project boards', [
      ['grp.accept', 'Accept group requests, move people', 'Decides which group’s messages someone sees.'],
      ['board.manage', 'Manage the project board', 'Create, assign, move, approve and receive projects.'],
      ['grp.rename', 'Rename the groups', 'The names of the two groups.'],
    ]],
    ['People and security', [
      ['log.view', 'See the activity log', 'Who renamed, hid, reset or removed what.'],
      ['ppl.realname', 'See real names', 'Sealed to admins only.'],
      ['ppl.reset', 'Reset passwords', 'Their older direct messages become unreadable.'],
      ['ppl.remove', 'Remove people', 'They can’t sign in any more.'],
    ]],
    ['Workspace', [
      ['sec.roles', 'Appoint admins, manage roles', 'This tab and the Role dropdowns.'],
      ['ws.settings', 'Workspace name and auto-lock', 'Applies to everyone.'],
      ['ws.update', 'Update mode', 'Disconnects everyone while the app is updated.'],
      ['ws.backup', 'Backups', 'Backup folder and restore.'],
      ['ws.files', 'Check app files', 'Fingerprint of the app code.'],
      ['ws.feedback', 'Feedback inbox', 'Encrypted to the super admin only.'],
    ]],
  ];
  const PERMS = [];
  CATS.forEach(([cat, items]) => items.forEach(([id, name, desc]) => PERMS.push({ id, name, desc, cat, tier: A.PERM_TIER[id], scoped: A.SCOPED_PERMS.includes(id) })));
  const P = Object.fromEntries(PERMS.map(p => [p.id, p]));
  const ROLE_PERMS = PERMS.filter(p => p.tier === 'role');
  const LOCK_WHY = { admin: 'Admins only: touches accounts, passwords or private data.', super: 'Super admin only.' };
  const BUILTIN = [
    { id: 'super', name: 'Super admin', color: '#7C3AED', desc: 'Created the workspace. Can do everything.', fixed: true, only1: true },
    { id: 'admin', name: 'Admin', color: '#DC2626', desc: 'Everything except super admin settings.', fixed: true },
  ];
  R.PERM_NAMES = Object.fromEntries(PERMS.map(p => [p.id, p.name]));

  /* ---------- draft ---------- */
  let D = null;
  const fromWs = () => {
    const out = {};
    for (const [id, r] of Object.entries(A.roles())) out[id] = { name: r.name, color: r.color, desc: r.desc || '', perms: new Set(r.perms || []), scope: Object.assign({}, r.scope) };
    return out;
  };
  const draft = () => D || (D = { roles: fromWs(), assign: {} });
  R.reset = () => { D = null; };
  /** The role someone will have after saving: 'super' | 'admin' | roleId | 'staff'. */
  R.roleFor = id => {
    const d = draft();
    const cur = A.roleIdOf(id);
    if (cur === 'super') return 'super';
    let r = d.assign[id] !== undefined ? d.assign[id] : cur;
    if (r !== 'admin' && r !== 'staff' && !d.roles[r]) r = 'staff';
    return r;
  };
  const people = () => A.activeUsers();
  const holders = id => people().filter(u => R.roleFor(u.id) === id);
  const cols = () => BUILTIN.concat(Object.entries(draft().roles).map(([id, r]) => Object.assign({ id }, r)));
  const colOf = id => cols().find(c => c.id === id);
  R.roleName = id => (id === 'staff' ? 'Staff' : (colOf(id) || {}).name || 'Staff');
  R.roleColor = id => (id === 'staff' ? '' : (colOf(id) || {}).color || '');
  const has = (c, pid) => (c.id === 'super' ? true : c.id === 'admin' ? P[pid].tier !== 'super' : c.perms.has(pid));
  const permCount = c => PERMS.filter(p => has(c, p.id)).length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const peopleWord = n => (n === 1 ? '1 person' : `${n} people`);

  function cellDirty(c, pid) {
    const old = A.roles()[c.id];
    if (!old) return c.perms.has(pid);
    const was = (old.perms || []).includes(pid);
    if (was !== c.perms.has(pid)) return true;
    return was && P[pid].scoped && ((old.scope || {})[pid] || 'own') !== (c.scope[pid] || 'own');
  }

  /** Human list of what saving would change. */
  R.changes = function () {
    if (!D) return [];
    const out = [];
    const ws = A.roles();
    for (const [id, r] of Object.entries(D.roles)) {
      const old = ws[id];
      const n = holders(id).length;
      if (!old) { out.push([`New role `, h('b', null, r.name), ` with ${plural(r.perms.size, 'permission')}`]); continue; }
      const parts = [];
      if (old.name !== r.name) parts.push(`renamed from ${old.name}`);
      if (old.color !== r.color) parts.push('new colour');
      if ((old.desc || '') !== r.desc) parts.push('new description');
      [...r.perms].filter(x => !(old.perms || []).includes(x)).forEach(x => parts.push('+ ' + P[x].name));
      (old.perms || []).filter(x => !r.perms.has(x)).forEach(x => parts.push('− ' + P[x].name));
      [...r.perms].filter(x => (old.perms || []).includes(x) && P[x].scoped && ((old.scope || {})[x] || 'own') !== (r.scope[x] || 'own'))
        .forEach(x => parts.push(`${P[x].name}: ${r.scope[x] === 'all' ? 'all groups' : 'own group'}`));
      if (parts.length) out.push([h('b', null, r.name), ': ' + parts.join(', '), h('span', { class: 'muted' }, ` (affects ${peopleWord(n)})`)]);
    }
    for (const [id, r] of Object.entries(ws)) if (!D.roles[id]) out.push(['Delete ', h('b', null, r.name)]);
    for (const u of people()) {
      const before = A.roleIdOf(u.id), after = R.roleFor(u.id);
      if (before !== after) out.push([h('b', null, u.name), `: ${before === 'staff' ? 'Staff' : A.roleLabel(u.id) || 'Staff'} → ${R.roleName(after)}`]);
    }
    return out;
  };
  R.dirty = () => R.changes().length > 0;

  /** Save the draft (asks first with a summary). @returns {Promise<boolean>} saved */
  R.review = function (redraw) {
    const list = R.changes();
    if (!list.length) return Promise.resolve(false);
    return new Promise(resolve => {
      let saved = false;
      const err = h('div', { class: 'form-error hidden', role: 'alert' });
      const ok = h('button', { class: 'btn btn-primary' }, `Save ${plural(list.length, 'change')}`);
      const m = UI.modal({ title: 'Save role changes?', cls: 'mid', onClose: () => resolve(saved), body: [err,
        h('p', { style: { marginTop: 0 } }, 'These are signed with your key and reach everyone’s app within a few seconds:'),
        h('ul', { class: 'rl-diff' }, list.map(x => h('li', null, x))),
        h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Anything people already did under their old rights stays in effect.')],
      foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Back'), ok] });
      ok.addEventListener('click', () => UI.busy(ok, 'Saving…', async () => {
        const roles = {};
        for (const [id, r] of Object.entries(D.roles)) roles[id] = { name: r.name, color: r.color, desc: r.desc, perms: [...r.perms], scope: r.scope };
        const assign = {};
        for (const u of people()) if (A.roleIdOf(u.id) !== R.roleFor(u.id)) assign[u.id] = R.roleFor(u.id);
        await A.saveRoles(roles, assign);
        saved = true; R.reset(); m.close();
        UI.toast('Saved. Everyone’s app picks this up within a few seconds.', 'ok');
        if (redraw) redraw();
      }, err));
    });
  };

  /** Sticky bar under the Roles and People tabs while there are unsaved changes. */
  R.saveBar = function (redraw) {
    const n = R.changes().length;
    if (!n) return null;
    return h('div', { class: 'rl-savebar', role: 'status' },
      h('span', null, h('b', null, plural(n, 'unsaved change')), ' · Nobody sees them until you save.'),
      h('span', { class: 'row', style: { gap: '8px' } },
        h('button', { class: 'btn btn-sm', onclick: () => { R.reset(); redraw(); UI.toast('Changes discarded'); } }, 'Discard'),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => R.review(redraw) }, 'Review and save')));
  };

  /** People tab: the role dropdown for one person (super admin only). */
  R.roleSelect = function (u, redraw) {
    const cur = R.roleFor(u.id);
    if (cur === 'super') return h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'rl-pill', style: { '--rc': '#7C3AED' } }, 'Super admin'), h('span', { class: 'rl-cap one' }, icon('lock'), 'Only 1'));
    const ids = ['staff'].concat(Object.keys(draft().roles), ['admin']);
    const sel = h('select', { class: 'select rl-sel', 'aria-label': `Role for ${u.name}` }, ids.map(id => h('option', { value: id, selected: id === cur }, R.roleName(id))));
    sel.addEventListener('change', () => { draft().assign[u.id] = sel.value; redraw(); });
    return h('span', { class: 'rl-selwrap', style: { '--rc': R.roleColor(cur) || 'var(--border-strong)' } }, sel);
  };
  /** People tab: is this row changed in the draft? */
  R.rowDirty = id => !!D && R.roleFor(id) !== A.roleIdOf(id);

  /* ---------- Roles tab ---------- */
  const view = { mode: null, one: 'super', q: '', collapsed: new Set() };

  R.render = function (redraw) {
    if (!view.mode) view.mode = root.matchMedia && root.matchMedia('(max-width: 640px)').matches ? 'one' : 'all';
    if (!colOf(view.one)) view.one = 'super';
    const wrap = h('div', { class: 'rl' });
    const rerender = () => { const active = document.activeElement && document.activeElement.id === 'rl-q'; redraw(); if (active) { const q = document.getElementById('rl-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } } };
    wrap.append(
      h('p', { class: 'muted', style: { fontSize: '14px', margin: '0 0 12px' } }, 'What each role can do. Super admin and Admin are built in and can’t be changed. Create roles to hand out day-to-day work without the security powers, then give them to people in People.'),
      cards(rerender), toolbar(rerender), view.mode === 'all' ? matrix(rerender) : oneRole(rerender));
    const bar = R.saveBar(rerender);
    if (bar) wrap.append(bar);
    return wrap;
  };

  function capTag(c) { return c.only1 ? h('span', { class: 'rl-cap one' }, icon('lock'), 'Only 1') : h('span', { class: 'rl-cap' }, 'No limit'); }
  function faces(id) {
    const hs = holders(id);
    if (!hs.length) return h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Nobody yet');
    return h('span', { class: 'rl-faces' }, hs.slice(0, 4).map(u => UI.avatar(u, 22)), hs.length > 4 ? h('span', { class: 'muted', style: { fontSize: '11.5px', marginLeft: '6px' } }, '+' + (hs.length - 4)) : null);
  }
  function whoPopover(anchor, id, redraw) {
    const c = colOf(id), hs = holders(id);
    UI.popover(anchor, [h('div', { class: 'rl-ph' }, `${c.name} · ${c.only1 ? 'Only 1' : 'No limit'}`),
      hs.length ? hs.map(u => h('div', { class: 'rl-pp' }, UI.avatar(u, 22), u.name)) : h('div', { class: 'rl-pp muted' }, 'Nobody has this role yet.'),
      c.only1 ? null : h('div', { class: 'rl-ph', style: { paddingTop: '8px' } }, 'Change people’s roles in the People tab.')], { label: `Who has ${c.name}` });
  }
  function roleMenu(anchor, id, redraw) {
    const r = draft().roles[id];
    const item = (label, fn, danger) => h('button', { class: 'menu-item' + (danger ? ' danger' : ''), onclick: () => { UI.closePopover(); fn(); } }, label);
    UI.popover(anchor, [h('div', { class: 'rl-ph' }, r.name),
      item('Edit name, colour and permissions', () => roleDialog(redraw, id)),
      item('Duplicate', () => roleDialog(redraw, null, id)),
      h('div', { class: 'menu-sep' }),
      item('Select all possible', () => { ROLE_PERMS.forEach(p => r.perms.add(p.id)); redraw(); }),
      item('Clear all', () => { r.perms.clear(); redraw(); }),
      h('div', { class: 'menu-sep' }),
      item('Delete role…', () => deleteRole(id, redraw), true)], { label: `${r.name} options` });
  }
  async function deleteRole(id, redraw) {
    const r = draft().roles[id];
    const n = holders(id).length;
    if (!(await UI.confirm({ title: `Delete ${r.name}?`, ok: 'Delete role', danger: true,
      text: `${n ? `${n === 1 ? '1 person has' : `${n} people have`} ${r.name}. They become regular staff. ` : ''}Things done under this role stay in effect. Nothing changes until you save.` }))) return;
    delete draft().roles[id];
    if (view.one === id) view.one = 'super';
    redraw();
  }

  function cards(redraw) {
    return h('div', { class: 'rl-cards' }, cols().map(c => {
      const n = permCount(c);
      const cnt = h('button', { class: 'rl-cnt', type: 'button' }, faces(c.id), h('span', null, peopleWord(holders(c.id).length)));
      cnt.addEventListener('click', () => whoPopover(cnt, c.id, redraw));
      const menu = c.fixed ? h('span', { class: 'muted', title: 'Built in' }, icon('lock')) : h('button', { class: 'icon-btn', 'aria-label': `${c.name} options`, title: 'Options' }, '⋯');
      if (!c.fixed) menu.addEventListener('click', () => roleMenu(menu, c.id, redraw));
      return h('div', { class: 'rl-card', style: { '--rc': c.color } },
        h('div', { class: 'rl-card-top' }, h('div', { class: 'rl-name' }, c.name), menu),
        h('div', { class: 'rl-desc' }, c.desc || ''),
        h('div', { class: 'rl-stats' }, cnt, capTag(c)),
        h('div', null, h('div', { class: 'rl-meter', title: `${n} of ${PERMS.length} permissions` }, h('i', { style: { width: Math.round(n / PERMS.length * 100) + '%' } })),
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, `${n} of ${PERMS.length} permissions`)));
    }), h('button', { class: 'rl-card rl-add', type: 'button', onclick: () => roleDialog(redraw) }, h('span', { style: { fontSize: '22px', lineHeight: 1 } }, '＋'), 'New role', h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '12.5px' } }, 'No limit on roles')));
  }

  function toolbar(redraw) {
    const q = h('input', { class: 'input', id: 'rl-q', type: 'search', placeholder: 'Search permissions', 'aria-label': 'Search permissions', value: view.q });
    q.addEventListener('input', () => { view.q = q.value; redraw(); });
    const seg = (mode, label) => h('button', { type: 'button', 'aria-pressed': String(view.mode === mode), onclick: () => { view.mode = mode; redraw(); } }, label);
    return h('div', { class: 'rl-toolbar' },
      h('label', { class: 'rl-search' }, icon('search'), q),
      h('span', { class: 'rl-seg', role: 'group', 'aria-label': 'View' }, seg('all', 'All roles'), seg('one', 'One role')),
      h('span', { class: 'rl-legend' },
        h('span', null, h('span', { class: 'rl-yes', style: { '--rc': 'var(--muted)' } }, icon('check')), 'Built in, always on'),
        h('span', null, h('span', { class: 'rl-box' }), 'Tick to allow'),
        h('span', null, h('span', { class: 'rl-lock' }, icon('lock')), 'Not possible for this role')));
  }
  const matches = p => !view.q || (p.name + ' ' + p.desc + ' ' + p.cat).toLowerCase().includes(view.q.toLowerCase());
  const tierTag = p => (p.tier === 'role' ? null : h('span', { class: 'rl-tier ' + p.tier }, p.tier === 'admin' ? 'Admins only' : 'Super admin'));
  const scopeSel = (c, p, redraw) => {
    const s = h('select', { class: 'rl-scope', 'aria-label': `${c.name}: ${p.name}, which groups` },
      h('option', { value: 'own', selected: c.scope[p.id] !== 'all' }, 'Own group'), h('option', { value: 'all', selected: c.scope[p.id] === 'all' }, 'All groups'));
    s.addEventListener('change', () => { c.scope[p.id] = s.value; redraw(); });
    return s;
  };
  const toggle = (c, pid, on, redraw) => {
    const r = draft().roles[c.id];
    if (on) { r.perms.add(pid); if (P[pid].scoped && !r.scope[pid]) r.scope[pid] = 'own'; } else r.perms.delete(pid);
    redraw();
    const again = document.querySelector(`[data-rl="${c.id}|${pid}"]`);
    if (again) again.focus();
  };

  function matrix(redraw) {
    const cs = cols();
    const head = h('tr', null, h('th', { class: 'rl-perm-h' }, 'Permission'), cs.map((c, i) => {
      const cnt = h('button', { class: 'rl-cnt', type: 'button' }, icon('users'), peopleWord(holders(c.id).length));
      cnt.addEventListener('click', () => whoPopover(cnt, c.id, redraw));
      const menu = c.fixed ? null : h('button', { class: 'icon-btn', 'aria-label': `${c.name} options`, title: 'Options' }, '⋯');
      if (menu) menu.addEventListener('click', () => roleMenu(menu, c.id, redraw));
      return h('th', { class: 'rl-rh', 'data-col': i }, h('div', { class: 'rl-rh-in' }, h('div', { class: 'row', style: { gap: '2px', flexWrap: 'nowrap' } }, h('span', { class: 'rl-pill', style: { '--rc': c.color } }, c.name), menu), cnt, capTag(c)));
    }));
    const body = [];
    let shown = 0;
    for (const [cat] of CATS) {
      const ps = PERMS.filter(p => p.cat === cat && matches(p));
      if (!ps.length) continue;
      shown += ps.length;
      const open = !view.collapsed.has(cat) || !!view.q;
      const btn = h('button', { class: 'rl-catbtn', type: 'button', 'aria-expanded': String(open) }, h('span', { class: 'rl-chev' }, '▾'), cat, h('small', null, plural(ps.length, 'permission')));
      btn.addEventListener('click', () => { view.collapsed.has(cat) ? view.collapsed.delete(cat) : view.collapsed.add(cat); redraw(); });
      body.push(h('tr', { class: 'rl-cat' }, h('td', null, btn), cs.map((c, i) => h('td', { class: 'rl-catcnt', 'data-col': i }, `${ps.filter(p => has(c, p.id)).length} / ${ps.length}`))));
      if (!open) continue;
      for (const p of ps) {
        body.push(h('tr', null, h('td', { class: 'rl-perm' }, h('div', { class: 'rl-perm-n' }, p.name, p.scoped ? h('span', { title: 'Own group or all groups' }, '◎') : null, tierTag(p)), h('div', { class: 'rl-perm-d' }, p.desc)),
          cs.map((c, i) => {
            const label = `${c.name}: ${p.name}`;
            if (c.fixed) {
              return h('td', { class: 'rl-cell', 'data-col': i }, has(c, p.id)
                ? h('span', { class: 'rl-yes', style: { '--rc': c.color }, role: 'img', 'aria-label': `${label}, always allowed` }, icon('check'))
                : h('span', { class: 'rl-lock', tabindex: '0', title: LOCK_WHY.super, role: 'img', 'aria-label': `${label}, ${LOCK_WHY.super}` }, icon('lock')));
            }
            if (p.tier !== 'role') return h('td', { class: 'rl-cell', 'data-col': i }, h('span', { class: 'rl-lock', tabindex: '0', title: LOCK_WHY[p.tier], role: 'img', 'aria-label': `${label}, ${LOCK_WHY[p.tier]}` }, icon('lock')));
            const on = c.perms.has(p.id);
            const cb = h('input', { type: 'checkbox', class: 'rl-chk', checked: on, 'aria-label': label, 'data-rl': `${c.id}|${p.id}` });
            cb.addEventListener('change', () => toggle(c, p.id, cb.checked, redraw));
            return h('td', { class: 'rl-cell' + (cellDirty(c, p.id) ? ' dirty' : ''), 'data-col': i }, cb, p.scoped && on ? scopeSel(draft().roles[c.id], Object.assign({}, p), redraw) : null);
          })));
      }
    }
    const table = h('table', { class: 'rl-matrix' }, h('thead', null, head), h('tbody', null, body));
    // highlight the column under the pointer
    let hi = null;
    table.addEventListener('mouseover', e => {
      const cell = e.target.closest('[data-col]'); const col = cell ? cell.dataset.col : null;
      if (col === hi) return;
      table.querySelectorAll('.colhi').forEach(x => x.classList.remove('colhi'));
      hi = col;
      if (col != null) table.querySelectorAll(`[data-col="${col}"]`).forEach(x => x.classList.add('colhi'));
    });
    table.addEventListener('mouseleave', () => { hi = null; table.querySelectorAll('.colhi').forEach(x => x.classList.remove('colhi')); });
    return h('div', { class: 'rl-matrix-wrap' }, table, shown ? null : h('div', { class: 'rl-empty' }, `No permission matches “${view.q}”.`));
  }

  function oneRole(redraw) {
    const cs = cols();
    const c = colOf(view.one) || cs[0];
    const chips = h('div', { class: 'rl-chips', role: 'group', 'aria-label': 'Choose a role' }, cs.map(x =>
      h('button', { type: 'button', class: 'rl-chip', style: { '--rc': x.color }, 'aria-pressed': String(x.id === c.id), onclick: () => { view.one = x.id; redraw(); } }, x.name)));
    const menu = c.fixed ? null : h('button', { class: 'btn btn-sm' }, '⋯ Options');
    if (menu) menu.addEventListener('click', () => roleMenu(menu, c.id, redraw));
    const out = [chips, h('div', { class: 'rl-onehead' }, h('span', { class: 'muted', style: { fontSize: '13.5px' } }, h('b', { style: { color: 'var(--text)' } }, c.name),
      ` · ${peopleWord(holders(c.id).length)} · ${c.only1 ? 'Only 1' : 'No limit'} · ${permCount(c)} of ${PERMS.length} permissions${c.fixed ? ' · built in, can’t be changed' : ''}`), menu)];
    let shown = 0;
    for (const [cat] of CATS) {
      const ps = PERMS.filter(p => p.cat === cat && matches(p));
      if (!ps.length) continue;
      shown += ps.length;
      out.push(h('div', { class: 'rl-list' }, h('h4', null, cat), ps.map(p => {
        const locked = c.fixed || p.tier !== 'role';
        const on = has(c, p.id);
        const why = c.fixed ? (on ? 'Always on for this built-in role.' : LOCK_WHY.super) : LOCK_WHY[p.tier];
        let ctl;
        if (locked && !on) ctl = h('span', { class: 'rl-lock', title: why }, icon('lock'));
        else {
          const cb = h('input', { type: 'checkbox', checked: on, disabled: locked, 'aria-label': p.name, 'data-rl': locked ? null : `${c.id}|${p.id}` });
          if (!locked) cb.addEventListener('change', () => toggle(c, p.id, cb.checked, redraw));
          ctl = h('label', { class: 'rl-switch' }, cb, h('i'));
        }
        return h('div', { class: 'rl-lrow' + (!locked && cellDirty(c, p.id) ? ' dirty' : '') },
          h('div', { class: 'rl-txt' }, h('div', { class: 'rl-perm-n' }, p.name, p.scoped ? ' ◎' : null, tierTag(p)), h('div', { class: 'rl-perm-d' }, locked ? why : p.desc),
            !locked && p.scoped && on ? scopeSel(draft().roles[c.id], p, redraw) : null), ctl);
      })));
    }
    if (!shown) out.push(h('div', { class: 'rl-empty' }, `No permission matches “${view.q}”.`));
    return h('div', null, out);
  }

  /* ---------- New / Edit role ---------- */
  function roleDialog(redraw, editId, copyId) {
    const d = draft();
    const edit = editId ? d.roles[editId] : null;
    const base = edit || (copyId ? d.roles[copyId] : null);
    let color = edit ? edit.color : (A.ROLE_COLORS.find(c => !Object.values(d.roles).some(r => r.color === c)) || A.ROLE_COLORS[0]);
    const perms = new Set(base ? base.perms : []);
    let scope = Object.assign({}, base ? base.scope : {});
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const nameVal = edit ? edit.name : base ? `${base.name} copy`.slice(0, 24) : '';
    const prev = h('span', { class: 'rl-pill', style: { '--rc': color } }, nameVal || 'New role');
    const name = h('input', { class: 'input', id: 'rl-name', maxlength: 24, value: nameVal, placeholder: 'e.g. Moderator', autofocus: true });
    name.addEventListener('input', () => { prev.textContent = name.value.trim() || 'New role'; });
    const desc = h('input', { class: 'input', id: 'rl-desc', maxlength: 120, value: base ? base.desc || '' : '', placeholder: 'What is this role for?' });
    const sw = h('div', { class: 'rl-sw', role: 'group', 'aria-label': 'Colour' }, A.ROLE_COLORS.map(c => {
      const b = h('button', { type: 'button', style: { '--c': c }, 'aria-pressed': String(c === color), 'aria-label': 'Colour ' + c });
      b.addEventListener('click', () => { color = c; prev.style.setProperty('--rc', c); sw.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
      return b;
    }));
    const cnt = h('span', { class: 'muted', style: { fontWeight: 400 } });
    const list = h('div');
    const drawList = () => {
      cnt.textContent = ` · ${perms.size} of ${ROLE_PERMS.length} selected`;
      UI.set(list, CATS.map(([cat]) => {
        const ps = ROLE_PERMS.filter(p => p.cat === cat);
        if (!ps.length) return null;
        return h('div', { class: 'rl-list' }, h('h4', null, cat), ps.map(p => {
          const cb = h('input', { type: 'checkbox', checked: perms.has(p.id), 'aria-label': p.name });
          cb.addEventListener('change', () => { cb.checked ? perms.add(p.id) : perms.delete(p.id); cnt.textContent = ` · ${perms.size} of ${ROLE_PERMS.length} selected`; });
          return h('div', { class: 'rl-lrow' }, h('div', { class: 'rl-txt' }, h('div', { class: 'rl-perm-n' }, p.name, p.scoped ? ' ◎' : null), h('div', { class: 'rl-perm-d' }, p.desc)), h('label', { class: 'rl-switch' }, cb, h('i')));
        }));
      }));
    };
    drawList();
    let start = null;
    if (!edit) {
      start = h('select', { class: 'select', id: 'rl-start' }, h('option', { value: '' }, 'Blank'),
        Object.entries(d.roles).map(([id, r]) => h('option', { value: id, selected: id === copyId }, `Copy of ${r.name}`)));
      start.addEventListener('change', () => {
        perms.clear();
        const src = d.roles[start.value];
        if (src) { src.perms.forEach(p => perms.add(p)); scope = Object.assign({}, src.scope); }
        drawList();
      });
    }
    const locked = PERMS.filter(p => p.tier !== 'role');
    const ok = h('button', { class: 'btn btn-primary' }, edit ? 'Done' : 'Create role');
    const m = UI.modal({ title: edit ? `Edit ${edit.name}` : 'New role', cls: 'mid', body: [err,
      h('div', { class: 'rl-preview', 'aria-live': 'polite' }, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Label preview'), prev),
      h('div', { class: 'rl-two' },
        h('div', { class: 'field' }, h('label', { for: 'rl-name' }, 'Role name'), name),
        start ? h('div', { class: 'field' }, h('label', { for: 'rl-start' }, 'Start from'), start) : null),
      h('div', { class: 'field' }, h('label', { for: 'rl-desc' }, 'Description (optional)'), desc),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Colour'), sw),
      h('div', { class: 'rl-ptitle' }, h('span', { class: 'label', style: { margin: 0 } }, 'What this role can do', cnt),
        h('span', { class: 'row', style: { gap: '6px' } },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { ROLE_PERMS.forEach(p => perms.add(p.id)); drawList(); } }, 'Select all'),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { perms.clear(); drawList(); } }, 'Clear'))),
      list,
      h('details', { class: 'rl-locked' }, h('summary', null, icon('lock'), ` Never available to custom roles (${locked.length})`),
        h('div', { class: 'rl-list' }, locked.map(p => h('div', { class: 'rl-lrow' }, h('div', { class: 'rl-txt' }, h('div', { class: 'rl-perm-n' }, p.name, tierTag(p)),
          h('div', { class: 'rl-perm-d' }, p.tier === 'admin' ? 'Admins only (security)' : 'Super admin only')), h('span', { class: 'rl-lock' }, icon('lock'))))))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
    ok.addEventListener('click', () => {
      const fail = msg => { err.textContent = msg; err.classList.remove('hidden'); m.body.scrollTop = 0; };
      const n = name.value.replace(/\s+/g, ' ').trim();
      if (n.length < 2) return fail('Give the role a name of at least 2 characters.');
      if (['admin', 'super admin', 'staff'].includes(n.toLowerCase())) return fail(`“${n}” is a built-in name. Pick another one.`);
      if (Object.entries(d.roles).some(([id, r]) => id !== editId && r.name.toLowerCase() === n.toLowerCase())) return fail(`There is already a role called “${n}”.`);
      if (!perms.size) return fail('Tick at least one permission.');
      const sc = {};
      for (const p of A.SCOPED_PERMS) if (perms.has(p)) sc[p] = scope[p] === 'all' ? 'all' : 'own';
      if (edit) Object.assign(edit, { name: n, desc: desc.value.trim(), color, perms: new Set(perms), scope: sc });
      else {
        let id;
        do { id = 'r' + U.rand(5); } while (d.roles[id] || A.roles()[id]);
        d.roles[id] = { name: n, desc: desc.value.trim(), color, perms: new Set(perms), scope: sc };
        view.one = id;
      }
      m.close();
      redraw();
      UI.toast(edit ? `${n} updated. Review and save to apply.` : `${n} added. Give it to people in People, then review and save.`, 'ok');
    });
  }

  SC.rolesUI = R;
})(window);
