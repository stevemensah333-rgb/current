import {test} from 'node:test'
import assert from 'node:assert/strict'
import {dispatch,tick,seedDevices,DEFAULT_RATES} from './energy.ts'
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`)
test('solar plus grid balances daytime demand',()=>{const f=dispatch(1856,'day',72,DEFAULT_RATES);close(f.solar,1050);close(f.grid,806);close(f.solar+f.grid+f.battery+f.generator+f.unserved,1856)})
test('outage enforces inverter power limit and reserve',()=>{const f=dispatch(3000,'outage',72,DEFAULT_RATES);close(f.solar,180);close(f.battery,2000);close(f.unserved,820);const empty=dispatch(1856,'outage',20,DEFAULT_RATES);close(empty.battery,0);close(empty.unserved,1676)})
test('tick integrates W to kWh and apportions delivered energy and cost',()=>{const r=tick(seedDevices(),'day',72,DEFAULT_RATES,0);close(r.energy,r.flow.demand/1000*5/60);close(r.devices.reduce((s,d)=>s+d.energy,0),r.energy);close(r.devices.reduce((s,d)=>s+d.cost,0),r.cost);close(r.cost,r.flow.costPerHour*5/60)})
test('near-empty battery cannot deliver energy below reserve',()=>{const r=tick(seedDevices(),'outage',20.01,DEFAULT_RATES,0);close(r.soc,20);close(r.energy,r.flow.solar/1000*5/60+.0001*5*.9)})
test('offline monitor reading remains stale and is excluded from known demand',()=>{const d=seedDevices();d[0].online=false;d[0].reading=1000;const r=tick(d,'day',72,DEFAULT_RATES,0);close(r.devices[0].reading,1000);close(r.devices[0].energy,0);close(r.flow.demand,r.devices.slice(1).reduce((s,d)=>s+d.reading,0))})
test('all sources balance across scenarios, loads, and battery states',()=>{for(const scenario of ['day','outage','night','generator'] as const)for(const watts of [0,100,1000,3500,6000])for(const soc of [20,21,72]){const f=dispatch(watts,scenario,soc,DEFAULT_RATES);close(f.solar+f.grid+f.battery+f.generator+f.unserved,watts);assert.ok(f.battery<=2000);assert.ok(f.generator<=3000);assert.ok(f.unserved>=0)}})
test('essential plan extends backup and zero net demand needs no discharge',()=>{const d=seedDevices();const all=d.filter(d=>d.on).reduce((s,d)=>s+d.watts,0),essential=d.filter(d=>d.on&&d.critical).reduce((s,d)=>s+d.watts,0);assert.ok(dispatch(essential,'outage',72,DEFAULT_RATES).runtime>dispatch(all,'outage',72,DEFAULT_RATES).runtime);assert.equal(dispatch(100,'outage',72,DEFAULT_RATES).runtime,Infinity)})

test('backup priorities can be revised after applying a plan and restored',async()=>{
 const {useEnergy}=await import('./store.ts')
 useEnergy.getState().reset()
 useEnergy.getState().essential()
 assert.equal(useEnergy.getState().devices.find(d=>d.id==='ac')?.on,false)
 useEnergy.getState().setCritical('ac')
 useEnergy.getState().essential()
 assert.equal(useEnergy.getState().devices.find(d=>d.id==='ac')?.on,true)
 assert.equal(useEnergy.getState().devices.find(d=>d.id==='kettle')?.on,false)
 useEnergy.getState().restore()
 assert.equal(useEnergy.getState().devices.find(d=>d.id==='tv')?.on,true)
 assert.equal(useEnergy.getState().savedPlan,null)
 useEnergy.getState().reset()
})
