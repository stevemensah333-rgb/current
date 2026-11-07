import {useEffect,useRef,useState} from 'react'
import {useEnergy} from './store'
import {api,fmtPower} from './telemetry'
import {useRoomNames} from './home/layout'
import {Icon,Modal} from './ui'

type TurnStatus='kept'|'waiting'|'redo'|'refused'|'ignored'
type Turn={id:number;status:TurnStatus;number:number|null;message:string;at:string|null;direction:-1|0|1;before_a:number|null;after_a:number|null;on_step_va:number|null;off_step_va:number|null;settle_ms:number|null;surge_peak:number|null;shape:number[]|null;has_waveform:boolean;received_at:string}
type Registration={id:string;name:string;setting:string|null;kind:string;room:string;device_id:string;status:'waiting'|'running'|'done'|'failed'|'cancelled';message:string|null;target:number;kept:number;turns:Turn[];created_at:string}
type Live={listening:boolean;points:[number,number][];now:{at:string;amps:number|null;measuring:boolean;expecting:'on'|'off';kept:number;phase?:'quiet'|'turns';quiet_a?:number|null;threshold_a?:number|null}|null}
type Waveform={readings_per_cycle:number;on:{before:number[][];after:number[][]};off:{before:number[][];after:number[][]}}

const KINDS=[['kettle','Kettle'],['fridge','Fridge'],['ac','Air conditioner'],['tv','Television'],['fan','Fan'],['lights','Lights'],['generic','Other']] as const
const ROOM_MAX=16
const CHART_MS=120000
const RESULT_SHOW_MS=6000
const active=(r:Registration|null)=>r?.status==='waiting'||r?.status==='running'
const va=(v:number|null)=>v==null?'—':`${v>0?'+':''}${fmtPower(Math.abs(v)).replace(/^/,v<0?'−':'')}`
const amps=(v:number|null|undefined)=>v==null?'—':`${v.toFixed(2)} A`

type Phase={key:'connecting'|'quiet'|'on'|'measure-on'|'off'|'measure-off';action:string;title:string;detail:string}
/** The one thing to do now. It comes from the monitor itself: is it listening, is it measuring a switch, which switch is next. */
function phaseOf(reg:Registration,live:Live|null):Phase{
 const n=Math.min(reg.kept+1,reg.target),now=live?.now
 // No readings: say so plainly. The gateway reopens a stalled USB link by itself; a replug fixes the rest.
 const silent={key:'connecting' as const,action:'Wait',title:'The home monitor is not sending readings',detail:'Don’t switch anything yet. Unplug the board’s USB cable and plug it back in; it reconnects by itself.'}
 if(reg.status==='running'&&now&&!live?.listening)return silent
 if((!live?.listening||!now)&&Date.now()-Date.parse(reg.created_at)>8000)return silent
 if(reg.status==='waiting'||!live?.listening||!now)return {key:'connecting',action:'Wait',title:'Connecting to the home monitor…',detail:'Don’t switch anything yet. This takes a few seconds.'}
 // First the appliance must be off: the monitor measures the quiet line, and that sets the smallest switch it counts.
 if(now.phase==='quiet')return {key:'quiet',action:'Keep it off',title:`Make sure ${reg.name} is off`,detail:'Unplug it or switch it off and leave it off for 2 seconds…'}
 // Measuring counts as a switch only when the current really moved: an appliance's own wobble also starts a
 // measurement, and must not make the screen say a switch was detected.
 const near=(now.quiet_a??0.03)+2*(now.threshold_a??0.03),amps=now.amps??0
 const switchedOn=now.measuring&&amps>near,switchedOff=now.measuring&&amps<=near
 if(switchedOn&&now.expecting==='on')return {key:'measure-on',action:'Keep it on',title:'Switch-on detected. Measuring…',detail:`Leave ${reg.name} on until this says to switch it off.`}
 if(switchedOff&&now.expecting==='off')return {key:'measure-off',action:'Leave it off',title:'Switch-off detected. Measuring…',detail:'Wait a moment while the switch-off is measured.'}
 if(now.expecting==='off')return {key:'off',action:'Switch OFF',title:`Now unplug or switch off ${reg.name}`,detail:`Turn ${n} of ${reg.target}: the switch-on is measured.`}
 const smallest=now.threshold_a!=null?` Switches of ${fmtPower(now.threshold_a*230)} or more are noticed.`:''
 return {key:'on',action:'Switch ON',title:`Plug in or switch on ${reg.name}`,detail:`Turn ${n} of ${reg.target}. Keep everything else in the house as it is.${n===1?smallest:''}`}
}

