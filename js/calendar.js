/* Sankyo Chat — calendar data (1.15): events that admins (and roles with "Manage the calendar") put on the calendar.
 * Each change is a new file calendar/<eventId>/<ts>_<userId>_<rand>.json, a signed full copy of the event, like the
 * project board: the newest valid one wins, and deleting writes one more copy with deleted: true. Every app ignores
 * files whose signer wasn't allowed to manage the calendar at the time (A.canAt).
 * An event is for everyone (team '') or for one group (PICKUP / INPUT). Only the super admin can put an event on
 * another group's calendar; everyone else with the permission posts to everyone or to their own group.
 * Events aren't encrypted, like the board and public channels.
 * Saving also sets lastPost['cal:all'] in the author's presence file, so other apps re-read within seconds.
 * "New" events (added or changed by someone else since I last opened the calendar) count on the calendar button;
 * that read-state is calRead in my presence file, so it follows me to other PCs.
 * No DOM access; the UI (js/calendar-ui.js) listens to SC.calendar.events 'change'. */
(function (root) {
  'use strict';
  const SC = root.SC = root.SC || {};
  const U = SC.util, S = SC.store, C = SC.crypto, A = SC.account, Y = SC.sync;
  /** @namespace SC.calendar */
  const K = {};
  K.events = U.emitter();
  K.KEEP_DAYS = 400;
  const HINT = 'cal:all';
  const DIR = 'calendar';
  const EID_RE = /^e_[a-z0-9]{8}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const TEAM_RE = /^[a-z0-9]{1,8}$/;

  /** eventId → valid revisions, oldest first */
  const revs = new Map();
  /** `${eid}/${file}` handled for good (valid, or never valid) */
  const done = new Set();
  /** eventId → current event (deleted ones left out) */
  K.list = new Map();
  const popped = new Set();
  let hint = 0, timer = 0, unsub = [], ready = false, busy = null;

  const me = () => A.me.id;
  const err = msg => new Error(msg);
  K.today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const floorDay = () => { const d = new Date(Date.now() - K.KEEP_DAYS * U.DAY_MS); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  /* ================= reading ================= */

  function clean(raw) {
    const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (!title || !DATE_RE.test(raw.date || '')) return null;
    const end = DATE_RE.test(raw.end || '') && raw.end > raw.date ? raw.end : '';
    const time = TIME_RE.test(raw.time || '') ? raw.time : '';
    return {
      title, date: raw.date, end, time,
      endTime: time && TIME_RE.test(raw.endTime || '') && (end || raw.endTime > time) ? raw.endTime : '',
      place: typeof raw.place === 'string' ? raw.place.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 1000) : '',
      team: typeof raw.team === 'string' && TEAM_RE.test(raw.team) ? raw.team : '',
      deleted: raw.deleted === true,
    };
  }
  /** May this author put an event on this group's calendar? Everyone's is open to anyone with the permission;
   *  a group's only to the super admin and that group's own people. */
  const allowedFor = (r, team) => !!A.ws && (!team || r.userId === A.ws.adminId || A.teamOf(r.userId) === team);

  async function readEvent(eid) {
    const names = (await S.list(`${DIR}/${eid}`, 'file')).filter(n => U.MSG_RE.test(n) && !n.includes('.ev.'));
    let changed = false;
    for (const n of names) {
      const key = eid + '/' + n;
      if (done.has(key)) continue;
      const pn = U.parseMsgName(n);
      if (!pn) { done.add(key); continue; }
      const raw = await S.readJSON(`${DIR}/${eid}/${n}`);
      if (!raw) continue; // unreadable right now: try again next time
      const id = n.slice(0, -5);
      const shapeOk = raw.type === 'cal' && raw.event === eid && raw.id === id && raw.userId === pn.userId && raw.ts === pn.ts;
      if (!shapeOk || !(await Y.verifyRaw(raw))) { done.add(key); continue; }
      // not known (yet) as allowed here, e.g. this PC hasn't read the new workspace.json: check again later
      if (!A.canAt(raw.userId, raw.kid, raw.ts, 'cal.manage')) continue;
      done.add(key);
      const f = clean(raw);
      if (!f) continue;
      let list = revs.get(eid);
      if (!list) revs.set(eid, list = []);
      list.push(Object.assign({ id, eid, userId: raw.userId, kid: raw.kid, ts: raw.ts }, f));
      changed = true;
    }
    if (changed) revs.get(eid).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    return changed;
  }

  function rebuild() {
    K.list.clear();
    const lo = floorDay();
    for (const [eid, all] of revs) {
      // a change only counts if its author may post to both the event's group and the group it sets
      let cur = null, first = null;
      for (const r of all) {
        if (!first) { if (!allowedFor(r, r.team)) continue; first = cur = r; continue; }
        if (!allowedFor(r, cur.team) || !allowedFor(r, r.team)) continue;
        cur = r;
      }
      if (!cur || cur.deleted || (cur.end || cur.date) < lo) continue;
      K.list.set(eid, Object.assign({}, cur, { created: first.ts, createdBy: first.userId, updated: cur.ts, updatedBy: cur.userId }));
    }
  }

  /** Re-read the calendar folder (one read at a time; overlapping calls share it). */
  K.refresh = function () {
    if (!busy) busy = (async () => {
      if (!A.me || !Y.connected) return false;
      const eids = (await S.list(DIR, 'directory')).filter(n => EID_RE.test(n));
      let changed = false;
      for (const eid of eids) { try { if (await readEvent(eid)) changed = true; } catch (e) { console.warn('calendar', eid, e); } }
      if (changed) { rebuild(); notifyNew(); K.events.emit('change'); }
      return changed;
    })().finally(() => { busy = null; });
    return busy;
  };

  /* ================= queries ================= */

  /** Can I see an event for this group? Everyone's: yes. A group's: its people, and the super admin. */
  K.canSee = team => !team || (!!A.me && (A.isOwner() || A.teamOf(me()) === team));
  K.canManage = () => !!A.me && A.can('cal.manage');
  /** Groups I can post an event to: '' (everyone), plus my own group, or every group for the super admin. */
  K.targets = () => {
    if (!K.canManage()) return [];
    const mine = A.teamOf(me());
    return [''].concat(A.teamList().map(t => t.id).filter(t => A.isOwner() || t === mine));
  };
  K.canEdit = ev => !!ev && K.canManage() && K.targets().includes(ev.team);
  K.get = eid => K.list.get(eid) || null;
  /** Events I can see, soonest first (all-day ones before timed ones on the same day). */
  K.visible = () => Array.from(K.list.values()).filter(e => K.canSee(e.team))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : a.created - b.created));
  /** Events on a day (multi-day events count on every day they cover). */
  K.onDay = day => K.visible().filter(e => e.date <= day && (e.end || e.date) >= day);
  K.upcoming = (n = 30) => { const t = K.today(); return K.visible().filter(e => (e.end || e.date) >= t).slice(0, n); };
  K.todayCount = () => K.onDay(K.today()).length;

  /** New or changed by someone else since I last opened the calendar. */
  K.isNew = ev => ev.updatedBy !== me() && ev.updated > Y.calRead();
  K.unreadCount = () => K.visible().filter(K.isNew).length;
  K.markAllRead = function () {
    let max = 0;
    for (const e of K.list.values()) if (e.updated > max) max = e.updated;
    if (max && Y.markCalRead(Math.min(Date.now(), max))) K.events.emit('change');
  };

  /* ================= saving ================= */

  /** @param {{title, date, end?, time?, endTime?, place?, note?, team?}} f */
  function check(f) {
    const title = String(f.title || '').replace(/\s+/g, ' ').trim();
    if (!title) throw err('Give the event a title.');
    if (title.length > 120) throw err('Titles can be at most 120 characters.');
    if (!DATE_RE.test(f.date || '')) throw err('Pick the date.');
    if (f.end && !DATE_RE.test(f.end)) throw err('Pick a valid end date.');
    if (f.end && f.end < f.date) throw err('The end date is before the start date.');
    if (f.time && !TIME_RE.test(f.time)) throw err('Pick a valid start time.');
    if (f.endTime && !TIME_RE.test(f.endTime)) throw err('Pick a valid end time.');
    if (f.endTime && !f.time) throw err('Set a start time too, or clear the end time.');
    if (f.endTime && (!f.end || f.end === f.date) && f.endTime <= f.time) throw err('The end time is before the start time.');
    const team = f.team || '';
    if (!K.targets().includes(team)) throw err(team ? `You can’t add events for ${A.teamName(team)}.` : 'You aren’t allowed to manage the calendar.');
    return { title, date: f.date, end: f.end && f.end > f.date ? f.end : '', time: f.time || '', endTime: f.time ? (f.endTime || '') : '',
      place: String(f.place || '').replace(/\s+/g, ' ').trim().slice(0, 120), note: String(f.note || '').trim().slice(0, 1000), team };
  }
  async function write(eid, f) {
    if (!K.canManage()) throw err('You aren’t allowed to manage the calendar.');
    if (!Y.connected) throw err('Lost access to the shared folder. Check the connection and try again.');
    const ts = Math.max(Date.now(), ((revs.get(eid) || []).slice(-1)[0] || { ts: 0 }).ts + 1);
    const id = `${ts}_${me()}_${U.rand(4)}`;
    const raw = Object.assign({ v: 1, type: 'cal', event: eid, id, userId: me(), ts, kid: A.me.signFp }, f);
    raw.sig = await C.sign(A.me.priv.sign, raw);
    await S.writeJSON(`${DIR}/${eid}/${id}.json`, raw);
    done.add(`${eid}/${id}.json`);
    let list = revs.get(eid);
    if (!list) revs.set(eid, list = []);
    list.push(Object.assign({ id, eid, userId: me(), kid: raw.kid, ts }, clean(raw)));
    rebuild();
    hint = Math.max(hint, ts);
    Y.noteMyPost(HINT, ts);
    K.events.emit('change');
    return eid;
  }
  K.create = f => write('e_' + U.rand(8), check(f));
  K.update = function (eid, f) {
    const ev = K.get(eid);
    if (!ev) throw err('That event no longer exists.');
    if (!K.canEdit(ev)) throw err('You can’t change this event.');
    return write(eid, check(f));
  };
  K.remove = function (eid) {
    const ev = K.get(eid);
    if (!ev) return Promise.resolve();
    if (!K.canEdit(ev)) return Promise.reject(err('You can’t delete this event.'));
    const f = { title: ev.title, date: ev.date, end: ev.end, time: ev.time, endTime: ev.endTime, place: ev.place, note: ev.note, team: ev.team, deleted: true };
    return write(eid, f);
  };

  /* ================= pop-ups ================= */

  /** Desktop pop-up for events someone else added or changed while I'm signed in. */
  function notifyNew() {
    if (!ready || !SC.notify || !SC.notify.allow('calendar')) { for (const e of K.list.values()) popped.add(e.eid + '|' + e.updated); return; }
    for (const e of K.visible()) {
      const k = e.eid + '|' + e.updated;
      if (popped.has(k)) continue;
      popped.add(k);
      if (!K.isNew(e)) continue;
      const fresh = e.created === e.updated;
      SC.app.notify({ title: `${fresh ? 'New event' : 'Event changed'}: ${e.title}`, body: K.when(e) + (e.place ? ' · ' + e.place : ''), tag: 'cal-' + e.eid,
        onClick: () => K.events.emit('open', e) });
    }
  }

  /** "Mon, 3 Mar · 09:00–10:00" style label. */
  K.dateLabel = day => new Date(day + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: day.slice(0, 4) === K.today().slice(0, 4) ? undefined : 'numeric' });
  K.when = function (e) {
    let s = K.dateLabel(e.date);
    if (e.end) s += ' – ' + K.dateLabel(e.end);
    if (e.time) s += ' · ' + e.time + (e.endTime ? '–' + e.endTime : '');
    else s += ' · All day';
    return s;
  };

  /* ================= lifecycle ================= */

  function onPresence() {
    let newest = 0;
    for (const p of Y.presence.values()) {
      const lp = p.data && p.data.lastPost;
      const ts = lp && lp[HINT];
      if (typeof ts === 'number' && ts > newest) newest = ts;
    }
    if (newest > hint) { hint = newest; if (ready) K.refresh().catch(e => console.warn('calendar', e)); }
  }

  /** Call before SC.sync.start(), like SC.board.start(). */
  K.start = function () {
    K.stop();
    unsub = [
      Y.events.on('presence', onPresence),
      Y.events.on('started', () => {
        K.refresh().catch(e => console.warn('calendar', e)).finally(() => {
          for (const e of K.list.values()) popped.add(e.eid + '|' + e.updated); // what was there before I signed in doesn't pop up
          ready = true; K.events.emit('change');
        });
      }),
      A.events.on('workspace', () => { if (ready) { rebuild(); K.events.emit('change'); K.refresh().catch(() => {}); } }),
      A.events.on('users', () => { if (ready) { rebuild(); K.events.emit('change'); } }),
    ];
    // also catches the day changing at midnight ("today" moves on)
    timer = setInterval(() => { if (ready && !(Y.hiddenSince && Date.now() - Y.hiddenSince > 5 * 60000)) K.refresh().then(c => { if (!c) K.events.emit('change'); }).catch(e => console.warn('calendar', e)); }, 60000);
  };
  K.stop = function () {
    unsub.forEach(f => f()); unsub = [];
    clearInterval(timer);
    revs.clear(); done.clear(); K.list.clear(); popped.clear();
    hint = 0; ready = false; busy = null;
  };
  K.ready = () => ready;

  SC.calendar = K;
})(typeof window !== 'undefined' ? window : globalThis);
