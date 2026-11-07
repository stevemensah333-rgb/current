// Registering an appliance: 5 turns, each one switch-on and its switch-off, run by the NILM gateway.
// The app starts a registration; the gateway asks for it, listens, and sends every turn back with its raw waveform.
// Example: POST /registrations {name:"kettle"} -> the gateway posts turn 1 "waiting" (switched on), then turn 1 "kept"
// (switched off, with ~10 KB of raw readings) ... turn 5 "kept", then status "done" -> a "kettle" channel exists.
import {randomBytes} from 'node:crypto'
import {allDevices} from './database.mjs'
import {fail,object,keys,id,text,number,optionalNumber,oneOf} from './validation.mjs'

export const TURNS=5
const ACTIVE=['waiting','running']
const TURN_STATUS=['kept','waiting','redo','refused','ignored']
const ROOM_MAX=16              // the pipeline's limit, as named in the app's home
const MAX_CYCLES=600           // per before/after window; the detector captures at most 10 + 500
export const WAVEFORM_MAX_BYTES=1<<20

/** 'Kitchen Kettle' -> 'kitchen-kettle', the same id the pipeline gives the channel. */
export function channelId(name){return (name.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'')||'device').slice(0,48)}

export function migrate(db){db.exec(`
 CREATE TABLE IF NOT EXISTS registrations(id TEXT PRIMARY KEY,gateway_id TEXT NOT NULL REFERENCES gateways(id),payload TEXT NOT NULL,status TEXT NOT NULL,message TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS one_active_registration ON registrations(gateway_id) WHERE status IN ('waiting','running');
 CREATE TABLE IF NOT EXISTS registration_turns(id INTEGER PRIMARY KEY,registration_id TEXT NOT NULL REFERENCES registrations(id),message_id TEXT NOT NULL,summary TEXT NOT NULL,waveform TEXT,received_at TEXT NOT NULL,UNIQUE(registration_id,message_id));
 CREATE TABLE IF NOT EXISTS registration_messages(registration_id TEXT NOT NULL REFERENCES registrations(id),message_id TEXT NOT NULL,PRIMARY KEY(registration_id,message_id));`)}

const finite=(v,name)=>number(v,name,-1e4,1e4)
function cycles(v,name,perCycle){
 if(!Array.isArray(v)||v.length>MAX_CYCLES)fail(`${name} must be a list of at most ${MAX_CYCLES} cycles`)
 return v.map((c,i)=>{if(!Array.isArray(c)||c.length!==perCycle)fail(`${name}[${i}] must hold ${perCycle} readings`);return c.map(x=>finite(x,name))})
}
function waveformInput(raw){
 if(raw==null)return null
 const v=object(raw);keys(v,['readings_per_cycle','on','off'])
 const per=number(v.readings_per_cycle,'readings_per_cycle',1,1000)
 if(!Number.isInteger(per))fail('readings_per_cycle must be an integer')
 const part=(p,name)=>{const w=object(p);keys(w,['t_ms','before','after']);return {t_ms:number(w.t_ms,`${name}.t_ms`,0,Number.MAX_SAFE_INTEGER),before:cycles(w.before,`${name}.before`,per),after:cycles(w.after,`${name}.after`,per)}}
 return {readings_per_cycle:per,on:part(v.on,'on'),off:part(v.off,'off')}
}
const isoTime=(v,name)=>{const t=text(v,name,40);if(!Number.isFinite(Date.parse(t))||!/(Z|[+-]\d\d:\d\d)$/.test(t))fail(`${name} must be an ISO 8601 time with timezone`);return new Date(Date.parse(t)).toISOString()}
function turnInput(raw){
 const v=object(raw);keys(v,['schema_version','message_id','status','number','message','at','direction','before_a','after_a','on_step_va','off_step_va','settle_ms','surge_peak','shape','waveform'])
 if(v.schema_version!==1)fail('Unsupported schema_version; expected 1')
 if(v.shape!=null&&(!Array.isArray(v.shape)||v.shape.length>256))fail('shape must be a list of at most 256 numbers')
 return {message_id:id(v.message_id,'message_id'),status:oneOf(v.status,'status',TURN_STATUS),number:v.number==null?null:number(v.number,'number',1,TURNS),
  message:text(v.message,'message',300),at:v.at==null?null:isoTime(v.at,'at'),direction:v.direction==null?0:oneOf(v.direction,'direction',[-1,0,1]),
  before_a:optionalNumber(v.before_a,'before_a',0,1e4),after_a:optionalNumber(v.after_a,'after_a',0,1e4),settle_ms:optionalNumber(v.settle_ms,'settle_ms',0,1e6),surge_peak:optionalNumber(v.surge_peak,'surge_peak',-1e4,1e4),
  on_step_va:optionalNumber(v.on_step_va,'on_step_va',-1e7,1e7),off_step_va:optionalNumber(v.off_step_va,'off_step_va',-1e7,1e7),
  shape:v.shape==null?null:v.shape.map(x=>finite(x,'shape')),waveform:waveformInput(v.waveform)}
}

