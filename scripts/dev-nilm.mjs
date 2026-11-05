// Starts the NILM installation: backend, pipeline gateway and app, on their own database (.data/nilm.sqlite).
// It never seeds simulator devices. Set NILM_SERIAL=COM6 for the live board, or NILM_REPLAY=<file> for a recording.
import {spawn,spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
// Load .env here, so the backend, Vite proxy, simulator and pipeline all see the same values.
if(existsSync('.env'))process.loadEnvFile('.env')

const db=resolve(process.env.APEIRON_DB||'.data/nilm.sqlite'),port=process.env.APEIRON_PORT||'5183'
const env={...process.env,APEIRON_DB:db,APEIRON_API:`http://127.0.0.1:${port}`,NILM_KEY_FILE:join(dirname(db),'nilm-gateway.key')}
const pipeline=resolve('pipeline'),python=join(pipeline,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')
if(!existsSync(python)){console.error('The pipeline environment is missing. Run: cd pipeline && uv sync');process.exit(1)}
const source=process.env.NILM_SERIAL?['--port',process.env.NILM_SERIAL]:process.env.NILM_REPLAY?['--in',resolve(process.env.NILM_REPLAY)]:null
if(!source){console.error('Set NILM_SERIAL=COM6 for the live board, or NILM_REPLAY=<file> for a recorded session.');process.exit(1)}

const children=[];let ending=false
function kill(child){
 // On Windows a plain kill can leave grandchildren running (and holding the COM port): end the whole tree.
 if(process.platform==='win32')spawnSync('taskkill',['/T','/F','/PID',String(child.pid)],{stdio:'ignore'});else child.kill('SIGTERM')
}
function stop(code=0){if(ending)return;ending=true;for(const child of children)kill(child);setTimeout(()=>process.exit(code),250).unref()}
function start(command,args,options={},onExit=code=>stop(code||0)){const child=spawn(command,args,{stdio:'inherit',env,...options});children.push(child);child.on('exit',code=>{if(!ending)onExit(code)});return child}
// A replay ends when its file ends; keep the backend and app open so the result can be looked at.
const gatewayExit=code=>{if(process.env.NILM_REPLAY&&code===0)console.log('Replay finished. The app keeps running; press Ctrl+C to stop.');else stop(code||0)}

// If something already answers on this port (for example `npm run dev`), connect would register into the wrong database.
try{if((await fetch(`${env.APEIRON_API}/api/health`)).ok){console.error(`Port ${port} is already in use (is npm run dev running?). Stop it first.`);process.exit(1)}}catch{}
start(process.execPath,['server/index.mjs'])
let up=false
for(let i=0;i<50&&!up;i++){try{up=(await fetch(`${env.APEIRON_API}/api/health`)).ok}catch{}if(!up)await new Promise(r=>setTimeout(r,100))}
if(!up){console.error('The backend did not start.');stop(1)}
else{
 const connected=spawnSync(python,['-m','shp.app','connect'],{cwd:pipeline,env,stdio:'inherit'})
 if(connected.status!==0){console.error('connect failed; see above.');stop(1)}
 else{
  start(python,['-m','shp.app','gateway',...source],{cwd:pipeline},gatewayExit)
  start(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',process.env.APEIRON_UI_PORT||'5182','--strictPort'])
 }
}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop())
