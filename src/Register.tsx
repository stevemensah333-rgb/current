import {useEffect,useRef,useState} from 'react'
import {useEnergy} from './store'
import {api} from './telemetry'
import {useRoomNames} from './home/layout'
import {Icon,Modal} from './ui'

type Turn={id:number;status:'kept'|'waiting'|'redo'|'refused'|'ignored';number:number|null;message:string;on_step_va:number|null;off_step_va:number|null;shape:number[]|null;has_waveform:boolean;received_at:string}
type Registration={id:string;name:string;setting:string|null;kind:string;room:string;device_id:string;status:'waiting'|'running'|'done'|'failed'|'cancelled';message:string|null;target:number;kept:number;turns:Turn[]}
type Waveform={readings_per_cycle:number;on:{before:number[][];after:number[][]};off:{before:number[][];after:number[][]}}

const KINDS=[['kettle','Kettle'],['fridge','Fridge'],['ac','Air conditioner'],['tv','Television'],['fan','Fan'],['lights','Lights'],['generic','Other']] as const
const ROOM_MAX=16
const active=(r:Registration|null)=>r?.status==='waiting'||r?.status==='running'
const va=(v:number|null)=>v==null?'—':`${v>0?'+':''}${Math.round(v).toLocaleString()} VA`

/** What to do now, from the newest turn. */
function instruction(r:Registration){
 if(r.status==='waiting')return 'Getting the home monitor ready to listen…'
 const last=r.turns.at(-1),next=r.kept+1
 if(last?.status==='waiting')return `Turn ${last.number??next}: now switch ${r.name} off.`
 return `Turn ${next} of ${r.target}: switch ${r.name} on, and wait until it runs steadily (about 2 seconds). Then switch it off.`
}

/** The device's steady shape: one averaged mains cycle. */
function Shape({values}:{values:number[]}){
 const max=Math.max(...values.map(Math.abs),1e-9),w=100,h=36
 const points=values.map((v,i)=>`${(i/(values.length-1)*w).toFixed(1)},${(h/2-v/max*(h/2-2)).toFixed(1)}`).join(' ')
 return <svg className="turn-shape" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2={w} y1={h/2} y2={h/2}/><polyline points={points}/></svg>
}

