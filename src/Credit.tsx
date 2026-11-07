import {useEffect,useRef,useState} from 'react'
import {useEnergy} from './store'
import {api} from './telemetry'
import {Icon} from './ui'

type Cut={id:string;name:string;action:'limit'|'off';from_hours:number;to_hours:number;saves_kwh_day:number;why:string}
type Plan={status:'already_fits'|'fits_with_cuts'|'cannot_fit'|'insufficient_data';budget_kwh:number;days:number;daily_budget_kwh:number;baseline_kwh_day:number|null;days_at_current_pace:number|null;gap_kwh_day:number;cuts:Cut[];kept_on:{id:string;name:string;why:string}[];planned_kwh_day:number|null;days_with_plan:number|null;shortfall_kwh_day:number;unnamed_kwh_day:number;low_confidence:boolean;meter_ratio:number;assumptions:string[]}
type Input={amount:number;unit:'ghs'|'kwh';days:number;tariff:number|null;keep_on:string[];budget_kwh:number}
type Meter={readings:{id:number;at:string;units_left:number}[];ratio:number|null;message:string|null}
type Result={input:Input;plan:Plan;usage:{days_of_data:number;apparent:boolean};meter:Meter}
type Progress={status:'on_track'|'over_today'|'over_limit'|'used_up';days_gone:number;days_left:number;used_kwh:number|null;today_kwh:number|null;today_budget_kwh:number;left_kwh:number|null;per_day_left_kwh:number|null;limits:{id:string;name:string;limit_hours:number;hours_today:number|null;over:boolean}[]}
type Current={plan:(Result&{created_at:string})|null;progress:Progress|null;meter:Meter}
type Job={job_id:string;status:'running'|'done'|'failed'|'cancelled';reply:string|null;error:string|null}

const kwh=(v:number|null|undefined,d=1)=>v==null?'—':`${v.toFixed(d)} kWh`
// Observed hours are shown to the nearest quarter hour: 4.97 h reads "5 h", 3.6 h reads "3.5 h", 0.47 h reads "28 min".
const hours=(h:number)=>{if(h===0)return '0 h';if(h<1)return `${Math.round(h*60)} min`;const q=Math.round(h*4)/4;return `${q.toFixed(2).replace(/\.?0+$/,'')} h`}
const days=(d:number|null)=>d==null?'—':`${d.toFixed(1)} days`

/** Ask the assistant (DeepSeek when Cloud is chosen) to explain the plan; it gets its numbers from plan_rationing. */
function useExplain(){
 const [job,setJob]=useState<Job|null>(null),[error,setError]=useState(''),timer=useRef<ReturnType<typeof setInterval>|null>(null)
 useEffect(()=>()=>{if(timer.current)clearInterval(timer.current)},[])
 const ask=async(message:string)=>{
  setError('');setJob(null);if(timer.current)clearInterval(timer.current)
  try{const started=await api<{job_id:string}>('/assistant','POST',{message})
   const poll=async()=>{try{const j=await api<Job>(`/assistant/${started.job_id}`);setJob(j);if(j.status!=='running'&&timer.current)clearInterval(timer.current)}catch(e){setError((e as Error).message);if(timer.current)clearInterval(timer.current)}}
   setJob({job_id:started.job_id,status:'running',reply:null,error:null});timer.current=setInterval(()=>void poll(),1500)
  }catch(e){setError((e as Error).message)}
 }
 return {job,error,ask}
}
function Explanation({job,error}:{job:Job|null;error:string}){
 if(error)return <p className="attention" role="alert">{error}</p>
 if(!job)return null
 return <div className="credit-ai" role="status" aria-live="polite"><p className="eyebrow">THE ASSISTANT SAYS</p>
  {job.status==='running'?<p className="quiet-note">Thinking…</p>:job.status==='done'?<p>{job.reply}</p>:<p className="attention">{job.error||'The assistant could not answer.'}</p>}</div>
}
const askText=(i:{amount:number;unit:'ghs'|'kwh';days:number},keep:string[])=>`Make ${i.unit==='ghs'?`GHS ${i.amount}`:`${i.amount} kWh`} of prepaid credit last ${i.days} days.${keep.length?` Keep these on: ${keep.join(', ')}.`:''} What should I limit or switch off?`

