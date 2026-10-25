import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDatabase} from '../server/database.mjs'
import {createService} from '../server/service.mjs'
import {createApp} from '../server/index.mjs'
import {realPower,energyBetween,backupEstimate} from '../shared/calculations.ts'

function fixture(){const dir=mkdtempSync(join(tmpdir(),'apeiron-test-')),path=join(dir,'test.sqlite'),db=openDatabase(path);let time=Date.parse('2026-10-25T12:00:00Z');const service=createService(db,{clock:()=>time}),g=service.registerGateway({id:'gateway',name:'Test meter'});const gateway={id:g.id,mode:'hardware'};return {db,path,dir,service,gateway,g,advance:ms=>{time+=ms},now:()=>time,close:()=>{db.close();rmSync(dir,{recursive:true,force:true})}}}
function register(f,id,role='appliance',kind='direct',extra={}){return f.service.registerDevice({id,name:id,gateway_id:'gateway',role,measurement_kind:kind,...extra})}
function reading(f,device_id,ms=0,fields={}){return {schema_version:1,message_id:`${device_id}-${ms}`,device_id,boot_id:'boot-1',sequence:ms+1,measured_at:new Date(f.now()+ms).toISOString(),power_w:1000,provenance:'measured',...fields}}
function ingest(f,r){return f.service.ingest(r,f.gateway)}

