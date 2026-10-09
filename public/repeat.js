/*
 * HomeBoard — repeating tasks.
 *
 * One file for both sides: the app uses it to show and roll a task forward in
 * the phone's own time zone (so "every Monday at 7pm" means 7pm where you are),
 * and the server uses the same rules to check what the app sends.
 *
 * A rule:  { unit: 'day' | 'week' | 'month', interval: 1–99, days?: [0–6], anchor?: ISO }
 *   days    weekdays for weekly rules, 0 = Sunday. Empty = same weekday as the due date.
 *   anchor  the first due date — keeps "every 2 weeks" and "the 31st" honest.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HomeBoardRepeat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNITS = ['day', 'week', 'month'];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_MS = 24 * 60 * 60 * 1000;

  const PRESETS = {
    daily:       () => ({ unit: 'day', interval: 1 }),
    weekdays:    () => ({ unit: 'week', interval: 1, days: [1, 2, 3, 4, 5] }),
    weekly:      (due) => ({ unit: 'week', interval: 1, days: [new Date(due || Date.now()).getDay()] }),
    fortnightly: (due) => ({ unit: 'week', interval: 2, days: [new Date(due || Date.now()).getDay()] }),
    monthly:     () => ({ unit: 'month', interval: 1 }),
  };

  function sanitise(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const unit = UNITS.includes(raw.unit) ? raw.unit : null;
    if (!unit) return null;
    const interval = Math.min(99, Math.max(1, Math.floor(Number(raw.interval) || 1)));
    const rule = { unit, interval };
    if (unit === 'week' && Array.isArray(raw.days)) {
      const days = [...new Set(raw.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      if (days.length) rule.days = days;
    }
    if (raw.anchor && Number.isFinite(Date.parse(raw.anchor))) rule.anchor = new Date(raw.anchor).toISOString();
    return rule;
  }

  const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; };
  const weeksBetween = (a, b) => Math.round((startOfWeek(b) - startOfWeek(a)) / (7 * DAY_MS));
  const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

  /** One step forward from `d`. */
  function step(d, rule, anchor) {
    const n = rule.interval || 1;
    if (rule.unit === 'day') { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
    if (rule.unit === 'month') {
      const x = new Date(d);
      const want = anchor.getDate();
      x.setDate(1);
      x.setMonth(x.getMonth() + n);
      x.setDate(Math.min(want, daysInMonth(x.getFullYear(), x.getMonth())));
      return x;
    }
    // week
    const days = rule.days && rule.days.length ? rule.days : [anchor.getDay()];
    for (let i = 1; i <= 7 * n + 7; i++) {
      const x = new Date(d);
      x.setDate(x.getDate() + i);
      if (days.includes(x.getDay()) && ((weeksBetween(anchor, x) % n) + n) % n === 0) return x;
    }
    const x = new Date(d); x.setDate(x.getDate() + 7 * n); return x; // unreachable, but never loop
  }

  /**
   * The next due date after finishing the one due at `dueISO`. Always moves on
   * at least once, then skips any that are already in the past — miss three
   * days of "water the plants" and the next one is the next one, not three.
   */
  function next(dueISO, rule, { after = Date.now() } = {}) {
    const r = sanitise(rule);
    if (!r) return null;
    const start = Number.isFinite(Date.parse(dueISO)) ? new Date(dueISO) : new Date(after);
    const anchor = r.anchor ? new Date(r.anchor) : start;
    let d = step(start, r, anchor);
    for (let guard = 0; d.getTime() <= after && guard < 5000; guard++) d = step(d, r, anchor);
    return d.toISOString();
  }

  /** The next few due dates, for showing in the form. */
  function upcoming(dueISO, rule, count = 3) {
    const out = [];
    if (!sanitise(rule) || !Number.isFinite(Date.parse(dueISO))) return out;
    out.push(new Date(dueISO).toISOString());
    let d = dueISO;
    for (let i = 1; i < count; i++) { d = next(d, rule, { after: Date.parse(d) }); out.push(d); }
    return out;
  }

  const list = (days) => days.map((d) => DAY_NAMES[d]).join(', ');

  /** "Daily", "Weekdays", "Weekly on Mon, Thu", "Every 3 days", "Monthly". */
  function describe(rule) {
    const r = sanitise(rule);
    if (!r) return '';
    const n = r.interval;
    if (r.unit === 'day') return n === 1 ? 'Daily' : `Every ${n} days`;
    if (r.unit === 'month') return n === 1 ? 'Monthly' : `Every ${n} months`;
    const days = r.days || [];
    if (n === 1 && days.join() === '1,2,3,4,5') return 'Weekdays';
    if (n === 1 && days.length === 7) return 'Daily';
    const on = days.length ? ` on ${list(days)}` : '';
    return n === 1 ? `Weekly${on}` : n === 2 ? `Every 2 weeks${on}` : `Every ${n} weeks${on}`;
  }

  /** Which preset a rule is, or 'custom'. */
  function presetOf(rule, dueISO) {
    const r = sanitise(rule);
    if (!r) return 'none';
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make(dueISO);
      if (p.unit === r.unit && p.interval === r.interval && (p.days || []).join() === (r.days || []).join()) return name;
    }
    return 'custom';
  }

  return { sanitise, next, upcoming, describe, presetOf, PRESETS, DAY_NAMES };
});
