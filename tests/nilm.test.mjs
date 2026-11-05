import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDatabase} from '../server/database.mjs'
import {createService} from '../server/service.mjs'
import {createAssistant,stateLine,parseXmlToolCalls,localChat,cloudChat,systemPrompt} from '../server/assistant.mjs'
import {createApp} from '../server/index.mjs'
import {realPower,energyBetween} from '../shared/calculations.ts'

const START=Date.parse('2026-11-05T12:00:00Z')
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'nilm-test-')),db=openDatabase(join(dir,'t.sqlite'));let time=START
 const service=createService(db,{clock:()=>time}),gw=service.registerGateway({id:'nilm',name:'NILM gateway'}),gateway={id:gw.id,mode:'hardware'}
 service.registerDevice({id:'mains',name:'Mains',gateway_id:'nilm',role:'whole_home',measurement_kind:'aggregate',expected_interval_s:5})
 service.registerDevice({id:'kettle',name:'Kettle',gateway_id:'nilm',role:'appliance',measurement_kind:'inferred',parent_device_id:'mains',kind:'kettle',room:'Kitchen',expected_interval_s:10})
 let seq=0
 const post=(device_id,fields,ms=0)=>service.ingest({schema_version:1,message_id:`m${++seq}`,device_id,boot_id:'b1',sequence:seq,measured_at:new Date(time+ms).toISOString(),...fields},gateway)
 const mains=(va,ms)=>post('mains',{current_a:va/230,apparent_power_va:va,provenance:'measured'},ms)
 const kettle=(va,p,ms)=>post('kettle',{apparent_power_va:va,provenance:'inferred',inference:{parent_device_id:'mains',model_version:'shp-0.1',confidence:p}},ms)
 return {db,service,gateway,mains,kettle,advance:ms=>{time+=ms},now:()=>time,close:()=>{db.close();rmSync(dir,{recursive:true,force:true})}}
}

// VA labelling

test('apparent power is a labelled last resort, never "reported" watts',()=>{
 assert.deepEqual(realPower({current_a:9.1,apparent_power_va:2093}),{value:2093,basis:'apparent_estimate_va'})
 assert.equal(realPower({power_w:1800,apparent_power_va:2093}).basis,'reported')
 const a={measured_at:'2026-11-05T12:00:00Z',boot_id:'b',power_w:2000,energy_total_wh:null,basis:'apparent_estimate_va'}
 assert.equal(energyBetween(a,{...a,measured_at:'2026-11-05T12:00:10Z'},30).basis,'integrated_apparent_va')
})

test('a VA-only inferred reading is accepted; negative VA is not',()=>{const f=fixture();try{
 assert.equal(f.kettle(2000,.94).duplicate,false)
 assert.throws(()=>f.kettle(-5,.9,1),/apparent_power_va/)
}finally{f.close()}})

test('snapshot labels VA, computes "not yet named" from fresh parts only, and labels the cost',()=>{const f=fixture();try{
 f.mains(2093,0);f.kettle(2000,.94,0);f.advance(5000);f.mains(2093,0);f.kettle(2000,.94,0)
 let s=f.service.snapshot()
 assert.equal(s.demand_basis,'apparent_estimate_va');assert.equal(Math.round(s.unnamed_va),93)
 assert.match(s.cost_basis,/Overstates the bill/)
 assert.equal(s.devices.find(d=>d.id==='kettle').energy_methods.includes('integrated_apparent_va'),true)
 f.advance(31000);f.mains(1000,0)                       // kettle channel now stale
 s=f.service.snapshot();assert.equal(s.unnamed_va,null)
 f.kettle(1500,.9,0);s=f.service.snapshot();assert.equal(s.unnamed_va,0)   // never below zero
}finally{f.close()}})

// Alerts

