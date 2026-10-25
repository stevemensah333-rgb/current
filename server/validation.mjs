export class ApiError extends Error { constructor(status,message){super(message);this.status=status} }
export const fail=(message,status=400)=>{throw new ApiError(status,message)}
export function object(v){if(!v||typeof v!=='object'||Array.isArray(v))fail('Expected a JSON object');return v}
export function keys(v,allowed){for(const k of Object.keys(v))if(!allowed.includes(k))fail(`Unknown field: ${k}`)}
export function text(v,name,max=100){if(typeof v!=='string'||!v.trim()||v.length>max)fail(`${name} must be a nonempty string of at most ${max} characters`);return v.trim()}
export function id(v,name='id'){const s=text(v,name,80);if(!/^[a-zA-Z0-9_-]+$/.test(s))fail(`${name} must use letters, digits, _ or -`);return s}
export function number(v,name,min=0,max=1e9){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(`${name} must be a finite number from ${min} to ${max}`);return v}
export function optionalNumber(v,name,min=0,max=1e9){return v==null?null:number(v,name,min,max)}
export function bool(v,name){if(typeof v!=='boolean')fail(`${name} must be boolean`);return v}
export function oneOf(v,name,options){if(!options.includes(v))fail(`${name} must be one of: ${options.join(', ')}`);return v}
export const roles=['appliance','whole_home','solar','grid','battery','generator']
export function deviceInput(raw){
 const v=object(raw);keys(v,['id','name','room','kind','role','measurement_kind','parent_device_id','gateway_id','nominal_power_w','critical','expected_interval_s'])
 const role=oneOf(v.role??'appliance','role',roles),kind=oneOf(v.measurement_kind??'direct','measurement_kind',['direct','aggregate','inferred'])
 if(kind==='inferred'&&role!=='appliance')fail('Only appliance channels may be inferred')
 return {id:id(v.id),name:text(v.name,'name',48),room:text(v.room??'Living room','room',48),kind:text(v.kind??'generic','kind',32),role,measurement_kind:kind,parent_device_id:kind==='inferred'?id(v.parent_device_id,'parent_device_id'):null,gateway_id:id(v.gateway_id,'gateway_id'),nominal_power_w:optionalNumber(v.nominal_power_w,'nominal_power_w',1,1e7),critical:v.critical==null?false:bool(v.critical,'critical'),expected_interval_s:number(v.expected_interval_s??5,'expected_interval_s',1,3600)}
}
export function readingInput(raw,now=Date.now()){
 const v=object(raw);keys(v,['schema_version','message_id','device_id','boot_id','sequence','measured_at','power_w','energy_total_wh','current_a','voltage_v','power_factor','battery_soc_pct','provenance','inference'])
 if(v.schema_version!==1)fail('Unsupported schema_version; expected 1')
 const measured=text(v.measured_at,'measured_at',40)
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(measured)||!Number.isFinite(Date.parse(measured)))fail('measured_at must be an ISO 8601 timestamp with timezone')
 const parts=measured.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/).slice(1).map(Number);if(parts[1]<1||parts[1]>12||parts[2]<1||parts[2]>new Date(Date.UTC(parts[0],parts[1],0)).getUTCDate()||parts[3]>23||parts[4]>59||parts[5]>59)fail('Invalid calendar date or time');
 const at=Date.parse(measured);if(at>now+30000)fail('Reading is more than 30 seconds in the future');if(at<now-7*86400000)fail('Reading is older than the seven-day backfill window')
 const result={schema_version:1,message_id:id(v.message_id,'message_id'),device_id:id(v.device_id,'device_id'),boot_id:id(v.boot_id,'boot_id'),sequence:v.sequence==null?null:number(v.sequence,'sequence',0,Number.MAX_SAFE_INTEGER),measured_at:new Date(at).toISOString(),power_w:optionalNumber(v.power_w,'power_w',-1e7,1e7),energy_total_wh:optionalNumber(v.energy_total_wh,'energy_total_wh',0,1e15),current_a:optionalNumber(v.current_a,'current_a',0,1e5),voltage_v:optionalNumber(v.voltage_v,'voltage_v',0,1e4),power_factor:optionalNumber(v.power_factor,'power_factor',0,1),battery_soc_pct:optionalNumber(v.battery_soc_pct,'battery_soc_pct',0,100),provenance:oneOf(v.provenance,'provenance',['measured','simulated','inferred']),inference:null}
 if(result.sequence!=null&&!Number.isInteger(result.sequence))fail('sequence must be an integer')
 if(['power_w','energy_total_wh','current_a','voltage_v','battery_soc_pct'].every(k=>result[k]==null))fail('Provide at least one measurement')
 if(result.provenance==='inferred'){
  const i=object(v.inference);keys(i,['parent_device_id','model_version','confidence']);result.inference={parent_device_id:id(i.parent_device_id),model_version:text(i.model_version,'model_version',80),confidence:optionalNumber(i.confidence,'confidence',0,1)}
 }else if(v.inference!=null)fail('inference metadata is only allowed for inferred readings')
 return result
}
