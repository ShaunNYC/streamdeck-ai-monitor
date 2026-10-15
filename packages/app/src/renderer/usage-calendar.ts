import type { AgentKind, MonitorSummary } from '@streamdeck-supervisor/shared';

export type UsagePeriod = 'day' | 'week' | 'month' | 'year';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const USAGE_COLORS = ['#2785E6', '#269964', '#D9AC24', '#DF525F', '#9561D8'] as const;
export function localDate(date = new Date()): Date { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
export function dateKey(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
export function dateFromKey(key: string): Date { const [y,m,d] = key.split('-').map(Number); return new Date(y,m-1,d); }
export function periodRange(period: UsagePeriod, anchor: Date): [Date, Date] {
 const start=localDate(anchor);
 if(period==='week') start.setDate(start.getDate()-(start.getDay()+6)%7);
 if(period==='month') start.setDate(1);
 if(period==='year') start.setMonth(0,1);
 const end=new Date(start);
 if(period==='year') end.setFullYear(end.getFullYear()+1);
 else if(period==='month') end.setMonth(end.getMonth()+1);
 else end.setDate(end.getDate()+(period==='week'?7:1));
 return [start,end];
}
export function moveAnchor(period: UsagePeriod, anchor: Date, direction: number, today = new Date()): Date {
 const next=localDate(anchor);
 if(period==='week') next.setDate(next.getDate()+direction*7);
 else {
  const day=next.getDate(); next.setDate(1);
  if(period==='year') next.setFullYear(next.getFullYear()+direction);
  else next.setMonth(next.getMonth()+direction); // Day view navigates calendar months.
  const last=new Date(next.getFullYear(),next.getMonth()+1,0).getDate();
  next.setDate(Math.min(day,last));
 }
 return next > localDate(today) ? localDate(today) : next;
}
export function dayUsage(monitor: MonitorSummary | undefined, agent: AgentKind, day: Date, today = new Date()): number | undefined {
 if(localDate(day)>localDate(today)) return undefined;
 const value=monitor?.days[dateKey(day)]?.[agent];
 return typeof value==='number' && Number.isFinite(value) && value>=0 ? value : undefined;
}
export function totalUsage(monitor: MonitorSummary | undefined, agent: AgentKind, period: UsagePeriod, anchor: Date, today = new Date()): number | undefined {
 const [start,end]=periodRange(period,anchor); let total=0, found=false;
 for(const key of Object.keys(monitor?.days ?? {})) {
  const date=dateFromKey(key);
  if(date<start || date>=end) continue;
  const value=dayUsage(monitor,agent,date,today);
  if(value!==undefined) {total+=value;found=true;}
 }
 return found?total:undefined;
}
export function formatUsage(value: number | undefined, precision: 'seconds' | 'minutes' | 'hours'): string {
 if(value===undefined) return 'No records';
 if(precision==='hours') return `${Math.round(value/HOUR*10)/10}h`;
 const seconds=Math.floor(Math.max(0,value)/1000), minutes=Math.floor(seconds/60);
 return `${Math.floor(minutes/60)}h ${String(minutes%60).padStart(2,'0')}m${precision==='seconds'?` ${String(seconds%60).padStart(2,'0')}s`:''}`;
}
export function formatCalendarDate(date: Date, options: Intl.DateTimeFormatOptions): string {
 return new Intl.DateTimeFormat('en-US', options).format(date);
}
export function usageBar(value: number | undefined): { width: number; color: string } {
 const duration=Math.max(0,value??0);
 return {width:Math.min(100,duration/DAY*100),color:USAGE_COLORS[duration<=4*HOUR?0:duration<=8*HOUR?1:duration<=12*HOUR?2:duration<=16*HOUR?3:4]};
}
export function calendarDays(anchor: Date): Array<Date | null> {
 const first=new Date(anchor.getFullYear(),anchor.getMonth(),1);
 const days:Array<Date|null>=Array.from({length:(first.getDay()+6)%7},()=>null);
 const end=new Date(anchor.getFullYear(),anchor.getMonth()+1,0).getDate();
 for(let day=1;day<=end;day++) days.push(new Date(anchor.getFullYear(),anchor.getMonth(),day));
 while(days.length%7) days.push(null);
 return days;
}

export class UsageCalendar {
 private period:UsagePeriod='day';
 private anchor=localDate();
 private followToday=true;
 private agent:AgentKind='codex';
 private initialized=false;
 private monitor:MonitorSummary|undefined;
 private structure='';
 constructor(private root:HTMLElement) {
  root.addEventListener('click',event=>{
   const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');
   if(!button || button.disabled) return;
   if(button.dataset.usageAgent) this.agent=button.dataset.usageAgent as AgentKind;
   else if(button.dataset.period) {this.period=button.dataset.period as UsagePeriod;this.anchor=localDate();this.followToday=true;}
   else if(button.dataset.day) {this.anchor=dateFromKey(button.dataset.day);this.followToday=false;}
   else if(button.id==='usage-today') {this.anchor=localDate();this.followToday=true;}
   else if(button.id==='usage-prev' || button.id==='usage-next') {this.anchor=moveAnchor(this.period,this.anchor,button.id==='usage-prev'?-1:1);this.followToday=false;}
   else return;
   this.render();
  });
 }
 update(monitor:MonitorSummary|undefined):void {
  this.monitor=monitor;
  if(!this.initialized) {this.agent=monitor?.selectedAgent??'codex';this.initialized=true;}
  if(this.followToday) this.anchor=localDate();
  this.render();
 }
 private render():void {
  const today=localDate(), agentName=this.agent==='codex'?'Codex':'Claude';
  const get=<T extends HTMLElement>(id:string)=>this.root.querySelector<T>(`#${id}`)!;
  const [start,end]=periodRange(this.period,this.anchor);
  const same=dateKey(start)===dateKey(periodRange(this.period,today)[0]);
  const name=({day:same?'Today':'Selected day',week:same?'This week':'Selected week',month:same?'This month':'Selected month',year:same?'This year':'Selected year'})[this.period];
  get('usage-summary-label').textContent=`${agentName} · ${name}`;
  get('usage-total').textContent=formatUsage(totalUsage(this.monitor,this.agent,this.period,this.anchor,today),this.period==='day'?'seconds':this.period==='year'?'hours':'minutes');
  const monthLabel=formatCalendarDate(this.anchor,{month:'long',year:'numeric'});
  const last=new Date(end);last.setDate(last.getDate()-1);
  const weekOptions:Intl.DateTimeFormatOptions={month:'short',day:'numeric',...(last.getFullYear()!==start.getFullYear()?{year:'numeric'}:{})};
  get('usage-range').textContent=this.period==='year'?String(this.anchor.getFullYear()):this.period==='week'?`${formatCalendarDate(start,weekOptions)} – ${formatCalendarDate(last,weekOptions)}`:monthLabel;
  get('usage-summary-date').textContent=this.period==='day'?formatCalendarDate(this.anchor,{month:'long',day:'numeric',year:'numeric'}):this.period==='week'?String(start.getFullYear()):'Recorded working time';
  this.root.querySelectorAll<HTMLButtonElement>('[data-period]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.period===this.period)));
  this.root.querySelectorAll<HTMLButtonElement>('[data-usage-agent]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.usageAgent===this.agent)));
  const navPeriod=this.period==='day'?'month':this.period;
  get<HTMLButtonElement>('usage-next').disabled=periodRange(navPeriod,this.anchor)[0]>=periodRange(navPeriod,today)[0];
  get('usage-today').textContent=({day:'Today',week:'This week',month:'This month',year:'This year'})[this.period];
  get('usage-legend').hidden=this.period==='year';
  const grid=get('usage-calendar');grid.className=`usage-calendar ${this.period==='year'?'usage-year':this.period==='week'?'usage-week':'usage-month'}`;
  const dates=this.period==='year'?Array.from({length:12},(_,m)=>new Date(this.anchor.getFullYear(),m,1)):this.period==='week'?Array.from({length:7},(_,i)=>new Date(start.getFullYear(),start.getMonth(),start.getDate()+i)):calendarDays(this.anchor);
  const signature=`${this.period}:${dates.map(d=>d?dateKey(d):'_').join(',')}`;
  if(signature!==this.structure) {
   this.structure=signature;
   const headings=this.period==='year'?'':['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div class="usage-weekday">${d}</div>`).join('');
   grid.innerHTML=headings+dates.map(date=>{
    if(!date) return '<div class="usage-empty" aria-hidden="true"></div>';
    const key=dateKey(date);
    const body=`<span class="usage-date">${this.period==='year'?formatCalendarDate(date,{month:'short'}):date.getDate()}</span><span class="usage-value"></span>${this.period==='year'?'':'<span class="usage-track" aria-hidden="true"><span class="usage-fill"></span></span>'}`;
    return this.period==='day'?`<button type="button" class="usage-cell" data-day="${key}" data-date="${key}">${body}</button>`:`<div class="usage-cell" data-date="${key}">${body}</div>`;
   }).join('');
  }
  grid.querySelectorAll<HTMLElement>('[data-date]').forEach(cell=>{
   const date=dateFromKey(cell.dataset.date!);
   const future=date>today;
   const value=this.period==='year'?totalUsage(this.monitor,this.agent,'month',date,today):dayUsage(this.monitor,this.agent,date,today);
   const label=future?'—':formatUsage(value,this.period==='year'?'hours':'minutes');
   cell.querySelector('.usage-value')!.textContent=label;
   cell.classList.toggle('is-future',future);
   cell.classList.toggle('is-today',this.period!=='year' && dateKey(date)===dateKey(today));
   cell.classList.toggle('is-selected',this.period==='day' && dateKey(date)===dateKey(this.anchor));
   cell.setAttribute('aria-label',`${formatCalendarDate(date,{month:'long',year:'numeric',...(this.period==='year'?{}:{day:'numeric'})})}, ${future?'Future date':label}`);
   if(cell instanceof HTMLButtonElement) {cell.disabled=future;cell.setAttribute('aria-pressed',String(dateKey(date)===dateKey(this.anchor)));}
   const fill=cell.querySelector<HTMLElement>('.usage-fill');
   if(fill) {const bar=usageBar(future?undefined:value);fill.style.width=`${bar.width}%`;fill.style.backgroundColor=bar.color;}
  });
 }
}
