import {readFileSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
const base=process.env.APEIRON_API||`http://127.0.0.1:${process.env.APEIRON_PORT||5183}`,token=process.env.APEIRON_GATEWAY_TOKEN||readFileSync(resolve(dirname(resolve(process.env.APEIRON_DB||'.data/apeiron.sqlite')),'simulator.key'),'utf8').trim()
const boot=randomUUID(),interval=Math.max(100,Number(process.env.SIM_INTERVAL_MS||2000)),fault=process.argv.find(x=>x.startsWith('--fault='))?.split('=')[1]
const energy=new Map();let seq=0,last=Date.now(),soc=72,pending=null,stopping=false
process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true})
async function api(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error(`${response.status}: ${await response.text()}`);return response.json()}
console.log('Simulator sends wall-clock readings through the authenticated ingestion API; no hardware or NILM inference is being simulated as measured data.')
while(!stopping){
 try{
  const cfg=await api('/api/v1/gateway/config'),time=Date.now(),hours=Math.min((time-last)/3600000,interval*2/3600000);last=time
  if(!cfg.simulation?.enabled||cfg.simulation.paused){await delay(interval);continue}
  seq++;const scenario=cfg.simulation.scenario,appliances=cfg.devices.filter(d=>d.role==='appliance'&&d.measurement_kind==='direct')
  const powers=Object.fromEntries(appliances.map(d=>[d.id,cfg.simulation.states[d.id]===false?0:Math.round((d.nominal_power_w||100)*(1+.02*Math.sin(seq*.31+d.id.length)))]))
  const demand=Object.values(powers).reduce((s,w)=>s+w,0),solar=Math.min(demand,scenario==='day'?1050:scenario==='outage'?180:0)
  let remaining=demand-solar;const grid=['day','night'].includes(scenario)?remaining:0;remaining-=grid
  const generator=scenario==='generator'?Math.min(3000,remaining):0;remaining-=generator
  const battery=soc>cfg.settings.battery.reserve_pct?Math.min(remaining,cfg.settings.battery.max_discharge_w||0):0
  const capacity=cfg.settings.battery.capacity_kwh||5
  soc=Math.max(cfg.settings.battery.reserve_pct,soc-battery/1000*hours/(capacity*cfg.settings.battery.efficiency)*100)
  Object.assign(powers,{mains:demand,solar,grid,generator,battery})
  for(const d of cfg.devices){
   if(cfg.simulation.offline_ids.includes(d.id))continue
   if(fault==='dropout'&&d.id==='ac'&&seq%20>=5)continue
   const power=powers[d.id];if(power==null)continue
   energy.set(d.id,(energy.get(d.id)||0)+power*hours)
   const message={schema_version:1,message_id:`${boot}-${d.id}-${seq}`,device_id:d.id,boot_id:boot,sequence:seq,measured_at:new Date(time).toISOString(),power_w:power,energy_total_wh:energy.get(d.id),provenance:'simulated',...(d.role==='battery'?{battery_soc_pct:soc}:{})}
   if(fault==='out-of-order'&&d.id==='ac'&&seq%5===0){pending=message;continue}
   await api('/api/v1/readings',message)
   if(fault==='duplicate'&&seq%5===0)await api('/api/v1/readings',message)
   if(pending&&d.id==='ac'){await api('/api/v1/readings',pending);pending=null}
   if(fault==='invalid'&&d.id==='ac'&&seq%5===0){try{await api('/api/v1/readings',{...message,message_id:`bad-${seq}`,power_w:'not-a-number'})}catch{console.log('Invalid fixture rejected as expected')}}
  }
  if(process.argv.includes('--once'))break
 }catch(e){console.error('Simulator:',e.message);if(process.argv.includes('--once'))process.exitCode=1}
 if(process.argv.includes('--once'))break
 await delay(interval)
}
