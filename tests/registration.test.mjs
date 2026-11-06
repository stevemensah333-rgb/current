import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createApp} from '../server/index.mjs'
import {channelId} from '../server/registration.mjs'

// A turn's raw waveform, as the gateway sends it: 17 readings per cycle, 10 cycles before, the rest after.
const cycle=amps=>Array.from({length:17},(_,i)=>Math.round(amps*Math.SQRT2*Math.sin(2*Math.PI*i/17)*1e4)/1e4)
const wave=(n=60)=>({readings_per_cycle:17,
 on:{t_ms:1000,before:Array(10).fill(cycle(0)),after:Array(n).fill(cycle(8.7))},
 off:{t_ms:4000,before:Array(10).fill(cycle(8.7)),after:Array(50).fill(cycle(0))}})

async function server(){
 const dir=mkdtempSync(join(tmpdir(),'reg-http-'))
 const app=createApp({databasePath:join(dir,'t.sqlite'),ownerToken:'owner-secret'})
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r))
 const base=`http://127.0.0.1:${app.server.address().port}/api/v1`
 const call=async(path,method,token,body)=>{const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}}
 const close=async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true})}
 return {call,close}
}
async function withMonitor(call){
 const gw=(await call('/gateways','POST','owner-secret',{id:'nilm',name:'NILM'})).data.token
 await call('/devices','POST','owner-secret',{id:'mains',name:'Mains',gateway_id:'nilm',role:'whole_home',measurement_kind:'aggregate'})
 return gw
}
let n=0
const turn=(fields)=>({schema_version:1,message_id:`t${++n}`,status:'kept',number:1,message:'turn 1 of 5 kept',on_step_va:2000,off_step_va:-2000,shape:[0,1,0,-1],waveform:wave(),...fields})

test('channel ids match the pipeline',()=>{
 assert.equal(channelId('Kitchen Kettle'),'kitchen-kettle')
 assert.equal(channelId('  ##  '),'device')
})

test('registration: 5 kept turns with waveforms, then the device channel exists',async()=>{
 const {call,close}=await server();try{
  assert.equal((await call('/registrations','POST','owner-secret',{name:'Kettle'})).status,409)   // no monitor yet
  const gw=await withMonitor(call)
  const started=await call('/registrations','POST','owner-secret',{name:'Kettle',kind:'kettle',room:'Kitchen'})
  assert.equal(started.status,201);assert.equal(started.data.status,'waiting');assert.equal(started.data.target,5)
  const id=started.data.id
  assert.equal((await call('/registrations','POST','owner-secret',{name:'Fan'})).status,409)      // one at a time
  // the gateway sees it
  const asked=await call('/gateway/registration','GET',gw)
  assert.deepEqual([asked.data.registration.id,asked.data.registration.name,asked.data.registration.turns],[id,'Kettle',5])
  assert.equal((await call('/gateway/registration','GET','owner-secret')).status,401)
  // a waiting switch-on, a redo, then 5 kept turns
  await call(`/gateway/registrations/${id}/turns`,'POST',gw,turn({status:'waiting',message:'turn 1: switched on',off_step_va:null,waveform:null}))
  await call(`/gateway/registrations/${id}/turns`,'POST',gw,turn({status:'redo',message:'turn 1 redo'}))
  assert.equal((await call(`/gateway/registrations/${id}/status`,'POST',gw,{schema_version:1,message_id:'s0',status:'done'})).status,409)  // not 5 yet
  for(let k=1;k<=5;k++){
   const r=await call(`/gateway/registrations/${id}/turns`,'POST',gw,turn({number:k,message:`turn ${k} of 5 kept`,waveform:wave(500)}))  // the largest capture fits
   assert.equal(r.status,200,JSON.stringify(r.data))
  }
  const view=(await call(`/registrations/${id}`,'GET','owner-secret')).data
  assert.equal(view.status,'running');assert.equal(view.kept,5);assert.equal(view.turns.length,7)
  assert.deepEqual(view.turns.map(t=>t.status),['waiting','redo','kept','kept','kept','kept','kept'])
  assert.equal(view.turns[0].has_waveform,false);assert.equal(view.turns[2].has_waveform,true)
  assert.equal(view.turns[2].waveform,undefined)                     // the list stays small; the waveform is fetched per turn
  // the stored raw waveform comes back as sent
  const stored=(await call(`/registrations/${id}/turns/${view.turns[2].id}/waveform`,'GET','owner-secret')).data
  assert.equal(stored.waveform.readings_per_cycle,17);assert.equal(stored.waveform.on.after.length,500);assert.deepEqual(stored.waveform.on.after[0],cycle(8.7))
  assert.equal((await call(`/registrations/${id}/turns/${view.turns[2].id}/waveform`,'GET',gw)).status,401)
  // done: the channel is registered for the gateway, under the same id the pipeline uses
  const done=await call(`/gateway/registrations/${id}/status`,'POST',gw,{schema_version:1,message_id:'s1',status:'done',message:'saved',device_id:'kettle'})
  assert.equal(done.status,200)
  assert.equal((await call(`/gateway/registrations/${id}/status`,'POST',gw,{schema_version:1,message_id:'s1',status:'done',device_id:'kettle'})).data.duplicate,true)
  const snap=(await call('/snapshot','GET','owner-secret')).data
  const kettle=snap.devices.find(d=>d.id==='kettle')
  assert.deepEqual([kettle.measurement_kind,kettle.parent_device_id,kettle.room,kettle.kind],['inferred','mains','Kitchen','kettle'])
  assert.equal((await call('/registrations/current','GET','owner-secret')).data.registration.status,'done')
  assert.equal((await call('/gateway/registration','GET',gw)).data.registration,null)
  // registering the same name again keeps the channel
  const again=await call('/registrations','POST','owner-secret',{name:'kettle',room:'Kitchen'})
  assert.equal(again.status,201)
  assert.equal((await call(`/registrations/${again.data.id}`,'DELETE','owner-secret')).data.status,'cancelled')
  assert.equal((await call(`/gateway/registrations/${again.data.id}/turns`,'POST',gw,turn())).status,409)   // cancelled: turns refused
 }finally{await close()}
})

test('registration input is checked',async()=>{
 const {call,close}=await server();try{
  const gw=await withMonitor(call)
  assert.equal((await call('/registrations','POST','owner-secret',{name:'Mains'})).status,400)
  assert.equal((await call('/registrations','POST','owner-secret',{name:'Fan',room:'A very long room name'})).status,400)
  const id=(await call('/registrations','POST','owner-secret',{name:'Fan'})).data.id
  const bad=async fields=>(await call(`/gateway/registrations/${id}/turns`,'POST',gw,turn(fields))).status
  assert.equal(await bad({status:'maybe'}),400)
  assert.equal(await bad({number:6}),400)
  assert.equal(await bad({waveform:{...wave(),readings_per_cycle:16}}),400)        // every cycle must hold 16
  assert.equal(await bad({waveform:{...wave(),on:{t_ms:0,before:[[NaN]],after:[]}}}),400)
  assert.equal(await bad({waveform:wave(601)}),400)                                 // longer than any capture
  const otherGw=(await call('/gateways','POST','owner-secret',{id:'other',name:'Other'})).data.token
  assert.equal((await call(`/gateway/registrations/${id}/turns`,'POST',otherGw,turn())).status,403)
 }finally{await close()}
})
