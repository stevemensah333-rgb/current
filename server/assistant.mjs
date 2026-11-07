// The household assistant. One question at a time runs as a job, because the local model can take minutes.
// Two providers behind one loop: "local" (LFM3-1.7B in LM Studio) and "cloud".
// Cloud is DeepSeek for now (NILM_CLOUD=deepseek, the default); NILM_CLOUD=claude switches back to Claude Opus 5.5.
// The model sees only a state line built here from device ids and numbers, never free text from a gateway.
import {randomBytes} from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import {isApparent} from '../shared/calculations.ts'
import {ApiError,fail,object,keys,text} from './validation.mjs'
import {planText} from './rationing.mjs'

// The caller's cancel signal plus a time limit: whichever comes first stops the request.
const withLimit=(signal,ms)=>signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms)
export const LOCAL_URL=process.env.NILM_LM_URL||'http://localhost:8000'
export const LOCAL_MODEL=process.env.NILM_LM_MODEL||'lfm3-1.7b'
export const CLAUDE_MODEL='claude-opus-5-5'
export const DEEPSEEK_URL=process.env.DEEPSEEK_URL||'https://api.deepseek.com'
export const DEEPSEEK_MODEL=process.env.DEEPSEEK_MODEL||'deepseek-chat'
export const CLOUD_PROVIDER=process.env.NILM_CLOUD==='claude'?'claude':'deepseek'
export const CLOUD_MODEL=CLOUD_PROVIDER==='claude'?CLAUDE_MODEL:DEEPSEEK_MODEL
/** Whether the cloud key for the chosen cloud provider is set (the key itself never leaves the server). */
export const cloudReady=()=>Boolean(CLOUD_PROVIDER==='claude'?process.env.ANTHROPIC_API_KEY:process.env.DEEPSEEK_API_KEY)
const MAX_ROUNDS={local:3,cloud:5}
const LOCAL_MAX_TOKENS=2048        // the LFM3 model card's max_new_tokens; also bounds its reasoning
const LOCAL_CALL_MS=5*60000        // one local model call may take at most 5 minutes
const DEEPSEEK_MAX_TOKENS=2048
const DEEPSEEK_CALL_MS=2*60000
const CONFIRM_MS=5*60000
const PERIOD_HOURS={hour:1,'24h':24,week:168}

const SYSTEM=`You help a household understand its electricity use. Answer in one to three short, plain sentences.
Use get_usage for any question about how long or how much. Use switch_off only when the user asks to switch something off; the user must then confirm.
Use plan_rationing when the user wants prepaid credit or units to last a number of days. Explain its plan as short steps; never work out your own numbers.`
const VA_NOTE=`Power values are watts estimated from current at 230 V, so they are approximate. Say watts or kilowatts. p is the pipeline's confidence from 0 to 1.`
export const systemPrompt=snapshot=>isApparent(snapshot.demand_basis)?`${SYSTEM}\n${VA_NOTE}`:SYSTEM

const fmt=value=>value==null?'unavailable':`${Math.round(value)} W`

/** The model's whole view of the house: ids, numbers and fixed words only. */
export function stateLine(snapshot){
 const appliances=snapshot.devices.filter(d=>d.role==='appliance')
 const on=appliances.filter(d=>d.power_w>0).map(d=>{const p=d.latest?.inference?.confidence;return `${d.id} ${fmt(d.power_w,d.power_basis)}${p!=null?` p ${p.toFixed(2)}`:''}`})
 const parts=[`On now: ${on.length?on.join('; '):'nothing'}.`,`House total ${fmt(snapshot.demand_w,snapshot.demand_basis)}.`]
 if(snapshot.unnamed_va!=null)parts.push(`Not yet named ${Math.round(snapshot.unnamed_va)} W.`)
 if(snapshot.alerts?.length)parts.push(`Open alerts: ${snapshot.alerts.map(a=>[a.device_id||'house',a.kind,a.value,a.amount!=null?Math.round(a.amount):null].filter(x=>x!=null).join(' ')).join('; ')}.`)
 parts.push(`Devices: ${appliances.map(d=>d.id).join(', ')||'none'}.`)
 return parts.join(' ')
}

