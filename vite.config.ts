import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {resolve,dirname} from 'node:path'
import {readFileSync} from 'node:fs'
export default defineConfig({plugins:[react()],base:'./',cacheDir:'.cache/vite',server:{host:'127.0.0.1',strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${process.env.APEIRON_PORT||5183}`,configure(proxy){
 // Development convenience only: the loopback Vite server injects a local owner
 // token. It is NEVER bundled into browser code. Use an authenticated reverse
 // proxy/session layer before any remote/public deployment.
 proxy.on('proxyReq',(request,incoming)=>{if(!incoming.headers.authorization){try{request.setHeader('Authorization',`Bearer ${process.env.APEIRON_OWNER_TOKEN||readFileSync(resolve(dirname(resolve(process.env.APEIRON_DB||'.data/apeiron.sqlite')),'owner.key'),'utf8').trim()}`)}catch{}}})
}}}}})