function PlanResult({r,keep,toggleKeep}:{r:Result;keep:string[];toggleKeep:(id:string)=>void}){
 const p=r.plan
 if(p.status==='insufficient_data')return <div className="credit-result"><h3>Not enough readings yet</h3><p className="muted">The plan needs at least a day of readings from the home monitor ({r.usage.days_of_data} so far). Leave it running and come back tomorrow.</p></div>
 const head=p.status==='already_fits'?`Good news: at your pace it already lasts ${days(p.days_at_current_pace)}.`
  :p.status==='fits_with_cuts'?`At your pace it lasts ${days(p.days_at_current_pace)}. With these changes, ${days(p.days_with_plan)}.`
  :`Even with every change below it lasts ${days(p.days_with_plan)}, not ${p.days}.`
 return <div className="credit-result">
  <h3>{head}</h3>
  <div className="credit-facts">
   <div><span>You can use</span><b>{kwh(p.daily_budget_kwh,2)}</b><small>a day ({kwh(p.budget_kwh)} over {p.days} days)</small></div>
   <div><span>You use now</span><b>{kwh(p.baseline_kwh_day,2)}</b><small>a day, average of {r.usage.days_of_data} days</small></div>
   <div className={p.gap_kwh_day>0?'gap':''}><span>To save</span><b>{kwh(p.gap_kwh_day,2)}</b><small>a day</small></div>
  </div>
  {p.cuts.length>0&&<><p className="eyebrow">WHAT TO CHANGE</p><ul className="cut-list">{p.cuts.map(c=><li key={c.id}>
   <span className={`cut-action ${c.action}`}>{c.action==='off'?'Switch off':'Limit'}</span>
   <div><b>{c.name}</b><small>{c.action==='off'?`Off for the whole period (now ${hours(c.from_hours)} a day)`:`${hours(c.from_hours)} → ${hours(c.to_hours)} a day`} · saves {kwh(c.saves_kwh_day,2)} a day</small></div>
   <button type="button" className="text-link" onClick={()=>toggleKeep(c.id)}>Keep it on</button></li>)}</ul></>}
  {p.kept_on.length>0&&<ul className="kept-list">{p.kept_on.map(k=><li key={k.id}><Icon name="check" size={14}/><span><b>{k.name}</b> stays on · {k.why}</span>{keep.includes(k.id)&&<button type="button" className="text-link" onClick={()=>toggleKeep(k.id)}>Allow changes</button>}</li>)}</ul>}
  {p.status==='cannot_fit'&&<p className="attention">Still {kwh(p.shortfall_kwh_day,2)} a day short. Choose fewer days or add credit{keep.length?', or allow changes to the appliances you kept on':''}.</p>}
  {p.unnamed_kwh_day>0.05&&<p className="quiet-note">{kwh(p.unnamed_kwh_day,2)} a day comes from appliances that are not registered yet, so the plan cannot name them. Register them under Appliances for a better plan.</p>}
  {p.low_confidence&&<p className="quiet-note">Only {r.usage.days_of_data} days of readings so far: treat this as a rough estimate.</p>}
  <details className="more-details"><summary>How this is worked out</summary><div>{p.assumptions.map(a=><p key={a}>{a}.</p>)}<p>Biggest non-essential appliances are limited first, by up to half their hours, before anything is switched off. Appliances marked “keep on in a power cut” are trimmed last, by a quarter at most. Fridges always stay on.</p></div></details>
 </div>
}