test('current alone never becomes real power; voltage and power factor are required',()=>{
 assert.equal(realPower({current_a:5}).value,null);assert.equal(realPower({current_a:5,voltage_v:230}).value,null)
 assert.equal(realPower({current_a:5,voltage_v:230,power_factor:.8}).value,920)
 assert.equal(realPower({power_w:0,current_a:5}).value,0)
})
test('energy integration uses elapsed seconds and refuses long gaps, resets and reboots',()=>{
 const a={measured_at:'2026-10-25T12:00:00Z',boot_id:'a',power_w:1000,energy_total_wh:null},b={...a,measured_at:'2026-10-25T12:00:10Z'}
 assert.equal(energyBetween(a,b,30).wh,1000*10/3600)
 assert.equal(energyBetween(a,{...b,measured_at:'2026-10-25T12:10:00Z'},30).gap,true)
 assert.equal(energyBetween({...a,energy_total_wh:100},{...b,energy_total_wh:110},30).wh,10)
 assert.equal(energyBetween({...a,energy_total_wh:100},{...b,energy_total_wh:2},30).gap,true)
 assert.equal(energyBetween(a,{...b,boot_id:'b'},30).gap,true)
})
test('required units, invalid numbers, future timestamps, schema and calendar errors are rejected',()=>{const f=fixture();try{register(f,'ac');for(const fields of [{schema_version:2},{power_w:'100'},{power_w:null,current_a:null},{measured_at:'2026-10-25T12:02:00Z'},{measured_at:'2026-10-25T12:00:00'},{measured_at:'2026-02-30T12:00:00Z'},{power_w:-1},{extra_field:2}])assert.throws(()=>ingest(f,reading(f,'ac',0,fields)));}finally{f.close()}})
test('duplicate delivery is idempotent and conflicting message IDs or sequences do not alter totals',()=>{const f=fixture();try{register(f,'ac');const r=reading(f,'ac');assert.equal(ingest(f,r).duplicate,false);assert.equal(ingest(f,r).duplicate,true);assert.throws(()=>ingest(f,{...r,power_w:500}),/message_id/);assert.throws(()=>ingest(f,{...r,message_id:'other',measured_at:new Date(f.now()+1000).toISOString()}));assert.equal(f.db.prepare('SELECT count(*) AS n FROM readings').get().n,1)}finally{f.close()}})
test('late readings are stored in timestamp order; insertion cannot double count counter energy',()=>{const f=fixture();try{register(f,'ac');ingest(f,reading(f,'ac',0,{energy_total_wh:100}));ingest(f,reading(f,'ac',10000,{energy_total_wh:110}));ingest(f,reading(f,'ac',5000,{energy_total_wh:105}));f.advance(10000);const d=f.service.snapshot().devices[0];assert.equal(d.energy_wh,10);assert.equal(d.latest.sequence,10001)}finally{f.close()}})
test('a zero-watt reading is available; stale or current-only readings are unknown, not zero',()=>{const f=fixture();try{register(f,'ac');ingest(f,reading(f,'ac',0,{power_w:0}));assert.equal(f.service.snapshot().demand_w,0);f.advance(16000);assert.equal(f.service.snapshot().demand_w,null);ingest(f,reading(f,'ac',0,{power_w:null,current_a:5,message_id:'current-only',sequence:20000}));assert.equal(f.service.snapshot().devices[0].power_w,null);assert.equal(f.service.snapshot().devices[0].latest.current_a,5)}finally{f.close()}})
test('aggregate is authoritative and inferred/direct appliances are never double counted',()=>{const f=fixture();try{register(f,'mains','whole_home','aggregate');register(f,'fridge');register(f,'estimate','appliance','inferred',{parent_device_id:'mains'});ingest(f,reading(f,'mains',0,{power_w:1000}));ingest(f,reading(f,'fridge',0,{power_w:150}));ingest(f,reading(f,'estimate',0,{power_w:140,provenance:'inferred',inference:{parent_device_id:'mains',model_version:'test-model',confidence:.7}}));const s=f.service.snapshot();assert.equal(s.demand_w,1000);assert.equal(s.monitored_power_w,150);assert.equal(s.unattributed_power_w,850);assert.equal(s.data_quality.inferred_channels.length,1);f.advance(16000);ingest(f,reading(f,'fridge',0,{power_w:150,message_id:'new-fridge',sequence:20000}));assert.equal(f.service.snapshot().demand_w,null)}finally{f.close()}})
test('energy counters persist across DB reopening and uncertain reboot intervals remain disclosed',()=>{const f=fixture();register(f,'ac');ingest(f,reading(f,'ac',0,{energy_total_wh:100}));ingest(f,reading(f,'ac',5000,{energy_total_wh:105}));ingest(f,reading(f,'ac',10000,{boot_id:'new-boot',energy_total_wh:0}));f.advance(10000);f.db.close();const db=openDatabase(f.path);try{const d=createService(db,{clock:f.now}).snapshot().devices[0];assert.equal(d.energy_wh,5);assert.equal(d.unknown_intervals,1)}finally{db.close();rmSync(f.dir,{recursive:true,force:true})}})
test('gateway credentials are scoped to registered device ownership and provenance',()=>{const f=fixture();try{register(f,'ac');assert.throws(()=>f.service.ingest(reading(f,'ac'),{id:'another',mode:'hardware'}),/not authorized/);assert.throws(()=>ingest(f,reading(f,'ac',0,{provenance:'simulated'})),/Hardware gateways/);assert.throws(()=>f.service.setSimulation({states:{ac:false}}),/Physical/)}finally{f.close()}})
test('unknown source and battery readings are not manufactured from load readings',()=>{const f=fixture();try{register(f,'ac');ingest(f,reading(f,'ac'));const s=f.service.snapshot();assert.equal(s.sources.grid,null);assert.equal(s.sources.solar,null);assert.equal(s.battery_soc_pct,null);const p=f.service.previewPlan({selected_ids:['ac'],target_hours:6});assert.equal(p.target_feasible,null);assert.equal(p.status,'insufficient_data')}finally{f.close()}})
test('backup calculator enforces reserve, power limits and missing data',()=>{
 const cfg={capacity_kwh:5,reserve_pct:20,efficiency:.9,max_discharge_w:2000}
 assert.equal(backupEstimate(500,70,cfg).runtime_hours,4.5);assert.equal(backupEstimate(2500,70,cfg).status,'power_limit_exceeded');assert.equal(backupEstimate(500,20,cfg).runtime_hours,0);assert.equal(backupEstimate(500,null,cfg).status,'insufficient_data')
})
test('planning uses backend evidence, excludes inferred loads and does not claim a budget result',()=>{const f=fixture();try{register(f,'ac');register(f,'battery','battery');ingest(f,reading(f,'ac',0,{power_w:500}));ingest(f,reading(f,'battery',0,{power_w:500,battery_soc_pct:70}));f.service.updateSettings({battery:{capacity_kwh:5,reserve_pct:20,efficiency:.9,max_discharge_w:2000}});const p=f.service.previewPlan({selected_ids:['ac'],target_hours:6,budget_ghs:20});assert.equal(p.runtime_hours,4.5);assert.equal(p.target_feasible,false);assert.equal(p.budget_status,'not_evaluated');assert.equal(p.execution,'advisory_only');assert.equal(f.service.snapshot().devices.find(d=>d.id==='ac').power_w,500);assert.equal(f.service.context().recommendations.length,0);assert.equal(f.service.context().constraints.commands_allowed,false)}finally{f.close()}})
test('retirement preserves history and removes a channel from live aggregation',()=>{const f=fixture();try{register(f,'ac');ingest(f,reading(f,'ac'));f.service.retire('ac');assert.equal(f.service.snapshot().devices.length,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM readings').get().n,1)}finally{f.close()}})

test('HTTP integration enforces auth, serves stored telemetry, and keeps commands and AI disabled',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'apeiron-http-')),app=createApp({databasePath:join(dir,'db.sqlite'),ownerToken:'test-owner-token'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`
 async function request(path,method='GET',body,token='test-owner-token',extra={}){const r=await fetch(base+'/api/v1'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}}
 try{
  assert.equal((await request('/snapshot','GET',undefined,'wrong')).status,401)
  assert.equal((await request('/snapshot','GET',undefined,'é'.repeat(16))).status,401)
  assert.equal((await request('/snapshot','GET',undefined,'test-owner-token',{Origin:'https://untrusted.example'})).status,403)
  const g=await request('/gateways','POST',{id:'real',name:'Real meter'});assert.equal(g.status,201)
  const d=await request('/devices','POST',{id:'real-ac',name:'AC',role:'appliance',gateway_id:'real'});assert.equal(d.status,201);assert.equal(d.data.can_switch,false)
  const r={schema_version:1,message_id:'first',device_id:'real-ac',boot_id:'boot',measured_at:new Date().toISOString(),power_w:250,provenance:'measured'}
  assert.equal((await request('/readings','POST',r,'test-owner-token')).status,401)
  assert.equal((await request('/readings','POST',r,g.data.token)).status,200)
  assert.equal((await request('/readings','POST',r,g.data.token)).data.duplicate,true)
  assert.equal((await request('/snapshot')).data.demand_w,250)
  assert.equal((await request('/snapshot','GET',undefined,g.data.token)).status,401)
  assert.equal((await request('/devices/real-ac/commands','POST',{on:false})).status,501)
  const ctx=(await request('/insights/context')).data;assert.equal(ctx.evidence.ai.enabled,false);assert.deepEqual(ctx.recommendations,[])
  assert.equal((await request('/devices/real-ac','DELETE')).status,200)
  assert.equal((await request('/readings','POST',{...r,message_id:'after-retire'},g.data.token)).status,404)
 }finally{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true})}
})

test('a plan cannot combine simulated battery state with measured appliance power',()=>{const f=fixture();try{register(f,'ac');ingest(f,reading(f,'ac',0,{power_w:500}));f.db.prepare('INSERT INTO gateways VALUES(?,?,?,?)').run('sim','Sim','hash','simulator');f.service.registerDevice({id:'battery',name:'Battery',gateway_id:'sim',role:'battery'});f.service.ingest(reading(f,'battery',0,{power_w:500,battery_soc_pct:70,provenance:'simulated'}),{id:'sim',mode:'simulator'});f.service.updateSettings({battery:{capacity_kwh:5,reserve_pct:20,efficiency:.9,max_discharge_w:2000}});const p=f.service.previewPlan({selected_ids:['ac'],target_hours:1});assert.equal(p.target_feasible,null);assert.equal(p.mixed_provenance,true);assert.equal(p.status,'insufficient_data')}finally{f.close()}})

test('a real simulator process ingests through HTTP and backend state survives its restart',async()=>{
 const {spawn}=await import('node:child_process'),{readFileSync}=await import('node:fs'),{fileURLToPath}=await import('node:url')
 const dir=mkdtempSync(join(tmpdir(),'apeiron-simulator-')),bootstrapPath=fileURLToPath(new URL('../scripts/bootstrap.mjs',import.meta.url)),simulatorPath=fileURLToPath(new URL('../scripts/simulator.mjs',import.meta.url))
 const run=(script,env={})=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,...(script===simulatorPath?['--once']:[])],{cwd:dir,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error)))})
 let app
 try{
  await run(bootstrapPath)
  app=createApp({databasePath:join(dir,'.data/apeiron.sqlite'),ownerToken:readFileSync(join(dir,'.data/owner.key'),'utf8').trim()});await new Promise(r=>app.server.listen(0,'127.0.0.1',r))
  const endpoint=`http://127.0.0.1:${app.server.address().port}`
  await run(simulatorPath,{APEIRON_API:endpoint});const first=app.service.snapshot();assert.equal(first.devices.length,13);assert.equal(first.devices.every(d=>d.latest?.provenance==='simulated'),true);assert.equal(first.demand_w>0,true)
  await run(simulatorPath,{APEIRON_API:endpoint});const next=app.service.snapshot();assert.equal(next.devices.find(d=>d.id==='mains').unknown_intervals,1)
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM readings').get().n,26)
 }finally{if(app){await new Promise(r=>app.server.close(r));app.db.close()}rmSync(dir,{recursive:true,force:true})}
})

test('frontend state has no synthetic fallback and never optimistically switches physical devices',async()=>{
 const {useEnergy}=await import('../src/store.ts'),originalFetch=globalThis.fetch,originalState=useEnergy.getState(),f=fixture();let calls=0
 try{
  register(f,'physical');ingest(f,reading(f,'physical',0,{power_w:125}));const snapshot=f.service.snapshot()
  globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>snapshot}}
  await useEnergy.getState().refresh();assert.equal(useEnergy.getState().devices[0].reading,125)
  useEnergy.getState().toggle('physical');assert.equal(calls,1);assert.equal(useEnergy.getState().devices[0].reading,125);assert.match(useEnergy.getState().notice,/monitor-only/)
  globalThis.fetch=async()=>{throw new Error('Network disconnected')};await useEnergy.getState().refresh()
  assert.equal(useEnergy.getState().connection,'error');assert.equal(useEnergy.getState().telemetry.demand_w,null);assert.equal(useEnergy.getState().telemetry.devices[0].power_w,null);assert.equal(useEnergy.getState().devices[0].online,false)
 }finally{globalThis.fetch=originalFetch;useEnergy.setState(originalState,true);f.close()}
})
