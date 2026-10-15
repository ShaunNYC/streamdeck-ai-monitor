import assert from 'node:assert/strict';
import {calendarDays,dateKey,dateFromKey,periodRange,moveAnchor,formatUsage,formatCalendarDate,usageBar,totalUsage,dayUsage,HOUR,USAGE_COLORS} from '../packages/app/src/renderer/usage-calendar.js';
import type {MonitorSummary} from '@streamdeck-supervisor/shared';
const date=(s:string)=>dateFromKey(s);
assert.equal(dateKey(periodRange('week',date('2027-01-01'))[0]),'2026-12-28');
assert.equal(dateKey(periodRange('week',date('2027-01-01'))[1]),'2027-01-04');
assert.equal(dateKey(periodRange('week',date('2026-09-07'))[0]),'2026-09-07');
assert.equal(calendarDays(date('2024-02-10')).filter(Boolean).length,29);
assert.equal(calendarDays(date('2025-02-10')).filter(Boolean).length,28);
assert.equal(calendarDays(date('2026-09-07'))[0],null); // September starts Tuesday.
assert.equal(dateKey(moveAnchor('day',date('2024-01-31'),1,date('2026-09-07'))),'2024-02-29');
assert.equal(dateKey(moveAnchor('year',date('2024-02-29'),1,date('2026-09-07'))),'2025-02-28');
assert.equal(dateKey(moveAnchor('month',date('2026-12-15'),1,date('2027-02-01'))),'2027-01-15');
assert.equal(dateKey(moveAnchor('month',date('2026-09-07'),1,date('2026-09-07'))),'2026-09-07');
assert.equal(formatUsage(5*HOUR+3*60000+59000,'seconds'),'5h 03m 59s');
assert.equal(formatUsage(5*HOUR+3*60000+59000,'minutes'),'5h 03m');
assert.equal(formatUsage(5.25*HOUR,'hours'),'5.3h');
assert.equal(formatUsage(undefined,'seconds'),'No records');
assert.equal(formatUsage(0,'minutes'),'0h 00m');
assert.equal(formatCalendarDate(date('2026-10-12'),{month:'long',day:'numeric',year:'numeric'}),'October 12, 2026');
assert.equal(formatCalendarDate(date('2026-12-28'),{month:'short',day:'numeric',year:'numeric'}),'Dec 28, 2026');
assert.equal(formatCalendarDate(date('2027-01-03'),{month:'short',day:'numeric',year:'numeric'}),'Jan 3, 2027');
for(const [i,h] of [4,8,12,16].entries()) {
 assert.equal(usageBar(h*HOUR).color,USAGE_COLORS[i]);
 assert.equal(usageBar(h*HOUR+1).color,USAGE_COLORS[i+1]);
}
assert.equal(usageBar(6*HOUR).width,25);
assert.equal(usageBar(0).width,0);
assert.equal(usageBar(undefined).width,0);
assert.equal(usageBar(25*HOUR).width,100);
assert.equal(formatUsage(25*HOUR,'minutes'),'25h 00m');
const monitor:MonitorSummary={days:{'2026-12-31':{codex:HOUR+59000,claude:2*HOUR},'2027-01-01':{codex:HOUR+59000,claude:0},'2027-01-02':{codex:5*HOUR,claude:7*HOUR}},slots:{codex:[],claude:[]}};
const now=date('2027-01-01');
assert.equal(totalUsage(monitor,'codex','week',now,now),2*HOUR+118000);
assert.equal(formatUsage(totalUsage(monitor,'codex','week',now,now),'minutes'),'2h 01m');
assert.equal(totalUsage(monitor,'codex','year',date('2026-09-01'),now),HOUR+59000);
assert.equal(totalUsage(monitor,'claude','month',now,now),0);
assert.equal(totalUsage(monitor,'claude','month',date('2026-11-01'),now),undefined);
assert.equal(dayUsage(monitor,'codex',date('2027-01-02'),now),undefined);
// Local dates advance across DST without assuming a day is always 86,400,000 ms.
assert.equal(dateKey(periodRange('day',date('2026-03-08'))[1]),'2026-03-09');
assert.equal(dateKey(periodRange('day',date('2026-11-01'))[1]),'2026-11-02');
console.log('[usage-calendar] local dates, leap/DST/year boundaries, precise aggregation, missing/future records, units and colors: ok');