test('alerts: stored as fields, idempotent, owned, time-checked, listed and acknowledged',()=>{const f=fixture();try{
 const a={schema_version:1,message_id:'a1',raised_at:new Date(f.now()).toISOString(),kind:'fault',device_id:'kettle',value:'settle_ms',amount:412}
 assert.equal(f.service.ingestAlert(a,f.gateway).duplicate,false)
 assert.equal(f.service.ingestAlert(a,f.gateway).duplicate,true)
 assert.throws(()=>f.service.ingestAlert({...a,amount:1},f.gateway),/already used/)
 assert.throws(()=>f.service.ingestAlert({...a,message_id:'a2',raised_at:new Date(f.now()+60000).toISOString()},f.gateway),/future/)
 assert.throws(()=>f.service.ingestAlert({...a,message_id:'a3',text:'free text'},f.gateway),/Unknown field/)
 f.service.ingestAlert({...a,message_id:'a4',kind:'missed_event',device_id:null,value:null,amount:-1000},f.gateway)
 const other=f.service.registerGateway({id:'other',name:'Other'})
 assert.throws(()=>f.service.ingestAlert({...a,message_id:'a5'},{id:other.id,mode:'hardware'}),e=>e.status===403)
 const open=f.service.snapshot().alerts;assert.deepEqual(open.map(x=>x.kind),['fault','missed_event'])
 f.service.ackAlert(open[0].id);assert.equal(f.service.snapshot().alerts.length,1)
 assert.throws(()=>f.service.ackAlert(open[0].id),/not found/)
}finally{f.close()}})

// Settings

test('assistant provider is a validated setting, local by default',()=>{const f=fixture();try{
 assert.equal(f.service.snapshot().settings.assistant.provider,'local')
 f.service.updateSettings({assistant:{provider:'cloud'}});assert.equal(f.service.snapshot().ai.provider,'cloud')
 assert.throws(()=>f.service.updateSettings({assistant:{provider:'other'}}))
}finally{f.close()}})

// Usage over any period

test('usage reports hours on, VA-hours and how much of the period is recorded',()=>{const f=fixture();try{
 for(let i=0;i<=12;i++){f.kettle(i<=6?2000:0,.9,0);f.advance(5000)}   // on for 30 s, off for 30 s
 const u=f.service.usage('kettle',START,f.now())
 assert.equal(Math.round(u.hours_on*3600),30)
 assert.equal(u.energy_basis,'integrated_apparent_va')
 assert.ok(u.covered_hours<u.period_hours+1e-9)
}finally{f.close()}})

// Assistant: state line and tools

test('the state line holds ids and numbers only',()=>{const f=fixture();try{
 f.mains(2093,0);f.kettle(2000,.94,0)
 const line=stateLine(f.service.snapshot())
 assert.match(line,/On now: kettle 2000 VA p 0\.94\./);assert.match(line,/House total 2093 VA\./);assert.doesNotMatch(line,/Kettle/)
}finally{f.close()}})

test('LFM3 XML tool calls are read',()=>{
 assert.deepEqual(parseXmlToolCalls('<tool_call>\n<function=get_usage>\n<parameter=device>\nkettle\n</parameter>\n<parameter=period>\ntoday\n</parameter>\n</function>\n</tool_call>'),
  [{id:'call_0',name:'get_usage',input:{device:'kettle',period:'today'}}])
})

const SPEC=[{name:'get_usage',description:'usage',schema:{type:'object',properties:{},additionalProperties:false}}]
const until=async(fn)=>{for(let i=0;i<200;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,5))}throw new Error('timeout')}

function scripted(...steps){   // a stand-in provider: each step is a tool call or a final answer
 return async({specs,execute})=>{let out='';for(const s of steps){if(s.tool)out=await execute(s.tool,s.input);else return `${s.answer} [${out}] [${specs.map(x=>x.name).join(',')}]`}return out}
}

test('a question runs as a job: one at a time, poll, cancel',async()=>{const f=fixture();try{
 let release;const slow=()=>new Promise(r=>{release=()=>r('done slowly')})
 const a=createAssistant(f.service,{clock:f.now,providers:{local:slow,cloud:slow}})
 const {job_id}=a.start({message:'hi'})
 assert.equal(a.view(job_id).status,'running')
 assert.throws(()=>a.start({message:'again'}),e=>e.status===409)
 release();await until(()=>a.view(job_id).status==='done');assert.equal(a.view(job_id).reply,'done slowly')
 const second=a.start({message:'next'}).job_id;assert.equal(a.cancel(second).status,'cancelled')
 a.start({message:'free again'})
 assert.throws(()=>a.view('ffff'),/may have restarted/)
}finally{f.close()}})

