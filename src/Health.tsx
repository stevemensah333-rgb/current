import {useEnergy} from './store'
import type {Health} from './telemetry'
import {Icon} from './ui'

const STATUS={
 ok:{icon:'check',label:'Healthy'},
 watch:{icon:'alert',label:'Keep an eye on it'},
 alert:{icon:'alert',label:'Check this device'}
} as const

/** The fault monitor's checks, said in everyday words. Only what is unusual is listed. */
function noticed(h:Health):string[]{
 const out:string[]=[]
 if(h.shape_diff>h.shape_limit)out.push('It draws power differently from when you taught it.')
 if(h.surge_peak>h.surge_high)out.push('It starts with a bigger jolt than usual.')
 if(h.surge_peak<h.surge_low)out.push('It starts with a smaller jolt than usual.')
 if(h.settle_ms>h.settle_high)out.push('It takes longer than usual to settle after switching on.')
 if(h.settle_ms<h.settle_low)out.push('It settles faster than usual after switching on.')
 return out
}

/** Today, Yesterday, or a day-month date (Ghana writes dates day first). */
function dayLabel(iso:string){
 const d=new Date(iso),start=(x:Date)=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime()
 const days=Math.round((start(new Date())-start(d))/86400000)
 return days===0?'Today':days===1?'Yesterday':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:d.getFullYear()===new Date().getFullYear()?undefined:'numeric'})
}

/** One row per taught device: its latest switch-on compared with how it behaved when it was taught. */
export function DeviceHealth(){
 const t=useEnergy(s=>s.telemetry)
 const devices=t?.devices.filter(d=>d.measurement_kind==='inferred')||[]
 const health=new Map((t?.health||[]).map(h=>[h.device_id,h]))
 return <div className="screen-content health-screen">
  <div className="health-intro"><Icon name="pulse" size={26}/><div>
   <p className="muted">Every time a device switches on, we compare it with how it behaved when you taught it. A slow change can warn of a fault before the device fails.</p></div></div>
  {!devices.length?<p className="empty">No appliances named yet. Register one under Appliances → Register device: switch it on and off five times while the app listens. It then appears here.</p>:
  <div className="panel health-table-wrap"><table className="health-table">
   <thead><tr><th>Device</th><th>Status</th><th>What we noticed</th><th>Last check</th></tr></thead>
   <tbody>{devices.map(d=>{const h=health.get(d.id) as Health|undefined
    if(!h)return <tr key={d.id}><th scope="row">{d.name}<small>{d.room}</small></th><td colSpan={3} className="muted">Not checked yet. It is checked the next time it switches on.</td></tr>
    const st=STATUS[h.status],notes=noticed(h)
    return <tr key={d.id} className={`health-${h.status}`}>
     <th scope="row">{d.name}<small>{d.room}</small></th>
     <td data-label="Status"><span className={`health-badge ${h.status}`}><Icon name={st.icon} size={15}/>{st.label}</span></td>
     <td data-label="What we noticed">{notes.length?notes.map(n=><p key={n} className="health-note">{n}</p>):<p className="health-note">Working as usual.</p>}
      {h.days_outside>1&&<small>For {h.days_outside} days in a row.</small>}</td>
     <td data-label="Last check"><b>{dayLabel(h.checked_at)}</b><small>{h.samples} switch-on{h.samples>1?'s':''} that day</small></td>
    </tr>})}</tbody>
  </table></div>}
 </div>
}
