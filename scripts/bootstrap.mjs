import {resolve,dirname} from 'node:path'
import {openDatabase,localToken,hash,simulation} from '../server/database.mjs'
import {createService} from '../server/service.mjs'
import {seedDevices} from '../src/energy.ts'
export function bootstrap(){
 const databasePath=resolve(process.env.APEIRON_DB||'.data/apeiron.sqlite'),db=openDatabase(databasePath),service=createService(db)
 const token=localToken(dirname(databasePath),'simulator.key');localToken(dirname(databasePath),'owner.key')
 db.prepare('INSERT OR IGNORE INTO gateways VALUES(?,?,?,?)').run('simulator','Local simulator',hash(token),'simulator')
 const count=db.prepare('SELECT count(*) AS count FROM devices').get().count
 if(!count){
  db.exec('BEGIN IMMEDIATE')
  try{
   for(const d of seedDevices())service.registerDevice({id:d.id,name:d.name,room:d.room,kind:d.kind,role:'appliance',measurement_kind:'direct',gateway_id:'simulator',nominal_power_w:d.watts,critical:d.critical,expected_interval_s:2})
   for(const role of ['whole_home','solar','grid','battery','generator'])service.registerDevice({id:role==='whole_home'?'mains':role,name:role==='whole_home'?'Whole-home meter':role,role,measurement_kind:role==='whole_home'?'aggregate':'direct',gateway_id:'simulator',expected_interval_s:2})
   service.updateSettings({battery:{capacity_kwh:5,reserve_pct:20,efficiency:.9,max_discharge_w:2000},rates:{grid:1.95,battery:.6,generator:4.8}})
   const states=Object.fromEntries(seedDevices().map(d=>[d.id,d.on]));service.setSimulation({enabled:true,states});db.exec('COMMIT')
  }catch(e){db.exec('ROLLBACK');throw e}
 }
 db.close()
}
if(process.argv[1]?.endsWith('bootstrap.mjs'))bootstrap()
