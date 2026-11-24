/* Sankyo Chat — calendar view (1.15): the month grid, the day's events, what's coming up, and the event dialog.
 * Opened from the calendar button next to the bells in the sidebar. Data lives in js/calendar.js.
 * Like the Windows 11 calendar, the weeks scroll smoothly: the mouse wheel or a touchpad moves them continuously,
 * the month in view is highlighted (the others are dimmed) and named in the title, and when scrolling stops near the
 * start of a month it settles there. The ↑ ↓ buttons and Page Up / Page Down glide to the previous or next month.
 * About two years of weeks are on screen at once; more are added at either end while scrolling. */
(function (root) {
  'use strict';
  const SC = root.SC;
  const U = SC.util, A = SC.account, UI = SC.ui, K = SC.calendar;
  const h = UI.h, icon = UI.icon;
  /** @namespace SC.calendarView */
  const V = {};
  let openDlg = null; // {draw, show(day), close} while the calendar is open

  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = s => new Date(s + 'T00:00:00');
  const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return dayKey(d); };
  const addMonths = (s, n) => { const d = parseDay(s); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return dayKey(d); };
  /** Colour class for an event's audience: everyone, or the 1st / 2nd group. */
  const tone = team => (!team ? 'cal-all' : 'cal-g' + (A.teamList().findIndex(t => t.id === team) + 1 || 1));
  const audience = team => (team ? A.teamName(team) || 'One group' : 'Everyone');
  const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString([], { weekday: 'short' })); // 1 Jan 2023 was a Sunday
  const monthTitle = ym => parseDay(ym + '-01').toLocaleDateString([], { month: 'long', year: 'numeric' });
  const BLOCK = 52;   // weeks added at a time
  const MAX_WEEKS = 520;

  /** Events by day between two days (multi-day events on every day they cover), in K.visible() order. */
  function dayMap(from, to) {
    const m = new Map();
    for (const e of K.visible()) {
      const last = e.end || e.date;
      if (last < from || e.date > to) continue;
      let d = e.date < from ? from : e.date, n = 0;
      while (d <= last && d <= to && n++ < 400) { if (!m.has(d)) m.set(d, []); m.get(d).push(e); d = addDays(d, 1); }
    }
    return m;
  }

  /** Open the calendar. opts.day = 'YYYY-MM-DD' to show. */
  V.open = function (opts = {}) {
    if (openDlg) { if (opts.day) openDlg.show(opts.day); return; }
    let sel = opts.day || K.today();
    let view = '';               // 'YYYY-MM' of the month in view
    let first = null, weeks = 0; // first Sunday on screen, number of weeks
    const wasNew = new Set(K.visible().filter(K.isNew).map(e => e.eid));
    const title = h('h3', { class: 'cal-month', 'aria-live': 'polite' });
    const grid = h('div', { class: 'cal-grid', role: 'grid' });
    const scroller = h('div', { class: 'cal-scroll' }, grid);
    const side = h('div', { class: 'cal-side' });
    const head = h('div', { class: 'cal-head' },
      title,
      h('span', { class: 'cal-arrows' },
        h('button', { class: 'icon-btn', 'aria-label': 'Previous month', title: 'Previous month (Page Up)', onclick: () => goMonth(-1) }, h('span', { class: 'cal-chev up' })),
        h('button', { class: 'icon-btn', 'aria-label': 'Next month', title: 'Next month (Page Down)', onclick: () => goMonth(1) }, h('span', { class: 'cal-chev' }))),
      h('button', { class: 'btn btn-sm', onclick: () => show(K.today()) }, 'Today'),
      h('span', { style: { flex: 1 } }),
      K.canManage() ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => eventDialog({ date: sel }) }, icon('plus'), 'Add event') : null);

    /* ---- the strip of weeks ---- */
    const sunday = day => { const d = parseDay(day); d.setDate(d.getDate() - d.getDay()); return d; };
    const lastDay = () => { const d = new Date(first); d.setDate(d.getDate() + weeks * 7 - 1); return dayKey(d); };
    const inRange = day => !!first && day >= dayKey(first) && day <= lastDay();
    function weekRow(start, map, today) {
      const cells = [];
      let monthStart = false;
      for (let i = 0; i < 7; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const key = dayKey(d);
        const evs = map.get(key) || [];
        if (d.getDate() === 1) monthStart = true;
        cells.push(h('button', {
          class: 'cal-day' + (key.slice(0, 7) !== view ? ' out' : '') + (key === today ? ' today' : '') + (key === sel ? ' sel' : '') + (d.getDate() === 1 ? ' first' : ''),
          role: 'gridcell', 'data-day': key, tabindex: key === sel ? '0' : '-1', 'aria-selected': String(key === sel),
          'aria-label': d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + (evs.length ? `, ${evs.length} ${evs.length === 1 ? 'event' : 'events'}` : ''),
        },
        h('span', { class: 'cal-num' }, d.getDate() === 1 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : String(d.getDate())),
        evs.slice(0, 2).map(e => h('span', { class: 'cal-chip ' + tone(e.team) + (wasNew.has(e.eid) ? ' new' : ''), title: `${e.title} · ${K.when(e)}` }, e.time && e.date === key ? h('b', null, e.time + ' ') : null, e.title)),
        evs.length > 2 ? h('span', { class: 'cal-more' }, `+${evs.length - 2} more`) : null));
      }
      return h('div', { class: 'cal-week' + (monthStart ? ' m-start' : ''), role: 'row' }, cells);
    }
    function rows(from, count) {
      const map = dayMap(dayKey(from), addDays(dayKey(from), count * 7 - 1));
      const today = K.today();
      return Array.from({ length: count }, (_, w) => weekRow(new Date(from.getFullYear(), from.getMonth(), from.getDate() + w * 7), map, today));
    }
    /** Re-draw every week in place (events changed), keeping the scroll position. */
    function draw() {
      const top = scroller.scrollTop;
      UI.set(grid, rows(first, weeks));
      jump(top);
      drawSide();
    }
    /** Start again around a day (it's outside the weeks on screen, or there are too many). */
    function build(day) {
      first = sunday(day); first.setDate(first.getDate() - BLOCK * 7);
      weeks = BLOCK * 2 + 6;
      UI.set(grid, rows(first, weeks));
    }
    const jump = top => scroller.scrollTo({ top, behavior: 'instant' });
    const rowOf = day => { const c = grid.querySelector(`[data-day="${day}"]`); return c && c.parentElement; };
    /** Scroll so the month's first week is at the top. */
    function toMonth(ym, smooth) {
      const day = ym + '-01';
      if (!inRange(day) || !inRange(addDays(day, 41))) build(day);
      const r = rowOf(day);
      if (!r) return;
      setView(ym);
      if (smooth) scroller.scrollTo({ top: r.offsetTop, behavior: 'smooth' }); else jump(r.offsetTop);
    }
    function goMonth(n) { toMonth(addMonths(view + '-01', n).slice(0, 7), true); }

    /** The month in view: the one the middle week mostly belongs to. Its days are bright, the others dimmed. */
    function setView(ym) {
      if (ym === view) return;
      view = ym;
      title.textContent = monthTitle(ym);
      for (const c of grid.querySelectorAll('.cal-day')) c.classList.toggle('out', c.dataset.day.slice(0, 7) !== ym);
    }
    function viewFromScroll() {
      const r = grid.firstElementChild;
      if (!r) return;
      const rowH = r.offsetHeight + 1;
      const mid = grid.children[Math.min(grid.children.length - 1, Math.floor((scroller.scrollTop + scroller.clientHeight / 2) / rowH))];
      if (mid) setView(mid.children[4].dataset.day.slice(0, 7)); // Thursday decides, like ISO weeks
    }
    /** Near either end (once scrolling has stopped): add another year of weeks there. */
    function extend() {
      const rowH = (grid.firstElementChild || {}).offsetHeight + 1 || 85;
      if (scroller.scrollTop < 10 * rowH) {
        if (weeks + BLOCK > MAX_WEEKS) return build(view + '-01'), toMonth(view, false);
        const from = new Date(first); from.setDate(from.getDate() - BLOCK * 7);
        const top = scroller.scrollTop;
        grid.prepend(...rows(from, BLOCK));
        first = from; weeks += BLOCK;
        jump(top + BLOCK * rowH);
      } else if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 10 * rowH) {
        if (weeks + BLOCK > MAX_WEEKS) return build(view + '-01'), toMonth(view, false);
        const from = new Date(first); from.setDate(from.getDate() + weeks * 7);
        grid.append(...rows(from, BLOCK));
        weeks += BLOCK;
      }
    }
    let raf = 0, idle = 0;
    scroller.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; viewFromScroll(); });
      clearTimeout(idle);
      idle = setTimeout(extend, 180); // works without the 'scrollend' event too
    }, { passive: true });

    /* ---- choosing a day ---- */
    function select(day) {
      if (day === sel) return;
      const prev = grid.querySelector(`[data-day="${sel}"]`);
      if (prev) { prev.classList.remove('sel'); prev.setAttribute('aria-selected', 'false'); prev.tabIndex = -1; }
      sel = day;
      const cur = grid.querySelector(`[data-day="${sel}"]`);
      if (cur) { cur.classList.add('sel'); cur.setAttribute('aria-selected', 'true'); cur.tabIndex = 0; }
      drawSide();
    }
    /** Choose a day and glide to its month. */
    function show(day) {
      if (!inRange(day)) { build(day); toMonth(day.slice(0, 7), false); }
      select(day);
      toMonth(day.slice(0, 7), true);
    }
    grid.addEventListener('click', e => {
      const c = e.target.closest('.cal-day');
      if (!c) return;
      if (c.classList.contains('out')) show(c.dataset.day); else select(c.dataset.day);
    });
    grid.addEventListener('dblclick', e => { const c = e.target.closest('.cal-day'); if (c && K.canManage()) eventDialog({ date: c.dataset.day }); });
    // keys: arrows move the chosen day, Page Up / Page Down change month, Home goes to today
    grid.addEventListener('keydown', e => {
      const from = (e.target.dataset && e.target.dataset.day) || sel;
      const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      let next = null;
      if (move) next = addDays(from, move);
      else if (e.key === 'PageUp' || e.key === 'PageDown') next = addMonths(from, e.key === 'PageUp' ? -1 : 1);
      else if (e.key === 'Home') next = K.today();
      if (!next) return;
      e.preventDefault();
      if (move && inRange(next)) {
        select(next);
        const r = rowOf(next);
        if (r) {
          const top = r.offsetTop, bottom = top + r.offsetHeight;
          if (top < scroller.scrollTop) scroller.scrollTo({ top, behavior: 'smooth' });
          else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTo({ top: bottom - scroller.clientHeight, behavior: 'smooth' });
        }
      } else show(next);
      const b = grid.querySelector(`[data-day="${next}"]`);
      if (b) b.focus({ preventScroll: true });
    });

    function eventCard(e) {
      const canEdit = K.canEdit(e);
      return h('div', { class: 'cal-ev ' + tone(e.team) + (wasNew.has(e.eid) ? ' new' : '') },
        h('div', { class: 'cal-ev-top' },
          h('div', { class: 'cal-ev-title' }, e.title, wasNew.has(e.eid) ? h('span', { class: 'pill' }, e.created === e.updated ? 'New' : 'Changed') : null),
          canEdit ? h('span', { class: 'cal-ev-tools' },
            h('button', { class: 'icon-btn', 'aria-label': 'Edit ' + e.title, title: 'Edit', onclick: () => eventDialog(e) }, icon('edit')),
            h('button', { class: 'icon-btn', 'aria-label': 'Delete ' + e.title, title: 'Delete', onclick: async () => {
              if (!(await UI.confirm({ title: `Delete “${e.title}”?`, text: 'It disappears from everyone’s calendar.', ok: 'Delete', danger: true }))) return;
              try { await K.remove(e.eid); UI.toast('Event deleted', 'ok'); } catch (ex) { UI.toast(ex.message, 'error'); }
            } }, icon('trash'))) : null),
        h('div', { class: 'cal-ev-when' }, icon('clock'), K.when(e)),
        e.place ? h('div', { class: 'cal-ev-when' }, icon('place'), e.place) : null,
        e.note ? h('div', { class: 'cal-ev-note' }, e.note) : null,
        h('div', { class: 'cal-ev-foot' }, h('span', { class: 'cal-for' }, icon('users'), audience(e.team)),
          `Added by ${A.name(e.createdBy)}` + (e.updated !== e.created ? ` · changed by ${A.name(e.updatedBy)}` : '')));
    }
    function drawSide() {
      const evs = K.onDay(sel);
      const up = K.upcoming(40).filter(e => !(e.date <= sel && (e.end || e.date) >= sel)).slice(0, 8);
      UI.set(side,
        h('div', { class: 'cal-side-h' }, parseDay(sel).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
        evs.length ? evs.map(eventCard) : h('div', { class: 'cal-none' }, 'Nothing on this day.',
          K.canManage() ? [' ', h('button', { class: 'link-btn', onclick: () => eventDialog({ date: sel }) }, 'Add an event')] : null),
        h('div', { class: 'cal-side-h cal-up' }, 'Coming up'),
        up.length ? up.map(e => h('button', { class: 'cal-up-row ' + tone(e.team), onclick: () => show(e.date) },
          h('span', { class: 'cal-dot' }), h('span', { class: 'cal-up-t' }, e.title), h('span', { class: 'cal-up-d' }, K.when(e))))
          : h('div', { class: 'cal-none' }, 'No other upcoming events.'));
    }

    const legend = h('div', { class: 'cal-legend' }, h('span', { class: 'cal-all' }, h('span', { class: 'cal-dot' }), 'Everyone'),
      A.teamList().filter(t => K.canSee(t.id)).map(t => h('span', { class: tone(t.id) }, h('span', { class: 'cal-dot' }), t.name)),
      h('span', { class: 'muted' }, 'Scroll over the weeks to move through the months.' + (K.canManage() ? ' Double-click a day to add an event.' : '')));
    const unsub = K.events.on('change', () => draw());
    const m = UI.modal({ title: 'Calendar', cls: 'wide cal-dlg', body: [head, h('div', { class: 'cal-body' },
      h('div', { class: 'cal-main' }, h('div', { class: 'cal-wdrow', role: 'row' }, WEEKDAYS.map(w => h('div', { class: 'cal-wd', role: 'columnheader' }, w))), scroller, legend), side)],
    onClose: () => { unsub(); clearTimeout(idle); cancelAnimationFrame(raf); openDlg = null; K.markAllRead(); } });
    openDlg = { draw, show, close: () => m.close() };
    build(sel);
    toMonth(sel.slice(0, 7), false);
    drawSide();
    K.markAllRead(); // opening it counts as seeing what's new (still highlighted until it's closed)
    K.refresh().catch(() => {});
  };

  /** Add (ev has only a date) or edit an event. */
  function eventDialog(ev) {
    const editing = !!ev.eid;
    const err = h('div', { class: 'form-error hidden', role: 'alert' });
    const title = h('input', { class: 'input', id: 'ce-title', maxlength: 120, value: ev.title || '', placeholder: 'e.g. Inventory count' });
    const date = h('input', { class: 'input', id: 'ce-date', type: 'date', value: ev.date || K.today() });
    const end = h('input', { class: 'input', id: 'ce-end', type: 'date', value: ev.end || '' });
    const allDay = h('input', { type: 'checkbox', id: 'ce-allday', checked: editing ? !ev.time : true });
    const time = h('input', { class: 'input', id: 'ce-time', type: 'time', value: ev.time || '09:00' });
    const endTime = h('input', { class: 'input', id: 'ce-endtime', type: 'time', value: ev.endTime || '' });
    const place = h('input', { class: 'input', id: 'ce-place', maxlength: 120, value: ev.place || '', placeholder: 'Optional' });
    const note = h('textarea', { class: 'input', id: 'ce-note', rows: 3, maxlength: '1000', placeholder: 'Optional details' });
    note.value = ev.note || '';
    const targets = K.targets();
    const team = h('select', { class: 'select', id: 'ce-team' }, targets.map(t => h('option', { value: t, selected: (ev.team || '') === t }, t ? `${A.teamName(t)} only` : 'Everyone')));
    const times = h('div', { class: 'cal-times' },
      h('div', { class: 'field' }, h('label', { for: 'ce-time' }, 'Starts'), time),
      h('div', { class: 'field' }, h('label', { for: 'ce-endtime' }, 'Ends (optional)'), endTime));
    const syncTimes = () => times.classList.toggle('hidden', allDay.checked);
    allDay.addEventListener('change', syncTimes);
    syncTimes();
    const ok = h('button', { class: 'btn btn-primary' }, editing ? 'Save changes' : 'Add event');
    ok.addEventListener('click', () => UI.busy(ok, null, async () => {
      const f = { title: title.value, date: date.value, end: end.value && end.value !== date.value ? end.value : '', time: allDay.checked ? '' : time.value, endTime: allDay.checked ? '' : endTime.value, place: place.value, note: note.value, team: team.value };
      if (editing) await K.update(ev.eid, f); else await K.create(f);
      m.close();
      UI.toast(editing ? 'Event saved' : `Event added for ${audience(f.team)}`, 'ok');
      if (openDlg) openDlg.show(f.date);
    }, err));
    const m = UI.modal({ title: editing ? 'Edit event' : 'Add an event', cls: 'mid', body: [err,
      h('div', { class: 'field' }, h('label', { for: 'ce-title' }, 'Title'), title),
      h('div', { class: 'cal-times' },
        h('div', { class: 'field' }, h('label', { for: 'ce-date' }, 'Date'), date),
        h('div', { class: 'field' }, h('label', { for: 'ce-end' }, 'Until (for several days)'), end)),
      h('label', { class: 'check', for: 'ce-allday' }, allDay, h('span', null, 'All day')),
      times,
      h('div', { class: 'field' }, h('label', { for: 'ce-place' }, 'Place'), place),
      h('div', { class: 'field' }, h('label', { for: 'ce-note' }, 'Details'), note),
      h('div', { class: 'field' }, h('label', { for: 'ce-team' }, 'Who sees it'), team,
        h('div', { class: 'hint' }, targets.length > 1 ? 'Everyone, or only the people in one group. Events aren’t encrypted: anyone with access to the shared drive can read them.' : 'Events aren’t encrypted: anyone with access to the shared drive can read them.'))],
    foot: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok] });
    title.focus();
  }

  V.isOpen = () => !!openDlg;
  V.close = () => { if (openDlg) openDlg.close(); };
  K.events.on('open', e => V.open({ day: e && e.date }));

  SC.calendarView = V;
})(typeof window !== 'undefined' ? window : globalThis);
