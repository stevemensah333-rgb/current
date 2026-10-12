import {create} from 'zustand'
import {DEFAULT_RATES,dispatch,seedDevices,tick,type Device,type Rates,type Room,type Scenario} from './energy.ts'
export type Sample={minute:number;demand:number;solar:number;battery:number;grid:number;generator:number}
interface State { devices:Device[]; selected:string; room:Room|'All rooms'; scenario:Scenario; soc:number; rates:Rates; paused:boolean; minute:number; energy:number; cost:number; samples:Sample[]; savedPlan:Record<string,boolean>|null; notice:string;
 select:(id:string)=>void;setRoom:(room:Room|'All rooms')=>void;setScenario:(s:Scenario)=>void;toggle:(id:string)=>void;setOnline:(id:string)=>void;setCritical:(id:string)=>void;add:(d:Pick<Device,'name'|'room'|'watts'|'critical'|'kind'>)=>void;remove:(id:string)=>void;advance:()=>void;pause:()=>void;essential:()=>void;restore:()=>void;reset:()=>void;setRate:(key:keyof Rates,value:number)=>void }
const initial=()=>({devices:seedDevices(), selected:'ac',room:'All rooms' as const,scenario:'day' as const,soc:72,rates:{...DEFAULT_RATES},paused:false,minute:0,energy:0,cost:0,samples:[] as Sample[],savedPlan:null,notice:''})
export const useEnergy=create<State>((set,get)=>({...initial(),
 select:selected=>set({selected}),setRoom:room=>set({room}),
 setScenario:scenario=>set({scenario,notice:`${scenario==='outage'?'Grid supply lost — reviewing backup coverage.':'Scenario updated.'}`}),
 toggle:id=>set(s=>({devices:s.devices.map(d=>d.id===id?{...d,on:!d.on,reading:d.on?0:d.watts}:d)})),
 setOnline:id=>set(s=>({devices:s.devices.map(d=>d.id===id?{...d,online:!d.online}:d)})),
 setCritical:id=>set(s=>({devices:s.devices.map(d=>d.id===id?{...d,critical:!d.critical}:d)})),
 add:d=>{ const id=crypto.randomUUID(); set(s=>({devices:[...s.devices,{...d,id,monitorId:`MON-${id.slice(0,6).toUpperCase()}`,on:true,online:true,reading:d.watts,energy:0,cost:0}],selected:id,room:'All rooms',notice:`${d.name} attached to ${d.room} with a simulated monitor.`})) },
 remove:id=>set(s=>({devices:s.devices.filter(d=>d.id!==id),selected:s.devices.find(d=>d.id!==id)?.id||'',notice:'Monitor removed from the demo.'})),
 advance:()=>{const s=get();if(s.paused)return;const result=tick(s.devices,s.scenario,s.soc,s.rates,s.minute/5);set({devices:result.devices,soc:result.soc,minute:s.minute+5,energy:s.energy+result.energy,cost:s.cost+result.cost,samples:[...s.samples,{minute:s.minute+5,...result.flow}].slice(-36)})},
 pause:()=>set(s=>({paused:!s.paused})),
 essential:()=>set(s=>({savedPlan:s.savedPlan||Object.fromEntries(s.devices.map(d=>[d.id,d.on])),devices:s.devices.map(d=>{const on=d.critical&&(s.savedPlan?.[d.id]??d.on);return {...d,on,reading:d.online?(on?d.watts:0):d.reading}}),notice:'Essential-load plan applied in simulation. Non-essential appliances are paused.'})),
 restore:()=>set(s=>({devices:s.devices.map(d=>({...d,on:s.savedPlan?.[d.id]??d.on,reading:d.online?(s.savedPlan?.[d.id]??d.on)?d.watts:0:d.reading})),savedPlan:null,notice:'Previous appliance plan restored.'})),
 reset:()=>set(initial()),setRate:(key,value)=>{if(Number.isFinite(value)&&value>=0&&value<=100)set(s=>({rates:{...s.rates,[key]:value}}))}
}))
export function getFlow(s:Pick<State,'devices'|'scenario'|'soc'|'rates'>){return dispatch(s.devices.filter(d=>d.online).reduce((sum,d)=>sum+d.reading,0),s.scenario,s.soc,s.rates)}