test('get_usage answers from stored readings; switch_off asks for a single-use, timed confirmation',async()=>{const f=fixture();try{
 f.mains(2093,0);f.kettle(2000,.94,0);f.advance(5000);f.mains(2093,0);f.kettle(2000,.94,0)
 const a=createAssistant(f.service,{clock:f.now,providers:{local:scripted({tool:'get_usage',input:{device:'kettle',period:'hour'}},{answer:'ok'}),cloud:null}})
 const j=a.start({message:'how long?'}).job_id;await until(()=>a.view(j).status==='done')
 assert.match(a.view(j).reply,/kettle: 0\.00 h on, 3 VAh \(estimated\) in the last hour \(only 0\.0 h of the last hour recorded\)\./);assert.match(a.view(j).reply,/get_usage,switch_off/)
 const b=createAssistant(f.service,{clock:f.now,providers:{local:scripted({tool:'switch_off',input:{device:'kettle'}},{answer:'asked'}),cloud:null}})
 const k=b.start({message:'switch the kettle off'}).job_id;await until(()=>b.view(k).status==='done')
 const {token,device}=b.view(k).confirm;assert.equal(device,'kettle')
 assert.match(b.confirm({token}).message,/No switch fitted for kettle/)
 assert.throws(()=>b.confirm({token}),/not valid/)                    // single use
 const c=createAssistant(f.service,{clock:f.now,providers:{local:scripted({tool:'switch_off',input:{device:'kettle'}},{answer:'asked'}),cloud:null}})
 const m=c.start({message:'off'}).job_id;await until(()=>c.view(m).status==='done')
 f.advance(6*60000);assert.throws(()=>c.confirm({token:c.view(m).confirm.token}),/expired/)
}finally{f.close()}})

test('switch_off refuses a device that is not on',async()=>{const f=fixture();try{
 f.mains(100,0);f.kettle(0,.9,0)
 const a=createAssistant(f.service,{clock:f.now,providers:{local:scripted({tool:'switch_off',input:{device:'kettle'}},{answer:'x'}),cloud:null}})
 const j=a.start({message:'off'}).job_id;await until(()=>a.view(j).status==='done')
 assert.match(a.view(j).reply,/kettle is not on/);assert.equal(a.view(j).confirm,null)
}finally{f.close()}})

// Provider adapters

test('local adapter: tool call, then answer; unreachable server gives a clear message',async()=>{
 const replies=[{tool_calls:[{id:'1',function:{name:'get_usage',arguments:'{"device":"kettle","period":"today"}'}}]},{content:'About 20 minutes.'}]
 const seen=[];const fetchImpl=async(url,opts)=>{seen.push(JSON.parse(opts.body));return {ok:true,json:async()=>({choices:[{message:replies.shift()}]})}}
 const run=localChat({fetchImpl})
 const out=await run({system:'s',user:'u',specs:SPEC,execute:async()=>'kettle: 0.33 h on',signal:undefined,maxRounds:3})
 assert.equal(out,'About 20 minutes.');assert.equal(seen[1].messages.at(-1).role,'tool');assert.equal(seen[0].temperature,.1)
 const down=localChat({fetchImpl:async()=>{throw new TypeError('fetch failed')}})
 await assert.rejects(down({system:'s',user:'u',specs:SPEC,execute:async()=>'',maxRounds:3}),/lms server start/)
})

