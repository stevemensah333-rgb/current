import {createServer} from 'node:http'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {timingSafeEqual} from 'node:crypto'
import {openDatabase,localToken,hash,allDevices,config,simulation} from './database.mjs'
import {realPower} from '../shared/calculations.ts'
import {createService} from './service.mjs'
import {ApiError,fail} from './validation.mjs'
export function createApp({databasePath,ownerToken,clock}={}){
 const db=openDatabase(databasePath),service=createService(db,{clock})
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff')
  const send=(status,data)=>{res.writeHead(status);res.end(JSON.stringify(data))}
  try{
   const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method
   if(req.headers.origin&&!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin))fail('Origin not allowed',403)
   if(path==='/api/health'&&method==='GET')return send(200,{ok:true,service:'apeiron-base',schema_version:1})
   const credential=(req.headers.authorization||'').replace(/^Bearer /,'')
   const owner=timingSafeEqual(Buffer.from(hash(credential)),Buffer.from(hash(ownerToken)))
   const gateway=db.prepare('SELECT id,mode FROM gateways WHERE token_hash=?').get(hash(credential))
   const ingestion=path==='/api/v1/readings'&&method==='POST'
   const gatewayConfig=path==='/api/v1/gateway/config'&&method==='GET'
   if(ingestion||gatewayConfig?!gateway:!owner)fail('Authentication required',401)
   let body={};if(['POST','PATCH','PUT'].includes(method)){
    if(!(req.headers['content-type']||'').startsWith('application/json'))fail('Content-Type must be application/json',415)
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)fail('Request body exceeds 64 KiB',413);chunks.push(chunk)}
    try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{fail('Invalid JSON')}
   }
   if(gatewayConfig)return send(200,{devices:allDevices(db).filter(d=>d.gateway_id===gateway.id),simulation:gateway.mode==='simulator'?simulation(db):null,settings:gateway.mode==='simulator'?config(db):null})
   if(ingestion)return send(200,service.ingest(body,gateway))
   if(path==='/api/v1/history'&&method==='GET'){const deviceId=url.searchParams.get('device_id');service.getDevice(deviceId);const rows=db.prepare('SELECT id,payload FROM readings WHERE device_id=? ORDER BY measured_at DESC LIMIT 180').all(deviceId).reverse().map(r=>{const value=JSON.parse(r.payload);return {...value,reported_power_w:value.power_w,power_w:realPower(value).value,power_basis:realPower(value).basis,reading_id:r.id}});return send(200,{device_id:deviceId,readings:rows})}
   if(path==='/api/v1/snapshot'&&method==='GET')return send(200,service.snapshot())
   if(path==='/api/v1/gateways'&&method==='POST')return send(201,service.registerGateway(body))
   if(path==='/api/v1/devices'&&method==='POST')return send(201,service.registerDevice(body))
   if(path==='/api/v1/settings'&&method==='PUT')return send(200,service.updateSettings(body))
   if(path==='/api/v1/plans/preview'&&method==='POST')return send(200,service.previewPlan(body))
   if(path==='/api/v1/insights/context'&&method==='GET')return send(200,service.context())
   if(path==='/api/v1/simulation'&&method==='PATCH')return send(200,service.setSimulation(body))
   const match=path.match(/^\/api\/v1\/devices\/([\w-]+)$/)
   if(match&&method==='PATCH')return send(200,service.patchDevice(match[1],body))
   if(match&&method==='DELETE')return send(200,service.retire(match[1]))
   if(path.endsWith('/commands'))fail('Physical device control is not implemented',501)
   fail('Route not found',404)
  }catch(e){const conflict=e.code?.startsWith('ERR_SQLITE')&&/UNIQUE constraint/.test(e.message);const status=e instanceof ApiError?e.status:conflict?409:500;if(status===500)console.error('API error:',e.message);send(status,{error:status===500?'Internal server error':conflict?'Conflicting ID, sequence or timestamp':e.message})}
 })
 server.requestTimeout=15000;server.headersTimeout=10000
 return {server,db,service}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const path=resolve(process.env.APEIRON_DB||'.data/apeiron.sqlite'),ownerToken=process.env.APEIRON_OWNER_TOKEN||localToken(dirname(path),'owner.key')
 const app=createApp({databasePath:path,ownerToken});const port=Number(process.env.APEIRON_PORT||5183)
 app.server.listen(port,'127.0.0.1',()=>console.log(`Apeiron API on http://127.0.0.1:${port}. Local owner credential: ${dirname(path)}/owner.key`))
 const close=()=>app.server.close(()=>{app.db.close();process.exit(0)});process.on('SIGTERM',close);process.on('SIGINT',close)
}
