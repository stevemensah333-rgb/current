import {useEffect,useRef,useState} from 'react'
import {useEnergy} from './store'
import {alertText,api,type Provider} from './telemetry'
import {FloatingCard,Icon} from './ui'

type Job={job_id:string;status:'running'|'done'|'failed'|'cancelled';provider:Provider;model:string;reply:string|null;error:string|null;confirm:{token:string;device:string}|null}
type Turn={question:string;job:Job|null;note?:string}

const EXAMPLES=['What is on right now?','How long was the kettle on today?','Is any device showing a problem?']
const PROVIDERS:{id:Provider;label:string;note:string}[]=[
 {id:'local',label:'This computer',note:'Private: nothing leaves this computer. An answer can take 1–3 minutes.'},
 {id:'cloud',label:'Cloud',note:'Faster. Your home’s readings are sent to DeepSeek.'}
]

/** Models often mark words as **bold**; show that as bold text, nothing else (no HTML is ever inserted). */
const withBold=(text:string)=>text.split(/\*\*(.+?)\*\*/g).map((part,i)=>i%2?<b key={i}>{part}</b>:part)

/** Open alerts from the pipeline. The sentence is written here, from structured fields. */
export function AlertList(){
 const s=useEnergy(),alerts=s.telemetry?.alerts||[]
 const name=(id:string)=>s.telemetry?.devices.find(d=>d.id===id)?.name||id
 if(!alerts.length)return null
 return <div className="alert-list" role="status">{alerts.map(a=><p key={a.id} className="attention"><Icon name="alert" size={16}/> {alertText(a,name)} <button className="icon-button alert-dismiss" aria-label="Dismiss this alert" title="Dismiss" disabled={s.busy} onClick={()=>void s.mutate(`/alerts/${a.id}/ack`,'POST')}><Icon name="close" size={16}/></button></p>)}</div>
}

