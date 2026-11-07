// Make prepaid credit last: the user's credit and target days in, a plan of which devices to limit out.
// All numbers come from stored readings and shared/calculations.ts; the assistant only explains them.
// Example: GHS 100 at GHS 1.80/kWh for 14 days -> 3.97 kWh a day; the home uses 6.0 -> limit the AC to 2.5 h a day...
import {config} from './database.mjs'
import {fail,object,keys,number,optionalNumber,oneOf,id} from './validation.mjs'
import {rationPlan,meterRatio,isApparent,ecgKwhForCredit,ecgCostForPeriod,ECG_TARIFF} from '../shared/calculations.ts'

const DAY_MS=86400000
const HISTORY_DAYS=7            // usage is averaged over the last 7 days
const METER_MIN_MS=DAY_MS       // two meter readings must be a day apart to compare them

export function migrate(db){db.exec(`
 CREATE TABLE IF NOT EXISTS rationing(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS meter_readings(id INTEGER PRIMARY KEY,at TEXT NOT NULL,units_left REAL NOT NULL);`)}

export function createRationing(db,service,{clock=()=>Date.now()}={}){
 migrate(db)
 const kwh=wh=>wh==null?null:wh/1000
 const midnight=()=>{const d=new Date(clock());d.setHours(0,0,0,0);return d.getTime()}

 /** Step 1: each appliance's average day over the recorded part of the last 7 days, plus what is not yet named. */
 function dailyUsage(){
  const end=clock(),start=end-HISTORY_DAYS*DAY_MS,snap=service.snapshot()
  const mains=snap.devices.find(d=>d.role==='whole_home')
  const devices=snap.devices.filter(d=>d.role==='appliance').map(d=>{
   const u=service.usage(d.id,start,end),covered=u.covered_hours/24
   return {id:d.id,name:d.name,kind:d.kind,critical:d.critical,covered_days:covered,
    kwh_day:covered>0&&u.energy_wh!=null?kwh(u.energy_wh)/covered:0,hours_day:covered>0?u.hours_on/covered:0}
  })
  let home=null,days=Math.max(0,...devices.map(d=>d.covered_days)),basis=null
  if(mains){const u=service.usage(mains.id,start,end);days=u.covered_hours/24;home=days>0&&u.energy_wh!=null?kwh(u.energy_wh)/days:null;basis=u.energy_basis}
  const named=devices.reduce((s,d)=>s+d.kwh_day,0)
  return {days_of_data:days,home_kwh_day:home??named,named_kwh_day:named,unnamed_kwh_day:home==null?0:Math.max(0,home-named),devices,apparent:isApparent(basis)||isApparent(snap.demand_basis)}
 }

 // --- meter check ---
 function meterReadings(){return db.prepare('SELECT id,at,units_left FROM meter_readings ORDER BY at').all()}
 /** The newest reading against the oldest one at least a day before it, with no top-up in between. */
 function meter(){
  const rows=meterReadings(),last=rows.at(-1)
  const base={readings:rows.slice(-5).reverse(),ratio:null,meter_kwh:null,app_kwh:null,message:null}
  if(rows.length<2)return {...base,message:rows.length?'Enter the meter again in a day or more to compare.':'Not checked against the meter yet.'}
  let first=null
  for(const r of rows){if(Date.parse(last.at)-Date.parse(r.at)>=METER_MIN_MS)first=r;else break}
  if(!first)return {...base,message:'Enter the meter again once a day has passed since the first reading.'}
  const between=rows.filter(r=>r.at>=first.at&&r.at<=last.at)
  if(between.some((r,i)=>i&&r.units_left>between[i-1].units_left+0.05))return {...base,message:'A top-up happened between the readings. Enter the meter again now and in a day.'}
  const mains=service.snapshot().devices.find(d=>d.role==='whole_home')
  if(!mains)return {...base,message:'The whole-home clamp is needed to compare with the meter.'}
  const u=service.usage(mains.id,Date.parse(first.at),Date.parse(last.at))
  const meterKwh=first.units_left-last.units_left,appKwh=u.covered_hours>=0.5*u.period_hours?kwh(u.energy_wh):null,ratio=meterRatio(meterKwh,appKwh)
  return {...base,meter_kwh:meterKwh,app_kwh:appKwh,ratio,
   message:ratio!=null?`The meter counted ${meterKwh.toFixed(1)} kWh while the app estimated ${appKwh.toFixed(1)}. App figures are scaled by ${ratio.toFixed(2)}.`
    :appKwh==null?'Too few app readings between the two meter readings to compare.':'The meter and the app do not agree well enough; check the numbers you entered.'}
 }
 function addMeterReading(raw){
  const v=object(raw);keys(v,['units_left'])
  db.prepare('INSERT INTO meter_readings(at,units_left) VALUES(?,?)').run(new Date(clock()).toISOString(),number(v.units_left,'units_left',0,1e6))
  return meter()
 }

 // --- plan ---
 function input(raw){
  const v=object(raw);keys(v,['amount','unit','days','tariff_ghs_per_kwh','tariff_category','keep_on'])
  const unit=oneOf(v.unit??'ghs','unit',['ghs','kwh']),amount=number(v.amount,'amount',0.01,1e6),days=number(v.days,'days',1,90)
  // Cedis -> kWh: the ECG tariff by default (blocks, levies, service charge, lifeline refund), or a flat price.
  const cfg=config(db),flat=optionalNumber(v.tariff_ghs_per_kwh,'tariff_ghs_per_kwh',0.01,1000)??(cfg.tariff.scheme==='flat'?cfg.rates.grid:null)
  const category=oneOf(v.tariff_category??cfg.tariff.category,'tariff_category',['residential','non_residential'])
  const tariff=flat!=null?{scheme:'flat',name:`GHS ${flat}/kWh`,price_ghs_per_kwh:flat}:{scheme:'ecg',name:ECG_TARIFF.name,category}
  if(unit==='ghs'&&tariff.scheme==='flat'&&!(flat>0))fail('Enter your price per kWh (GHS), or enter the amount as kWh units.')
  const budget=unit==='kwh'?amount:tariff.scheme==='flat'?amount/flat:ecgKwhForCredit(amount,days,category)
  if(unit==='ghs'&&tariff.scheme==='ecg'){tariff.average_price_ghs_per_kwh=budget>0?amount/budget:null;tariff.service_only_ghs=Math.round(ecgCostForPeriod(0,days,category)*100)/100}
  if(v.keep_on!=null&&(!Array.isArray(v.keep_on)||v.keep_on.length>64))fail('keep_on must be a list of device ids')
  const appliances=service.snapshot().devices.filter(d=>d.role==='appliance').map(d=>d.id)
  const keepOn=(v.keep_on??[]).map(x=>{const i=id(x,'keep_on');if(!appliances.includes(i))fail(`Unknown appliance: ${i}`);return i})
  return {amount,unit,days,tariff,keep_on:keepOn,budget_kwh:budget}
 }
 function compute(i){
  const usage=dailyUsage(),m=meter()
  const plan=rationPlan({budget_kwh:i.budget_kwh,days:i.days,devices:usage.devices,unnamed_kwh_day:usage.unnamed_kwh_day,days_of_data:usage.days_of_data,meter_ratio:m.ratio??1,keep_on:i.keep_on})
  return {input:i,plan,usage:{days_of_data:Math.round(usage.days_of_data*10)/10,apparent:usage.apparent,named_kwh_day:usage.named_kwh_day,unnamed_kwh_day:usage.unnamed_kwh_day},meter:m}
 }
 const preview=raw=>compute(input(raw))
 function save(raw){
  const result=compute(input(raw)),saved={created_at:new Date(clock()).toISOString(),...result}
  db.prepare('INSERT INTO rationing VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(saved))
  return current()
 }
 function end(){db.prepare('DELETE FROM rationing WHERE id=1').run();return current()}
 const active=()=>{const r=db.prepare('SELECT payload FROM rationing WHERE id=1').get();return r?JSON.parse(r.payload):null}

 /** Step 5: how the saved plan is going. Used energy is the whole-home clamp, scaled by the meter check. */
 function progress(p){
  const now=clock(),start=Date.parse(p.created_at),ratio=meter().ratio??p.plan.meter_ratio??1
  const mains=service.snapshot().devices.find(d=>d.role==='whole_home')
  const used=(from,to)=>{if(!mains)return null;const u=service.usage(mains.id,from,to);return u.energy_wh==null?0:kwh(u.energy_wh)*ratio}
  const usedTotal=used(start,now),today=used(Math.max(start,midnight()),now)
  const daysGone=(now-start)/DAY_MS,daysLeft=Math.max(0,p.input.days-daysGone)
  const left=usedTotal==null?null:Math.max(0,p.plan.budget_kwh-usedTotal)
  const limits=p.plan.cuts.map(c=>{let hours=null;try{hours=service.usage(c.id,midnight(),now).hours_on}catch{}
   return {id:c.id,name:c.name,limit_hours:c.to_hours,hours_today:hours,over:hours!=null&&hours>c.to_hours+0.05}})
  const perDayLeft=left!=null&&daysLeft>0?left/daysLeft:null
  const status=left===0?'used_up':today!=null&&today>p.plan.daily_budget_kwh?'over_today':limits.some(l=>l.over)?'over_limit':'on_track'
  return {status,days_gone:daysGone,days_left:daysLeft,used_kwh:usedTotal,today_kwh:today,today_budget_kwh:p.plan.daily_budget_kwh,
   left_kwh:left,per_day_left_kwh:perDayLeft,limits}
 }
 function current(){const p=active();return {plan:p,progress:p?progress(p):null,meter:meter()}}

 /** One line for the assistant's view of the house while a plan is running. */
 function stateText(){
  const p=active();if(!p)return null
  const g=progress(p),f=v=>v==null?'unknown':v.toFixed(1)
  return `Credit plan: ${f(g.today_kwh)} of ${f(g.today_budget_kwh)} kWh used today; ${f(g.left_kwh)} kWh left for ${g.days_left.toFixed(1)} days (${g.status.replace('_',' ')}).`
 }
 return {dailyUsage,preview,save,end,current,meter,addMeterReading,stateText}
}

/** The plan in plain sentences for the assistant to explain. Numbers only from the calculation. */
export function planText({input,plan,usage}){
 const f=v=>v==null?'unknown':String(v)
 const price=input.tariff?.scheme==='ecg'?`under the ${input.tariff.name}, ${input.tariff.category==='non_residential'?'non-residential':'residential'}, about GHS ${input.tariff.average_price_ghs_per_kwh?.toFixed(2)} per kWh with all charges`:`at ${input.tariff?.name}`
 const head=`Budget ${f(plan.budget_kwh)} kWh${input.unit==='ghs'?` (GHS ${input.amount} ${price})`:''} for ${input.days} days = ${f(plan.daily_budget_kwh)} kWh a day.`
 if(plan.status==='insufficient_data')return `${head} Not enough recorded use yet (${f(usage.days_of_data)} days); no plan can be made.`
 const lines=[head,`The home uses about ${f(plan.baseline_kwh_day)} kWh a day; at this pace the credit lasts ${f(plan.days_at_current_pace)} days.`]
 if(plan.status==='already_fits')lines.push('No changes are needed.')
 else{
  for(const c of plan.cuts)lines.push(c.action==='off'?`Switch off ${c.name} (now ${c.from_hours} h a day): saves ${c.saves_kwh_day} kWh a day.`:`Limit ${c.name} from ${c.from_hours} h to ${c.to_hours} h a day: saves ${c.saves_kwh_day} kWh a day.`)
  for(const k of plan.kept_on)lines.push(`${k.name} stays on (${k.why}).`)
  if(plan.unnamed_kwh_day>0.05)lines.push(`${f(plan.unnamed_kwh_day)} kWh a day comes from devices that are not named yet.`)
  lines.push(plan.status==='cannot_fit'?`Even with these changes it lasts ${f(plan.days_with_plan)} days; ${f(plan.shortfall_kwh_day)} kWh a day short.`:`With these changes it lasts ${f(plan.days_with_plan)} days.`)
 }
 if(plan.low_confidence)lines.push(`Only ${f(usage.days_of_data)} days of readings: a rough estimate.`)
 return lines.join(' ')
}