test('cloud adapter: tool_use loop, refusal, fallbacks and a missing key',async()=>{
 const calls=[],replies=[
  {stop_reason:'tool_use',content:[{type:'tool_use',id:'t1',name:'get_usage',input:{device:'kettle',period:'today'}}]},
  {stop_reason:'end_turn',content:[{type:'text',text:'About 20 minutes.'}]}]
 const client={beta:{messages:{create:async(body)=>{calls.push(structuredClone(body));return replies.shift()}}}}
 const out=await cloudChat({client})({system:'s',user:'u',specs:SPEC,execute:async()=>'kettle: 0.33 h on',maxRounds:5})
 assert.equal(out,'About 20 minutes.')
 assert.equal(calls[0].model,'claude-opus-5-5');assert.deepEqual(calls[0].tool_choice,{type:'auto'});assert.equal(calls[0].fallbacks,'default');assert.deepEqual(calls[0].betas,['server-side-fallback-2026-07-01'])
 assert.deepEqual(calls[1].messages.at(-1).content,[{type:'tool_result',tool_use_id:'t1',content:'kettle: 0.33 h on'}])
 const refusing={beta:{messages:{create:async()=>({stop_reason:'refusal',content:[]})}}}
 assert.equal(await cloudChat({client:refusing})({system:'s',user:'u',specs:[],execute:async()=>'',maxRounds:5}),'Claude declined to answer this.')
 const saved=process.env.ANTHROPIC_API_KEY;delete process.env.ANTHROPIC_API_KEY
 try{await assert.rejects(cloudChat()({system:'s',user:'u',specs:[],execute:async()=>'',maxRounds:5}),/Cloud is not set up/)}
 finally{if(saved!==undefined)process.env.ANTHROPIC_API_KEY=saved}
})


// Review fixes

test('the last tool round still gets an answer; malformed tool arguments are reported, not fatal',async()=>{
 const replies=[
  {tool_calls:[{id:'1',function:{name:'get_usage',arguments:'{"device":'}}]},   // malformed JSON
  {tool_calls:[{id:'2',function:{name:'get_usage',arguments:'{"device":"kettle","period":"today"}'}}]},
  {content:'About 20 minutes.'}]
 const seen=[];const fetchImpl=async(url,opts)=>{seen.push(JSON.parse(opts.body));return {ok:true,json:async()=>({choices:[{message:replies.shift()}]})}}
 const ran=[];const out=await localChat({fetchImpl})({system:'s',user:'u',specs:SPEC,execute:async(n,i)=>{ran.push(i);return 'ok'},maxRounds:2})
 assert.equal(out,'About 20 minutes.')
 assert.equal(seen[1].messages.at(-1).content,'Invalid arguments.')
 assert.deepEqual(ran,[{device:'kettle',period:'today'}])
 assert.equal(seen[2].tool_choice,'none');assert.equal(seen[0].tool_choice,'auto')   // the last call must answer
 const garbled=localChat({fetchImpl:async()=>({ok:true,json:async()=>({nothing:true})})})
 await assert.rejects(garbled({system:'s',user:'u',specs:SPEC,execute:async()=>'',maxRounds:2}),/could not be read/)
})

test('the system prompt mentions VA only for VA data',()=>{
 assert.match(systemPrompt({demand_basis:'apparent_estimate_va'}),/apparent power in VA/)
 assert.doesNotMatch(systemPrompt({demand_basis:'reported'}),/VA/)
})

test('a cancelled question cannot switch anything off; the running job can be found again',async()=>{const f=fixture();try{
 f.mains(2093,0);f.kettle(2000,.94,0)
 let release;const slowAsk=async({execute})=>{await execute('switch_off',{device:'kettle'});await new Promise(r=>{release=r});return 'asked'}
 const a=createAssistant(f.service,{clock:f.now,providers:{local:slowAsk,cloud:null}})
 const j=a.start({message:'off'}).job_id
 await until(()=>a.view(j).confirm)
 assert.equal(a.current().job.job_id,j)
 const token=a.view(j).confirm.token
 a.cancel(j);release()
 assert.equal(a.current().job,null)
 assert.throws(()=>a.confirm({token}),/not valid/)
}finally{f.close()}})

test('usage does not count time before a long gap',()=>{const f=fixture();try{
 f.kettle(2000,.9,0)                       // one reading, then nothing for an hour
 f.advance(3600000);f.kettle(2000,.9,0);f.advance(5000);f.kettle(2000,.9,0)
 const u=f.service.usage('kettle',f.now()-60000,f.now())
 assert.equal(Math.round(u.hours_on*3600),5)
}finally{f.close()}})