export function AssistantPanel({close}:{close:()=>void}){
 const s=useEnergy(),provider=s.telemetry?.settings.assistant?.provider||'local'
 const [message,setMessage]=useState(''),[turns,setTurns]=useState<Turn[]>([]),[error,setError]=useState('')
 const current=turns.at(-1),running=current?.job?.status==='running'
 const timer=useRef<number|null>(null)
 const [slow,setSlow]=useState(false),[startedAt,setStartedAt]=useState(0),[now,setNow]=useState(Date.now())
 useEffect(()=>{if(!running)return;const tick=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(tick)},[running])
 const elapsed=Math.max(0,Math.round((now-startedAt)/1000)),clock=`${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`
 const cloudMissing=provider==='cloud'&&s.telemetry?.ai.cloud_ready===false

 // A question may still be running from before the panel was closed: pick it up again.
 useEffect(()=>{void api<{job:Job|null}>('/assistant/current').then(r=>{if(r.job)setTurns(t=>t.length?t:[{question:'(earlier question)',job:r.job}])}).catch(()=>{})},[])

 useEffect(()=>{
  if(!running||!current?.job)return
  const id=current.job.job_id
  timer.current=window.setInterval(async()=>{
   try{const job=await api<Job>(`/assistant/${id}`);setSlow(false);setTurns(t=>t.map((x,i)=>i===t.length-1?{...x,job}:x))}
   catch(e){
    const message=(e as Error).message
    // Only 'not found' is final (the backend restarted). Anything else may be a slow poll: keep trying.
    if(/not found/i.test(message))setTurns(t=>t.map((x,i)=>i===t.length-1?{...x,job:{...x.job!,status:'failed',error:message}}:x))
    else setSlow(true)
   }
  },2000)
  return()=>{if(timer.current)window.clearInterval(timer.current)}
 },[running,current?.job?.job_id])

 const ask=async(text=message)=>{
  const question=text.trim();if(!question||running)return
  setStartedAt(Date.now());setNow(Date.now())
  setError('');setMessage('')
  try{const started=await api<{job_id:string;provider:Provider;model:string}>('/assistant','POST',{message:question})
   setTurns(t=>[...t,{question,job:{job_id:started.job_id,status:'running',provider:started.provider,model:started.model,reply:null,error:null,confirm:null}}])}
  catch(e){setError((e as Error).message)}
 }
 const cancel=async()=>{if(current?.job)try{const job=await api<Job>(`/assistant/${current.job.job_id}`,'DELETE');setTurns(t=>t.map((x,i)=>i===t.length-1?{...x,job}:x))}catch(e){setError((e as Error).message)}}
 const confirm=async(turn:number,token:string)=>{
  try{const r=await api<{message:string}>('/assistant/confirm','POST',{token});setTurns(t=>t.map((x,i)=>i===turn?{...x,note:r.message,job:{...x.job!,confirm:null}}:x));void s.refresh()}
  catch(e){setTurns(t=>t.map((x,i)=>i===turn?{...x,note:(e as Error).message,job:{...x.job!,confirm:null}}:x))}
 }
 const choose=(id:Provider)=>{if(id!==provider&&!running)void s.mutate('/settings','PUT',{assistant:{provider:id}})}

 return <FloatingCard title="Ask about your home" eyebrow="ASSISTANT" close={close}>
  <div className="assistant-toggle segmented" role="radiogroup" aria-label="Where the assistant runs">
   {PROVIDERS.map(p=><button key={p.id} role="radio" aria-checked={provider===p.id} className={provider===p.id?'active':''} disabled={running||s.busy} onClick={()=>choose(p.id)}>{p.label}</button>)}
  </div>
  <p className="quiet-note">{PROVIDERS.find(p=>p.id===provider)!.note}</p>
  {cloudMissing&&<p className="attention">The cloud assistant is not set up yet. Choose This computer, or see Technical details below.</p>}
  {!turns.length&&<div className="example-questions" aria-label="Example questions">{EXAMPLES.map(q=><button key={q} className="outline small-action" disabled={cloudMissing||running} onClick={()=>void ask(q)}>{q}</button>)}</div>}
  <p className="visually-hidden" aria-live="polite">{current?.job?.status==='done'?current.job.reply:current?.job?.status==='failed'?current.job.error:''}</p>
  <div className="assistant-turns">
   {turns.map((t,i)=><div key={i} className="assistant-turn panel">
    <p><b>You:</b> {t.question}</p>
    {t.job?.status==='running'&&<p className="muted">Thinking… {clock}{slow?' (slow connection, still waiting)':''}<br/><small>You can close this card. The answer keeps coming.</small></p>}
    {t.job?.status==='done'&&<p>{withBold(t.job.reply||'')}</p>}
    {t.job?.status==='failed'&&<p className="attention">{t.job.error}</p>}
    {t.job?.status==='cancelled'&&<p className="muted">Cancelled.</p>}
    {t.job?.confirm&&<button className="primary" onClick={()=>void confirm(i,t.job!.confirm!.token)}>Switch off {t.job.confirm.device}?</button>}
    {t.note&&<p className="quiet-note">{t.note}</p>}
    {t.job&&t.job.status!=='running'&&<p className="quiet-note">Answered {t.job.provider==='cloud'?'in the cloud':'on this computer'}</p>}
   </div>)}
  </div>
  {error&&<p className="attention" role="alert">{error}</p>}
  <form className="assistant-ask" onSubmit={e=>{e.preventDefault();void ask()}}>
   <label>Your question<input value={message} maxLength={500} onChange={e=>setMessage(e.target.value)} placeholder="How long was the kettle on today?" disabled={running}/></label>
   {running?<button type="button" className="outline full" onClick={()=>void cancel()}>Cancel</button>:<button className="primary full" disabled={!message.trim()||cloudMissing}>Ask</button>}
  </form>
  <p className="quiet-note">Switching off always asks you first.</p>
  <details className="more-details"><summary>Technical details</summary><div><p>This computer: LFM3-1.7B in LM Studio. Cloud: {s.telemetry?.ai.cloud_name==='claude'?'Claude, by Anthropic':'DeepSeek'}.</p><p>Power values are estimates from one current clamp.</p>{cloudMissing&&<p>To use the cloud, add {s.telemetry?.ai.cloud_name==='claude'?'ANTHROPIC_API_KEY':'DEEPSEEK_API_KEY'} to the .env file and restart the app.</p>}</div></details>
 </FloatingCard>
}
