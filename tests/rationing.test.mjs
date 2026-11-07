import test from 'node:test'
import assert from 'node:assert/strict'
import {rationPlan,meterRatio} from '../shared/calculations.ts'

// The design example: GHS 100 at GHS 1.80 = 55.56 kWh, wanted for 14 days; the home uses 6.0 kWh a day.
const HOME=[
 {id:'ac',name:'AC',kind:'ac',critical:false,kwh_day:3.0,hours_day:5},          // 0.6 kWh an hour
 {id:'fridge',name:'Fridge',kind:'fridge',critical:true,kwh_day:1.2,hours_day:24},
 {id:'pump',name:'Water pump',kind:'generic',critical:false,kwh_day:0.8,hours_day:1},
 {id:'kettle',name:'Kettle',kind:'kettle',critical:false,kwh_day:0.6,hours_day:0.5},
 {id:'tv',name:'TV',kind:'tv',critical:false,kwh_day:0.4,hours_day:4}]
const base={budget_kwh:100/1.8,days:14,devices:HOME,unnamed_kwh_day:0,days_of_data:7}

test('budget, current pace and the gap',()=>{
 const p=rationPlan(base)
 assert.equal(p.daily_budget_kwh,3.97);assert.equal(p.baseline_kwh_day,6);assert.equal(p.days_at_current_pace,9.3);assert.equal(p.gap_kwh_day,2.03)
})

test('cuts close the gap: biggest non-essential first, spread before switching anything off',()=>{
 const p=rationPlan(base)
 assert.equal(p.status,'fits_with_cuts')
 assert.ok(p.days_with_plan>=14,`lasts ${p.days_with_plan} days`)
 assert.ok(p.planned_kwh_day<=p.daily_budget_kwh)
 const ac=p.cuts.find(c=>c.id==='ac')
 assert.deepEqual([ac.action,ac.from_hours,ac.to_hours],['limit',5,2.5])        // first pass: at most half its hours
 assert.ok(!p.cuts.some(c=>c.id==='fridge'))                                      // never cut
 assert.deepEqual(p.kept_on.map(k=>k.id),['fridge'])
 assert.ok(p.cuts.every(c=>Number.isInteger(Math.round(c.to_hours*400)/100)))    // whole quarter hours
 assert.ok(!p.cuts.some(c=>c.action==='off'))                                    // half-hours were enough
})

test('the plan does not cut more than it needs to',()=>{
 const p=rationPlan({...base,days:10})                                            // gap is only 0.44 kWh a day
 const saved=p.cuts.reduce((s,c)=>s+c.saves_kwh_day,0)
 assert.ok(saved>=0.44&&saved<0.44+0.6*0.25+1e-9,`saved ${saved}`)               // at most one quarter hour of the AC over
 assert.deepEqual(p.cuts.map(c=>c.id),['ac'])
})

test('keep_on is respected and the plan finds the savings elsewhere',()=>{
 const p=rationPlan({...base,keep_on:['ac']})
 assert.ok(!p.cuts.some(c=>c.id==='ac'));assert.ok(p.kept_on.some(k=>k.id==='ac'&&/asked/.test(k.why)))
 assert.ok(p.cuts.some(c=>c.action==='off'))                                      // the gap now needs devices switched off
})

test('an impossible target says so, with the shortfall',()=>{
 const p=rationPlan({...base,days:50})                                            // 1.11 kWh a day; the fridge alone uses 1.2
 assert.equal(p.status,'cannot_fit');assert.ok(p.shortfall_kwh_day>0)
 assert.ok(p.days_with_plan<50)
})

test('essential devices are trimmed last and by a quarter at most',()=>{
 const devices=[{id:'light',name:'Lights',kind:'lights',critical:true,kwh_day:2,hours_day:8},{id:'tv',name:'TV',kind:'tv',critical:false,kwh_day:0.5,hours_day:4}]
 const p=rationPlan({budget_kwh:18,days:10,devices,unnamed_kwh_day:0,days_of_data:5})   // 1.8 a day, uses 2.5
 const light=p.cuts.find(c=>c.id==='light'),tv=p.cuts.find(c=>c.id==='tv')
 assert.equal(tv.action,'off')                                                    // the non-essential goes first, fully
 assert.ok(light.to_hours>=6&&light.to_hours<8)                                 // trimmed, but 8 h -> no less than 6 h
 assert.equal(p.status,'fits_with_cuts')
})

test('a device on for less than a quarter hour a day can still be switched off',()=>{
 const devices=[{id:'iron',name:'Iron',kind:'generic',critical:false,kwh_day:0.3,hours_day:0.2}]
 const p=rationPlan({budget_kwh:1,days:10,devices,unnamed_kwh_day:0,days_of_data:5})
 assert.deepEqual(p.cuts.map(c=>[c.id,c.action]),[['iron','off']])
})

test('already fits; not enough data; unnamed use and the meter ratio count',()=>{
 assert.equal(rationPlan({...base,days:5}).status,'already_fits')
 assert.equal(rationPlan({...base,days_of_data:0.5}).status,'insufficient_data')
 assert.equal(rationPlan({...base,days_of_data:2}).low_confidence,true)
 const p=rationPlan({...base,unnamed_kwh_day:1,meter_ratio:0.8})
 assert.equal(p.baseline_kwh_day,5.6)                                             // (6 + 1) x 0.8
 assert.equal(p.unnamed_kwh_day,0.8)
})

test('meter ratio: meter kWh against the app estimate, refused when it cannot be right',()=>{
 assert.equal(meterRatio(10,12.5),0.8)
 assert.equal(meterRatio(10,null),null);assert.equal(meterRatio(10,0.2),null);assert.equal(meterRatio(30,10),null)
})
