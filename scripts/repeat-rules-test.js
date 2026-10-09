/* Repeat rules — run in a few time zones: TZ=Asia/Kolkata node scripts/repeat-rules-test.js */
const R = require('../public/repeat.js');
let pass=0, fail=0; const eq=(l,a,b)=>{ if(a===b){pass++;} else {fail++; console.log('FAIL',l,'\n  got ',a,'\n  want',b);} };
const L = (y,m,d,h=18,mi=0)=>new Date(y,m-1,d,h,mi).toISOString();
// Thu 8 Oct 2026 18:00
const due = L(2026,10,8);
eq('daily', R.next(due,{unit:'day',interval:1},{after:Date.parse(due)}), L(2026,10,9));
eq('daily skips missed', R.next(due,{unit:'day',interval:1},{after:Date.parse(L(2026,10,11,9))}), L(2026,10,11));
eq('every 3 days', R.next(due,{unit:'day',interval:3},{after:Date.parse(due)}), L(2026,10,11));
eq('weekdays from Fri', R.next(L(2026,10,9),R.PRESETS.weekdays(),{after:Date.parse(L(2026,10,9))}), L(2026,10,12));
eq('weekly same day', R.next(due,R.PRESETS.weekly(due),{after:Date.parse(due)}), L(2026,10,15));
eq('weekly Mon+Thu from Thu 8', R.next(due,{unit:'week',interval:1,days:[1,4]},{after:Date.parse(due)}), L(2026,10,12)); eq('weekly Mon+Thu from Tue 6', R.next(L(2026,10,6),{unit:'week',interval:1,days:[1,4]},{after:Date.parse(L(2026,10,6))}), L(2026,10,8));
eq('fortnightly', R.next(due,R.PRESETS.fortnightly(due),{after:Date.parse(due)}), L(2026,10,22));
const a2={unit:'week',interval:2,days:[1,4],anchor:L(2026,10,5)}; // Mon 5 Oct anchor
eq('2wk Mon/Thu: Thu 8 -> Mon 19', R.next(L(2026,10,8),a2,{after:Date.parse(L(2026,10,8))}), L(2026,10,19));
eq('monthly 31st -> Feb end', R.next(L(2027,1,31),{unit:'month',interval:1},{after:Date.parse(L(2027,1,31))}), L(2027,2,28));
eq('monthly keeps 31st after Feb', R.next(L(2027,2,28),{unit:'month',interval:1,anchor:L(2027,1,31)},{after:Date.parse(L(2027,2,28))}), L(2027,3,31));
eq('describe weekdays', R.describe(R.PRESETS.weekdays()), 'Weekdays');
eq('describe weekly', R.describe({unit:'week',interval:1,days:[1,4]}), 'Weekly on Mon, Thu');
eq('describe 3 days', R.describe({unit:'day',interval:3}), 'Every 3 days');
eq('preset weekly', R.presetOf(R.PRESETS.weekly(due), due), 'weekly');
eq('preset custom', R.presetOf({unit:'day',interval:2}, due), 'custom');
eq('sanitise junk', R.sanitise({unit:'year'}), null);
eq('upcoming', R.upcoming(due,{unit:'day',interval:1},3).length, 3);
console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