function MeterCheck({meter,saved}:{meter:Meter;saved:(m:Meter)=>void}){
 const [units,setUnits]=useState(''),[error,setError]=useState('')
 const save=async(e:React.FormEvent)=>{e.preventDefault();const v=Number(units);if(!(v>=0)||units.trim()===''){setError('Enter the units left on your meter, for example 84.5.');return}
  try{saved(await api<Meter>('/rationing/meter','POST',{units_left:v}));setUnits('');setError('')}catch(err){setError((err as Error).message)}}
 return <details className="more-details meter-check"><summary>Check against your prepaid meter {meter.ratio!=null&&<span className="meter-ok">· checked</span>}</summary><div>
  <p>The app estimates use from current alone, which can read high for fans, fridges and ACs. Type the units left on your meter today, and again in a day or more. The app then corrects its numbers to match the meter.</p>
  <form className="meter-form" onSubmit={e=>void save(e)}><label>Units left on the meter (kWh)<input type="number" min="0" step="any" value={units} onChange={e=>setUnits(e.target.value)} placeholder="For example, 84.5"/></label><button className="outline" type="submit">Save reading</button></form>
  {error&&<p className="attention" role="alert">{error}</p>}
  {meter.message&&<p className={meter.ratio!=null?'meter-msg ok':'meter-msg'}>{meter.message}</p>}
  {meter.readings.length>0&&<ul className="meter-readings">{meter.readings.map(r=><li key={r.id}><span>{new Date(r.at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span><b>{r.units_left} kWh left</b></li>)}</ul>}
 </div></details>
}

function Tracking({c,change,end,busy}:{c:Current;change:()=>void;end:()=>void;busy:boolean}){
 const p=c.plan!,g=c.progress!,{job,error,ask}=useExplain()
 const label={on_track:'On track',over_today:'Over today’s budget',over_limit:'An appliance is over its limit',used_up:'The credit is used up'}[g.status]
 const share=g.today_kwh==null?0:Math.min(100,g.today_kwh/g.today_budget_kwh*100)
 const keep=p.plan.kept_on.filter(k=>/asked/.test(k.why)).map(k=>k.name)
 return <div className="credit-track">
  <div className={`credit-status ${g.status}`}><Icon name={g.status==='on_track'?'check':'alert'} size={18}/><div><h3>{label}</h3><p>Day {Math.min(p.input.days,Math.floor(g.days_gone)+1)} of {p.input.days} · {p.input.unit==='ghs'?`GHS ${p.input.amount}`:`${p.input.amount} kWh`} to last {p.input.days} days</p></div></div>
  <div className="credit-today"><div className="credit-today-top"><span>Used today</span><b>{kwh(g.today_kwh,2)} of {kwh(g.today_budget_kwh,2)}</b></div>
   <div className="credit-bar" role="img" aria-label={`${Math.round(share)}% of today's budget used`}><i style={{width:`${share}%`}} className={g.today_kwh!=null&&g.today_kwh>g.today_budget_kwh?'over':''}/></div></div>
  <div className="credit-facts">
   <div><span>Credit left</span><b>{kwh(g.left_kwh)}</b><small>of {kwh(p.plan.budget_kwh)}</small></div>
   <div><span>Days left</span><b>{g.days_left.toFixed(1)}</b><small>of {p.input.days}</small></div>
   <div className={g.per_day_left_kwh!=null&&g.per_day_left_kwh<p.plan.daily_budget_kwh?'gap':''}><span>To finish on time</span><b>{kwh(g.per_day_left_kwh,2)}</b><small>a day from now</small></div>
  </div>
  {g.limits.length>0&&<><p className="eyebrow">TODAY’S LIMITS</p><ul className="cut-list">{g.limits.map(l=><li key={l.id} className={l.over?'over':''}>
   <span className={`cut-action ${l.limit_hours===0?'off':'limit'}`}>{l.limit_hours===0?'Off':`≤ ${hours(l.limit_hours)}`}</span>
   <div><b>{l.name}</b><small>{l.hours_today==null?'No reading today':`On ${hours(Math.round(l.hours_today*4)/4)} today`}{l.over?' · over the limit':''}</small></div></li>)}</ul></>}
  <div className="credit-actions"><button type="button" className="outline" onClick={()=>void ask(`${askText(p.input,keep)} I have ${kwh(g.left_kwh)} left for ${g.days_left.toFixed(1)} days.`)} disabled={job?.status==='running'}>Ask the assistant for tips <Icon name="chat" size={16}/></button>
   <button type="button" className="outline" onClick={change}>Change plan</button><button type="button" className="text-link danger" onClick={end} disabled={busy}>End plan</button></div>
  <Explanation job={job} error={error}/>
 </div>
}

/** Make prepaid credit last: enter the credit and the days, see which appliances to limit, then follow the plan day by day. */
export function CreditPlan(){
 const rates=useEnergy(s=>s.telemetry?.settings.rates.grid??null),devices=useEnergy(s=>s.telemetry?.devices)
 const [current,setCurrent]=useState<Current|null>(null),[editing,setEditing]=useState(false)
 const [amount,setAmount]=useState('100'),[unit,setUnit]=useState<'ghs'|'kwh'>('ghs'),[span,setSpan]=useState('14'),[tariff,setTariff]=useState('')
 const [keep,setKeep]=useState<string[]>([]),[result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const {job,error:aiError,ask}=useExplain()
 const load=async()=>{try{setCurrent(await api<Current>('/rationing'))}catch(e){setError((e as Error).message)}}
 useEffect(()=>{void load();const t=setInterval(()=>void load(),30000);return()=>clearInterval(t)},[])
 useEffect(()=>{if(rates!=null&&tariff==='')setTariff(String(rates))},[rates])
 const body=()=>({amount:Number(amount),unit,days:Number(span),keep_on:keep,...(unit==='ghs'&&tariff!==''?{tariff_ghs_per_kwh:Number(tariff)}:{})})
 const valid=Number(amount)>0&&Number(span)>=1&&Number(span)<=90&&(unit==='kwh'||Number(tariff)>0)
 // The preview follows every change, half a second after typing stops.
 useEffect(()=>{if(!valid){setResult(null);return}const t=setTimeout(async()=>{try{setResult(await api<Result>('/rationing/preview','POST',body()));setError('')}catch(e){setError((e as Error).message);setResult(null)}},500);return()=>clearTimeout(t)},[amount,unit,span,tariff,keep.join(',')])
 const toggleKeep=(id:string)=>setKeep(k=>k.includes(id)?k.filter(x=>x!==id):[...k,id])
 const start=async()=>{setBusy(true);try{setCurrent(await api<Current>('/rationing','PUT',body()));setEditing(false)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const end=async()=>{setBusy(true);try{setCurrent(await api<Current>('/rationing','DELETE'))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const name=(id:string)=>devices?.find(d=>d.id===id)?.name||id
 const meter=current?.meter??result?.meter

 return <div className="credit-screen panel">
  <div className="credit-intro"><p className="eyebrow">MAKE YOUR CREDIT LAST</p><h2>{current?.plan&&!editing?'Your credit plan':'How long should your credit last?'}</h2>
   {!(current?.plan&&!editing)&&<p className="muted">Enter your prepaid credit and the number of days. The app works out how much you can use each day and which appliances to limit, from what your home really uses.</p>}</div>
  {current?.plan&&!editing?<Tracking c={current} busy={busy} change={()=>{const i=current.plan!.input;setAmount(String(i.amount));setUnit(i.unit);setSpan(String(i.days));setKeep(i.keep_on);if(i.tariff)setTariff(String(i.tariff));setEditing(true)}} end={()=>void end()}/>:<>
   <form className="credit-form" onSubmit={e=>{e.preventDefault();void start()}}>
    <fieldset className="unit-toggle"><legend>My credit is in</legend>{(['ghs','kwh'] as const).map(u=><label key={u} className={unit===u?'active':''}><input type="radio" name="unit" checked={unit===u} onChange={()=>setUnit(u)}/>{u==='ghs'?'Cedis (GHS)':'Units (kWh)'}</label>)}</fieldset>
    <label>{unit==='ghs'?'Credit (GHS)':'Units on the meter (kWh)'}<input type="number" min="0.01" step="any" value={amount} onChange={e=>setAmount(e.target.value)} required/></label>
    <label>Make it last (days)<input type="number" min="1" max="90" step="1" value={span} onChange={e=>setSpan(e.target.value)} required/></label>
    {unit==='ghs'&&<label>Price per kWh (GHS)<input type="number" min="0.01" step="any" value={tariff} onChange={e=>setTariff(e.target.value)} placeholder="See your ECG receipt" required/></label>}
   </form>
   {error&&<p className="attention" role="alert">{error}</p>}
   {result&&<PlanResult r={result} keep={keep} toggleKeep={toggleKeep}/>}
   {keep.length>0&&<p className="quiet-note">Kept on at your request: {keep.map(name).join(', ')}.</p>}
   <div className="credit-actions">
    <button type="button" className="primary" disabled={!result||busy||result.plan.status==='insufficient_data'} onClick={()=>void start()}>Start this plan <Icon name="check" size={16}/></button>
    <button type="button" className="outline" disabled={!valid||job?.status==='running'} onClick={()=>void ask(askText({amount:Number(amount),unit,days:Number(span)},keep.map(name)))}>Explain with the assistant <Icon name="chat" size={16}/></button>
    {editing&&<button type="button" className="text-link" onClick={()=>setEditing(false)}>Back to my plan</button>}
   </div>
   <Explanation job={job} error={aiError}/>
  </>}
  {meter&&<MeterCheck meter={meter} saved={m=>{setCurrent(c=>c?{...c,meter:m}:c);void load()}}/>}
 </div>
}