function toolSpecs(snapshot){
 const ids=snapshot.devices.filter(d=>d.role==='appliance').map(d=>d.id),onIds=snapshot.devices.filter(d=>d.role==='appliance'&&d.power_w>0).map(d=>d.id)
 const specs=[]
 if(ids.length)specs.push({name:'get_usage',description:'Hours on and energy of one device over a period. today = since local midnight.',
  schema:{type:'object',properties:{device:{type:'string',enum:ids},period:{type:'string',enum:['hour','today','24h','week']}},required:['device','period'],additionalProperties:false}})
 specs.push({name:'plan_rationing',description:'Plan how to make prepaid credit last: which devices to limit or switch off. amount is the credit in GHS (unit ghs) or kWh units (unit kwh).',
  schema:{type:'object',properties:{amount:{type:'number'},unit:{type:'string',enum:['ghs','kwh']},days:{type:'number'},keep_on:{type:'array',items:ids.length?{type:'string',enum:ids}:{type:'string'}}},required:['amount','unit','days','keep_on'],additionalProperties:false}})
 if(onIds.length)specs.push({name:'switch_off',description:'Ask to switch off a device that is on now. The user must confirm with a button.',
  schema:{type:'object',properties:{device:{type:'string',enum:onIds}},required:['device'],additionalProperties:false}})
 return specs
}

// LFM3 writes tool calls as XML; LM Studio usually converts them, this reads them if a server does not.
const TOOL_CALL=/<tool_call>\s*<function=([^>]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g
const PARAMETER=/<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g
export function parseXmlToolCalls(textValue){
 return [...textValue.matchAll(TOOL_CALL)].map((m,i)=>({id:`call_${i}`,name:m[1].trim(),input:Object.fromEntries([...m[2].matchAll(PARAMETER)].map(p=>[p[1].trim(),p[2]]))}))
}

const LOCAL_ERRORS={
 timeout:()=>'The local model took longer than 5 minutes. Try a shorter question, or use Cloud.',
 unreachable:()=>'The local model is not reachable. Start LM Studio: lms server start, then lms load lfm3-1.7b.',
 status:code=>`The local model answered with an error (${code}).`,
 unreadable:()=>'The local model sent an answer that could not be read.'}
const DEEPSEEK_ERRORS={
 timeout:()=>'DeepSeek took longer than 2 minutes. Try again.',
 unreachable:()=>'DeepSeek is not reachable. Check the internet connection.',
 status:code=>code===401?'The cloud key was refused. Check DEEPSEEK_API_KEY in .env.':code===402?'The DeepSeek account has no balance left.':code===429?'DeepSeek is busy (rate limited). Try again in a minute.':`DeepSeek answered with an error (${code}).`,
 unreadable:()=>'DeepSeek sent an answer that could not be read.'}

/** Local provider: an OpenAI-style chat endpoint (LM Studio). */
export function localChat({url=LOCAL_URL,model=LOCAL_MODEL,fetchImpl=fetch}={}){
 return openAiChat({url:`${url}/v1/chat/completions`,model,fetchImpl,maxTokens:LOCAL_MAX_TOKENS,callMs:LOCAL_CALL_MS,errors:LOCAL_ERRORS})
}

/** Cloud provider (default): DeepSeek's OpenAI-compatible chat API. */
export function deepseekChat({url=DEEPSEEK_URL,model=DEEPSEEK_MODEL,apiKey,fetchImpl=fetch}={}){
 const run=openAiChat({url:`${url}/chat/completions`,model,fetchImpl,maxTokens:DEEPSEEK_MAX_TOKENS,callMs:DEEPSEEK_CALL_MS,errors:DEEPSEEK_ERRORS,
  key:()=>apiKey||process.env.DEEPSEEK_API_KEY})
 return async args=>{
  if(!apiKey&&!process.env.DEEPSEEK_API_KEY)throw new ApiError(503,'Cloud is not set up: add DEEPSEEK_API_KEY to .env and restart.')
  return run(args)
 }
}

/** One loop for any OpenAI-style chat endpoint (LM Studio, DeepSeek). */
function openAiChat({url,model,fetchImpl,maxTokens,callMs,errors,key=()=>null}){
 return async function run({system,user,specs,execute,signal,maxRounds}){
  const messages=[{role:'system',content:system},{role:'user',content:user}]
  const tools=specs.map(s=>({type:'function',function:{name:s.name,description:s.description,parameters:s.schema}}))
  // maxRounds rounds of tool use, then one last call that must answer from the results.
  // Example: maxRounds 3 → calls 0, 1 and 2 may use tools; call 3 has tool_choice "none" and must answer.
  // The tools stay listed on that last call, because the history already holds tool messages.
  for(let round=0;round<=maxRounds;round++){
   const offerTools=round<maxRounds&&tools.length>0
   let response
   const headers={'Content-Type':'application/json'},k=key();if(k)headers.Authorization=`Bearer ${k}`
   try{response=await fetchImpl(url,{method:'POST',headers,signal:withLimit(signal,callMs),body:JSON.stringify({model,messages,temperature:.1,max_tokens:maxTokens,
    ...(tools.length?{tools,tool_choice:offerTools?'auto':'none'}:{})})})}
   catch(e){
    if(signal?.aborted)throw e
    if(e?.name==='TimeoutError')throw new ApiError(504,errors.timeout())
    throw new ApiError(503,errors.unreachable())
   }
   if(!response.ok)throw new ApiError(502,errors.status(response.status))
   const msg=(await response.json().catch(()=>null))?.choices?.[0]?.message
   if(!msg)throw new ApiError(502,errors.unreadable())
   const parse=args=>{try{return JSON.parse(args||'{}')}catch{return null}}   // null = malformed; reported back to the model
   let content=msg.content||'',calls=(msg.tool_calls||[]).map(c=>({id:c.id,name:c.function?.name,input:parse(c.function?.arguments)}))
   if(!calls.length&&content.includes('<tool_call>')){calls=parseXmlToolCalls(content);content=content.replace(TOOL_CALL,'').trim()}
   // On the last call any tool call is dropped on purpose (the round limit is reached); only its text is kept.
   if(!calls.length||!offerTools)return content||`Stopped after ${maxRounds} tool rounds.`
   messages.push({role:'assistant',content,tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.input??{})}}))})
   for(const c of calls)messages.push({role:'tool',tool_call_id:c.id,content:c.input?await execute(c.name,c.input):'Invalid arguments.'})
  }
 }
}

