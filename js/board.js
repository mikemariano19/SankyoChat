/* Sankyo Chat — project board (kanban): Review → In progress → Checking → Done.
 *
 * Each group (PICKUP GROUP, INPUT GROUP) has its own board: a project's `team` says which.
 * People see their own group's board; the super admin sees every board. Admins manage their own group's
 * board, the super admin manages all of them. Nobody else can create, assign, move or edit projects.
 * Projects saved before boards were split have no `team`: they show on the board of the superior's group.
 * Like messages, every change is its own new file, so two admins never write the same file:
 *   data/board/<projectId>/<ts>_<userId>_<rand>.json
 * Each file is a signed, complete copy of the project at that moment: number, members, status, progress,
 * deadline, the superior who assigned it, and its place in the column. The newest valid file wins.
 * Every app ignores files whose signer wasn't allowed to manage boards at that time (A.canAt 'board.manage'), and
 * files signed by someone of another group (only the super admin, and custom roles whose board permission was set
 * to "all groups" at the time, work on every board), so nobody else can forge or move a project. A project never changes board. Deleting a project writes one more file with deleted = true.
 *
 * Hand-off (PICKUP → INPUT): when a PICKUP project is Done, a PICKUP admin approves it. That writes
 * `approved = {by, ts}` and `handoff = <new project id>` on the PICKUP project, which is then locked, and
 * creates the new project on the INPUT board in Review with `from = {pid, team}`, no members yet, label Input.
 * The new project's first file is the one write a PICKUP admin may make on the INPUT board, and every app
 * only accepts it if the PICKUP project really names it as its hand-off and the same admin approved it.
 *
 * Completion: INPUT's Done is the last step. An INPUT admin confirms it (`completed = {by, ts}`), and the
 * project leaves the board and goes to the History tab of the board notifications, which both groups see
 * for projects that passed through their board.
 *
 * Board notifications are separate from chat notifications. Each app works them out from the history:
 * "you were assigned a project", "your project moved to Checking", "your project is Done". Read-state is
 * boardRead in my presence file (js/sync.js), so it follows me to other PCs.
 * Saving also sets lastPost['board:all'] in the admin's presence file, so other apps re-read within seconds.
 * No DOM access; the UI listens to SC.board.events 'change'. */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  const U = SC.util, S = SC.store, C = SC.crypto, A = SC.account, Y = SC.sync;
  /** @namespace SC.board */
  const B = {};
  B.events = U.emitter();
  B.COLS = [
    { id: 'review', name: 'Review' },
    { id: 'progress', name: 'In progress' },
    { id: 'checking', name: 'Checking' },
    { id: 'done', name: 'Done' },
  ];
  const COL_IDS = B.COLS.map(c => c.id);
  B.colName = id => (B.COLS.find(c => c.id === id) || B.COLS[0]).name;
  /** Priority 1 = High, 2 = Normal, 3 = Low. */
  B.PRIOS = { 1: 'High', 2: 'Normal', 3: 'Low' };
  /** What kind of work the project is. Every project must have one, chosen from its board's list:
   *  PICKUP GROUP (t1): None, Pickup, Input. INPUT GROUP (t2): Input, Correction.
   *  'none' is a real choice (the admin decided there's no label), so nothing shows on the card. */
  B.LABELS = [{ id: 'none', name: 'None' }, { id: 'pickup', name: 'Pickup' }, { id: 'input', name: 'Input' }, { id: 'correction', name: 'Correction' }];
  B.labelName = id => (B.LABELS.find(l => l.id === id) || { name: '' }).name;
  const LABEL_IDS = B.LABELS.map(l => l.id);
  const BOARD_LABELS = { t1: ['none', 'pickup', 'input'], t2: ['input', 'correction'] };
  /** The labels an admin can choose on this group's board. */
  B.labelsFor = team => (BOARD_LABELS[team] || ['input', 'correction']).map(id => B.LABELS.find(l => l.id === id));
  /** Approving a Done project on this board sends it to that board's Review. */
  B.HANDOFF = { t1: 't2' };
  B.MAX_MEMBERS = 30;
  B.MAX_NOTE = 1000;
  const cleanNote = s => String(s || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  B.NOTE_DAYS = 30;
  const HINT = 'board:all';
  const DIR = 'board';
  const PID_RE = /^p_[a-z0-9]{8}$/;
  const UID_RE = /^[a-z0-9]{4}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** projectId → valid revisions, oldest first */
  const revs = new Map();
  /** `${pid}/${file}` already handled for good (valid, or never valid) */
  const done = new Set();
  /** projectId → current project (deleted ones left out) */
  B.projects = new Map();
  const notes = new Map();
  const popped = new Set();
  let hint = 0, timer = 0, unsub = [], ready = false, startTs = 0, busy = null;

  const me = () => A.me.id;
  const err = msg => new Error(msg);

  /* ================= reading ================= */

  /** Pull the fields out of a revision file, or null if they don't make sense. */
  function clean(raw) {
    const number = typeof raw.number === 'string' ? raw.number.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    if (!number) return null;
    const members = Array.isArray(raw.members) ? U.uniq(raw.members.filter(x => typeof x === 'string' && UID_RE.test(x))).slice(0, B.MAX_MEMBERS) : [];
    return {
      number, members,
      col: COL_IDS.includes(raw.col) ? raw.col : 'review',
      pct: Number.isFinite(raw.pct) ? Math.max(0, Math.min(100, Math.round(raw.pct))) : 0,
      deadline: typeof raw.deadline === 'string' && DATE_RE.test(raw.deadline) ? raw.deadline : '',
      by: typeof raw.by === 'string' && UID_RE.test(raw.by) ? raw.by : raw.userId,
      order: Number.isFinite(raw.order) ? raw.order : 0,
      deleted: raw.deleted === true,
      name: typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
      note: typeof raw.note === 'string' ? cleanNote(raw.note).slice(0, B.MAX_NOTE) : '',
      prio: [1, 2, 3].includes(raw.prio) ? raw.prio : 2,
      label: LABEL_IDS.includes(raw.label) ? raw.label : '',
      team: typeof raw.team === 'string' && /^[a-z0-9]{1,8}$/.test(raw.team) ? raw.team : '',
      approved: raw.approved && UID_RE.test(raw.approved.by) && Number.isFinite(raw.approved.ts) ? { by: raw.approved.by, ts: raw.approved.ts } : null,
      handoff: typeof raw.handoff === 'string' && PID_RE.test(raw.handoff) ? raw.handoff : '',
      from: raw.from && PID_RE.test(raw.from.pid) && /^[a-z0-9]{1,8}$/.test(raw.from.team) ? { pid: raw.from.pid, team: raw.from.team } : null,
      received: raw.received && UID_RE.test(raw.received.by) && Number.isFinite(raw.received.ts) ? { by: raw.received.by, ts: raw.received.ts } : null,
      completed: raw.completed && UID_RE.test(raw.completed.by) && Number.isFinite(raw.completed.ts) ? { by: raw.completed.by, ts: raw.completed.ts } : null,
    };
  }

  /** May the author of this file write on this group's board? (The board.manage permission itself is checked per file
   *  in readProject.) Super admin: every board. Admins and "own group" roles: their own group's board. Custom roles
   *  with board.manage set to "all groups" at the time of the file: every board. */
  const allowedOn = (r, team) => !!A.ws && !!r && (r.userId === A.ws.adminId || (!!team && A.teamOf(r.userId) === team) ||
    (!!team && A.roleScopeAt(r.userId, r.kid, r.ts, 'board.manage') === 'all'));
  /** pid → the revisions that count, after the group rules; the project's board is fixed by its first file. */
  const valid = new Map();

  async function readProject(pid) {
    const names = (await S.list(`${DIR}/${pid}`, 'file')).filter(n => U.MSG_RE.test(n) && !n.includes('.ev.'));
    let changed = false;
    for (const n of names) {
      const key = pid + '/' + n;
      if (done.has(key)) continue;
      const pn = U.parseMsgName(n);
      if (!pn) { done.add(key); continue; }
      const raw = await S.readJSON(`${DIR}/${pid}/${n}`);
      if (!raw) continue; // unreadable right now: try again next time
      const id = n.slice(0, -5);
      const shapeOk = raw.type === 'board' && raw.project === pid && raw.id === id && raw.userId === pn.userId && raw.ts === pn.ts;
      if (!shapeOk || !(await Y.verifyRaw(raw))) { done.add(key); continue; }
      // signer not known as an admin here (yet), e.g. this PC hasn't read the new workspace.json: re-check later
      if (!A.canAt(raw.userId, raw.kid, raw.ts, 'board.manage')) continue;
      const f = clean(raw);
      done.add(key);
      if (!f) continue;
      let list = revs.get(pid);
      if (!list) revs.set(pid, list = []);
      list.push(Object.assign({ id, pid, userId: raw.userId, kid: raw.kid, ts: raw.ts }, f));
      changed = true;
    }
    if (changed) revs.get(pid).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    return changed;
  }

  /** Apply the group rules to one project's files. `source` checks a hand-off against its PICKUP project. */
  function filterRevs(list, source) {
    const first = list[0];
    if (!first) return [];
    // older projects have no group: they belong to the board of the superior's (or creator's) group
    const team = first.team || A.teamOf(first.by) || A.teamOf(first.userId) || ((A.teamList()[0] || {}).id || '');
    let ok;
    if (first.from) {
      // a hand-off: only valid if the PICKUP project names this one and the same admin approved it
      const src = source(first.from.pid);
      const appr = src && src.find(r => r.approved && r.handoff === first.pid);
      ok = !!appr && B.HANDOFF[src.team] === team && appr.approved.by === first.userId && allowedOn(first, src.team);
    } else ok = allowedOn(first, team);
    if (!ok) return [];
    const out = [Object.assign({}, first, { team })];
    // a hand-off waits until an admin of this board receives it; until then nothing else counts
    let got = first.from ? null : true;
    for (const r of list.slice(1)) {
      const last = out[out.length - 1];
      if (last.approved || last.completed) break; // approved and completed projects are locked
      if (r.team && r.team !== team) continue;
      if (!allowedOn(r, team)) continue;
      if (r.approved && (last.col !== 'done' || r.col !== 'done' || !B.HANDOFF[team])) continue;
      if (!got) { if (!r.received || r.received.by !== r.userId) continue; got = r.received; }
      // completing only counts on the last board (one that doesn't hand off), from Done, by whoever saved it
      if (r.completed && (last.col !== 'done' || r.col !== 'done' || B.HANDOFF[team] || r.completed.by !== r.userId)) continue;
      out.push(Object.assign({}, r, { team }));
    }
    out.team = team;
    out.received = first.from ? got : null;
    return out;
  }

  /** Completed projects for the History tab, newest first (everyone's; B.completedList filters by board). */
  let finished = [];
  function rebuild() {
    B.projects.clear();
    valid.clear();
    finished = [];
    // projects that don't come from a hand-off first, so hand-offs can be checked against them
    const order = Array.from(revs.keys()).sort((a, b) => ((revs.get(a)[0] || {}).from ? 1 : 0) - ((revs.get(b)[0] || {}).from ? 1 : 0));
    for (const pid of order) {
      const list = filterRevs(revs.get(pid), id => valid.get(id));
      valid.set(pid, list);
      const cur = list[list.length - 1];
      if (!cur || cur.deleted) continue;
      const first = list[0];
      if (cur.completed) {
        // gone from the board: keep the whole story for History
        const src = first.from ? (valid.get(first.from.pid) || []) : [];
        const srcLast = src[src.length - 1];
        const srcAppr = src.find(r => r.approved && r.handoff === pid);
        finished.push(Object.assign({}, cur, { created: first.ts, createdBy: first.userId, from: first.from, received: list.received || null,
          source: first.from && srcLast ? { team: src.team, members: srcLast.members, by: srcLast.by, label: srcLast.label, created: src[0].ts, approved: srcAppr ? srcAppr.approved : null } : null }));
        continue;
      }
      B.projects.set(pid, Object.assign({}, cur, { created: first.ts, createdBy: first.userId, updated: cur.ts, updatedBy: cur.userId, from: first.from, received: list.received || null }));
    }
    // once the next board has received a hand-off, the approved project leaves the PICKUP board
    for (const [pid, p] of Array.from(B.projects)) {
      if (!p.approved || !p.handoff) continue;
      const to = valid.get(p.handoff);
      if (to && to.received) B.projects.delete(pid);
    }
    finished.sort((a, b) => b.completed.ts - a.completed.ts);
  }

  /** History: projects that passed through a board I can see (PICKUP sees the ones it sent; INPUT all of its own). */
  B.completedList = () => finished.filter(p => B.canSee(p.team) || (p.from && B.canSee(p.from.team)));
  B.getCompleted = pid => finished.find(p => p.pid === pid) || null;

  /** Re-read the board folder (one read at a time; overlapping calls share it). */
  B.refresh = function () {
    if (!busy) busy = (async () => {
      if (!A.me || !Y.connected) return false;
      const pids = (await S.list(DIR, 'directory')).filter(n => PID_RE.test(n));
      let changed = false;
      for (const pid of pids) { try { if (await readProject(pid)) changed = true; } catch (e) { console.warn('board', pid, e); } }
      if (changed) { rebuild(); derive(); B.events.emit('change'); }
      return changed;
    })().finally(() => { busy = null; });
    return busy;
  };

  /* ================= queries ================= */

  /** The boards I can open: my own group's, or every group's for the super admin. */
  B.boards = () => (!A.me ? [] : A.teamList().filter(t => A.isOwner() || A.teamOf(me()) === t.id || (A.can('board.manage') && !A.ownGroupOnly('board.manage'))));
  B.canSee = team => B.boards().some(t => t.id === team);
  /** Admins manage their own group's board; the super admin manages every board. */
  B.canEdit = team => !!A.me && (A.isOwner() || (!!team && A.can('board.manage', { team })));
  B.get = pid => B.projects.get(pid) || null;
  B.inTeam = team => Array.from(B.projects.values()).filter(p => p.team === team);
  B.inCol = (col, team) => B.inTeam(team).filter(p => p.col === col).sort((a, b) => a.order - b.order || a.created - b.created);
  B.isMine = p => !!p && p.members.includes(me());
  B.mineCount = team => B.inTeam(team).filter(p => B.isMine(p) && p.col !== 'done').length;
  B.openCount = team => B.inTeam(team).filter(p => p.col !== 'done').length;
  /** People who can be put on a project in this group: its members, plus admins and the super admin. */
  /** A board belongs to its group only: just the people accepted into that group (its admins included),
   *  plus the super admin, who sees every board. Nobody from the other group. */
  B.inGroup = (uid, team) => !!team && (A.teamOf(uid) === team || (!!A.ws && uid === A.ws.adminId));
  B.assignable = team => A.activeUsers().filter(u => B.inGroup(u.id, team));
  /** Admins and the super admin: the people who can be named as the superior. */
  B.superiors = team => A.activeUsers().filter(u => (A.isUserAdmin(u.id) || A.userCan(u.id, 'board.manage', { team })) && B.inGroup(u.id, team));
  /** Days until the deadline (negative = late), or null. */
  B.daysLeft = function (deadline) {
    if (!deadline) return null;
    const d = new Date(deadline + 'T00:00:00');
    if (isNaN(d)) return null;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / U.DAY_MS);
  };

  /** What changed in each revision, newest first, for the project's history list. */
  B.history = function (pid) {
    const list = valid.get(pid) || [];
    const out = [];
    let prev = null;
    for (const r of list) {
      const what = [];
      if (!prev) what.push(r.from ? `approved it on ${A.teamName(r.from.team) || 'the other board'} and sent it here to ${B.colName(r.col)}` : `created it in ${B.colName(r.col)}`);
      else if (r.approved) what.push(`approved it and sent it to ${A.teamName(B.HANDOFF[r.team]) || 'the next board'}`);
      else if (r.received && !prev.received && list.received === r.received) what.push('received it');
      else if (r.completed) what.push('confirmed it complete');
      else {
        if (r.deleted && !prev.deleted) what.push('deleted it');
        if (r.number !== prev.number) what.push(`renamed it to ${r.number}`);
        if (r.col !== prev.col) what.push(`moved it to ${B.colName(r.col)}`);
        const added = r.members.filter(x => !prev.members.includes(x)), gone = prev.members.filter(x => !r.members.includes(x));
        if (added.length) what.push('assigned ' + added.map(A.name).join(', '));
        if (gone.length) what.push('removed ' + gone.map(A.name).join(', '));
        if (r.pct !== prev.pct) what.push(`set progress to ${r.pct}%`);
        if (r.deadline !== prev.deadline) what.push(r.deadline ? `set the deadline to ${r.deadline}` : 'cleared the deadline');
        if (r.by !== prev.by) what.push(`set the superior to ${A.name(r.by)}`);
        if (r.name !== prev.name) what.push(r.name ? `named it “${r.name}”` : 'cleared the project name');
        if (r.prio !== prev.prio) what.push(`set priority to ${B.PRIOS[r.prio]}`);
        if (r.label !== prev.label) what.push(r.label ? `labeled it ${B.labelName(r.label)}` : 'removed the label');
        if (r.note !== prev.note) what.push(!r.note ? 'removed the note' : prev.note ? 'edited the note' : 'added a note');
      }
      if (what.length) out.push({ ts: r.ts, userId: r.userId, text: what.join(', ') });
      prev = r;
    }
    return out.reverse();
  };

  /* ================= saving (admins only) ================= */

  async function write(pid, f, handoff) {
    // the one exception: a PICKUP admin creating the hand-off copy on the INPUT board (B.approve)
    if (!handoff && !B.canEdit(f.team)) throw err(`Only admins of ${A.teamName(f.team) || 'this group'} can change its board.`);
    if (!Y.connected) throw err('Lost access to the shared folder. Check the connection and try again.');
    const ts = Math.max(Date.now(), ((revs.get(pid) || []).slice(-1)[0] || { ts: 0 }).ts + 1);
    const id = `${ts}_${me()}_${U.rand(4)}`;
    const raw = Object.assign({ v: 1, type: 'board', project: pid, id, userId: me(), ts, kid: A.me.signFp }, f);
    raw.sig = await C.sign(A.me.priv.sign, raw);
    await S.writeJSON(`${DIR}/${pid}/${id}.json`, raw);
    done.add(`${pid}/${id}.json`);
    let list = revs.get(pid);
    if (!list) revs.set(pid, list = []);
    list.push(Object.assign({ id, pid, userId: me(), ts }, clean(raw)));
    rebuild(); derive();
    hint = Math.max(hint, ts);
    Y.noteMyPost(HINT, ts);
    B.events.emit('change');
    return pid;
  }

  /** Members can wait while a project is in Review; from In progress on, it needs at least one. */
  B.needsMembers = col => col !== 'review';
  const noMembersErr = col => err(`Assign at least one member before it goes to ${B.colName(col)}. Projects in Review can wait.`);
  function checkFields(f, pid, team, col) {
    const number = String(f.number || '').replace(/\s+/g, ' ').trim();
    if (!number) throw err('Enter the project number.');
    if (number.length > 40) throw err('Project numbers can be at most 40 characters.');
    const dup = B.inTeam(team).find(p => p.pid !== pid && p.number.toLowerCase() === number.toLowerCase());
    if (dup) throw err(`Project ${dup.number} is already on this board (in ${B.colName(dup.col)}).`);
    const members = U.uniq((f.members || []).filter(x => UID_RE.test(x) && !A.isRemoved(x)));
    if (!members.length && B.needsMembers(col)) throw noMembersErr(col);
    const outside = members.filter(x => !B.inGroup(x, team));
    if (outside.length) throw err(`${outside.map(A.name).join(', ')} ${outside.length === 1 ? 'isn’t' : 'aren’t'} in ${A.teamName(team)}. Only people in this group can be on its board.`);
    if (members.length > B.MAX_MEMBERS) throw err(`A project can have up to ${B.MAX_MEMBERS} members.`);
    const pct = Math.max(0, Math.min(100, Math.round(Number(f.pct) || 0)));
    const deadline = DATE_RE.test(f.deadline || '') ? f.deadline : '';
    const by = UID_RE.test(f.by || '') ? f.by : me();
    if (!B.inGroup(by, team)) throw err(`The superior must be an admin of ${A.teamName(team)} or the super admin.`);
    const name = String(f.name || '').replace(/\s+/g, ' ').trim();
    if (name.length > 80) throw err('Project names can be at most 80 characters.');
    const note = cleanNote(f.note);
    if (note.length > B.MAX_NOTE) throw err(`Notes can be at most ${B.MAX_NOTE} characters.`);
    const prio = [1, 2, 3].includes(Number(f.prio)) ? Number(f.prio) : 2;
    const allowed = B.labelsFor(team);
    if (!allowed.some(l => l.id === f.label)) throw err(`Choose a label: ${allowed.map(l => l.name).join(', ').replace(/, ([^,]*)$/, ' or $1')}.`);
    const label = f.label;
    return { number, members, pct, deadline, by, name, note, prio, label, team };
  }
  const endOf = (col, team) => { const l = B.inCol(col, team); return l.length ? l[l.length - 1].order + 1024 : 1024; };

  B.create = async function (f) {
    if (!A.teamList().some(t => t.id === f.team)) throw err('Pick which group’s board this project goes on.');
    const col = COL_IDS.includes(f.col) ? f.col : 'review';
    const v = checkFields(f, null, f.team, col);
    return write('p_' + U.rand(8), Object.assign(v, { col, order: endOf(col, f.team), deleted: false }));
  };
  const locked = p => {
    if (p.completed) throw err(`${p.number} is complete. It’s in History now.`);
    if (p.approved) throw err(`${p.number} was approved by ${A.name(p.approved.by)}, so it can’t be changed.`);
    if (B.isPending(p)) throw err(`Receive ${p.number} first. Then you can assign members and move it.`);
  };
  B.update = async function (pid, f) {
    const p = B.get(pid);
    if (!p) throw err('That project was deleted.');
    locked(p);
    // fields left out keep their current value
    f = Object.assign({}, f);
    for (const k of ['name', 'note', 'prio', 'label']) if (f[k] === undefined) f[k] = p[k];
    const col = COL_IDS.includes(f.col) ? f.col : p.col;
    const v = checkFields(f, pid, p.team, col);
    return write(pid, Object.assign(v, { col, order: col === p.col ? p.order : endOf(col, p.team), deleted: false }));
  };
  /** Drag and drop: a new column and/or place. */
  B.move = async function (pid, col, order) {
    const p = B.get(pid);
    if (!p) throw err('That project was deleted.');
    locked(p);
    if (!p.members.length && B.needsMembers(col)) throw noMembersErr(col);
    const { number, members, pct, deadline, by, name, note, prio, label, team } = p;
    return write(pid, { number, members, pct, deadline, by, name, note, prio, label, team, col, order, deleted: false });
  };
  B.remove = async function (pid) {
    const p = B.get(pid);
    if (!p) return Promise.resolve();
    locked(p);
    const { number, members, pct, deadline, by, name, note, prio, label, team, col, order } = p;
    return write(pid, { number, members, pct, deadline, by, name, note, prio, label, team, col, order, deleted: true });
  };

  /* ---- approval and hand-off (PICKUP → INPUT) ---- */
  /** The board an approved project goes to, or '' if this board doesn't hand off. */
  B.handoffTo = team => B.HANDOFF[team] || '';
  B.canApprove = p => !!p && !p.approved && p.col === 'done' && !!B.handoffTo(p.team) && B.canEdit(p.team);
  /** Approved, but the copy on the next board is missing (the second save failed): offer to send it again. */
  B.needsResend = p => !!p && !!p.approved && !!p.handoff && p.approved.by === me() && !B.get(p.handoff) && !(valid.get(p.handoff) || []).length;

  async function sendHandoff(p) {
    const to = B.handoffTo(p.team);
    const { number, name, note, prio, deadline } = p;
    return write(p.handoff, { number, name, note, prio, deadline, members: [], pct: 0, by: me(), label: 'input', team: to,
      col: 'review', order: endOf('review', to), deleted: false, from: { pid: p.pid, team: p.team } }, true);
  }
  /** Approve a Done project: lock it here and put a copy in the next board's Review, unassigned. */
  B.approve = async function (pid) {
    const p = B.get(pid);
    if (!p) throw err('That project was deleted.');
    if (p.approved) throw err(`${p.number} was already approved by ${A.name(p.approved.by)}.`);
    if (p.col !== 'done') throw err('Only projects in Done can be approved.');
    const to = B.handoffTo(p.team);
    if (!to) throw err('Projects on this board aren’t sent anywhere.');
    if (!B.canEdit(p.team)) throw err(`Only admins of ${A.teamName(p.team)} can approve its projects.`);
    const dup = B.inTeam(to).find(x => x.number.toLowerCase() === p.number.toLowerCase());
    if (dup) throw err(`${p.number} is already on the ${A.teamName(to)} board (in ${B.colName(dup.col)}).`);
    const handoff = 'p_' + U.rand(8);
    const { number, members, pct, deadline, by, name, note, prio, label, team, col, order } = p;
    await write(pid, { number, members, pct, deadline, by, name, note, prio, label, team, col, order, deleted: false, approved: { by: me(), ts: Date.now() }, handoff });
    await sendHandoff(B.get(pid));
    return handoff;
  };
  /** Sent from PICKUP, not received yet: the INPUT board shows it with a Receive button. */
  B.isPending = p => !!p && !!p.from && !p.received;
  /** Approved on PICKUP and waiting for the next board to receive it (shown faded). */
  B.isSent = p => !!p && !!p.approved && !!p.handoff;
  B.canReceive = p => B.isPending(p) && B.canEdit(p.team);
  /** INPUT admin takes the project: it becomes a normal project here and leaves the PICKUP board. */
  B.receive = async function (pid) {
    const p = B.get(pid);
    if (!p) throw err('That project was deleted.');
    if (!B.isPending(p)) throw err(`${p.number} was already received${p.received ? ' by ' + A.name(p.received.by) : ''}.`);
    if (!B.canEdit(p.team)) throw err(`Only admins of ${A.teamName(p.team)} can receive it.`);
    const { number, members, pct, deadline, name, note, prio, label, team, col, order } = p;
    // the receiving admin becomes its superior here (the PICKUP approver stays in its 'from' line)
    return write(pid, { number, members, pct, deadline, by: me(), name, note, prio, label, team, col, order, deleted: false, received: { by: me(), ts: Date.now() } });
  };
  /** INPUT's Done is the last step: an admin of that board confirms it, and it moves to History. */
  B.isFinalBoard = team => !!team && !B.HANDOFF[team];
  B.canComplete = p => !!p && p.col === 'done' && B.isFinalBoard(p.team) && !p.completed && !B.isPending(p) && B.canEdit(p.team) && p.members.length > 0;
  B.complete = async function (pid) {
    const p = B.get(pid);
    if (!p) throw err('That project was deleted or is already complete.');
    if (p.col !== 'done') throw err('Only projects in Done can be confirmed.');
    if (!B.isFinalBoard(p.team)) throw err(`On this board, approve it instead: it goes on to ${A.teamName(B.handoffTo(p.team))}.`);
    if (!B.canEdit(p.team)) throw err(`Only admins of ${A.teamName(p.team)} can confirm it.`);
    locked(p);
    const { number, members, pct, deadline, by, name, note, prio, label, team, col, order } = p;
    return write(pid, { number, members, pct, deadline, by, name, note, prio, label, team, col, order, deleted: false, completed: { by: me(), ts: Date.now() } });
  };
  B.resendHandoff = async function (pid) {
    const p = B.get(pid);
    if (!B.needsResend(p)) return;
    await sendHandoff(p);
  };
  /** Order value between two neighbours (either may be missing). */
  B.orderBetween = function (above, below) {
    const a = above != null ? above : null, b = below != null ? below : null;
    if (a == null && b == null) return 1024;
    if (a == null) return b - 1024;
    if (b == null) return a + 1024;
    return (a + b) / 2;
  };

  /* ================= board notifications ================= */

  function derive() {
    if (!A.me) return;
    const lo = Date.now() - B.NOTE_DAYS * U.DAY_MS;
    const born = (A.users.get(me()) || {}).created || 0;
    const fresh = [];
    notes.clear();
    for (const list of valid.values()) {
      let prev = null;
      for (const r of list) {
        const inNow = !r.deleted && r.members.includes(me());
        const inBefore = !!prev && !prev.deleted && prev.members.includes(me());
        const seen = B.canSee(r.team) || ((r.received || r.completed) && list[0].from && B.canSee(list[0].from.team));
        if (seen && r.userId !== me() && r.ts > lo && r.ts > born - 60000) {
          const base = { pid: r.pid, number: r.number, name: r.name, prio: r.prio, team: r.team, actor: r.userId, by: r.by, deadline: r.deadline, ts: r.ts };
          if (r.completed && prev && !prev.completed) {
            const src = list[0].from ? (valid.get(list[0].from.pid) || []) : [];
            const srcLast = src[src.length - 1];
            const mine = r.members.includes(me()) || B.canEdit(r.team) || (list[0].from && (B.canEdit(list[0].from.team) || (srcLast && srcLast.members.includes(me()))));
            if (mine) fresh.push(Object.assign({ id: 'cp:' + r.id, type: 'completed' }, base));
          } else
          // received on the next board: tell the PICKUP admins and the people who worked on it there
          if (r.received && prev && !prev.received && list.received === r.received) {
            const src = valid.get(list[0].from.pid) || [];
            const srcLast = src[src.length - 1];
            if (B.canEdit(list[0].from.team) || (srcLast && srcLast.members.includes(me()))) {
              fresh.push(Object.assign({ id: 'rc:' + r.id, type: 'received', fromTeam: list[0].from.team }, base));
            }
          } else if (r.approved && inNow) fresh.push(Object.assign({ id: 'ap:' + r.id, type: 'approved', to: B.HANDOFF[r.team] || '' }, base));
          else if (!prev && r.from && B.canEdit(r.team)) fresh.push(Object.assign({ id: 'ho:' + r.id, type: 'handoff', fromTeam: r.from.team }, base));
          else if (inNow && !inBefore) fresh.push(Object.assign({ id: 'as:' + r.id, type: 'assigned', col: r.col }, base));
          else if (inNow && prev.col !== r.col && (r.col === 'checking' || r.col === 'done')) fresh.push(Object.assign({ id: 'st:' + r.id, type: r.col }, base));
        }
        prev = r;
      }
    }
    for (const it of fresh) notes.set(it.id, it);
    if (!ready) { fresh.forEach(it => popped.add(it.id)); return; }
    for (const it of fresh) {
      if (popped.has(it.id)) continue;
      popped.add(it.id);
      if (it.ts > startTs - 60000 && SC.notify && SC.notify.allow('board') && SC.app && SC.app.notify) {
        const d = B.describe(it);
        SC.app.notify({ title: d.title, body: d.sub, tag: 'b-' + it.id, onClick: () => B.events.emit('open', it) });
      }
    }
  }

  /** Plain-text title and sub-line for a board notification. */
  B.describe = function (it) {
    const who = A.name(it.actor);
    const due = it.deadline ? ` · due ${U.formatDateTime(new Date(it.deadline + 'T00:00:00').getTime()).replace(/ at .*$/, '')}` : '';
    const nm = it.name ? ` · ${it.name}` : '';
    const grp = it.team && A.teamName(it.team) ? ` · ${A.teamName(it.team)} board` : '';
    if (it.type === 'assigned') return { title: `New project ${it.number}${nm}`, sub: `${it.prio === 1 ? 'High priority · ' : ''}Assigned to you${grp ? ' on the' + grp.slice(2) : ''} by ${A.name(it.by)}${it.by !== it.actor ? ` (added by ${who})` : ''}${due}` };
    if (it.type === 'approved') return { title: `${it.number}${nm} was approved`, sub: `Approved by ${who} and sent to the ${A.teamName(it.to) || 'next'} board.` };
    if (it.type === 'handoff') return { title: `New from ${A.teamName(it.fromTeam) || 'another board'}: ${it.number}${nm}`, sub: `${it.prio === 1 ? 'High priority · ' : ''}Approved by ${who}. Open it in Review and click Receive${due}.` };
    if (it.type === 'received') return { title: `${it.number}${nm} was received by ${who}`, sub: `${A.teamName(it.team) || 'The next board'} has it now, so it’s gone from the ${A.teamName(it.fromTeam) || 'PICKUP'} board.` };
    if (it.type === 'completed') return { title: `${it.number}${nm} is complete`, sub: `Confirmed by ${who}. It’s in History now.` };
    if (it.type === 'checking') return { title: `${it.number}${nm} moved to Checking`, sub: `Moved by ${who}. It’s being checked now.` };
    return { title: `${it.number}${nm} is Done`, sub: `Marked done by ${who}.` };
  };
  B.notifications = () => Array.from(notes.values()).sort((a, b) => b.ts - a.ts);
  B.isUnread = it => it.ts > Y.boardRead();
  B.unreadCount = () => { let n = 0; for (const it of notes.values()) if (B.isUnread(it)) n++; return n; };
  B.markAllRead = function () {
    let max = 0;
    for (const it of notes.values()) if (it.ts > max) max = it.ts;
    if (max && Y.markBoardRead(Math.min(Date.now(), max))) B.events.emit('change');
  };

  /* ================= lifecycle ================= */

  function onPresence() {
    let newest = 0;
    for (const p of Y.presence.values()) {
      const lp = p.data && p.data.lastPost;
      const ts = lp && lp[HINT];
      if (typeof ts === 'number' && ts > newest) newest = ts;
    }
    if (newest > hint) { hint = newest; if (ready) B.refresh().catch(e => console.warn('board', e)); }
  }

  /** Call before SC.sync.start(), like SC.notify.start(). */
  B.start = function () {
    B.stop();
    startTs = Date.now();
    unsub = [
      Y.events.on('presence', onPresence),
      Y.events.on('started', () => { B.refresh().catch(e => console.warn('board', e)).finally(() => { ready = true; B.events.emit('change'); }); }),
      A.events.on('workspace', () => { if (ready) { rebuild(); B.events.emit('change'); B.refresh().catch(() => {}); } }),
      A.events.on('users', () => { if (ready) { rebuild(); B.events.emit('change'); } }),
    ];
    timer = setInterval(() => { if (ready && !(Y.hiddenSince && Date.now() - Y.hiddenSince > 5 * 60000)) B.refresh().catch(e => console.warn('board', e)); }, 30000);
  };
  B.stop = function () {
    unsub.forEach(f => f()); unsub = [];
    clearInterval(timer);
    revs.clear(); done.clear(); B.projects.clear(); notes.clear(); popped.clear();
    hint = 0; ready = false; busy = null;
  };
  B.ready = () => ready;

  SC.board = B;
})(typeof window !== 'undefined' ? window : globalThis);
