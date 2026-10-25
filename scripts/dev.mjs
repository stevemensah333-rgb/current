import {spawn} from 'node:child_process'
import {bootstrap} from './bootstrap.mjs'
bootstrap()
const children=[];let ending=false
function stop(code=0){if(ending)return;ending=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),250).unref()}
function start(args){const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});children.push(child);child.on('exit',code=>{if(!ending)stop(code||0)});return child}
start(['server/index.mjs'])
for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${process.env.APEIRON_PORT||5183}/api/health`);if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
start(['scripts/simulator.mjs']);start(['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',process.env.APEIRON_UI_PORT||'5182','--strictPort'])
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop())
