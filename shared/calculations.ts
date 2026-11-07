/** Pure, deterministic calculations. No network, state, AI or device commands. */
export type PowerBasis='reported'|'calculated_from_voltage_current_pf'|'apparent_estimate_va'|'unavailable'
export type NumericReading = { measured_at:string; boot_id:string; power_w:number|null; energy_total_wh:number|null; basis?:PowerBasis }
export function realPower(input:{power_w?:number|null;voltage_v?:number|null;current_a?:number|null;power_factor?:number|null;apparent_power_va?:number|null}):{value:number|null;basis:PowerBasis} {
 if(input.power_w!=null)return {value:input.power_w,basis:'reported'}
 if(input.voltage_v!=null&&input.current_a!=null&&input.power_factor!=null)
  return {value:input.voltage_v*input.current_a*input.power_factor,basis:'calculated_from_voltage_current_pf'}
 // Apparent power (VA) from a current-only meter at nominal voltage. A stand-in for watts, never presented as watts.
 if(input.apparent_power_va!=null)return {value:input.apparent_power_va,basis:'apparent_estimate_va'}
 return {value:null,basis:'unavailable'}
}
export const isApparent=(basis:string|null|undefined)=>basis==='apparent_estimate_va'||basis==='integrated_apparent_va'
export function energyBetween(a:NumericReading,b:NumericReading,maxGapSeconds:number){
 const seconds=(Date.parse(b.measured_at)-Date.parse(a.measured_at))/1000
 if(seconds<=0)return {wh:0,basis:'none',gap:false}
 if(a.boot_id!==b.boot_id)return {wh:0,basis:'unknown_restart',gap:true}
 if(a.energy_total_wh!=null&&b.energy_total_wh!=null){
  if(b.energy_total_wh<a.energy_total_wh)return {wh:0,basis:'unknown_counter_reset',gap:true}
  return {wh:b.energy_total_wh-a.energy_total_wh,basis:'counter_delta',gap:false}
 }
 if(seconds>maxGapSeconds||a.power_w==null||b.power_w==null)return {wh:0,basis:'unknown_interval',gap:true}
 // Consumers and production channels use positive magnitudes. Signed battery/grid
 // channels must use separate import/export counters for exact directional energy.
 if(a.power_w<0||b.power_w<0)return {wh:0,basis:'unknown_direction',gap:true}
 const apparent=a.basis==='apparent_estimate_va'||b.basis==='apparent_estimate_va'
 return {wh:(a.power_w+b.power_w)/2*seconds/3600,basis:apparent?'integrated_apparent_va':'integrated_power',gap:false}
}
export type BatteryConfig={capacity_kwh:number|null;reserve_pct:number;efficiency:number;max_discharge_w:number|null}
export function backupEstimate(loadW:number|null,soc:number|null,config:BatteryConfig){
 const assumptions=['Constant current load','No solar or grid contribution','Configured battery capacity, efficiency and reserve']
 if(loadW==null||soc==null||config.capacity_kwh==null||config.max_discharge_w==null)
  return {status:'insufficient_data',runtime_hours:null,usable_kwh:null,assumptions}
 const usable=Math.max(0,(soc-config.reserve_pct)/100*config.capacity_kwh*config.efficiency)
 if(loadW>config.max_discharge_w)return {status:'power_limit_exceeded',runtime_hours:0,usable_kwh:usable,assumptions}
 if(loadW<=0)return {status:'no_active_load',runtime_hours:null,usable_kwh:usable,assumptions}
 return {status:usable>0?'estimated':'reserve_reached',runtime_hours:usable/(loadW/1000),usable_kwh:usable,assumptions}
}
export function costAtRate(energyWh:number|null,pricePerKwh:number|null){return energyWh==null||pricePerKwh==null?null:energyWh/1000*pricePerKwh}

// --- ECG tariff (PURC Electricity Tariff Reckoner, effective 1 April 2026) ------------------------------------
// For E kWh in a month:
//   energy  = 1.9688 x min(E, 300) + 2.6015 x max(E - 300, 0)        (residential; non-residential 1.7775 / 2.1649)
//   street light = 3 % of energy, national electrification levy = 2 % of energy
//   service = 2.13 if E <= 30 (lifeline) else 10.73                   (residential; non-residential always 12.43)
//   non-residential only: NHIL & GETFund = 5 % of (energy + service), VAT = 15 % of (energy + service)
//   residential lifeline (E <= 30): refund = 1.15479 x E, i.e. (1.9688 - 0.8690 lifeline rate) x 1.05 levies
//   each part is rounded to the pesewa; total = sum of parts; net = total - refund
// Example: 30 kWh residential = 59.06 + 1.77 + 1.18 + 2.13 = 64.14, minus refund 34.64 = GHS 29.50.
export type TariffCategory='residential'|'non_residential'
type TariffClass={blocks:{upto:number;rate:number}[];street_light:number;nel:number;service:number;lifeline_kwh:number;lifeline_service:number;lifeline_refund_per_kwh:number;nhil_getfund:number;vat:number}
export const ECG_TARIFF={name:'ECG tariff, effective 1 April 2026',effective:'2026-04-01',
 residential:{blocks:[{upto:300,rate:1.9688},{upto:Infinity,rate:2.6015}],street_light:.03,nel:.02,service:10.73,lifeline_kwh:30,lifeline_service:2.13,lifeline_refund_per_kwh:1.15479,nhil_getfund:0,vat:0},
 non_residential:{blocks:[{upto:300,rate:1.7775},{upto:Infinity,rate:2.1649}],street_light:.03,nel:.02,service:12.43,lifeline_kwh:0,lifeline_service:12.43,lifeline_refund_per_kwh:0,nhil_getfund:.05,vat:.15}} as const satisfies {name:string;effective:string;residential:TariffClass;non_residential:TariffClass}
