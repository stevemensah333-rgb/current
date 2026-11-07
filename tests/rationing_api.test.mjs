import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDatabase} from '../server/database.mjs'
import {createService} from '../server/service.mjs'
import {createRationing,planText} from '../server/rationing.mjs'
import {createAssistant} from '../server/assistant.mjs'

const START=Date.parse('2026-11-03T00:00:00Z'),STEP=60000,DAY=86400000   // one reading a minute keeps the test fast
// A recorded home: the clamp sees 200 VA all day, plus a 2000 VA kettle for one hour each day (07:00-08:00 UTC).
function home(days=2){
 const dir=mkdtempSync(join(tmpdir(),'ration-')),db=openDatabase(join(dir,'t.sqlite'));let time=START
 db.prepare("UPDATE settings SET payload=json_set(payload,'$.max_integration_gap_s',120) WHERE id=1").run()   // minute readings are not gaps
 const service=createService(db,{clock:()=>time}),gw=service.registerGateway({id:'nilm',name:'NILM'}),gateway={id:gw.id,mode:'hardware'}
 service.registerDevice({id:'mains',name:'Mains',gateway_id:'nilm',role:'whole_home',measurement_kind:'aggregate',expected_interval_s:5})
 service.registerDevice({id:'kettle',name:'Kettle',gateway_id:'nilm',role:'appliance',measurement_kind:'inferred',parent_device_id:'mains',kind:'kettle',room:'Kitchen',expected_interval_s:10})
 let seq=0
 const post=(device_id,fields)=>service.ingest({schema_version:1,message_id:`m${++seq}`,device_id,boot_id:'b1',sequence:seq,measured_at:new Date(time).toISOString(),...fields},gateway)
 const run=ms=>{const end=time+ms;for(;time<end;time+=STEP){const on=(time-START)%DAY>=7*3600000&&(time-START)%DAY<8*3600000
  post('mains',{current_a:(on?2200:200)/230,apparent_power_va:on?2200:200,provenance:'measured'})
  post('kettle',{apparent_power_va:on?2000:0,provenance:'inferred',inference:{parent_device_id:'mains',model_version:'t',confidence:.9}})}}
 run(days*DAY)
 const rationing=createRationing(db,service,{clock:()=>time})
 return {db,service,rationing,run,now:()=>time,close:()=>{db.close();rmSync(dir,{recursive:true,force:true})}}
}

test('daily usage per device, and what is not yet named',()=>{const h=home();try{
 const u=h.rationing.dailyUsage()
 assert.ok(Math.abs(u.days_of_data-2)<0.01,`days ${u.days_of_data}`)
 assert.ok(Math.abs(u.home_kwh_day-6.8)<0.05,`home ${u.home_kwh_day}`)                 // 200 VA x 24 h + 2000 VA x 1 h
 const k=u.devices.find(d=>d.id==='kettle')
 assert.ok(Math.abs(k.kwh_day-2)<0.05&&Math.abs(k.hours_day-1)<0.02,`kettle ${k.kwh_day} kWh, ${k.hours_day} h`)
 assert.ok(Math.abs(u.unnamed_kwh_day-4.8)<0.05);assert.equal(u.apparent,true)
}finally{h.close()}})

test('preview: credit in GHS needs a price; kWh units do not; unknown devices are refused',()=>{const h=home();try{
 assert.throws(()=>h.rationing.preview({amount:50,unit:'ghs',days:5,keep_on:[]}),/price per kWh/)
 const p=h.rationing.preview({amount:50,unit:'ghs',days:5,tariff_ghs_per_kwh:2,keep_on:[]})   // 25 kWh -> 5 a day
 assert.equal(p.plan.budget_kwh,25);assert.equal(p.plan.daily_budget_kwh,5)
 assert.equal(p.plan.status,'fits_with_cuts')                                                  // only the kettle can go: 6.8 - 2 = 4.8 <= 5
 const k=h.rationing.preview({amount:20,unit:'kwh',days:5,keep_on:[]})                       // 4 a day; best is 4.8 -> short
 assert.equal(k.plan.status,'cannot_fit');assert.deepEqual(k.plan.cuts.map(c=>[c.id,c.action]),[['kettle','off']])
 assert.throws(()=>h.rationing.preview({amount:20,unit:'kwh',days:5,keep_on:['toaster']}),/Unknown appliance/)
 assert.throws(()=>h.rationing.preview({amount:20,unit:'kwh',days:500}),/days/)
 assert.match(planText(k),/Switch off Kettle .* saves 2 kWh a day/)
 assert.match(planText(k),/not named yet/)
}finally{h.close()}})

