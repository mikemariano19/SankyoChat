/* Sankyo Chat — project board view and dialogs (data: js/board.js).
 * Cards show only what the team needs: project number, members, progress, deadline and the superior who
 * assigned it. Admins drag cards between columns and open them to edit; everyone else opens them read-only.
 * js/chat.js shows this view in the main pane (sidebar → Project board) and calls SC.boardView. */
(function (root) {
  'use strict';
  const SC = root.SC;
  const U = SC.util, A = SC.account, UI = SC.ui, B = SC.board;
  const h = UI.h, icon = UI.icon;
  /** @namespace SC.boardView */
  const V = {};
  const st = { team: '', q: '', mine: false, label: '', prio: 0, els: null, hooks: { profile: () => {}, openBoard: () => {} } };
  const meId = () => A.me.id;

  /** js/chat.js passes how to open a profile and how to switch to the board. */
  V.init = hooks => Object.assign(st.hooks, hooks);
  V.reset = () => { st.els = null; };

  /* ================= helpers ================= */

  const shortDate = d => new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(d + 'T00:00:00').getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  const fullDate = d => new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  /** Deadline label and tone: late (red), soon (amber) or plain. */
  function deadlineInfo(p) {
    const days = B.daysLeft(p.deadline);
    if (days == null) return null;
    if (p.col === 'done') return { text: shortDate(p.deadline), tone: '', title: 'Deadline was ' + fullDate(p.deadline) };
    if (days < 0) return { text: `Overdue ${-days} ${days === -1 ? 'day' : 'days'}`, tone: 'late', title: 'Deadline was ' + fullDate(p.deadline) };
    if (days === 0) return { text: 'Due today', tone: 'soon', title: 'Deadline ' + fullDate(p.deadline) };
    if (days <= 3) return { text: `${shortDate(p.deadline)} · ${days} ${days === 1 ? 'day' : 'days'} left`, tone: 'soon', title: 'Deadline ' + fullDate(p.deadline) };
    return { text: shortDate(p.deadline), tone: '', title: 'Deadline ' + fullDate(p.deadline) };
  }
  function matches(p) {
    if (st.mine && !B.isMine(p)) return false;
    if (st.label && p.label !== st.label) return false;
    if (st.prio && p.prio !== st.prio) return false;
    if (!st.q) return true;
    const q = st.q.toLowerCase();
    return p.number.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.members.some(id => A.name(id).toLowerCase().includes(q)) || A.name(p.by).toLowerCase().includes(q);
  }
  function progressBar(pct, col) {
    return h('div', { class: 'bd-progress', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `Progress ${pct}%` },
      h('div', { class: 'bd-track' }, h('span', { class: 'bd-fill bd-c-' + col, style: { width: pct + '%' } })),
      h('span', { class: 'bd-pct' }, pct + '%'));
  }
  /** High shows in red, Low in grey; Normal shows nothing on the card (it's the default). */
  function prioTag(prio, always) {
    if (prio === 2 && !always) return null;
    return h('span', { class: 'bd-prio bd-p' + prio, title: B.PRIOS[prio] + ' priority' }, icon(prio === 1 ? 'alert' : 'clock'), B.PRIOS[prio]);
  }
  /** "Tiger_Lily" → "TL", "Juan" → "JU". */
  function initials(name) {
    const words = String(name || '?').split(/[\s_.\-]+/).filter(Boolean);
    const s = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
    return s.toUpperCase();
  }
  /** A person as a circle with their initials, in their profile color. Hover shows the name. */
  function initialCircle(id, title) {
    const u = A.users.get(id);
    return h('span', { class: 'bd-ini', title: title || A.name(id), style: { background: u ? A.avatarColor(u.color) : '#E2E8F0' } }, initials(A.name(id)));
  }
  function memberChips(ids, max = 3) {
    const shown = ids.slice(0, max);
    return h('div', { class: 'bd-members' },
      shown.map(id => h('span', { class: 'bd-member' + (id === meId() ? ' me' : '') }, UI.avatar(A.users.get(id), 20), h('span', { class: 'nm' }, id === meId() ? 'You' : A.name(id)))),
      ids.length > max ? h('span', { class: 'bd-more', title: ids.slice(max).map(A.name).join(', ') }, '+' + (ids.length - max)) : null);
  }

  /* ================= the board ================= */

  /** Header line for js/chat.js. */
  V.headerSub = function (team) {
    const n = B.inTeam(team).length, mine = B.mineCount(team);
    return `${n} ${n === 1 ? 'project' : 'projects'}` + (mine ? ` · ${mine} assigned to you` : '') + (B.canEdit(team) ? '' : ' · admins of this group manage it');
  };

  /** Draw the board into the message pane. Keeps the search box (and its focus) between redraws. */
  V.render = function (box, team) {
    if (team !== st.team) { st.team = team; st.els = null; }
    if (!st.els || !box.contains(st.els.root)) build(box);
    draw();
  };

  function build(box) {
    const q = h('input', { class: 'input bd-search', type: 'search', placeholder: 'Search number, name or member', 'aria-label': 'Search projects', value: st.q });
    q.addEventListener('input', () => { st.q = q.value.trim(); draw(); });
    const scope = h('div', { class: 'bd-scope', role: 'radiogroup', 'aria-label': 'Show' });
    const filters = h('div', { class: 'bd-filters', role: 'group', 'aria-label': 'Filter' });
    const cols = h('div', { class: 'bd-cols' });
    const summary = h('span', { class: 'bd-summary' });
    const root = h('div', { class: 'bd-view' },
      h('div', { class: 'bd-toolbar' }, q, scope, filters, h('span', { class: 'bd-spacer' }), summary,
        B.canEdit(st.team) ? h('button', { class: 'btn btn-primary', onclick: () => V.projectDialog(null) }, icon('plus'), 'New project') : null),
      cols);
    UI.set(box, root);
    st.els = { root, q, scope, filters, cols, summary };
    cols.addEventListener('click', onClick);
    cols.addEventListener('keydown', onKey);
    if (B.canEdit(st.team)) setupDrag(cols);
  }

  function draw() {
    const e = st.els;
    if (!e) return;
    if (st.dragging) { st.redraw = true; return; } // a live update mid-drag waits until the drop
    const focusPid = document.activeElement && document.activeElement.closest && document.activeElement.closest('.bd-card') ? document.activeElement.closest('.bd-card').dataset.pid : null;
    UI.set(e.scope, [['all', 'All projects'], ['mine', `Assigned to me (${B.mineCount(st.team)})`]].map(([v, label]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String((v === 'mine') === st.mine), onclick: () => { st.mine = v === 'mine'; draw(); } }, label)));
    const chip = (on, label, cls, fn) => h('button', { type: 'button', class: 'bd-fchip' + (cls ? ' ' + cls : ''), 'aria-pressed': String(on), onclick: fn }, label);
    UI.set(e.filters,
      B.labelsFor(st.team).filter(l => l.id !== 'none').map(l => chip(st.label === l.id, l.name, 'bd-lab-' + l.id, () => { st.label = st.label === l.id ? '' : l.id; draw(); })),
      chip(st.prio === 1, 'High priority', 'bd-p1', () => { st.prio = st.prio === 1 ? 0 : 1; draw(); }));
    const all = B.inTeam(st.team);
    const doneN = all.filter(p => p.col === 'done').length;
    e.summary.textContent = all.length ? `${doneN} of ${all.length} done` : '';
    if (!B.ready()) { UI.set(e.cols, h('div', { class: 'bd-state' }, h('div', { class: 'spinner' }), h('div', null, 'Loading the project board…'))); return; }
    if (!all.length) {
      UI.set(e.cols, h('div', { class: 'bd-state' }, icon('board'), h('h3', null, 'No projects yet'),
        h('p', { class: 'muted' }, B.canEdit(st.team) ? 'Add a project number, assign the members, and set the deadline. They get a board notification right away.' : 'When an admin assigns you a project, it shows up here and in the board notifications.'),
        B.canEdit(st.team) ? h('button', { class: 'btn btn-primary', onclick: () => V.projectDialog(null) }, icon('plus'), 'New project') : null));
      return;
    }
    UI.set(e.cols, B.COLS.map(c => {
      const inCol = B.inCol(c.id, st.team), shown = inCol.filter(matches);
      const filtered = shown.length !== inCol.length;
      return h('section', { class: 'bd-col bd-c-' + c.id, 'data-col': c.id, 'aria-label': c.name },
        h('div', { class: 'bd-col-head' }, h('span', { class: 'bd-dot' }), h('h3', null, c.name),
          h('span', { class: 'bd-count' }, filtered ? `${shown.length}/${inCol.length}` : String(inCol.length)),
          B.canEdit(st.team) ? h('button', { class: 'icon-btn bd-add', 'aria-label': `New project in ${c.name}`, title: `New project in ${c.name}`, onclick: () => V.projectDialog(null, c.id) }, icon('plus')) : null),
        h('div', { class: 'bd-list', 'data-col': c.id },
          shown.length ? shown.map(card) : h('div', { class: 'bd-empty' }, filtered ? 'Nothing matches' : B.canEdit(st.team) ? 'Drag a project here' : 'Nothing here')));
    }));
    if (focusPid) { const n = e.cols.querySelector(`.bd-card[data-pid="${CSS.escape(focusPid)}"]`); if (n) n.focus(); }
  }

  function card(p) {
    const dl = deadlineInfo(p);
    const mine = B.isMine(p);
    const label = `Project ${p.number}` + (p.name ? `, ${p.name}` : '') + `, ${B.PRIOS[p.prio]} priority` + (p.label && p.label !== 'none' ? `, ${B.labelName(p.label)}` : '') + `, ${B.colName(p.col)}, ${p.pct}% done` + (dl ? `, ${dl.title}` : '') + `. Members: ${p.members.map(A.name).join(', ')}. Assigned by ${A.name(p.by)}.`;
    // delayed work stands out: orange stripe when it's due today, red when it's overdue (not once it's Done)
    const days = p.col === 'done' ? null : B.daysLeft(p.deadline);
    const delay = days == null ? '' : days < 0 ? ' overdue' : days === 0 ? ' due-today' : '';
    const approvedLine = p.approved ? h('div', { class: 'bd-approved', title: 'Approved ' + U.formatFull(p.approved.ts) },
      icon('check'), h('span', null, 'Approved by ', h('b', null, A.name(p.approved.by)), ` · sent to ${shortTeam(B.handoffTo(p.team))}, waiting to be received`)) : null;
    const pending = B.isPending(p);
    const pendingLine = pending ? h('div', { class: 'bd-pending' }, icon('clock'), h('span', null, 'Waiting to be received')) : null;
    const receiveBtn = B.canReceive(p) ? h('button', { class: 'btn btn-sm btn-primary bd-receive-btn', type: 'button', 'data-receive': p.pid }, icon('download'), 'Receive') : null;
    const approveBtn = B.canApprove(p) ? h('button', { class: 'btn btn-sm bd-approve-btn', type: 'button', 'data-approve': p.pid }, icon('check'), `Approve · send to ${shortTeam(B.handoffTo(p.team))}`) : null;
    const completeBtn = B.canComplete(p) ? h('button', { class: 'btn btn-sm bd-approve-btn', type: 'button', 'data-complete': p.pid }, icon('check'), 'Confirm complete') : null;
    const resendBtn = B.needsResend(p) ? h('button', { class: 'btn btn-sm', type: 'button', 'data-resend': p.pid, title: `The copy didn’t reach the ${A.teamName(B.handoffTo(p.team))} board` }, icon('refresh'), 'Send again') : null;
    const fromLine = p.from ? h('div', { class: 'bd-from' }, icon('reply'), `From ${shortTeam(p.from.team)} · approved by ${A.name(p.createdBy)}`) : null;
    return h('div', { class: 'bd-card' + (mine ? ' mine' : '') + delay + (p.approved ? ' approved' : '') + (B.isSent(p) ? ' sent' : '') + (pending ? ' pending' : ''), 'data-pid': p.pid, tabindex: '0', role: 'button', 'aria-label': label + (p.approved ? ` Approved by ${A.name(p.approved.by)}.` : '') + (p.from ? ` From ${A.teamName(p.from.team)}.` : ''), draggable: B.canEdit(st.team) && !p.approved && !pending ? 'true' : null },
      h('div', { class: 'bd-card-top' },
        h('div', { class: 'bd-title' }, h('span', { class: 'bd-num' }, p.number), p.name ? h('span', { class: 'bd-name' }, p.name) : null),
        p.label && p.label !== 'none' ? h('span', { class: 'bd-label bd-lab-' + p.label }, B.labelName(p.label)) : null),
      fromLine,
      p.prio !== 2 ? h('div', { class: 'bd-tags' }, prioTag(p.prio)) : null,
      p.members.length ? memberChips(p.members) : h('div', { class: 'bd-unassigned' }, icon('users'), pending ? 'Receive it to assign members' : B.canEdit(p.team) ? 'Not assigned yet · click to assign' : 'Not assigned yet'),
      progressBar(p.pct, p.col),
      h('div', { class: 'bd-foot' },
        dl ? h('span', { class: 'bd-due ' + dl.tone, title: dl.title }, icon('calendar'), dl.text) : h('span', { class: 'bd-due none' }, 'No deadline'),
        h('span', { class: 'bd-by' }, initialCircle(p.by, 'Assigned by ' + A.name(p.by)))),
      approvedLine, pendingLine, approveBtn || resendBtn || receiveBtn || completeBtn ? h('div', { class: 'bd-card-actions' }, approveBtn, resendBtn, receiveBtn, completeBtn) : null);
  }
  /** INPUT admin takes a project sent from PICKUP, then picks its members. */
  function receive(btn, pid) {
    const p = B.get(pid);
    return UI.busy(btn, null, async () => {
      await B.receive(pid);
      UI.toast(`${p.number} received. ${A.teamName(p.from.team)} was told. Now assign the members.`, 'ok');
      setTimeout(() => V.projectDialog(pid), 60);
    });
  }
  const shortTeam = t => (A.teamName(t) || 'the next board').replace(/\s+group$/i, '');

  function onClick(e) {
    const ap = e.target.closest('[data-approve]');
    if (ap) { e.stopPropagation(); V.approveDialog(ap.dataset.approve); return; }
    const cp = e.target.closest('[data-complete]');
    if (cp) { e.stopPropagation(); V.completeDialog(cp.dataset.complete); return; }
    const rc = e.target.closest('[data-receive]');
    if (rc) { e.stopPropagation(); receive(rc, rc.dataset.receive); return; }
    const rs = e.target.closest('[data-resend]');
    if (rs) { e.stopPropagation(); UI.busy(rs, null, async () => { await B.resendHandoff(rs.dataset.resend); UI.toast('Sent', 'ok'); }); return; }
    const c = e.target.closest('.bd-card');
    if (c) V.projectDialog(c.dataset.pid);
  }
  function onKey(e) {
    const c = e.target.closest('.bd-card');
    if (!c || e.target !== c) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); V.projectDialog(c.dataset.pid); return; }
    if (B.canEdit(st.team) && e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const p = B.get(c.dataset.pid);
      if (!p || p.approved || B.isPending(p)) return;
      const i = B.COLS.findIndex(x => x.id === p.col) + (e.key === 'ArrowRight' ? 1 : -1);
      if (i < 0 || i >= B.COLS.length) return;
      const to = B.COLS[i].id, first = B.inCol(to, p.team)[0];
      B.move(p.pid, to, first ? first.order - 1024 : 1024).then(() => UI.toast(`${p.number} moved to ${B.colName(to)}`, 'ok')).catch(ex => UI.toast(ex.message, 'error'));
    }
  }

  /* ---- drag and drop (admins) ---- */
  function setupDrag(cols) {
    let dragPid = null;
    const line = h('div', { class: 'bd-drop-line' });
    cols.addEventListener('dragstart', e => {
      const c = e.target.closest('.bd-card');
      if (!c) return;
      dragPid = c.dataset.pid;
      st.dragging = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragPid);
      requestAnimationFrame(() => c.classList.add('dragging'));
    });
    cols.addEventListener('dragend', () => {
      dragPid = null; line.remove();
      cols.querySelectorAll('.dragging, .bd-col.over').forEach(n => n.classList.remove('dragging', 'over', 'blocked'));
      st.dragging = false;
      if (st.redraw) { st.redraw = false; draw(); }
    });
    cols.addEventListener('dragover', e => {
      if (!dragPid) return;
      const list = e.target.closest('.bd-col') && e.target.closest('.bd-col').querySelector('.bd-list');
      if (!list) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cols.querySelectorAll('.bd-col.over').forEach(n => { if (n !== list.parentElement) n.classList.remove('over', 'blocked'); });
      // a project without members can't leave Review: show it on the column while dragging
      const dp = B.get(dragPid);
      const blocked = !!dp && !dp.members.length && B.needsMembers(list.dataset.col);
      list.parentElement.classList.add('over');
      list.parentElement.classList.toggle('blocked', blocked);
      const cards = Array.from(list.querySelectorAll('.bd-card:not(.dragging)'));
      const before = cards.find(n => { const r = n.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      if (before) list.insertBefore(line, before); else list.appendChild(line);
    });
    cols.addEventListener('drop', e => {
      if (!dragPid || !line.parentElement) return;
      e.preventDefault();
      const list = line.parentElement, col = list.dataset.col;
      let above = line.previousElementSibling; while (above && (!above.classList.contains('bd-card') || above.classList.contains('dragging'))) above = above.previousElementSibling;
      let below = line.nextElementSibling; while (below && (!below.classList.contains('bd-card') || below.classList.contains('dragging'))) below = below.nextElementSibling;
      const pa = above && B.get(above.dataset.pid), pb = below && B.get(below.dataset.pid);
      const pid = dragPid, p = B.get(pid);
      // dropped right next to where it already is: nothing to save
      const besideSelf = [line.previousElementSibling, line.nextElementSibling].some(n => n && n.dataset && n.dataset.pid === pid);
      line.remove();
      if (!p || (p.col === col && besideSelf)) return;
      const order = B.orderBetween(pa ? pa.order : null, pb ? pb.order : null);
      B.move(pid, col, order).then(() => { if (p.col !== col) UI.toast(`${p.number} moved to ${B.colName(col)}`, 'ok'); }).catch(ex => UI.toast(ex.message, 'error'));
    });
  }

  /* ================= project dialog ================= */

  /** Admins: create or edit. Everyone else: read-only details. */
  V.projectDialog = function (pid, col) {
    const p = pid ? B.get(pid) : null;
    if (pid && !p) { UI.toast('That project was deleted.'); return; }
    const team = p ? p.team : st.team;
    if (!B.canEdit(team) || (p && (p.approved || B.isPending(p)))) return viewDialog(p);
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const num = h('input', { class: 'input bd-num-input', id: 'bd-num', maxlength: '40', placeholder: 'e.g. 380-1234-00', value: p ? p.number : '', autofocus: true, required: true, 'aria-required': 'true' });
    num.addEventListener('input', () => num.classList.remove('bd-missing'));
    const pname = h('input', { class: 'input', id: 'bd-name', maxlength: '80', placeholder: 'e.g. Tokyo branch inventory', value: p ? p.name : '' });
    const labelChoices = B.labelsFor(team);
    let prio = p ? p.prio : 2, label = p && labelChoices.some(l => l.id === p.label) ? p.label : '';
    const prioSeg = h('div', { class: 'bd-seg', role: 'radiogroup', 'aria-label': 'Priority' });
    const drawPrio = () => UI.set(prioSeg, [1, 2, 3].map(v => h('button', { type: 'button', role: 'radio', 'aria-checked': String(prio === v), onclick: () => { prio = v; drawPrio(); } }, h('span', { class: 'bd-pdot bd-p' + v }), B.PRIOS[v])));
    drawPrio();
    const labelSeg = h('div', { class: 'bd-seg', role: 'radiogroup', 'aria-label': 'Label' });
    const drawLabel = () => UI.set(labelSeg, labelChoices.map(l => h('button', { type: 'button', role: 'radio', 'aria-checked': String(label === l.id), onclick: () => { label = l.id; labelSeg.classList.remove('bd-missing'); drawLabel(); } }, l.id !== 'none' ? h('span', { class: 'bd-ldot bd-lab-' + l.id }) : null, l.name)));
    labelSeg.setAttribute('aria-required', 'true');
    drawLabel();
    const picker = memberPicker(p ? p.members : [], team);
    let status = p ? p.col : (col || 'review');
    const seg = h('div', { class: 'bd-seg', role: 'radiogroup', 'aria-label': 'Status' });
    const memReq = h('span', { class: 'bd-req', 'aria-hidden': 'true' }, ' *');
    const memHint = h('div', { class: 'hint bd-mem-opt' });
    const drawSeg = () => {
      UI.set(seg, B.COLS.map(c => h('button', { type: 'button', role: 'radio', 'aria-checked': String(status === c.id), onclick: () => { status = c.id; drawSeg(); } }, h('span', { class: 'bd-dot bd-c-' + c.id }), c.name)));
      const need = B.needsMembers(status);
      memReq.hidden = !need;
      memHint.textContent = need ? '' : 'Optional while it’s in Review. Required before it moves to In progress.';
      memHint.hidden = need;
    };
    drawSeg();
    const pctOut = h('output', { class: 'bd-pct-out', for: 'bd-pct' }, (p ? p.pct : 0) + '%');
    const pct = h('input', { type: 'range', id: 'bd-pct', min: '0', max: '100', step: '5', value: String(p ? p.pct : 0), class: 'bd-range' });
    const syncPct = () => { pctOut.textContent = pct.value + '%'; pct.style.setProperty('--v', pct.value + '%'); };
    pct.addEventListener('input', syncPct); syncPct();
    const due = h('input', { class: 'input', type: 'date', id: 'bd-due', value: p ? p.deadline : '' });
    const sups = B.superiors(team);
    const by = h('select', { class: 'select input', id: 'bd-by' }, sups.map(u => h('option', { value: u.id, selected: (p ? p.by : meId()) === u.id }, u.name + (A.roleLabel(u.id) === 'Super admin' ? ' (super admin)' : ''))));
    if (p && !sups.some(u => u.id === p.by)) by.appendChild(h('option', { value: p.by, selected: true }, A.name(p.by) + ' (not an admin of this group)'));

    const save = h('button', { class: 'btn btn-primary' }, icon('check'), p ? 'Save changes' : 'Create project');
    save.addEventListener('click', () => UI.busy(save, null, async () => {
      // point at what's missing before the save is refused
      if (!num.value.trim()) { num.classList.add('bd-missing'); num.focus(); }
      if (!label) labelSeg.classList.add('bd-missing');
      const f = { number: num.value, name: pname.value, prio, label, members: picker.value(), col: status, pct: Number(pct.value), deadline: due.value, by: by.value };
      if (p) await B.update(p.pid, f); else await B.create(Object.assign(f, { team }));
      m.close();
      UI.toast(p ? `${f.number.trim()} saved` : !f.members.length ? `${f.number.trim()} added to Review. Assign members before it moves on.` : `${f.number.trim()} added. ${f.members.length === 1 ? A.name(f.members[0]) + ' was' : f.members.length + ' members were'} notified.`, 'ok');
    }, err));
    const del = p ? h('button', { class: 'btn btn-danger-ghost', onclick: async () => {
      if (!(await UI.confirm({ title: `Delete ${p.number}?`, text: 'It disappears from the board for everyone. Its history is kept in the data folder.', ok: 'Delete project', danger: true }))) return;
      try { await B.remove(p.pid); m.close(); UI.toast(`${p.number} deleted`, 'ok'); } catch (ex) { UI.toast(ex.message, 'error'); }
    } }, icon('trash'), 'Delete') : null;
    const approve = p && B.canApprove(p) ? h('button', { class: 'btn bd-approve-btn', onclick: () => { m.close(); V.approveDialog(p.pid); } }, icon('check'), 'Approve')
      : p && B.canComplete(p) ? h('button', { class: 'btn bd-approve-btn', onclick: () => { m.close(); V.completeDialog(p.pid); } }, icon('check'), 'Confirm complete') : null;

    const m = UI.modal({ title: p ? `Project ${p.number}` : `New project · ${A.teamName(team)}`, cls: 'mid bd-dlg', body: [err,
      h('div', { class: 'bd-two' },
        h('div', { class: 'field' }, h('label', { for: 'bd-num' }, 'Project number', h('span', { class: 'bd-req', 'aria-hidden': 'true' }, ' *')), num),
        h('div', { class: 'field' }, h('label', { for: 'bd-name' }, 'Project name'), pname)),
      h('div', { class: 'bd-two' },
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Priority'), prioSeg),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Label', h('span', { class: 'bd-req', 'aria-hidden': 'true' }, ' *')), labelSeg)),
      h('div', { class: 'field' }, h('label', { for: picker.inputId }, 'Members', memReq), picker.el, memHint,
        h('div', { class: 'hint' }, `Type @ and a name from ${A.teamName(team)}. Only people in this group can be on its board. Each member gets a board notification when they’re assigned, and again when the project moves to Checking or Done.`)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Status'), seg),
      h('div', { class: 'field' }, h('label', { for: 'bd-pct' }, 'Progress'), h('div', { class: 'bd-range-row' }, pct, pctOut)),
      h('div', { class: 'bd-two' },
        h('div', { class: 'field' }, h('label', { for: 'bd-due' }, 'Deadline'), due),
        h('div', { class: 'field' }, h('label', { for: 'bd-by' }, 'Assigned by (superior)'), by)),
      p ? historyBlock(p.pid) : null],
    foot: [del, h('span', { style: { flex: 1 } }), h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), approve, save] });
    num.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pname.focus(); } });
    pname.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); picker.focus(); } });
  };

  function viewDialog(p) {
    if (!p) return;
    const dl = deadlineInfo(p);
    const person = id => h('button', { class: 'bd-person', onclick: () => st.hooks.profile(id) }, UI.avatar(A.users.get(id), 28), h('span', null, A.name(id) + (id === meId() ? ' (you)' : '')));
    const vm = UI.modal({ title: `Project ${p.number}`, cls: 'mid bd-dlg', body: [
      p.name ? h('div', { class: 'bd-view-name' }, p.name) : null,
      h('div', { class: 'bd-view-grid' },
        h('span', { class: 'label' }, 'Priority'), h('span', null, prioTag(p.prio, true)),
        h('span', { class: 'label' }, 'Label'), h('span', null, p.label && p.label !== 'none' ? h('span', { class: 'bd-label bd-lab-' + p.label }, B.labelName(p.label)) : h('span', { class: 'muted' }, 'None')),
        h('span', { class: 'label' }, 'Status'), h('span', null, h('span', { class: 'bd-status bd-c-' + p.col }, h('span', { class: 'bd-dot' }), B.colName(p.col))),
        h('span', { class: 'label' }, 'Progress'), progressBar(p.pct, p.col),
        h('span', { class: 'label' }, 'Deadline'), h('span', { class: dl ? 'bd-due ' + dl.tone : 'muted' }, dl ? [icon('calendar'), dl.text] : 'No deadline'),
        h('span', { class: 'label' }, 'Assigned by'), h('span', null, person(p.by)),
        h('span', { class: 'label' }, 'Members'), p.members.length ? h('div', { class: 'bd-people' }, p.members.map(person)) : h('span', { class: 'muted' }, 'Not assigned yet'),
        p.from ? [h('span', { class: 'label' }, 'Came from'), h('span', null, `${A.teamName(p.from.team)} · approved by `, person(p.createdBy))] : null,
        p.approved ? [h('span', { class: 'label' }, 'Approved by'), h('span', { class: 'bd-approved-cell' }, person(p.approved.by), h('span', { class: 'muted' }, ' ' + U.formatDateTime(p.approved.ts)))] : null),
      h('p', { class: 'muted', style: { fontSize: '13px' } }, p.approved ? `Approved projects are locked. It was sent to the ${A.teamName(B.handoffTo(p.team))} board and leaves this board once one of its admins receives it.`
        : B.isPending(p) ? `Sent from ${A.teamName(p.from.team)}. An admin of ${A.teamName(p.team)} receives it, then assigns the members.`
        : 'Only admins can change projects. Ask ' + A.name(p.by) + ' if something needs updating.'),
      B.canReceive(p) ? h('button', { class: 'btn btn-primary', onclick: e => { const b = e.currentTarget; vm.close(); receive(b, p.pid); } }, icon('download'), `Receive ${p.number}`) : null,
      B.needsResend(p) ? h('button', { class: 'btn', onclick: e => UI.busy(e.currentTarget, null, async () => { await B.resendHandoff(p.pid); UI.toast('Sent', 'ok'); }) }, icon('refresh'), `Send to ${A.teamName(B.handoffTo(p.team))} again`) : null,
      historyBlock(p.pid)] });
  }

  /** PICKUP admin: approve a Done project. It's locked here and goes to the INPUT board's Review, unassigned. */
  V.approveDialog = function (pid) {
    const p = B.get(pid);
    if (!B.canApprove(p)) { UI.toast(p && p.approved ? `Already approved by ${A.name(p.approved.by)}.` : 'This project can’t be approved right now.', 'error'); return; }
    const to = A.teamName(B.handoffTo(p.team));
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const ok = h('button', { class: 'btn btn-primary' }, icon('check'), `Approve and send to ${to}`);
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      await B.approve(pid);
      m.close();
      UI.toast(`${p.number} approved and sent to ${to}. It leaves this board once they receive it.`, 'ok');
    }, err));
    const m = UI.modal({ title: `Approve ${p.number}?`, cls: 'mid', body: [err,
      h('div', { class: 'bd-approve-sum' },
        h('div', { class: 'bd-num' }, p.number), p.name ? h('div', { class: 'bd-name' }, p.name) : null,
        h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' } }, `Done · ${p.pct}% · ${p.members.map(A.name).join(', ')}`)),
      h('ul', { class: 'bd-approve-list' },
        h('li', null, 'You’re approving it as ', h('b', null, A.name(meId())), '. Your name and today’s date are saved on it.'),
        h('li', null, `It stays here in Done, greyed out and locked, until an admin of ${to} clicks Receive. Then it leaves this board and you’re told who received it.`),
        h('li', null, 'It appears on the ', h('b', null, to), ' board in ', h('b', null, 'Review'), ', with the same number, name, priority and deadline, labeled Input and at 0%. Its admins get a board notification.'),
        h('li', null, `${p.members.map(A.name).join(', ')} ${p.members.length === 1 ? 'is' : 'are'} told it was approved.`))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  };

  /** Last board (INPUT): confirm a Done project. It leaves the board and goes to History. */
  V.completeDialog = function (pid) {
    const p = B.get(pid);
    if (!B.canComplete(p)) { UI.toast('This project can’t be confirmed right now.', 'error'); return; }
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const ok = h('button', { class: 'btn btn-primary' }, icon('check'), 'Confirm complete');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      await B.complete(pid);
      m.close();
      UI.toast(`${p.number} is complete. Find it in Board notifications → History.`, 'ok');
    }, err));
    const told = [p.members.length ? 'its members' : null, p.from ? `${A.teamName(p.from.team)}’s admins and members` : null].filter(Boolean).join(' and ');
    const m = UI.modal({ title: `Confirm ${p.number} is complete?`, cls: 'mid', body: [err,
      h('div', { class: 'bd-approve-sum' },
        h('div', { class: 'bd-num' }, p.number), p.name ? h('div', { class: 'bd-name' }, p.name) : null,
        h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' } }, `Done · ${p.pct}% · ${p.members.map(A.name).join(', ')}`)),
      h('ul', { class: 'bd-approve-list' },
        h('li', null, 'This is the last step. The project leaves the board for everyone.'),
        h('li', null, 'It goes to ', h('b', null, 'History'), ' in the board notifications (the second bell), with who did what on ' + (p.from ? 'both boards.' : 'this board.')),
        h('li', null, 'You’re confirming it as ', h('b', null, A.name(meId())), '.' + (told ? ` ${told[0].toUpperCase() + told.slice(1)} get a notification.` : '')))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
  };

  function historyBlock(pid) {
    const list = B.history(pid).slice(0, 12);
    if (!list.length) return null;
    return h('details', { class: 'bd-history' }, h('summary', null, 'History'),
      h('ol', null, list.map(x => h('li', null, h('b', null, A.name(x.userId)), ' ', x.text, h('span', { class: 'muted' }, ' · ' + U.formatDateTime(x.ts))))));
  }

  /** Chips for chosen people, plus an @-typeahead over everyone in the workspace. */
  function memberPicker(initial, team) {
    const chosen = initial.filter(id => A.users.has(id));
    const inputId = 'bd-mem-' + U.rand(4);
    const input = h('input', { class: 'bd-mem-input', id: inputId, placeholder: chosen.length ? 'Add another: @name' : '@name', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list' });
    const chips = h('div', { class: 'bd-chips' });
    const menu = h('div', { class: 'bd-menu', role: 'listbox', hidden: true });
    let hits = [], idx = 0;
    const box = h('div', { class: 'bd-picker', onclick: e => { if (e.target === box || e.target === chips) input.focus(); } }, chips, input, menu);
    function drawChips() {
      UI.set(chips, chosen.map(id => h('span', { class: 'bd-chip' }, UI.avatar(A.users.get(id), 20), A.name(id),
        h('button', { type: 'button', 'aria-label': 'Remove ' + A.name(id), onclick: () => { chosen.splice(chosen.indexOf(id), 1); drawChips(); input.focus(); } }, icon('x')))), input);
      input.placeholder = chosen.length ? 'Add another: @name' : '@name';
    }
    function search() {
      const q = input.value.replace(/^@/, '').trim().toLowerCase();
      if (!input.value.trim()) { close(); return; }
      hits = B.assignable(team).filter(u => !chosen.includes(u.id) && (!q || u.name.toLowerCase().includes(q))).slice(0, 7);
      idx = 0; drawMenu();
    }
    function drawMenu() {
      menu.hidden = false; input.setAttribute('aria-expanded', 'true');
      UI.set(menu, hits.length ? hits.map((u, i) => h('div', { class: 'bd-opt' + (i === idx ? ' on' : ''), role: 'option', 'aria-selected': String(i === idx), onmousedown: e => { e.preventDefault(); pick(u.id); } },
        UI.avatar(u, 24), h('span', { class: 'nm' }, u.name), A.teamOf(u.id) ? h('span', { class: 'muted' }, A.teamName(A.teamOf(u.id))) : null))
        : h('div', { class: 'bd-opt none' }, 'No one with that name'));
    }
    function close() { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); }
    function pick(id) {
      if (chosen.length >= B.MAX_MEMBERS) { UI.toast(`A project can have up to ${B.MAX_MEMBERS} members.`, 'error'); return; }
      chosen.push(id); input.value = ''; close(); drawChips(); input.focus();
    }
    input.addEventListener('input', search);
    input.addEventListener('focus', () => { if (input.value.trim()) search(); });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && chosen.length) { chosen.pop(); drawChips(); return; }
      if (menu.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, hits.length - 1); drawMenu(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); drawMenu(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { if (hits[idx]) { e.preventDefault(); pick(hits[idx].id); } }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    drawChips();
    return { el: box, inputId, value: () => chosen.slice(), focus: () => input.focus() };
  }

  /* ================= board notifications (separate from chat) ================= */

  /** The second bell: board notifications, plus History (completed projects from the boards I can see). */
  V.notificationsDialog = function (opts = {}) {
    if (st.inbox) return;
    let tab = opts.tab || 'notes', open = opts.pid || null, q = '';
    const wasUnread = new Set(B.notifications().filter(B.isUnread).map(it => it.id));
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const tools = h('div', { class: 'row notif-tools' });
    const list = h('div', { class: 'notif-list', role: 'list' });
    const search = h('input', { class: 'input bd-hist-search', type: 'search', placeholder: 'Search number, name or person', 'aria-label': 'Search history' });
    search.addEventListener('input', () => { q = search.value.trim().toLowerCase(); drawList(); });
    const ICON_OF = { assigned: ['review', 'board'], handoff: ['progress', 'board'], approved: ['done', 'check'], received: ['done', 'check'], completed: ['done', 'check'] };
    function draw() {
      const n = B.completedList().length;
      UI.set(tabs,
        h('button', { role: 'tab', 'aria-selected': String(tab === 'notes'), onclick: () => { tab = 'notes'; draw(); } }, 'Notifications'),
        h('button', { role: 'tab', 'aria-selected': String(tab === 'history'), onclick: () => { tab = 'history'; draw(); setTimeout(() => search.focus(), 0); } }, 'History', n ? h('span', { class: 'tab-n grey' }, String(n)) : null));
      UI.set(tools, tab === 'history' ? search : h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Projects only. Chat notifications are under the other bell.'),
        h('span', { style: { flex: 1 } }),
        B.boards().length ? h('button', { class: 'btn btn-sm', onclick: () => { m.close(); st.hooks.openBoard(st.team && B.canSee(st.team) ? st.team : B.boards()[0].id); } }, icon('board'), 'Open board') : null);
      drawList();
    }
    function drawList() { if (tab === 'history') drawHistory(); else drawNotes(); }
    function drawNotes() {
      const items = B.notifications();
      UI.set(list, items.length ? items.map(it => {
        const d = B.describe(it);
        const p = B.get(it.pid);
        const unread = wasUnread.has(it.id) || B.isUnread(it);
        const [col, ic] = ICON_OF[it.type] || [it.type, 'check'];
        const now = p ? `Now in ${B.colName(p.col)} · ${p.pct}%` : B.getCompleted(it.pid) ? 'Complete · in History' : it.type === 'received' ? `On the ${A.teamName(it.team)} board` : 'Deleted from the board';
        return h('div', { class: 'notif-row' + (unread ? ' unread' : ''), role: 'listitem', tabindex: '0',
          onclick: () => go(it), onkeydown: e => { if (e.key === 'Enter' && e.target === e.currentTarget) go(it); } },
        h('span', { class: 'avatar ann-avatar bd-n-ic bd-c-' + col, style: { width: '36px', height: '36px' } }, icon(ic)),
        h('div', { class: 'notif-main' }, h('div', { class: 'notif-title' }, d.title), h('div', { class: 'notif-sub' }, d.sub), h('div', { class: 'bd-n-now' + (p ? '' : ' muted') }, now)),
        h('div', { class: 'notif-side' }, h('div', { class: 'notif-time', title: U.formatFull(it.ts) }, U.formatDateTime(it.ts)),
          unread ? h('span', { class: 'notif-dot', 'aria-label': 'Unread' }) : null));
      }) : h('div', { class: 'notif-empty' }, icon('check'), h('div', null, h('b', null, 'No board notifications.'),
        h('div', { class: 'muted' }, 'You’ll see new projects assigned to you here, and when your projects move to Checking or Done.'))));
    }
    function drawHistory() {
      const who = id => A.name(id).toLowerCase();
      const items = B.completedList().filter(p => !q || p.number.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
        || p.members.some(id => who(id).includes(q)) || (p.source && p.source.members.some(id => who(id).includes(q)))
        || who(p.completed.by).includes(q) || (p.received && who(p.received.by).includes(q)) || (p.source && p.source.approved && who(p.source.approved.by).includes(q)));
      if (!items.length) {
        UI.set(list, h('div', { class: 'notif-empty' }, icon('archive'), h('div', null, h('b', null, q ? 'Nothing matches.' : 'No completed projects yet.'),
          h('div', { class: 'muted' }, 'When an INPUT admin confirms a project in Done, it leaves the board and shows here, for both groups.'))));
        return;
      }
      UI.set(list, items.map(p => histRow(p)));
      if (open) { const el = list.querySelector(`[data-pid="${CSS.escape(open)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
    }
    function histRow(p) {
      const expanded = open === p.pid;
      const people = ids => ids.length ? ids.map(id => A.name(id) + (id === meId() ? ' (you)' : '')).join(', ') : '—';
      const step = (label, text, ts) => h('li', null, h('span', { class: 'bd-h-step' }, label), h('span', null, text), ts ? h('span', { class: 'muted' }, ' · ' + U.formatDateTime(ts)) : null);
      const steps = [];
      if (p.source) {
        steps.push(step(A.teamName(p.source.team), `Members: ${people(p.source.members)} · superior ${A.name(p.source.by)}`, p.source.created));
        if (p.source.approved) steps.push(step('Approved', A.name(p.source.approved.by), p.source.approved.ts));
        if (p.received) steps.push(step('Received', A.name(p.received.by), p.received.ts));
      }
      steps.push(step(A.teamName(p.team), `Members: ${people(p.members)} · superior ${A.name(p.by)}`, p.source ? null : p.created));
      steps.push(step('Completed', A.name(p.completed.by), p.completed.ts));
      return h('div', { class: 'bd-hist' + (expanded ? ' open' : ''), role: 'listitem', 'data-pid': p.pid },
        h('button', { class: 'bd-hist-head', 'aria-expanded': String(expanded), onclick: () => { open = expanded ? null : p.pid; drawHistory(); } },
          h('span', { class: 'avatar ann-avatar bd-n-ic bd-c-done', style: { width: '32px', height: '32px' } }, icon('check')),
          h('span', { class: 'bd-hist-main' },
            h('span', { class: 'bd-hist-title' }, h('b', null, p.number), p.name ? h('span', { class: 'muted' }, ' · ' + p.name) : null,
              p.label && p.label !== 'none' ? h('span', { class: 'bd-label bd-lab-' + p.label }, B.labelName(p.label)) : null),
            h('span', { class: 'bd-hist-sub' }, `Completed ${U.formatDateTime(p.completed.ts)} · confirmed by ${A.name(p.completed.by)}` + (p.source ? ` · from ${A.teamName(p.source.team)}` : ''))),
          icon(expanded ? 'x' : 'info')),
        expanded ? h('ol', { class: 'bd-hist-steps' }, steps) : null);
    }
    function go(it) {
      if (it.type === 'completed' || (!B.get(it.pid) && B.getCompleted(it.pid))) { tab = 'history'; open = it.pid; draw(); return; }
      m.close();
      const p = B.get(it.pid);
      if (it.type === 'received') { UI.toast(`${it.number} is on the ${A.teamName(it.team)} board now.`); return; }
      if (p && B.canSee(p.team)) st.hooks.openBoard(p.team);
      if (p) setTimeout(() => V.projectDialog(it.pid), 50); else UI.toast('That project was deleted.');
    }
    const unsub = B.events.on('change', draw);
    const m = UI.modal({ title: 'Board notifications', cls: 'mid notif-dlg', body: [tabs, tools, list],
      onClose: () => { st.inbox = null; unsub(); B.markAllRead(); } });
    st.inbox = m;
    draw();
    B.markAllRead();
  };

  SC.boardView = V;
})(typeof window !== 'undefined' ? window : globalThis);