export const DAYS_PER_MONTH=30          // a period's use is priced as its monthly equivalent, then scaled back
const pesewas=(v:number)=>Math.round((v+Number.EPSILON)*100)/100

/** One month's ECG bill for E kWh, part by part, as on the reckoner. */
export function ecgBill(kwh:number,category:TariffCategory='residential'){
 const t:TariffClass=ECG_TARIFF[category],e=Math.max(0,kwh)
 let energy=0,from=0
 for(const b of t.blocks){const part=Math.min(e,b.upto)-from;if(part<=0)break;energy+=part*b.rate;from=b.upto}
 const lifeline=e<=t.lifeline_kwh,service=lifeline?t.lifeline_service:t.service
 const parts={energy:pesewas(energy),street_light:pesewas(energy*t.street_light),nel:pesewas(energy*t.nel),service,
  nhil_getfund:pesewas((energy+service)*t.nhil_getfund),vat:pesewas((energy+service)*t.vat)}
 const total=pesewas(Object.values(parts).reduce((s,v)=>s+v,0)),refund=lifeline?pesewas(e*t.lifeline_refund_per_kwh):0
 return {...parts,total,refund,net:pesewas(total-refund),lifeline}
}
/** What E kWh used over a number of days costs: priced as the monthly equivalent, then scaled to those days.
 * Example: 3.97 kWh a day for 14 days -> 119 kWh a month -> GHS 256.8 a month -> GHS 119.8 for 14 days. */
export function ecgCostForPeriod(kwh:number,days:number,category:TariffCategory='residential'){
 return ecgBill(kwh*DAYS_PER_MONTH/days,category).net*days/DAYS_PER_MONTH
}
/** How many kWh a prepaid credit buys over a number of days: the inverse of ecgCostForPeriod. The bill only ever
 * rises with use (it jumps at the 30 kWh lifeline edge), so halving the search finds the most kWh within the credit. */
export function ecgKwhForCredit(amountGhs:number,days:number,category:TariffCategory='residential'){
 if(ecgCostForPeriod(0,days,category)>amountGhs)return 0
 let lo=0,hi=amountGhs/0.5+1
 for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(ecgCostForPeriod(mid,days,category)<=amountGhs)lo=mid;else hi=mid}
 return lo
}
/** Average price per kWh at a month's use, with every charge and levy included. Example: 119 kWh -> GHS 2.16. */
export function ecgAveragePrice(kwhPerMonth:number,category:TariffCategory='residential'){
 return kwhPerMonth>0?ecgBill(kwhPerMonth,category).net/kwhPerMonth:null
}

// --- Prepaid credit rationing -------------------------------------------------------------------------------
// Example: GHS 100 at GHS 1.80/kWh = 55.6 kWh. To last 14 days that is 3.97 kWh a day. The home uses 6.0 kWh a day,
// so at this pace the credit lasts 9.3 days. The gap, 2.03 kWh a day, is closed by limiting hours of the biggest,
// least essential devices first. Every number here is computed; the assistant only explains the result.
export type RationDevice={id:string;name:string;kind:string;critical:boolean;kwh_day:number;hours_day:number}
export type RationInput={budget_kwh:number;days:number;devices:RationDevice[];unnamed_kwh_day:number;days_of_data:number;meter_ratio?:number;keep_on?:string[]}
export type RationCut={id:string;name:string;action:'limit'|'off';from_hours:number;to_hours:number;saves_kwh_day:number;why:string}
export type RationPlan={status:'already_fits'|'fits_with_cuts'|'cannot_fit'|'insufficient_data';budget_kwh:number;days:number;daily_budget_kwh:number;
 baseline_kwh_day:number|null;days_at_current_pace:number|null;gap_kwh_day:number;cuts:RationCut[];kept_on:{id:string;name:string;why:string}[];
 planned_kwh_day:number|null;days_with_plan:number|null;shortfall_kwh_day:number;unnamed_kwh_day:number;low_confidence:boolean;meter_ratio:number;assumptions:string[]}
/** Devices that must never be cut: switching them off spoils food or stops something that must keep running. */
export const NEVER_OFF_KINDS=['fridge']
const ESSENTIAL_MAX_CUT=0.25        // a device marked "keep on in a power cut" gives up at most a quarter of its hours
const QUARTER=0.25                  // limits are whole quarter hours: 3.25 h, not 3.17 h
const quarterDown=(h:number)=>Math.floor(h/QUARTER+1e-9)*QUARTER
const round=(v:number,d=2)=>Math.round(v*10**d)/10**d