test('the backup planner refuses to compare a VA home total with battery watts',()=>{const f=fixture();try{
 f.mains(2093,0);f.kettle(2000,.94,0)
 const plan=f.service.previewPlan({selected_ids:['kettle'],target_hours:2})
 assert.equal(plan.baseline.status,'insufficient_data');assert.equal(plan.baseline_basis,'apparent_estimate_va')
 assert.deepEqual(plan.missing_channels,['kettle'])        // inferred loads are never planned on
}finally{f.close()}})

test('HTTP: gateway posts alerts, owner dismisses them with an empty body, the assistant routes work',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nilm-http-'))
 const answer=async()=>'Hello.'
 const app=createApp({databasePath:join(dir,'t.sqlite'),ownerToken:'owner-secret',assistantProviders:{local:answer,cloud:answer}})
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r))
 const base=`http://127.0.0.1:${app.server.address().port}/api/v1`
 const call=async(path,method,token,body,raw)=>{const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:raw??(body===undefined?undefined:JSON.stringify(body))});return {status:r.status,data:await r.json()}}
 try{
  const gw=(await call('/gateways','POST','owner-secret',{id:'nilm',name:'NILM'})).data.token
  await call('/devices','POST','owner-secret',{id:'mains',name:'Mains',gateway_id:'nilm',role:'whole_home',measurement_kind:'aggregate'})
  const alert={schema_version:1,message_id:'a1',raised_at:new Date().toISOString(),kind:'missed_event',device_id:null,value:null,amount:-900}
  assert.equal((await call('/alerts','POST','owner-secret',alert)).status,401)          // the owner token cannot post alerts
  assert.equal((await call('/alerts','POST',gw,alert)).status,200)
  const open=(await call('/snapshot','GET','owner-secret')).data.alerts
  assert.equal(open.length,1)
  assert.equal((await call(`/alerts/${open[0].id}/ack`,'POST',gw,undefined,'')).status,401)  // gateways cannot dismiss
  assert.equal((await call(`/alerts/${open[0].id}/ack`,'POST','owner-secret',undefined,'')).status,200)
  assert.equal((await call('/snapshot','GET','owner-secret')).data.alerts.length,0)
  const started=await call('/assistant','POST','owner-secret',{message:'hi'})
  assert.equal(started.status,202)
  await until(()=>true);await new Promise(r=>setTimeout(r,20))
  const job=await call(`/assistant/${started.data.job_id}`,'GET','owner-secret')
  assert.equal(job.data.status,'done');assert.equal(job.data.reply,'Hello.')
  assert.equal((await call('/assistant/current','GET','owner-secret')).data.job,null)
  assert.equal((await call('/assistant/abcdef','GET','owner-secret')).status,404)
  assert.equal((await call('/assistant','POST',gw,{message:'hi'})).status,401)          // gateways cannot ask
 }finally{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true})}
})


test('device health: newest check per device, owned by the gateway, listed in the snapshot',()=>{const f=fixture();try{
 const h={schema_version:1,message_id:'h1',device_id:'kettle',checked_at:new Date(f.now()).toISOString(),status:'watch',samples:2,days_outside:1,
  shape_diff:.02,shape_limit:.1,surge_peak:2,surge_low:1.5,surge_high:2.5,settle_ms:400,settle_low:20,settle_high:60,p:.9}
 f.service.ingestHealth(h,f.gateway)
 assert.equal(f.service.ingestHealth(h,f.gateway).duplicate,true)
 f.service.ingestHealth({...h,message_id:'h0',checked_at:new Date(f.now()-60000).toISOString(),status:'ok'},f.gateway)   // older: ignored
 assert.deepEqual(f.service.snapshot().health.map(x=>[x.device_id,x.status]),[['kettle','watch']])
 assert.throws(()=>f.service.ingestHealth({...h,message_id:'h2',status:'bad'},f.gateway),/status/)
 const other=f.service.registerGateway({id:'other',name:'Other'})
 assert.throws(()=>f.service.ingestHealth({...h,message_id:'h3'},{id:other.id,mode:'hardware'}),e=>e.status===403)
}finally{f.close()}})