/** The newest switch result, shown for a few seconds after it arrives: kept, redo or refused, with the reason. */
function latestResult(reg:Registration):Turn|null{
 const t=reg.turns.at(-1)
 if(!t||t.status==='waiting'||Date.now()-Date.parse(t.received_at)>RESULT_SHOW_MS)return null
 return t
}
const resultText=(t:Turn)=>t.status==='kept'?`Turn ${t.number} kept.`:t.message.replace(/^turn \d+ redo: /,'Redo: ').replace(/^switch-(on|off) refused: /,'Not used: ').replace(/^./,c=>c.toUpperCase())

/** Current on the clamp over the last 2 minutes, with a marker at each switch the monitor saw. */
function LiveChart({live,turns}:{live:Live;turns:Turn[]}){
 const w=640,h=170,pad={l:40,r:8,t:26,b:20}
 const end=live.now?Date.parse(live.now.at):Date.now(),start=end-CHART_MS
 const pts=live.points.filter(p=>p[0]>=start)
 const top=Math.max(0.5,...pts.map(p=>p[1]),...turns.flatMap(t=>[t.before_a??0,t.after_a??0]))*1.15
 const x=(ms:number)=>pad.l+(ms-start)/CHART_MS*(w-pad.l-pad.r),y=(a:number)=>pad.t+(1-a/top)*(h-pad.t-pad.b)
 const marks=turns.filter(t=>t.at&&Date.parse(t.at)>=start)
 const ticks=[0,top/2,top]
 return <figure className="live-chart"><figcaption><b>Current on the clamp</b><span>last 2 min</span></figcaption>
  <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Current on the clamp over the last two minutes: now ${amps(live.now?.amps)}`}>
   {ticks.map(v=><g key={v}><line className="grid" x1={pad.l} x2={w-pad.r} y1={y(v)} y2={y(v)}/><text className="tick" x={pad.l-6} y={y(v)+4} textAnchor="end">{v.toFixed(v<1?2:1)} A</text></g>)}
   {['−2 min','−1 min','now'].map((l,i)=><text key={l} className="tick" x={pad.l+i/2*(w-pad.l-pad.r)} y={h-4} textAnchor={i===0?'start':i===2?'end':'middle'}>{l}</text>)}
   {marks.map(t=>{const mx=x(Date.parse(t.at!))
    // Short labels (turn number and direction) so close switches never overlap; sizes are in the Now card and the table.
    return <g key={t.id} className={`mark ${t.status}`}><line x1={mx} x2={mx} y1={pad.t-4} y2={h-pad.b}/><text x={mx} y={t.direction>0?pad.t-8:pad.t+4} textAnchor="middle">{t.number??''}{t.direction>0?'▲':'▼'}</text></g>})}
   {pts.length>1&&<polyline className="trace-line" points={pts.map(p=>`${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')}/>}
  </svg>
  <div className="chart-key"><span className="k-kept">Kept turn</span><span className="k-redo">Redo</span><span className="k-refused">Not used</span></div>
 </figure>
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

/** One row per finished turn (kept or redo): what the monitor measured. The waveform opens under it. */
function TurnRows({reg,turn,onTurn}:{reg:Registration;turn:Turn;onTurn?:Turn}){
 const [wave,setWave]=useState<Waveform|null>(null),[open,setOpen]=useState(false),[error,setError]=useState('')
 const toggle=async()=>{setOpen(o=>!o);if(wave||open)return;try{setWave((await api<{waveform:Waveform}>(`/registrations/${reg.id}/turns/${turn.id}/waveform`)).waveform)}catch(e){setError((e as Error).message)}}
 const kept=turn.status==='kept'
 return <><tr className={kept?'':'redo'}>
  <th scope="row">{turn.number}</th>
  <td>{kept?<span className="turn-badge kept"><Icon name="check" size={13}/>Kept</span>:<span className="turn-badge redo">Redo</span>}</td>
  <td>{va(turn.on_step_va)} / {va(turn.off_step_va)}</td>
  <td>{amps(onTurn?.before_a)} → {amps(onTurn?.after_a)}</td>
  <td>{turn.settle_ms!=null?`${(turn.settle_ms/1000).toFixed(1)} s`:'—'}</td>
  <td>{turn.shape&&<Shape values={turn.shape}/>}</td>
  <td>{turn.has_waveform&&<button type="button" className="text-link" aria-expanded={open} onClick={()=>void toggle()}>{open?'Hide':'Waveform'}</button>}</td>
 </tr>
 {!kept&&<tr className="redo-reason"><td/><td colSpan={6}>{resultText(turn)}</td></tr>}
 {open&&<tr className="wave-row"><td colSpan={7}>{error?<p className="attention">{error}</p>:wave?<div className="turn-wave"><Trace label="Switch-on" before={wave.on.before} after={wave.on.after}/><Trace label="Switch-off" before={wave.off.before} after={wave.off.after}/></div>:<p className="quiet-note">Loading the stored readings…</p>}</td></tr>}
 </>
}

function TurnTable({reg}:{reg:Registration}){
 const rows=reg.turns.map((t,i)=>({t,on:[...reg.turns.slice(0,i)].reverse().find(x=>x.status==='waiting')})).filter(r=>r.t.status==='kept'||r.t.status==='redo')
 if(!rows.length)return null
 return <div className="turn-table-wrap"><table className="turn-table">
  <thead><tr><th>Turn</th><th>Result</th><th>Step on / off</th><th>Before → after</th><th>Settled in</th><th>Shape</th><th><span className="visually-hidden">Waveform</span></th></tr></thead>
  <tbody>{rows.map(r=><TurnRows key={r.t.id} reg={reg} turn={r.t} onTurn={r.on}/>)}</tbody>
 </table></div>
}

function Progress({reg,phase}:{reg:Registration;phase?:Phase}){
 const half=phase?.key==='off'||phase?.key==='measure-off'
 return <ol className="turn-progress" aria-label={`${reg.kept} of ${reg.target} turns kept`}>{Array.from({length:reg.target},(_,i)=><li key={i} className={i<reg.kept?'kept':i===reg.kept&&active(reg)?half?'half':'next':''}><span>{i<reg.kept?<Icon name="check" size={14}/>:i+1}</span></li>)}</ol>
}

/** The newest switch the monitor saw, as a step in amps: "+4.00 A" for a switch-on. */
function lastStep(reg:Registration){
 const t=[...reg.turns].reverse().find(x=>x.before_a!=null&&x.after_a!=null)
 return t?`${t.direction>0?'switch-on':'switch-off'}: ${t.after_a!-t.before_a!>0?'+':''}${(t.after_a!-t.before_a!).toFixed(2)} A`:null
}

function Running({reg,live,cancel,busy}:{reg:Registration;live:Live|null;cancel:()=>void;busy:boolean}){
 const phase=phaseOf(reg,live),result=latestResult(reg),now=live?.now,step=lastStep(reg)
 return <div className="register-run">
  <div className="register-status">
   <span className={`listen-pill ${live?.listening?'on':''}`}><i/>{live?.listening?'Listening':live?.now?'Not listening':'Not listening yet'}</span>
   <span className="register-count">{reg.kept} of {reg.target} turns kept</span>
  </div>
  <Progress reg={reg} phase={phase}/>
  <section className={`do-now ${phase.key}`} aria-live="assertive" aria-atomic="true">
   <span className="do-now-action">{phase.action}</span>
   <div><h3>{phase.title}</h3><p>{phase.detail}</p></div>
  </section>
  {result&&<p className={`turn-result ${result.status}`} role="status">{result.status==='kept'&&<Icon name="check" size={15}/>}{resultText(result)}</p>}
  <details className="more-details register-details"><summary>Show details</summary>
  <div className="live-row">
   <div className="live-load"><span>Now</span><b>{amps(now?.amps)}</b><small>{now?.amps==null?'waiting for readings':live?.listening?`≈ ${fmtPower(now.amps*230)} at 230 V`:'last reading, not current'}</small>{step&&<small className="last-step">Last {step}</small>}</div>
   {live&&<LiveChart live={live} turns={reg.turns}/>}
  </div>
  <TurnTable reg={reg}/>
  </details>
  <button type="button" className="outline full" onClick={cancel} disabled={busy}>Cancel registration</button>
 </div>
}

/** Register an appliance: three turns of switching it on and off while the home monitor listens. */
export function RegisterDevice({close}:{close:()=>void}){
 const ROOMS=useRoomNames().filter(r=>r.length<=ROOM_MAX)
 const [reg,setReg]=useState<Registration|null>(null),[live,setLive]=useState<Live|null>(null),[loaded,setLoaded]=useState(false)
 const [name,setName]=useState(''),[room,setRoom]=useState(ROOMS[0]||'Living room'),[kind,setKind]=useState('generic'),[setting,setSetting]=useState('')
 const [error,setError]=useState(''),[busy,setBusy]=useState(false)
 const id=useRef<string|null>(null)
 // Opening the screen resumes a registration that is still running; a finished one is not shown again.
 const load=async()=>{try{
  const r=id.current?await api<Registration>(`/registrations/${id.current}`):(await api<{registration:Registration|null}>('/registrations/current')).registration
  const keep=id.current||active(r)?r:null;setReg(keep);if(keep)id.current=keep.id
  if(keep&&active(keep))setLive(await api<Live>(`/registrations/${keep.id}/live`))
  setError('')}catch(e){setError((e as Error).message)}finally{setLoaded(true)}}
 useEffect(()=>{void load()},[])
 useEffect(()=>{if(!active(reg))return;const timer=setInterval(()=>void load(),700);return()=>clearInterval(timer)},[reg?.status])
 useEffect(()=>{if(reg?.status==='done')void useEnergy.getState().refresh()},[reg?.status])
 const start=async(e:React.FormEvent)=>{e.preventDefault();if(!name.trim()){setError('Give the appliance a name.');return}
  setBusy(true);setError('');try{const r=await api<Registration>('/registrations','POST',{name:name.trim(),room,kind,...(setting.trim()?{setting:setting.trim()}:{})});id.current=r.id;setLive(null);setReg(r)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const cancel=async()=>{if(!reg)return;setBusy(true);try{setReg(await api<Registration>(`/registrations/${reg.id}`,'DELETE'))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const again=()=>{id.current=null;setReg(null);setLive(null);setError('');setName('');setSetting('')}
 const showForm=loaded&&(!reg||reg.status==='cancelled')

 return <Modal title={reg&&!showForm?`Register ${reg.name}`:'Register an appliance'} close={close} eyebrow="REGISTER" className="register-modal">
  {!loaded&&<p className="quiet-note">Loading…</p>}
  {showForm&&<form onSubmit={e=>void start(e)}>
   <p className="muted">Three quick turns: switch it on when the screen says Switch ON, off when it says Switch OFF.</p>
   <label>Name<input value={name} maxLength={48} onChange={e=>setName(e.target.value)} required placeholder="For example, kitchen kettle"/></label>
   <details className="more-details"><summary>More (type, room, settings)</summary>
    <label>What is it?<select value={kind} onChange={e=>setKind(e.target.value)}>{KINDS.map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>
    <label>Where is it?<select value={room} onChange={e=>setRoom(e.target.value)}>{(ROOMS.length?ROOMS:['Living room']).map(r=><option key={r}>{r}</option>)}</select></label>
    <label>Setting, if it has settings (for example fan speeds)<input value={setting} maxLength={32} onChange={e=>setSetting(e.target.value)} placeholder="For example, speed 3"/></label><p>Register each setting on its own, under the same name.</p>
   </details>
   {error&&<p className="attention" role="alert">{error}</p>}
   <p className="register-off-first"><span><b>Unplug it first.</b> Press Start with the appliance off; the screen then tells you when to switch it on.</span></p>
   <button className="primary full" type="submit" disabled={busy}>Start listening <Icon name="arrow" size={17}/></button>
  </form>}
  {!showForm&&reg&&active(reg)&&<>{error&&<p className="attention" role="alert">{error}</p>}<Running reg={reg} live={live} cancel={()=>void cancel()} busy={busy}/></>}
  {!showForm&&reg?.status==='done'&&<div className="register-end">
   <Progress reg={reg}/>
   <section className="do-now done" role="status"><span className="do-now-action"><Icon name="check" size={20}/></span><div><h3>{reg.message}</h3><p>All {reg.target} turns are stored with their raw waveforms. {reg.name} appears in {reg.room} from its next switch-on.</p></div></section>
   {reg.turns.some(t=>t.status==='kept'||t.status==='redo')&&<details className="more-details register-details"><summary>Show details</summary><TurnTable reg={reg}/></details>}
   <div className="register-actions"><button type="button" className="outline" onClick={again}>Register another</button><button type="button" className="primary" onClick={close}>Done <Icon name="check" size={17}/></button></div>
  </div>}
  {!showForm&&reg?.status==='failed'&&<div className="register-end">
   <section className="do-now failed" role="alert"><span className="do-now-action">Stopped</span><div><h3>Registration stopped</h3><p>{reg.message||'Nothing was saved.'} Check that nothing else switches while you register, then try again.</p></div></section>
   <button type="button" className="primary full" onClick={again}>Try again</button>
  </div>}
 </Modal>
}
