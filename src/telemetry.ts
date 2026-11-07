import type {BatteryConfig} from '../shared/calculations'
import {isApparent} from '../shared/calculations.ts'
export {isApparent}
export type Provenance='measured'|'simulated'|'inferred'
export type Channel={id:string;name:string;room:string;kind:string;gateway_id:string;role:'appliance'|'whole_home'|'solar'|'grid'|'battery'|'generator';measurement_kind:'direct'|'aggregate'|'inferred';parent_device_id:string|null;nominal_power_w:number|null;critical:boolean;expected_interval_s:number;mode:'hardware'|'simulator';can_switch:false;simulator_control:boolean;power_w:number|null;last_known_power_w:number|null;power_basis:string;fresh:boolean;age_seconds:number|null;energy_wh:number|null;energy_methods:string[];covered_seconds:number;observed_seconds:number;unknown_intervals:number;cost_at_grid_rate_ghs:number|null;latest:{reading_id:number;measured_at:string;received_at:string;provenance:Provenance;power_w:number|null;apparent_power_va?:number|null;current_a:number|null;voltage_v:number|null;battery_soc_pct:number|null;inference:{model_version:string;confidence:number|null}|null}|null}
export type Settings={battery:BatteryConfig;rates:{grid:number|null;generator:number|null;battery:number|null};currency:'GHS';stale_after_s:number;max_integration_gap_s:number;assistant:{provider:Provider};tariff:{scheme:'ecg'|'flat';category:'residential'|'non_residential'}}
export type Provider='local'|'cloud'
export type Health={device_id:string;checked_at:string;status:'ok'|'watch'|'alert';samples:number;days_outside:number;shape_diff:number;shape_limit:number;surge_peak:number;surge_low:number;surge_high:number;settle_ms:number;settle_low:number;settle_high:number;p:number}
export type Alert={id:number;kind:'fault'|'missed_event'|'unexplained_off';device_id:string|null;value:'shape_diff'|'surge_peak'|'settle_ms'|null;amount:number|null;raised_at:string}
export type Snapshot={schema_version:1;as_of:string;window_hours:number;devices:Channel[];settings:Settings;simulation:{enabled:boolean;paused:boolean;scenario:'day'|'night'|'outage'|'generator';states:Record<string,boolean>;offline_ids:string[]};demand_w:number|null;demand_basis:string;unnamed_va:number|null;alerts:Alert[];health:Health[];demand_scope:'whole_home'|'monitored_appliances';monitored_power_w:number|null;unattributed_power_w:number|null;energy_wh:number|null;cost_at_grid_rate_ghs:number|null;cost_basis:string;tariff?:{scheme:'ecg'|'flat';name:string;category:'residential'|'non_residential';average_price_ghs_per_kwh:number|null;day_cost_ghs:number|null};sources:{solar:number|null;grid:number|null;battery:number|null;generator:number|null};battery_soc_pct:number|null;data_quality:{missing_channels:string[];inferred_channels:string[];unknown_energy_intervals:number};ai:{enabled:boolean;provider:Provider;model:string;cloud_name?:'deepseek'|'claude';cloud_ready:boolean}}
export type Plan={as_of:string;selected_ids:string[];target_hours:number;load_w:number|null;load_basis:string|null;baseline_basis:string;baseline:{status:string;runtime_hours:number|null};status:string;runtime_hours:number|null;usable_kwh:number|null;assumptions:string[];missing_channels:string[];mixed_provenance:boolean;target_feasible:boolean|null;budget_status:string;budget_reason:string|null;execution:string;ai_generated:false}
export async function api<T>(path:string,method='GET',body?:unknown):Promise<T>{
 const response=await fetch(`/api/v1${path}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)})
 const data=await response.json().catch(()=>({error:'Backend returned an invalid response'}))
 if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`)
 return data as T
}
/** Power in watts, or kilowatts from 1,000 W: 850 -> "850 W", 1350 -> "1.35 kW". */
export const fmtPower=(value:number)=>Math.abs(value)<1000?`${Math.round(value).toLocaleString()} W`:`${(value/1000).toFixed(2)} kW`
export const watts=(value:number|null|undefined)=>value==null?'Unavailable':fmtPower(value)
// Power is shown in watts. From the clamp alone it is estimated from current at 230 V (power factor taken as 1),
// so it can read a little high for motors and chargers; estimated tells the screen to say so.
export const powerLabel=(value:number|null|undefined,_basis?:string|null)=>watts(value)
export const powerUnit=(t:Snapshot|null)=>({long:'watts',short:'W',estimated:isApparent(t?.demand_basis)})
/** Energy in kWh (estimated when it comes from the clamp alone). */
export const energyLabel=(wh:number|null|undefined,_methods:string[]=[])=>wh==null?'Unavailable':`${(wh/1000).toFixed(2)} kWh`
const VALUE_NAMES={shape_diff:'shape',surge_peak:'switch-on surge',settle_ms:'settling time'}
/** The app, not the gateway, writes every alert sentence. */
export function alertText(a:Alert,name:(id:string)=>string){
 const who=a.device_id?name(a.device_id):'Home'
 if(a.kind==='fault')return `${who}: ${a.value?VALUE_NAMES[a.value]:'reading'} outside its normal range for several days in a row${a.amount!=null&&a.value==='settle_ms'?` (${Math.round(a.amount)} ms)`:''}.`
 if(a.kind==='missed_event')return `The home total changed by ${a.amount!=null?fmtPower(a.amount):'an unknown amount'} without a recognised switch.`
 return `Something switched off (${a.amount!=null?fmtPower(Math.abs(a.amount)):'unknown size'}) that was not on the list.`
}