/** Alternative cloud provider (NILM_CLOUD=claude): Claude through the official SDK, with Anthropic's automatic fallback for declined requests. */
export function cloudChat({client}={}){
 return async function run({system,user,specs,execute,signal,maxRounds}){
  if(!client&&!process.env.ANTHROPIC_API_KEY)throw new ApiError(503,'Cloud is not set up: add ANTHROPIC_API_KEY to .env and restart.')
  const claude=client||new Anthropic()
  const tools=specs.map(s=>({name:s.name,description:s.description,input_schema:s.schema,strict:true}))
  const messages=[{role:'user',content:user}]
  // maxRounds rounds of tool use, then one last call that must answer from the results.
  // Example: maxRounds 5 → calls 0–4 may use tools; call 5 has tool_choice "none" and must answer.
  // The tools stay listed on that last call: the API refuses tool_use/tool_result history without them.
  for(let round=0;round<=maxRounds;round++){
   const offerTools=round<maxRounds&&tools.length>0
   let response
   try{
    response=await claude.beta.messages.create({model:CLAUDE_MODEL,max_tokens:16000,system,messages,
     ...(tools.length?{tools,tool_choice:{type:offerTools?'auto':'none'}}:{}),
     output_config:{effort:'low'},betas:['server-side-fallback-2026-07-01'],fallbacks:'default'},{signal})
   }catch(e){
    if(signal?.aborted)throw e
    if(e instanceof Anthropic.AuthenticationError)throw new ApiError(502,'The cloud key was refused. Check ANTHROPIC_API_KEY in .env.')
    if(e instanceof Anthropic.RateLimitError)throw new ApiError(503,'Claude is busy (rate limited). Try again in a minute.')
    if(e instanceof Anthropic.APIConnectionError)throw new ApiError(503,'Claude is not reachable. Check the internet connection.')
    if(e instanceof Anthropic.APIError)throw new ApiError(502,`Claude answered with an error (${e.status}).`)
    throw e
   }
   if(response.stop_reason==='refusal')return 'Claude declined to answer this.'
   messages.push({role:'assistant',content:response.content})
   const calls=response.content.filter(b=>b.type==='tool_use')
   const answer=response.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim()
   if(response.stop_reason!=='tool_use'||!calls.length||!offerTools)return answer||`Stopped after ${maxRounds} tool rounds.`
   const results=[]
   for(const c of calls)results.push({type:'tool_result',tool_use_id:c.id,content:await execute(c.name,c.input)})
   messages.push({role:'user',content:results})
  }
  return `Stopped after ${maxRounds} tool rounds.`
 }
}

