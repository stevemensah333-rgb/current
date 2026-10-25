/** Pure, deterministic calculations. No network, state, AI or device commands. */
export type NumericReading = { measured_at:string; boot_id:string; power_w:number|null; energy_total_wh:number|null }
export function realPower(input:{power_w?:number|null;voltage_v?:number|null;current_a?:number|null;power_factor?:number|null}) {
 if(input.power_w!=null)return {value:input.power_w,basis:'reported' as const}
 if(input.voltage_v!=null&&input.current_a!=null&&input.power_factor!=null)
  return {value:input.voltage_v*input.current_a*input.power_factor,basis:'calculated_from_voltage_current_pf' as const}
 return {value:null,basis:'unavailable' as const}
}
export function energyBetween(a:NumericReading,b:NumericReading,maxGapSeconds:number){
 const seconds=(Date.parse(b.measured_at)-Date.parse(a.measured_at))/1000
 if(seconds<=0)return {wh:0,basis:'none',gap:false}
 if(a.boot_id!==b.boot_id)return {wh:0,basis:'unknown_restart',gap:true}
 if(a.energy_total_wh!=null&&b.energy_total_wh!=null){
  if(b.energy_total_wh<a.energy_total_wh)return {wh:0,basis:'unknown_counter_reset',gap:true}
  return {wh:b.energy_total_wh-a.energy_total_wh,basis:'counter_delta',gap:false}
 }
 if(seconds>maxGapSeconds||a.power_w==null||b.power_w==null)return {wh:0,basis:'unknown_interval',gap:true}
 // Consumers and production channels use positive magnitudes. Signed battery/grid
 // channels must use separate import/export counters for exact directional energy.
 if(a.power_w<0||b.power_w<0)return {wh:0,basis:'unknown_direction',gap:true}
 return {wh:(a.power_w+b.power_w)/2*seconds/3600,basis:'integrated_power',gap:false}
}
export type BatteryConfig={capacity_kwh:number|null;reserve_pct:number;efficiency:number;max_discharge_w:number|null}
export function backupEstimate(loadW:number|null,soc:number|null,config:BatteryConfig){
 const assumptions=['Constant current load','No solar or grid contribution','Configured battery capacity, efficiency and reserve']
 if(loadW==null||soc==null||config.capacity_kwh==null||config.max_discharge_w==null)
  return {status:'insufficient_data',runtime_hours:null,usable_kwh:null,assumptions}
 const usable=Math.max(0,(soc-config.reserve_pct)/100*config.capacity_kwh*config.efficiency)
 if(loadW>config.max_discharge_w)return {status:'power_limit_exceeded',runtime_hours:0,usable_kwh:usable,assumptions}
 if(loadW<=0)return {status:'no_active_load',runtime_hours:null,usable_kwh:usable,assumptions}
 return {status:usable>0?'estimated':'reserve_reached',runtime_hours:usable/(loadW/1000),usable_kwh:usable,assumptions}
}
export function costAtRate(energyWh:number|null,pricePerKwh:number|null){return energyWh==null||pricePerKwh==null?null:energyWh/1000*pricePerKwh}
