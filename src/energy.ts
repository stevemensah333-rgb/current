export type Room = 'Living room' | 'Kitchen' | 'Bedroom' | 'Office'
export type Scenario = 'day' | 'outage' | 'night' | 'generator'
export type Device = { id: string; monitorId: string; name: string; kind: string; room: Room; watts: number; critical: boolean; on: boolean; online: boolean; reading: number; energy: number; cost: number }
export type Rates = { grid: number; generator: number; battery: number }
export const ROOM_NAMES: Room[] = ['Living room', 'Kitchen', 'Bedroom', 'Office']
export const SOURCE_COLORS = { solar:'var(--yellow)', grid:'var(--grid-color)', battery:'var(--green)', generator:'var(--generator-color)' }
export const SCENARIOS: Record<Scenario, {name:string;time:string;solar:number;grid:boolean;generator:boolean;description:string}> = {
 day:{name:'Sunny afternoon',time:'14:00',solar:1050,grid:true,generator:false,description:'Solar first. Grid supplies the remaining demand.'},
 outage:{name:'Grid outage',time:'18:30',solar:180,grid:false,generator:false,description:'Low sunlight. Battery covers demand up to its 2 kW limit.'},
 night:{name:'Evening peak',time:'20:00',solar:0,grid:true,generator:false,description:'No solar production. Grid supplies the home.'},
 generator:{name:'Generator backup',time:'19:00',solar:0,grid:false,generator:true,description:'Generator covers up to 3 kW. Battery supplies any remaining load.'}
}
export const DEFAULT_RATES: Rates = { grid:1.95,generator:4.8,battery:.6 }
export function seedDevices(): Device[] {
 const entries: [string,string,string,Room,number,boolean,boolean][] = [
 ['ac','Air conditioner','ac','Living room',1350,false,true],['tv','Television','tv','Living room',95,false,true],
 ['fridge','Refrigerator','fridge','Kitchen',150,true,true],['kettle','Electric kettle','kettle','Kitchen',1800,false,false],
 ['lights','Bedroom lights','lights','Bedroom',24,true,true],['fan','Ceiling fan','fan','Bedroom',60,false,true],
 ['router','Wi-Fi router','router','Office',12,true,true],['laptop','Work laptop','laptop','Office',65,true,true]]
 return entries.map(([id,name,kind,room,watts,critical,on],i)=>({id,monitorId:`MON-${String(i+1).padStart(3,'0')}`,name,kind,room,watts,critical,on,online:true,reading:on?watts:0,energy:0,cost:0}))
}
export function dispatch(demand:number, scenario:Scenario, soc:number, rates:Rates, solarAvailable=SCENARIOS[scenario].solar) {
 const config=SCENARIOS[scenario]
 const solar=Math.min(demand,solarAvailable)
 let remaining=Math.max(0,demand-solar)
 const grid=config.grid?remaining:0; remaining-=grid
 const generator=config.generator?Math.min(3000,remaining):0; remaining-=generator
 const battery=soc>20?Math.min(2000,remaining):0; remaining-=battery
 const usableKwh=Math.max(0,(soc-20)/100*5*.9)
 const netDemand=Math.max(0,demand-solar)
 const runtime=netDemand>0?usableKwh/(netDemand/1000):Infinity
 return {solar,grid,generator,battery,unserved:Math.max(0,remaining),demand,costPerHour:(grid*rates.grid+generator*rates.generator+battery*rates.battery)/1000,runtime,usableKwh}
}
export function readingAt(d:Device,step:number) {
 if(!d.on)return 0
 const variation=1+.035*Math.sin(step*.71+d.watts*.013)
 return Math.round(d.watts*variation)
}
// Five simulated minutes per tick. Actual elapsed simulation time is bounded by
// remaining battery energy; no energy is delivered below the 20% reserve.
export function tick(devices:Device[], scenario:Scenario, soc:number, rates:Rates, step:number) {
 const next=devices.map(d=>({...d,reading:d.online?readingAt(d,step):d.reading}))
 const demand=next.filter(d=>d.online).reduce((s,d)=>s+d.reading,0)
 const flow=dispatch(demand,scenario,soc,rates)
 const hours=5/60
 const deliveredBattery=Math.min(flow.battery/1000*hours,flow.usableKwh)
 const deliveredKwh=(flow.solar+flow.grid+flow.generator)/1000*hours+deliveredBattery
 const cost=(flow.grid*rates.grid+flow.generator*rates.generator)/1000*hours+deliveredBattery*rates.battery
 const newSoc=Math.max(20,soc-deliveredBattery/(5*.9)*100)
 return {devices:next.map(d=>({...d,energy:d.energy+(d.online&&demand?deliveredKwh*d.reading/demand:0),cost:d.cost+(d.online&&demand?cost*d.reading/demand:0)})),soc:newSoc,flow,energy:deliveredKwh,cost}
}