export function createAssistant(service,{clock=()=>Date.now(),rationing=null,providers={local:localChat(),cloud:CLOUD_PROVIDER==='claude'?cloudChat():deepseekChat()}}={}){
 const jobs=new Map(),confirms=new Map();let running=null

 function periodStart(period){
  const now=clock()
  if(period==='today'){const d=new Date(now);d.setHours(0,0,0,0);return d.getTime()}
  return now-PERIOD_HOURS[period]*3600000
 }
 function usageText(device,period){
  const u=service.usage(device,periodStart(period),clock())
  const unit=isApparent(u.energy_basis)?'Wh (estimated)':'Wh'
  const energy=u.energy_wh==null?'energy unknown':`${Math.round(u.energy_wh)} ${unit}`
  const span=period==='today'?'today':`the last ${period==='24h'?'24 hours':period}`
  const coverage=u.covered_hours+0.01<u.period_hours?` (only ${u.covered_hours.toFixed(1)} h of ${span} recorded)`:''
  return `${device}: ${u.hours_on.toFixed(2)} h on, ${energy} in ${span}${coverage}.`
 }
 function makeExecute(job){
  return async(name,input)=>{
   const snapshot=service.snapshot(),ids=snapshot.devices.filter(d=>d.role==='appliance').map(d=>d.id)
   if(name==='get_usage'){
    if(!ids.includes(input?.device)||!['hour','today','24h','week'].includes(input?.period))return 'Unknown device or period.'
    return usageText(input.device,input.period)
   }
   if(name==='plan_rationing'){
    if(!rationing)return 'Credit planning is not available.'
    try{return planText(rationing.preview(input))}catch(e){if(e instanceof ApiError)return e.message;throw e}
   }
   if(name==='switch_off'){
    const d=snapshot.devices.find(x=>x.id===input?.device&&x.role==='appliance')
    if(!d||!(d.power_w>0))return `${input?.device} is not on.`
    const token=randomBytes(16).toString('hex')
    confirms.set(token,{device:d.id,job:job.id,expires:clock()+CONFIRM_MS})
    job.confirm={token,device:d.id}
    return `Needs the user's confirmation. A "Switch off ${d.id}" button is now shown.`
   }
   return `Unknown tool ${name}.`
  }
 }

 function start(raw){
  const v=object(raw);keys(v,['message']);const message=text(v.message,'message',500)
  if(running)fail('The assistant is already answering a question',409)
  const provider=service.snapshot().settings.assistant.provider
  const job={id:randomBytes(8).toString('hex'),status:'running',provider,model:provider==='cloud'?CLOUD_MODEL:LOCAL_MODEL,question:message,reply:null,error:null,confirm:null,controller:new AbortController()}
  jobs.set(job.id,job);running=job
  if(jobs.size>20)jobs.delete(jobs.keys().next().value)
  const snapshot=service.snapshot()
  providers[provider]({system:systemPrompt(snapshot),user:`House now: ${stateLine(snapshot)}${rationing?.stateText()?` ${rationing.stateText()}`:''}\n\nQuestion: ${message}`,specs:toolSpecs(snapshot),
   execute:makeExecute(job),signal:job.controller.signal,maxRounds:MAX_ROUNDS[provider]})
   .then(reply=>{if(job.status==='running'){job.status='done';job.reply=reply||'(no answer)'}})
   .catch(e=>{if(job.status==='running'){job.status='failed';job.error=e instanceof ApiError?e.message:'The assistant failed. Try again.';if(!(e instanceof ApiError))console.error('Assistant error:',e.message)}})
   .finally(()=>{if(running===job)running=null})
  return {job_id:job.id,provider,model:job.model}
 }
 function view(jobId){const j=jobs.get(jobId);if(!j)fail('Job not found. The assistant may have restarted; ask again.',404);return {job_id:j.id,status:j.status,provider:j.provider,model:j.model,reply:j.reply,error:j.error,confirm:j.confirm&&{token:j.confirm.token,device:j.confirm.device}}}
 function dropTokens(test){for(const [token,c] of confirms)if(test(c))confirms.delete(token)}
 function cancel(jobId){
  const j=jobs.get(jobId);if(!j)fail('Job not found',404)
  if(j.status==='running'){j.status='cancelled';j.controller.abort();if(running===j)running=null}
  dropTokens(c=>c.job===j.id);j.confirm=null
  return view(jobId)
 }
 /** The job still running, if any: lets a reopened panel pick it up again. */
 function current(){return {job:running?view(running.id):null}}
 function confirm(raw){
  dropTokens(c=>clock()>c.expires+CONFIRM_MS)              // forget long-expired tokens
  const v=object(raw);keys(v,['token']);const c=confirms.get(text(v.token,'token',64))
  if(!c)fail('This confirmation is not valid any more',404)
  confirms.delete(v.token)
  if(clock()>c.expires)fail('This confirmation expired. Ask again.',410)
  if(jobs.get(c.job)?.status==='cancelled')fail('That question was cancelled. Ask again.',410)
  const d=service.snapshot().devices.find(x=>x.id===c.device)
  if(!d||!(d.power_w>0))return {done:false,message:`${c.device} is already off.`}
  if(!d.simulator_control)return {done:false,message:`No switch fitted for ${c.device} yet. The clamp only listens.`}
  service.setSimulation({states:{[d.id]:false}})
  return {done:true,message:`Switched off ${c.device} (simulator).`}
 }
 return {start,view,cancel,confirm,current}
}