export function rationPlan(input:RationInput):RationPlan{
 const ratio=input.meter_ratio??1,days=input.days,daily=input.budget_kwh/days
 const assumptions=['Daily use per device is its average over the recorded days','Each device uses the same energy for every hour it is on',
  ratio===1?'App readings are not yet checked against the prepaid meter (apparent power can read high for motors)':`App readings are scaled by ${round(ratio,2)} to match the prepaid meter`]
 const unnamed=Math.max(0,input.unnamed_kwh_day)*ratio
 const empty={budget_kwh:round(input.budget_kwh),days,daily_budget_kwh:round(daily),cuts:[],kept_on:[],shortfall_kwh_day:0,unnamed_kwh_day:round(unnamed),low_confidence:input.days_of_data<3,meter_ratio:ratio,assumptions}
 const devices=input.devices.filter(d=>d.kwh_day>0&&d.hours_day>0)
 const baseline=devices.reduce((s,d)=>s+d.kwh_day,0)*ratio+unnamed
 if(input.days_of_data<1||!(baseline>0))return {...empty,status:'insufficient_data',baseline_kwh_day:null,days_at_current_pace:null,gap_kwh_day:0,planned_kwh_day:null,days_with_plan:null}
 const gap=Math.max(0,baseline-daily),pace=input.budget_kwh/baseline
 const keep=new Set(input.keep_on??[]),kept_on:RationPlan['kept_on']=[]
 // How far each device may be cut, and in which pass: first spread cuts over the non-essential devices (up to half
 // their hours, biggest first), then let them go further (down to off), and only then trim essentials by a quarter.
 const candidates:{d:RationDevice;cap:number;pass:number}[]=[]
 for(const d of devices){
  if(keep.has(d.id)){kept_on.push({id:d.id,name:d.name,why:'you asked to keep it on'});continue}
  if(NEVER_OFF_KINDS.includes(d.kind)){kept_on.push({id:d.id,name:d.name,why:'must stay on'});continue}
  if(d.critical)candidates.push({d,cap:ESSENTIAL_MAX_CUT,pass:3})
  else{candidates.push({d,cap:.5,pass:1});candidates.push({d,cap:1,pass:2})}
 }
 const cutHours=new Map<string,number>()   // device id -> hours a day removed
 let remaining=gap
 for(const pass of [1,2,3]){
  for(const c of candidates.filter(x=>x.pass===pass).sort((a,b)=>b.d.kwh_day-a.d.kwh_day)){
   if(remaining<=1e-9)break
   const perHour=c.d.kwh_day/c.d.hours_day*ratio,already=cutHours.get(c.d.id)??0
   // A device on for less than a quarter hour a day can only be switched off entirely.
   const room=(c.cap>=1?c.d.hours_day:quarterDown(c.d.hours_day*c.cap))-already
   if(room<=1e-9)continue
   // The fewest whole quarter hours that close the rest of the gap, never more than this pass allows.
   const want=Math.min(room,Math.ceil(remaining/perHour/QUARTER-1e-9)*QUARTER)
   cutHours.set(c.d.id,already+want);remaining-=want*perHour
  }
 }
 const cuts:RationCut[]=[...cutHours].filter(([,h])=>h>0).map(([id,h])=>{
  const d=devices.find(x=>x.id===id)!,to=Math.max(0,d.hours_day-h),off=to<QUARTER-1e-9
  return {id,name:d.name,action:off?'off' as const:'limit' as const,from_hours:round(d.hours_day),to_hours:off?0:round(to),saves_kwh_day:round(d.kwh_day/d.hours_day*(off?d.hours_day:h)*ratio),
   why:d.critical?'essential: trimmed by at most a quarter':off?'not essential, and the gap needs all of it':'one of the biggest non-essential users'}
 }).sort((a,b)=>b.saves_kwh_day-a.saves_kwh_day)
 const saved=cuts.reduce((s,c)=>s+c.saves_kwh_day,0),planned=Math.max(0,baseline-saved)
 const shortfall=Math.max(0,planned-daily)
 const status=gap<=0?'already_fits':shortfall>0.005?'cannot_fit':'fits_with_cuts'
 return {...empty,status,baseline_kwh_day:round(baseline),days_at_current_pace:round(pace,1),gap_kwh_day:round(gap),cuts,kept_on,
  planned_kwh_day:round(planned),days_with_plan:planned>0?round(input.budget_kwh/planned,1):null,shortfall_kwh_day:round(shortfall)}
}

/** Prepaid meter check: how the meter's kWh compare with the app's own estimate over the same time.
 * Example: the meter's units fell by 10.0 kWh while the app counted 12.5 kVAh -> ratio 0.80. */
export function meterRatio(meterKwh:number,appKwh:number|null){
 if(appKwh==null||!(appKwh>0.5)||!(meterKwh>0))return null
 const r=meterKwh/appKwh
 return r>=0.3&&r<=1.5?r:null     // outside this the readings do not describe the same thing (wrong entry, gaps)
}
