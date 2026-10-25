import {randomBytes} from 'node:crypto'
import {hash,config,simulation,allDevices,putDevice} from './database.mjs'
import {ApiError,fail,object,keys,id,text,number,optionalNumber,bool,oneOf,deviceInput,readingInput} from './validation.mjs'
import {realPower,energyBetween,backupEstimate,costAtRate} from '../shared/calculations.ts'

export function createService(db,{clock=()=>Date.now()}={}){
 const now=()=>new Date(clock()).toISOString()
 const getDevice=deviceId=>{const row=db.prepare('SELECT metadata,active FROM devices WHERE id=?').get(deviceId);if(!row||!row.active)fail('Device not found',404);return JSON.parse(row.metadata)}
 function registerGateway(v){object(v);keys(v,['id','name']);const gateway={id:id(v.id),name:text(v.name,'name',80)},token=randomBytes(32).toString('hex');db.prepare('INSERT INTO gateways VALUES(?,?,?,?)').run(gateway.id,gateway.name,hash(token),'hardware');return {...gateway,token}}
 function registerDevice(raw){
  const d=deviceInput(raw);const g=db.prepare('SELECT mode FROM gateways WHERE id=?').get(d.gateway_id);if(!g)fail('Unknown gateway',404)
  if(allDevices(db).length>=64)fail('This single-home base supports at most 64 active channels',409)
  if(d.measurement_kind==='inferred'){const parent=getDevice(d.parent_device_id);if(parent.measurement_kind!=='aggregate'||parent.role!=='whole_home')fail('Inference parent must be an aggregate whole-home channel')}
  if(d.role==='whole_home'&&allDevices(db).some(x=>x.role==='whole_home'))fail('Only one whole-home authority may be active',409)
  if(d.role!=='appliance'&&allDevices(db).some(x=>x.role===d.role))fail('Only one active channel per source role is supported in this base',409)
  d.mode=g.mode;d.can_switch=false;d.simulator_control=g.mode==='simulator'
  putDevice(db,d);return d
 }
 function ingest(raw,gateway){
  const r=readingInput(raw,clock()),d=getDevice(r.device_id)
  if(d.gateway_id!==gateway.id)fail('Gateway is not authorized for this device',403)
  if(gateway.mode==='simulator'&&r.provenance!=='simulated')fail('Simulator gateways may only send simulated readings')
  if(gateway.mode==='hardware'&&r.provenance==='simulated')fail('Hardware gateways may not send simulated readings')
  if(d.measurement_kind==='inferred'){
   if(r.provenance!=='inferred')fail('Inferred channels require inferred provenance')
   if(r.inference.parent_device_id!==d.parent_device_id)fail('Inference parent does not match registration')
   if(r.battery_soc_pct!=null||r.energy_total_wh!=null)fail('Inferred channels accept estimated power, not physical counters or battery state')
  }else if(r.provenance==='inferred')fail('Inferred readings require an inferred channel')
  if(!['grid','battery'].includes(d.role)&&r.power_w!=null&&r.power_w<0)fail('Negative power is only supported for bidirectional grid/battery channels')
  if(d.role!=='battery'&&r.battery_soc_pct!=null)fail('battery_soc_pct requires a battery channel')
  const normalized=JSON.stringify(r),digest=hash(normalized)
  const old=db.prepare('SELECT id,payload_hash FROM readings WHERE gateway_id=? AND message_id=?').get(gateway.id,r.message_id)
  if(old){if(old.payload_hash!==digest)fail('message_id was already used for different data',409);return {id:old.id,duplicate:true}}
  const result=db.prepare('INSERT INTO readings(gateway_id,device_id,message_id,measured_at,received_at,payload,payload_hash,boot_id,sequence) VALUES(?,?,?,?,?,?,?,?,?)').run(gateway.id,r.device_id,r.message_id,r.measured_at,now(),normalized,digest,r.boot_id,r.sequence)
  return {id:Number(result.lastInsertRowid),duplicate:false}
 }
 function deviceSummary(d){
  const latestRow=db.prepare('SELECT * FROM readings WHERE device_id=? ORDER BY measured_at DESC LIMIT 1').get(d.id)
  const latest=latestRow?JSON.parse(latestRow.payload):null,p=latest?realPower(latest):{value:null,basis:'unavailable'},cfg=config(db)
  const age=latest?Math.max(0,(clock()-Date.parse(latest.measured_at))/1000):null
  const fresh=age!=null&&age<=Math.max(cfg.stale_after_s,d.expected_interval_s*3)&&Date.parse(latest.measured_at)<=clock()
  const rows=db.prepare('SELECT payload FROM readings WHERE device_id=? AND measured_at>=? ORDER BY measured_at').all(d.id,new Date(clock()-86400000).toISOString()).map(x=>JSON.parse(x.payload))
  let energy=0,gaps=0,intervals=0,coveredSeconds=0;const methods=new Set()
  for(let i=1;i<rows.length;i++){const a={...rows[i-1],power_w:realPower(rows[i-1]).value},b={...rows[i],power_w:realPower(rows[i]).value},part=energyBetween(a,b,cfg.max_integration_gap_s);energy+=part.wh;if(part.gap)gaps++;else if(part.basis!=='none'){intervals++;coveredSeconds+=(Date.parse(b.measured_at)-Date.parse(a.measured_at))/1000};methods.add(part.basis)}
  return {...d,latest:latest?{...latest,reading_id:latestRow.id,received_at:latestRow.received_at}:null,fresh,age_seconds:age,power_w:fresh?p.value:null,last_known_power_w:p.value,power_basis:p.basis,energy_wh:intervals?energy:null,energy_methods:[...methods],covered_seconds:coveredSeconds,observed_seconds:rows.length>1?(Date.parse(rows.at(-1).measured_at)-Date.parse(rows[0].measured_at))/1000:0,unknown_intervals:gaps,cost_at_grid_rate_ghs:costAtRate(intervals?energy:null,cfg.rates.grid)}
 }
 function snapshot(){
  const devices=allDevices(db).map(deviceSummary),main=devices.find(d=>d.role==='whole_home'),direct=devices.filter(d=>d.role==='appliance'&&d.measurement_kind==='direct'),fresh=direct.filter(d=>d.power_w!=null)
  // A registered aggregate is authoritative, even when stale. Never silently
  // replace a missing whole-home reading with a smaller appliance subtotal.
  const demand=main?main.power_w:fresh.length?fresh.reduce((s,d)=>s+d.power_w,0):null
  const sourceDevices=Object.fromEntries(['solar','grid','battery','generator'].map(role=>[role,devices.find(d=>d.role===role)||null]))
  const battery=sourceDevices.battery
  const totalEnergy=main?main.energy_wh:direct.some(d=>d.energy_wh!=null)?direct.reduce((s,d)=>s+(d.energy_wh??0),0):null
  return {schema_version:1,as_of:now(),window_hours:24,devices,settings:config(db),simulation:simulation(db),demand_w:demand,demand_scope:main?'whole_home':'monitored_appliances',monitored_power_w:fresh.length?fresh.reduce((s,d)=>s+d.power_w,0):null,unattributed_power_w:main?.power_w!=null&&fresh.length?Math.max(0,main.power_w-fresh.reduce((s,d)=>s+d.power_w,0)):null,energy_wh:totalEnergy,cost_at_grid_rate_ghs:costAtRate(totalEnergy,config(db).rates.grid),cost_basis:'Energy at current configured grid rate; not a mixed-source bill',sources:Object.fromEntries(Object.entries(sourceDevices).map(([role,d])=>[role,d?.power_w??null])),battery_soc_pct:battery?.fresh?battery.latest?.battery_soc_pct??null:null,data_quality:{missing_channels:devices.filter(d=>!d.fresh||d.power_w==null).map(d=>d.id),inferred_channels:devices.filter(d=>d.measurement_kind==='inferred').map(d=>d.id),unknown_energy_intervals:devices.reduce((s,d)=>s+d.unknown_intervals,0)},ai:{enabled:false,status:'not_implemented'}}
 }
 function updateSettings(raw){const v=object(raw);keys(v,['battery','rates']);const cfg=config(db)
  if(v.battery){const b=object(v.battery);keys(b,['capacity_kwh','reserve_pct','efficiency','max_discharge_w']);cfg.battery={capacity_kwh:optionalNumber(b.capacity_kwh,'capacity_kwh',.01,10000),reserve_pct:number(b.reserve_pct,'reserve_pct',0,100),efficiency:number(b.efficiency,'efficiency',.01,1),max_discharge_w:optionalNumber(b.max_discharge_w,'max_discharge_w',1,1e7)}}
  if(v.rates){object(v.rates);keys(v.rates,['grid','generator','battery']);for(const k of ['grid','generator','battery'])cfg.rates[k]=optionalNumber(v.rates[k],k,0,1000)}
  db.prepare('UPDATE settings SET payload=? WHERE id=1').run(JSON.stringify(cfg));return cfg
 }
 function previewPlan(raw){const v=object(raw);keys(v,['selected_ids','target_hours','budget_ghs']);if(!Array.isArray(v.selected_ids)||v.selected_ids.length>64||new Set(v.selected_ids).size!==v.selected_ids.length)fail('selected_ids must be a unique list of at most 64 device IDs')
  const target=number(v.target_hours,'target_hours',.01,168),budget=optionalNumber(v.budget_ghs,'budget_ghs',0,1e6),s=snapshot(),selected=v.selected_ids.map(x=>{const d=s.devices.find(d=>d.id===id(x));if(!d||d.role!=='appliance')fail('Select active appliance channels only');return d})
  const missing=selected.filter(d=>d.power_w==null||d.measurement_kind==='inferred').map(d=>d.id)
  const provenances=new Set(selected.map(d=>d.latest?.provenance));const batteryChannel=s.devices.find(d=>d.role==='battery');const mixed=provenances.size>1||(selected.length&&batteryChannel?.latest&&provenances.size===1&&!provenances.has(batteryChannel.latest.provenance))
  const load=missing.length||mixed?null:selected.reduce((sum,d)=>sum+d.power_w,0)
  const result=backupEstimate(load,s.battery_soc_pct,s.settings.battery),baseline=backupEstimate(s.demand_w,s.battery_soc_pct,s.settings.battery)
  const feasible=missing.length||result.status==='insufficient_data'?null:result.status==='no_active_load'?true:result.status==='estimated'?result.runtime_hours>=target:false
  return {as_of:s.as_of,selected_ids:v.selected_ids,target_hours:target,load_w:load,baseline,...result,missing_channels:missing,mixed_provenance:Boolean(mixed),target_feasible:feasible,budget_ghs:budget,budget_status:budget==null?'not_requested':'not_evaluated',budget_reason:budget==null?null:'Source dispatch, charging cost and fuel consumption are not known. No budget guarantee can be made.',execution:'advisory_only',ai_generated:false}
 }
 function setSimulation(raw){const v=object(raw);keys(v,['enabled','paused','scenario','states','offline_ids']);const state=simulation(db)
  for(const k of ['enabled','paused'])if(v[k]!=null)state[k]=bool(v[k],k)
  if(v.scenario!=null)state.scenario=oneOf(v.scenario,'scenario',['day','outage','night','generator'])
  if(v.states){object(v.states);for(const [key,value] of Object.entries(v.states)){const d=getDevice(key);if(!d.simulator_control||d.role!=='appliance')fail('Physical devices cannot be controlled by the simulator',409);state.states[key]=bool(value,key)}}
  if(v.offline_ids){if(!Array.isArray(v.offline_ids))fail('offline_ids must be an array');state.offline_ids=v.offline_ids.map(x=>{const d=getDevice(id(x));if(!d.simulator_control)fail('Not a simulator channel');return d.id})}
  db.prepare('UPDATE simulation SET payload=? WHERE id=1').run(JSON.stringify(state));return state
 }
 function patchDevice(deviceId,raw){const d=getDevice(deviceId),v=object(raw);keys(v,['critical']);d.critical=bool(v.critical,'critical');db.prepare('UPDATE devices SET metadata=? WHERE id=?').run(JSON.stringify(d),d.id);return d}
 function retire(deviceId){const d=getDevice(deviceId);if(allDevices(db).some(x=>x.parent_device_id===d.id))fail('Retire dependent inferred channels first',409);db.prepare('UPDATE devices SET active=0 WHERE id=?').run(d.id);return {retired:true,history_retained:true}}
 return {registerGateway,registerDevice,ingest,snapshot,updateSettings,previewPlan,setSimulation,patchDevice,retire,getDevice,context:()=>({contract_version:1,generated_at:now(),evidence:snapshot(),constraints:{recommendations_implemented:false,commands_allowed:false,inferred_readings_are_estimates:true},recommendations:[]})}
}