/** The raw clamp readings of one switch: the cycles before it, then every cycle after it, as stored. */
function Trace({label,before,after}:{label:string;before:number[][];after:number[][]}){
 const all=[...before,...after].flat(),max=Math.max(...all.map(Math.abs),1e-9),w=600,h=90,cut=before.flat().length
 const points=all.map((v,i)=>`${(i/(all.length-1)*w).toFixed(1)},${(h/2-v/max*(h/2-3)).toFixed(1)}`).join(' ')
 return <figure className="trace"><figcaption>{label} · {before.length + after.length} cycles · peak {max.toFixed(2)} A</figcaption>
  <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${label}: raw current readings`}><line className="axis" x1="0" x2={w} y1={h/2} y2={h/2}/><line className="switch-at" x1={cut/(all.length-1)*w} x2={cut/(all.length-1)*w} y1="0" y2={h}/><polyline points={points}/></svg></figure>
}

function TurnRow({reg,turn}:{reg:Registration;turn:Turn}){
 const [wave,setWave]=useState<Waveform|null>(null),[open,setOpen]=useState(false),[error,setError]=useState('')
 const toggle=async()=>{setOpen(o=>!o);if(wave||open)return;try{setWave((await api<{waveform:Waveform}>(`/registrations/${reg.id}/turns/${turn.id}/waveform`)).waveform)}catch(e){setError((e as Error).message)}}
 return <li className="turn-row">
  <span className="turn-check"><Icon name="check" size={15}/></span>
  <div><b>Turn {turn.number}</b><small>{va(turn.on_step_va)} on · {va(turn.off_step_va)} off</small></div>
  {turn.shape&&<Shape values={turn.shape}/>}
  {turn.has_waveform&&<button type="button" className="text-link" aria-expanded={open} onClick={()=>void toggle()}>{open?'Hide':'Waveform'}</button>}
  {open&&<div className="turn-wave">{error?<p className="attention">{error}</p>:wave?<><Trace label="Switch-on" before={wave.on.before} after={wave.on.after}/><Trace label="Switch-off" before={wave.off.before} after={wave.off.after}/></>:<p className="quiet-note">Loading the stored readings…</p>}</div>}
 </li>
}

function Progress({reg}:{reg:Registration}){
 const waiting=reg.turns.at(-1)?.status==='waiting'
 return <ol className="turn-progress" aria-label={`${reg.kept} of ${reg.target} turns kept`}>{Array.from({length:reg.target},(_,i)=><li key={i} className={i<reg.kept?'kept':i===reg.kept&&active(reg)?waiting?'half':'next':''}><span>{i+1}</span></li>)}</ol>
}

function Running({reg,cancel,busy}:{reg:Registration;cancel:()=>void;busy:boolean}){
 const kept=reg.turns.filter(t=>t.status==='kept'),notes=reg.turns.filter(t=>t.status==='redo'||t.status==='refused'||t.status==='ignored').slice(-3).reverse()
 return <div className="register-run" aria-live="polite">
  <Progress reg={reg}/>
  <p className="register-step">{instruction(reg)}</p>
  <p className="quiet-note register-tip">Keep everything else in the house as it is until all {reg.target} turns are done.</p>
  {notes.length>0&&<ul className="turn-notes">{notes.map(t=><li key={t.id} className={t.status==='redo'?'redo':''}><Icon name="alert" size={14}/>{t.message}</li>)}</ul>}
  {kept.length>0&&<ul className="turn-list">{kept.map(t=><TurnRow key={t.id} reg={reg} turn={t}/>)}</ul>}
  <button type="button" className="outline full" onClick={cancel} disabled={busy}>Cancel registration</button>
 </div>
}

/** Register an appliance: five turns of switching it on and off while the home monitor listens. */
export function RegisterDevice({close}:{close:()=>void}){
 const ROOMS=useRoomNames().filter(r=>r.length<=ROOM_MAX)
 const [reg,setReg]=useState<Registration|null>(null),[loaded,setLoaded]=useState(false)
 const [name,setName]=useState(''),[room,setRoom]=useState(ROOMS[0]||'Living room'),[kind,setKind]=useState('generic'),[setting,setSetting]=useState('')
 const [error,setError]=useState(''),[busy,setBusy]=useState(false)
 const id=useRef<string|null>(null)
 // Opening the screen resumes a registration that is still running; a finished one is not shown again.
 const load=async()=>{try{const r=id.current?await api<Registration>(`/registrations/${id.current}`):(await api<{registration:Registration|null}>('/registrations/current')).registration;const keep=id.current||active(r)?r:null;setReg(keep);if(keep)id.current=keep.id;setError('')}catch(e){setError((e as Error).message)}finally{setLoaded(true)}}
 useEffect(()=>{void load()},[])
 useEffect(()=>{if(!active(reg))return;const timer=setInterval(()=>void load(),1000);return()=>clearInterval(timer)},[reg?.status])
 useEffect(()=>{if(reg?.status==='done')void useEnergy.getState().refresh()},[reg?.status])
 const start=async(e:React.FormEvent)=>{e.preventDefault();if(!name.trim()){setError('Give the appliance a name.');return}
  setBusy(true);setError('');try{const r=await api<Registration>('/registrations','POST',{name:name.trim(),room,kind,...(setting.trim()?{setting:setting.trim()}:{})});id.current=r.id;setReg(r)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const cancel=async()=>{if(!reg)return;setBusy(true);try{setReg(await api<Registration>(`/registrations/${reg.id}`,'DELETE'))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const again=()=>{id.current=null;setReg(null);setError('')}
 const showForm=loaded&&(!reg||reg.status==='cancelled')

 return <Modal title={reg&&!showForm?`Register ${reg.name}`:'Register an appliance'} close={close} eyebrow="REGISTER">
  {!loaded&&<p className="quiet-note">Loading…</p>}
  {showForm&&<form onSubmit={e=>void start(e)}>
   <p className="muted">The home monitor learns an appliance from five turns. In each turn you switch it on, let it run steadily for about 2 seconds, then switch it off.</p>
   <label>Name<input value={name} maxLength={48} onChange={e=>setName(e.target.value)} required placeholder="For example, kitchen kettle"/></label>
   <label>What is it?<select value={kind} onChange={e=>setKind(e.target.value)}>{KINDS.map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>
   <label>Where is it?<select value={room} onChange={e=>setRoom(e.target.value)}>{(ROOMS.length?ROOMS:['Living room']).map(r=><option key={r}>{r}</option>)}</select></label>
   <details className="more-details"><summary>It has settings (for example fan speeds)</summary><label>Setting<input value={setting} maxLength={32} onChange={e=>setSetting(e.target.value)} placeholder="For example, speed 3"/></label><p>Register each setting on its own, under the same name.</p></details>
   {error&&<p className="attention" role="alert">{error}</p>}
   <button className="primary full" type="submit" disabled={busy}>Start listening <Icon name="arrow" size={17}/></button>
  </form>}
  {!showForm&&reg&&active(reg)&&<>{error&&<p className="attention" role="alert">{error}</p>}<Running reg={reg} cancel={()=>void cancel()} busy={busy}/></>}
  {!showForm&&reg?.status==='done'&&<div className="register-end">
   <Progress reg={reg}/>
   <p className="register-step"><Icon name="check" size={18}/> {reg.message}</p>
   <p className="quiet-note">All {reg.target} turns are stored with their raw waveforms. {reg.name} appears in {reg.room} from its next switch-on.</p>
   <ul className="turn-list">{reg.turns.filter(t=>t.status==='kept').map(t=><TurnRow key={t.id} reg={reg} turn={t}/>)}</ul>
   <div className="register-actions"><button type="button" className="outline" onClick={again}>Register another</button><button type="button" className="primary" onClick={close}>Done <Icon name="check" size={17}/></button></div>
  </div>}
  {!showForm&&reg?.status==='failed'&&<div className="register-end">
   <p className="attention" role="alert">{reg.message||'The registration stopped.'}</p>
   <p className="quiet-note">Nothing was saved. Check that nothing else switches while you register, then try again.</p>
   <button type="button" className="primary full" onClick={again}>Try again</button>
  </div>}
 </Modal>
}
