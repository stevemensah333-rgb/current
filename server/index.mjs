import {createServer} from 'node:http'
import {resolve,dirname} from 'node:path'
import {mkdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {timingSafeEqual} from 'node:crypto'
import {openDatabase,localToken,hash,allDevices,config,simulation} from './database.mjs'
import {realPower} from '../shared/calculations.ts'
import {createService} from './service.mjs'
import {ApiError,fail} from './validation.mjs'
import {createAssistant} from './assistant.mjs'
import {createRegistrations,WAVEFORM_MAX_BYTES} from './registration.mjs'
export function createApp({databasePath,ownerToken,clock,assistantProviders}={}){
 const db=openDatabase(databasePath),service=createService(db,{clock}),registrations=createRegistrations(db,{clock,registerDevice:service.registerDevice}),assistant=createAssistant(service,{clock,...(assistantProviders?{providers:assistantProviders}:{})})
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
   const alertIngestion=path==='/api/v1/alerts'&&method==='POST'
   const healthIngestion=path==='/api/v1/health'&&method==='POST'
   // Every /api/v1/gateway/ route is the gateway's own (config, registration); everything else not listed is the owner's.
   const gatewayRoute=ingestion||alertIngestion||healthIngestion||path.startsWith('/api/v1/gateway/')
   if(gatewayRoute?!gateway:!owner)fail('Authentication required',401)
   const regTurn=path.match(/^\/api\/v1\/gateway\/registrations\/([a-f0-9]+)\/(turns|status|live)$/)
   let body={};if(['POST','PATCH','PUT'].includes(method)){
    if(!(req.headers['content-type']||'').startsWith('application/json'))fail('Content-Type must be application/json',415)
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;const limit=regTurn?.[2]==='turns'?WAVEFORM_MAX_BYTES:65536;if(size>limit)fail(`Request body exceeds ${limit>>10} KiB`,413);chunks.push(chunk)}
    try{const raw=Buffer.concat(chunks).toString();body=raw.trim()?JSON.parse(raw):{}}catch{fail('Invalid JSON')}
   }
   if(gatewayConfig)return send(200,{devices:allDevices(db).filter(d=>d.gateway_id===gateway.id),simulation:gateway.mode==='simulator'?simulation(db):null,settings:gateway.mode==='simulator'?config(db):null})
   if(path==='/api/v1/gateway/registration'&&method==='GET')return send(200,registrations.forGateway(gateway))
   if(regTurn&&method==='POST')return send(200,regTurn[2]==='turns'?registrations.addTurn(regTurn[1],body,gateway):regTurn[2]==='live'?registrations.addLive(regTurn[1],body,gateway):registrations.setStatus(regTurn[1],body,gateway))
   if(gatewayRoute&&!ingestion&&!alertIngestion&&!healthIngestion)fail('Route not found',404)
   if(ingestion)return send(200,service.ingest(body,gateway))
   if(alertIngestion)return send(200,service.ingestAlert(body,gateway))
   if(healthIngestion)return send(200,service.ingestHealth(body,gateway))
   if(path==='/api/v1/history'&&method==='GET'){const deviceId=url.searchParams.get('device_id');service.getDevice(deviceId);const rows=db.prepare('SELECT id,payload FROM readings WHERE device_id=? ORDER BY measured_at DESC LIMIT 180').all(deviceId).reverse().map(r=>{const value=JSON.parse(r.payload);return {...value,reported_power_w:value.power_w,power_w:realPower(value).value,power_basis:realPower(value).basis,reading_id:r.id}});return send(200,{device_id:deviceId,readings:rows})}
   if(path==='/api/v1/snapshot'&&method==='GET')return send(200,service.snapshot())
   if(path==='/api/v1/gateways'&&method==='POST')return send(201,service.registerGateway(body))
   if(path==='/api/v1/devices'&&method==='POST')return send(201,service.registerDevice(body))
   if(path==='/api/v1/settings'&&method==='PUT')return send(200,service.updateSettings(body))
   if(path==='/api/v1/plans/preview'&&method==='POST')return send(200,service.previewPlan(body))
   if(path==='/api/v1/insights/context'&&method==='GET')return send(200,service.context())
   if(path==='/api/v1/simulation'&&method==='PATCH')return send(200,service.setSimulation(body))
   if(path==='/api/v1/assistant'&&method==='POST')return send(202,assistant.start(body))
   if(path==='/api/v1/assistant/confirm'&&method==='POST')return send(200,assistant.confirm(body))
   if(path==='/api/v1/assistant/current'&&method==='GET')return send(200,assistant.current())
   const job=path.match(/^\/api\/v1\/assistant\/([a-f0-9]+)$/)
   if(job&&method==='GET')return send(200,assistant.view(job[1]))
   if(job&&method==='DELETE')return send(200,assistant.cancel(job[1]))
   if(path==='/api/v1/registrations'&&method==='POST')return send(201,registrations.start(body))
   if(path==='/api/v1/registrations/current'&&method==='GET')return send(200,registrations.current())
   const reg=path.match(/^\/api\/v1\/registrations\/([a-f0-9]+)$/)
   if(reg&&method==='GET')return send(200,registrations.get(reg[1]))
   if(reg&&method==='DELETE')return send(200,registrations.cancel(reg[1]))
   const liveReg=path.match(/^\/api\/v1\/registrations\/([a-f0-9]+)\/live$/)
   if(liveReg&&method==='GET')return send(200,registrations.live(liveReg[1]))
   const wave=path.match(/^\/api\/v1\/registrations\/([a-f0-9]+)\/turns\/(\d+)\/waveform$/)
   if(wave&&method==='GET')return send(200,registrations.waveform(wave[1],Number(wave[2])))
   const ack=path.match(/^\/api\/v1\/alerts\/(\d+)\/ack$/)
   if(ack&&method==='POST')return send(200,service.ackAlert(Number(ack[1])))
   const match=path.match(/^\/api\/v1\/devices\/([\w-]+)$/)
   if(match&&method==='PATCH')return send(200,service.patchDevice(match[1],body))
   if(match&&method==='DELETE')return send(200,service.retire(match[1]))
   if(path.endsWith('/commands'))fail('Physical device control is not implemented',501)
   fail('Route not found',404)
  }catch(e){const conflict=e.code?.startsWith('ERR_SQLITE')&&/UNIQUE constraint/.test(e.message);const status=e instanceof ApiError?e.status:conflict?409:500;if(status===500)console.error('API error:',e.message);send(status,{error:status===500?'Internal server error':conflict?'Conflicting ID, sequence or timestamp':e.message})}
 })
 server.requestTimeout=15000;server.headersTimeout=10000
 return {server,db,service,registrations}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const path=resolve(process.env.APEIRON_DB||'.data/apeiron.sqlite');mkdirSync(dirname(path),{recursive:true,mode:0o700})
 const ownerToken=process.env.APEIRON_OWNER_TOKEN||localToken(dirname(path),'owner.key')
 const app=createApp({databasePath:path,ownerToken});const port=Number(process.env.APEIRON_PORT||5183)
 app.server.listen(port,'127.0.0.1',()=>console.log(`Apeiron API on http://127.0.0.1:${port}. Local owner credential: ${dirname(path)}/owner.key`))
 const close=()=>app.server.close(()=>{app.db.close();process.exit(0)});process.on('SIGTERM',close);process.on('SIGINT',close)
}