test('meter check: two readings a day apart scale the app figures',()=>{const h=home();try{
 assert.equal(h.rationing.meter().ratio,null)
 h.rationing.addMeterReading({units_left:100})
 assert.match(h.rationing.meter().message,/again in a day/)
 h.run(DAY)                                                                                     // app counts 6.8 kVAh
 const m=h.rationing.addMeterReading({units_left:94.0})                                          // meter counted 6.0 kWh
 assert.ok(Math.abs(m.ratio-6/6.8)<0.01,`ratio ${m.ratio}`)
 const p=h.rationing.preview({amount:30,unit:'kwh',days:5,keep_on:[]})
 assert.ok(Math.abs(p.plan.baseline_kwh_day-6.0)<0.06,`baseline ${p.plan.baseline_kwh_day}`)   // 6.8 x 0.88
 h.rationing.addMeterReading({units_left:150})                                                    // a top-up
 assert.equal(h.rationing.meter().ratio,null)
}finally{h.close()}})

test('a saved plan tracks today, credit left and each device limit',()=>{const h=home();try{
 assert.equal(h.rationing.current().plan,null)
 const saved=h.rationing.save({amount:30,unit:'kwh',days:7,keep_on:[]})                        // 4.29 a day
 assert.equal(saved.plan.input.days,7);assert.equal(saved.progress.status,'on_track')
 h.run(DAY)                                                                                       // one more day at 6.8
 const g=h.rationing.current().progress
 assert.ok(Math.abs(g.used_kwh-6.8)<0.05,`used ${g.used_kwh}`);assert.ok(Math.abs(g.left_kwh-23.2)<0.05)
 assert.ok(Math.abs(g.days_left-6)<0.01);assert.ok(Math.abs(g.per_day_left_kwh-23.2/6)<0.02)
 const kettle=g.limits.find(l=>l.id==='kettle')
 assert.ok(kettle&&kettle.limit_hours<1)
 assert.match(h.rationing.stateText(),/Credit plan: .* kWh left for 6\.0 days/)
 assert.equal(h.rationing.end().plan,null)
}finally{h.close()}})

test('the assistant plans with the plan_rationing tool and explains only its numbers',async()=>{const h=home();try{
 let seen=null
 const provider=async({specs,execute,system})=>{seen={names:specs.map(s=>s.name),system};return execute('plan_rationing',{amount:20,unit:'kwh',days:5,keep_on:[]})}
 const a=createAssistant(h.service,{clock:h.now,rationing:h.rationing,providers:{local:provider,cloud:provider}})
 const {job_id}=a.start({message:'Make 20 kWh last 5 days'})
 await new Promise(r=>setTimeout(r,20))
 const v=a.view(job_id)
 assert.equal(v.status,'done');assert.match(v.reply,/Budget 20 kWh for 5 days = 4 kWh a day/)
 assert.ok(seen.names.includes('plan_rationing'));assert.match(seen.system,/plan_rationing/)
 const bad=await createAssistant(h.service,{clock:h.now,rationing:h.rationing,providers:{local:async({execute})=>execute('plan_rationing',{amount:5,unit:'ghs',days:3,keep_on:[]}),cloud:null}})
 const j2=bad.start({message:'x'});await new Promise(r=>setTimeout(r,20))
 assert.match(bad.view(j2.job_id).reply,/price per kWh/)                                         // errors come back as text
}finally{h.close()}})