const LIVE_MS=120000            // the app's chart shows the last 2 minutes
const LIVE_POINT_MS=200        // one chart point per 200 ms (10 mains cycles)
const LIVE_STALE_MS=4000       // no live readings for 4 s: the monitor is not listening

export function createRegistrations(db,{clock=()=>Date.now(),registerDevice}){
 migrate(db)
 // Live current while registering. Kept in memory only: it is for the chart, not a record.
 const live=new Map()   // registration id -> {points:[[ms,amps]], at, amps, measuring, expecting, kept}
 const now=()=>new Date(clock()).toISOString()
 const row=regId=>{const r=db.prepare('SELECT * FROM registrations WHERE id=?').get(regId);if(!r)fail('Registration not found',404);return r}
 function view(r){
  const p=JSON.parse(r.payload)
  const turns=db.prepare('SELECT id,summary,waveform IS NOT NULL AS has_waveform,received_at FROM registration_turns WHERE registration_id=? ORDER BY id').all(r.id)
   .map(t=>({id:t.id,...JSON.parse(t.summary),has_waveform:Boolean(t.has_waveform),received_at:t.received_at}))
  const kept=turns.filter(t=>t.status==='kept')
  return {id:r.id,...p,status:r.status,message:r.message,target:TURNS,kept:kept.length,turns,created_at:r.created_at,updated_at:r.updated_at}
 }
 // The NILM gateway: the hardware gateway that owns the whole-home clamp.
 function nilmGateway(){
  const mains=allDevices(db).find(d=>d.role==='whole_home'&&d.measurement_kind==='aggregate'&&d.mode==='hardware')
  if(!mains)fail('No home monitor is connected. Start the NILM installation (npm run dev:nilm) first.',409)
  return mains
 }
 function start(raw){
  const v=object(raw);keys(v,['name','setting','kind','room'])
  const name=text(v.name,'name',48),deviceId=channelId(name),mains=nilmGateway()
  if(name.includes('|'))fail('name must not contain |')
  if(deviceId==='mains')fail('"mains" is the whole-home clamp. Choose another name.')
  const existing=allDevices(db).find(d=>d.id===deviceId)
  if(existing&&!(existing.measurement_kind==='inferred'&&existing.gateway_id===mains.gateway_id))fail(`"${existing.name}" already uses this name. Choose another name.`,409)
  const room=text(v.room??'Living room','room',ROOM_MAX)
  const payload={name,setting:v.setting==null||v.setting===''?null:text(v.setting,'setting',32),kind:text(v.kind??'generic','kind',32),room,device_id:deviceId,gateway_id:mains.gateway_id,parent_device_id:mains.id}
  if(db.prepare(`SELECT 1 FROM registrations WHERE gateway_id=? AND status IN ('waiting','running')`).get(mains.gateway_id))fail('A registration is already running. Finish or cancel it first.',409)
  const regId=randomBytes(8).toString('hex'),at=now()
  db.prepare('INSERT INTO registrations(id,gateway_id,payload,status,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(regId,mains.gateway_id,JSON.stringify(payload),'waiting','Waiting for the home monitor to start listening.',at,at)
  return view(row(regId))
 }
 const get=regId=>view(row(regId))
 /** The active registration, or else the newest one, so the app can show how the last one ended. */
 function current(){const r=db.prepare(`SELECT * FROM registrations ORDER BY status IN ('waiting','running') DESC,created_at DESC,rowid DESC LIMIT 1`).get();return {registration:r?view(r):null}}
 function cancel(regId){
  const r=row(regId)
  if(ACTIVE.includes(r.status))db.prepare('UPDATE registrations SET status=?,message=?,updated_at=? WHERE id=?').run('cancelled','Cancelled. Nothing was saved.',now(),r.id)
  return get(regId)
 }
 function waveform(regId,turnId){
  row(regId)
  const t=db.prepare('SELECT summary,waveform FROM registration_turns WHERE registration_id=? AND id=?').get(regId,turnId)
  if(!t)fail('Turn not found',404)
  if(!t.waveform)fail('This turn has no waveform',404)
  return {registration_id:regId,turn_id:turnId,...JSON.parse(t.summary),waveform:JSON.parse(t.waveform)}
 }
 // --- the gateway's side ---
 function addLive(regId,raw,gateway){
  const r=ownActive(regId,gateway),v=object(raw);keys(v,['schema_version','at','cycle_ms','amps','measuring','expecting','kept'])
  if(v.schema_version!==1)fail('Unsupported schema_version; expected 1')
  const at=Date.parse(isoTime(v.at,'at')),cycle=number(v.cycle_ms,'cycle_ms',1,1000)
  if(!Array.isArray(v.amps)||v.amps.length>500)fail('amps must be a list of at most 500 numbers')
  const amps=v.amps.map(x=>number(x,'amps',0,1e4))
  const state=live.get(r.id)||{points:[]}
  // Average every 10 cycles into one point; the newest reading is the end of the list.
  const per=Math.max(1,Math.round(LIVE_POINT_MS/cycle))
  for(let i=0;i<amps.length;i+=per){const part=amps.slice(i,i+per);state.points.push([at-(amps.length-i-part.length)*cycle,part.reduce((a,b)=>a+b,0)/part.length])}
  state.points=state.points.filter(p=>p[0]>at-LIVE_MS)
  Object.assign(state,{at,amps:amps.length?amps.slice(-10).reduce((a,b)=>a+b,0)/Math.min(10,amps.length):state.amps??null,measuring:Boolean(v.measuring),expecting:oneOf(v.expecting,'expecting',['on','off']),kept:number(v.kept??0,'kept',0,TURNS)})
  live.set(r.id,state)
  if(r.status==='waiting')db.prepare('UPDATE registrations SET status=?,message=?,updated_at=? WHERE id=?').run('running','Listening.',now(),r.id)
  return {ok:true}
 }
 /** The chart and the "do this now" state. listening=false when the monitor has gone quiet. */
 function liveView(regId){
  const r=row(regId),state=live.get(r.id)
  if(!state)return {listening:false,points:[],now:null}
  const fresh=clock()-state.at<LIVE_STALE_MS&&ACTIVE.includes(r.status)
  return {listening:fresh,points:state.points,now:{at:new Date(state.at).toISOString(),amps:state.amps,measuring:state.measuring,expecting:state.expecting,kept:state.kept}}
 }
 function forGateway(gateway){
  const r=db.prepare(`SELECT * FROM registrations WHERE gateway_id=? AND status IN ('waiting','running')`).get(gateway.id)
  if(!r)return {registration:null}
  const p=JSON.parse(r.payload)
  return {registration:{id:r.id,status:r.status,name:p.name,setting:p.setting,kind:p.kind,room:p.room,device_id:p.device_id,turns:TURNS}}
 }
 function ownActive(regId,gateway){
  const r=row(regId)
  if(r.gateway_id!==gateway.id)fail('Gateway is not authorized for this registration',403)
  if(!ACTIVE.includes(r.status))fail(`This registration is ${r.status}`,409)
  return r
 }
 function addTurn(regId,raw,gateway){
  const r=ownActive(regId,gateway),t=turnInput(raw)
  const old=db.prepare('SELECT id FROM registration_turns WHERE registration_id=? AND message_id=?').get(r.id,t.message_id)
  if(old)return {id:old.id,duplicate:true}
  const {message_id,waveform,...summary}=t,at=now()
  const result=db.prepare('INSERT INTO registration_turns(registration_id,message_id,summary,waveform,received_at) VALUES(?,?,?,?,?)').run(r.id,message_id,JSON.stringify(summary),waveform?JSON.stringify(waveform):null,at)
  db.prepare('UPDATE registrations SET status=?,message=?,updated_at=? WHERE id=?').run('running',t.message,at,r.id)
  return {id:Number(result.lastInsertRowid),duplicate:false}
 }
 function setStatus(regId,raw,gateway){
  const v=object(raw);keys(v,['schema_version','message_id','status','message','device_id'])
  if(v.schema_version!==1)fail('Unsupported schema_version; expected 1')
  const messageId=id(v.message_id,'message_id')
  if(db.prepare('SELECT 1 FROM registration_messages WHERE registration_id=? AND message_id=?').get(regId,messageId))return {duplicate:true}
  const r=ownActive(regId,gateway),status=oneOf(v.status,'status',['running','done','failed']),message=v.message==null?null:text(v.message,'message',300)
  const p=JSON.parse(r.payload)
  if(status==='done'){
   const kept=db.prepare('SELECT summary FROM registration_turns WHERE registration_id=?').all(r.id).filter(t=>JSON.parse(t.summary).status==='kept').length
   if(kept<TURNS)fail(`A registration needs ${TURNS} kept turns; ${kept} arrived`,409)
   if(v.device_id!=null&&id(v.device_id,'device_id')!==p.device_id)fail('device_id does not match the registration')
   addChannel(p)
  }
  db.exec('BEGIN')
  try{
   db.prepare('INSERT INTO registration_messages VALUES(?,?)').run(r.id,messageId)
   db.prepare('UPDATE registrations SET status=?,message=?,updated_at=? WHERE id=?').run(status,status==='done'?`Saved. ${p.name} is now recognised.`:message,now(),r.id)
   db.exec('COMMIT')
  }catch(e){db.exec('ROLLBACK');throw e}
  return {duplicate:false,status}
 }
 // The new appliance's channel; registering the same name again keeps its channel and history.
 function addChannel(p){
  const old=db.prepare('SELECT metadata,active FROM devices WHERE id=?').get(p.device_id)
  if(old){
   if(!old.active){const d={...JSON.parse(old.metadata),name:p.name,room:p.room,kind:p.kind};db.prepare('UPDATE devices SET metadata=?,active=1 WHERE id=?').run(JSON.stringify(d),p.device_id)}
   return
  }
  registerDevice({id:p.device_id,name:p.name,room:p.room,kind:p.kind,role:'appliance',measurement_kind:'inferred',parent_device_id:p.parent_device_id,gateway_id:p.gateway_id,expected_interval_s:10})
 }
 return {start,get,current,cancel,waveform,forGateway,addTurn,setStatus,addLive,live:liveView}
}
