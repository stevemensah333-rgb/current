import {Canvas,useFrame,useThree} from '@react-three/fiber'
import {ContactShadows,Edges,Html,Line,OrbitControls} from '@react-three/drei'
import {createContext,useContext,useEffect,useMemo,useRef} from 'react'
import * as THREE from 'three'
import {getFlow,useEnergy} from './store'
import {powerUnit} from './telemetry'
import {SOURCE_COLORS,type Device,type Room} from './energy'
import {CELL_D,FLOOR_H,pack,useHome,type Layout,type Placed} from './home/layout'
import type {Theme} from './theme'
import type {OrbitControls as OrbitControlsImpl} from 'three-stdlib'

const ThemeContext=createContext<Theme>('dark')
function Block({position=[0,0,0],size,color,rotation=[0,0,0],edges=false}:{position?:[number,number,number];size:[number,number,number];color?:string;rotation?:[number,number,number];edges?:boolean}) {
 const theme=useContext(ThemeContext)
 return <mesh position={position} rotation={rotation} castShadow receiveShadow><boxGeometry args={size}/><meshStandardMaterial color={color|| (theme==='dark'?'#55585a':'#d6d7d3')} roughness={.68} metalness={.12}/>{edges&&<Edges color={theme==='dark'?'#66696b':'#b6b9b7'} threshold={25}/>}</mesh>
}
function Appliance({d}:{d:Device}) {
 const light=useContext(ThemeContext)==='light',color=light?'#d5d7d5':'#65696b',dark=light?'#969d9b':'#353b3d',metal=light?'#81898a':'#b8bcbf'
 switch(d.kind){
 case 'fridge':return <group><Block size={[.62,1.25,.62]} position={[0,.625,0]} color={color}/><Block size={[.63,.022,.02]} position={[0,.82,.32]} color={dark}/><Block size={[.027,.28,.05]} position={[.22,.48,.35]} color={metal}/><Block size={[.027,.16,.05]} position={[.22,1.04,.35]} color={metal}/></group>
 case 'ac':return <group rotation={[0,Math.PI/2,0]}><Block size={[1.1,.38,.28]} position={[0,.95,0]} color={color}/>{[0,1,2].map(n=><Block key={n} size={[.87,.014,.02]} position={[0,.9+n*.045,.15]} color={dark}/>)}</group>
 case 'tv':return <group><Block size={[1.05,.62,.07]} position={[0,.77,0]} color="#24282a"/><Block size={[.96,.53,.018]} position={[0,.77,.045]} color={d.on?'#354a54':'#111517'}/><Block size={[.055,.22,.08]} position={[0,.4,0]} color={dark}/><Block size={[1.28,.35,.48]} position={[0,.19,0]} color={light?'#a59b8e':'#625c53'}/></group>
 case 'laptop':return <group><Block size={[.7,.045,.43]} position={[0,.78,0]} color={metal}/><Block size={[.62,.4,.03]} position={[0,.98,-.18]} rotation={[-.18,0,0]} color={dark}/><Block size={[1.2,.09,.7]} position={[0,.73,0]} color={light?'#9a8c78':'#746754'}/>{[-.48,.48].map(x=><Block key={x} size={[.04,.68,.5]} position={[x,.36,0]} color={metal}/>)}</group>
 case 'kettle':return <group><mesh position={[0,.23,0]} castShadow><cylinderGeometry args={[.14,.19,.42,24]}/><meshStandardMaterial color={metal} metalness={.55} roughness={.3}/></mesh><Block size={[.1,.25,.05]} position={[.2,.23,0]} color={dark}/><mesh position={[0,.46,0]}><sphereGeometry args={[.05,12,12]}/><meshStandardMaterial color={dark}/></mesh></group>
 case 'fan':return <group><Block size={[.34,.06,.34]} position={[0,.03,0]} color={dark}/><Block size={[.03,.8,.03]} position={[0,.45,0]} color={metal}/><mesh position={[0,.97,0]} rotation={[Math.PI/2,0,0]}><torusGeometry args={[.25,.02,8,36]}/><meshStandardMaterial color={metal}/></mesh>{[0,1,2].map(i=><group key={i} position={[0,.97,0]} rotation={[0,0,i*Math.PI*2/3]}><Block size={[.29,.085,.024]} position={[.12,0,0]} color={dark}/></group>)}</group>
 case 'lights':return <group><Block size={[.28,.04,.28]} position={[0,.02,0]} color={dark}/><Block size={[.024,.95,.024]} position={[0,.49,0]} color={metal}/><mesh position={[0,1.03,0]} castShadow><cylinderGeometry args={[.18,.29,.3,24,1,true]}/><meshStandardMaterial color={d.on?'#e5d9b8':color} side={THREE.DoubleSide}/></mesh>{d.on&&<pointLight position={[0,1,0]} color="#ffddb0" intensity={.6} distance={2}/>}</group>
 default:return <group><Block size={[.36,.12,.27]} position={[0,.08,0]} color={color}/><Block size={[.015,.26,.015]} position={[-.12,.23,-.06]} color={metal}/><Block size={[.015,.26,.015]} position={[.12,.23,-.06]} color={metal}/></group>
 }
}
function FlowDot({points,active,color='#00d28a'}:{points:[number,number,number][];active:boolean;color?:string}) {
 const ref=useRef<THREE.Mesh>(null)
 const curve=useMemo(()=>new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),[points])
 useFrame(({clock})=>{if(ref.current)ref.current.position.copy(curve.getPoint((clock.elapsedTime*.14)%1))})
 return <mesh ref={ref} visible={active}><sphereGeometry args={[.035,8,8]}/><meshBasicMaterial color={color}/></mesh>
}
function Gable({z,color}:{z:number;color:string}){
 const shape=useMemo(()=>{const s=new THREE.Shape();s.moveTo(-3.2,2.18);s.lineTo(0,3.27);s.lineTo(3.2,2.18);s.closePath();return s},[])
 return <mesh position={[0,0,z]} castShadow receiveShadow><extrudeGeometry args={[shape,{depth:.14,bevelEnabled:false}]}/><meshStandardMaterial color={color} roughness={.7}/></mesh>
}
/** Simple furniture for each kind of room, placed against the room's back wall. */
function RoomFurniture({r}:{r:Placed}){
 const light=useContext(ThemeContext)==='light',fabric=light?'#b0b8b2':'#596561',wood=light?'#a39177':'#776955',pale=light?'#e1ddd5':'#b1b1a9',metal='#707575'
 const hw=r.w/2,back=-r.d/2,span=Math.min(r.w-.3,1.45)
 let body
 switch(r.kind){
 case 'living':body=<><Block size={[span,.38,.66]} position={[0,.43,back+.5]} color={fabric}/><Block size={[span,.48,.13]} position={[0,.8,back+.24]} color={fabric}/><Block size={[.8,.07,.5]} position={[0,.51,back+1.35]} color={wood}/></>;break
 case 'kitchen':body=<><Block size={[r.w-.3,.59,.57]} position={[0,.49,back+.4]} color={light?'#d1d4cc':'#657064'}/><Block size={[r.w-.18,.08,.67]} position={[0,.825,back+.4]} color={light?'#e0dfd7':'#9c9a8b'}/></>;break
 case 'bedroom':body=<><Block size={[1.18,.27,1.55]} position={[0,.36,back+.95]} color={wood}/><Block size={[1.12,.16,1.46]} position={[0,.56,back+.95]} color={pale}/><Block size={[1.12,.05,1.05]} position={[0,.66,back+1.2]} color={fabric}/><Block size={[.65,.11,.34]} position={[0,.69,back+.4]} color={light?'#f2efe8':'#d1cbbf'}/><Block size={[1.25,.7,.09]} position={[0,.59,back+.12]} color={wood}/></>;break
 case 'office':body=<><Block size={[1.2,.09,.6]} position={[0,.73,back+.45]} color={wood}/>{[-.52,.52].map(x=><Block key={x} size={[.04,.68,.5]} position={[x,.36,back+.45]} color={metal}/>)}<Block size={[.45,.1,.45]} position={[0,.48,back+1.15]} color={fabric}/><Block size={[.45,.5,.08]} position={[0,.75,back+1.4]} color={fabric}/></>;break
 case 'bathroom':body=<><Block size={[.7,.45,1.3]} position={[-hw+.5,.33,back+.8]} color={pale}/><Block size={[.45,.4,.35]} position={[hw-.4,.3,back+.3]} color={pale}/></>;break
 case 'store':body=<>{[back+.25,back+.7].map(z=><Block key={z} size={[r.w-.3,1.1,.3]} position={[0,.65,z]} color={wood}/>)}</>;break
 case 'porch':body=<><Block size={[1,.3,.4]} position={[0,.3,back+.35]} color={wood}/><mesh position={[hw-.35,.35,back+.35]} castShadow><cylinderGeometry args={[.16,.12,.4,16]}/><meshStandardMaterial color={metal}/></mesh></>;break
 }
 return <group position={[r.cx,0,r.cz]}>{body}</group>
}
type Spot=[number,number,number]
/** Where each appliance stands: in its room by name, or in the first room when its room is not in the house. */
function placeDevices(devices:Device[],rooms:Placed[]){
 const out:Record<string,Spot>={},count:Record<string,number>={},first=rooms[0]
 for(const d of devices){
  const r=rooms.find(x=>x.name===d.room)||first,i=(count[r.id]=(count[r.id]??-1)+1)
  if(d.kind==='kettle'&&r.kind==='kitchen'){out[d.id]=[r.cx+r.w/2-.45,r.y+.86,r.z+.4];continue}
  const step=Math.min(.75,r.w/3)
  out[d.id]=[r.cx+((i%3)-1)*step,r.y+.22,r.cz+.35+Math.floor(i/3)%2*.5]
 }
 return out
}
/** A few steps in the back-left corner show where the stairs come up. */
function Stairs({x,z,color}:{x:number;z:number;color:string}){
 return <group>{[0,1,2,3].map(i=><Block key={i} size={[.5,(4-i)*.1,.28]} position={[x+.3,.11+(4-i)*.05,z+.25+i*.28]} color={color}/>)}<Block size={[.05,.5,1.15]} position={[x+.58,.4,z+.65]} color={color}/></group>
}
function House({layout,floor,roof,heatmap,interactive,onSelect,onRoom,focusRoom,focusDevice,editRoom,onEditRoom}:{layout:Layout;floor:number;roof:boolean;heatmap:boolean;interactive:boolean;onSelect:(id:string)=>void;onRoom:(room:Room)=>void;focusRoom:Room|null;focusDevice:string|null;editRoom?:string|null;onEditRoom?:(id:string)=>void}) {
 const theme=useContext(ThemeContext),light=theme==='light',s=useEnergy(),builder=!!onEditRoom,flow=getFlow(s)
 const allDevices=useMemo(()=>builder?[]:s.devices,[builder,s.devices])
 const data=s.connection==='connected'?s.telemetry:null
 const wall=light?'#d5d5ce':'#686c69',trim=light?'#e3e4df':'#979b97',floorColor=light?'#b7a793':'#89806f',chosen=light?'#acbaa9':'#728578',solid=light?'#c9cac4':'#5b5f5c'
 const {placed,depth,rowsOn}=useMemo(()=>pack(layout),[layout])
 const positions=useMemo(()=>placeDevices(allDevices,placed),[allDevices,placed])
 const shown=roof?layout.floors:Math.min(Math.max(1,floor),layout.floors)
 const front=depth/2,back=-depth/2,low=roof?2:.9,top=(layout.floors-1)*FLOOR_H
 const roomFloor=(name:string)=>(placed.find(r=>r.name===name)||placed[0])?.floor??1
 const devices=allDevices.filter(d=>roof||roomFloor(d.room)===shown)
 const focusName=focusRoom||allDevices.find(d=>d.id===focusDevice)?.room
 const levels=Array.from({length:shown},(_,i)=>i+1)
 return <group>
 <Block size={[6.7,.23,depth+.4]} position={[0,-.04,0]} color={light?'#a6aaa5':'#494d4b'}/>
 {levels.map(f=>{const y=(f-1)*FLOOR_H,open=roof||f===shown,rooms=placed.filter(r=>r.floor===f)
  // A floor below the one being shown is drawn as a solid level, so the shown floor reads clearly.
  if(!open)return <group key={f}><Block size={[6.42,FLOOR_H-.05,depth+.1]} position={[0,y+FLOOR_H/2+.08,0]} color={solid} edges/></group>
  return <group key={f} position={[0,y,0]}>
  {f>1&&<Block size={[6.42,.1,depth+.1]} position={[0,.05,0]} color={light?'#a6aaa5':'#494d4b'}/>}
  {rooms.map(r=>{const load=devices.filter(d=>d.room===r.name&&d.online).reduce((sum,d)=>sum+d.reading,0),on=builder?editRoom===r.id:focusName===r.name
   return <group key={r.id}>
   <group onClick={e=>{if(!builder||roof)return;e.stopPropagation();onEditRoom!(r.id)}}><Block size={[r.w-.16,.055,r.d-.1]} position={[r.cx,.11,r.cz]} color={on?chosen:heatmap?load>700?light?'#beab68':'#a39753':load>100?light?'#a1b2a3':'#6d8777':floorColor:floorColor}/></group>
   {!roof&&<RoomFurniture r={{...r,y:0}}/>}
   {r.x+r.w<3.19&&<Block size={[.12,low,r.d-.15]} position={[r.x+r.w,roof?1.16:low/2+.16,r.cz]} color={wall}/>}
   {(interactive||builder)&&!roof&&<Html position={[r.cx,.18,r.cz+r.d/2-.35]} center zIndexRange={[8,0]}><button className={`room-label ${on?'active':''}`} onClick={()=>builder?onEditRoom!(r.id):onRoom(r.name)} aria-label={builder?`Edit ${r.name}`:`Explore ${r.name}`} aria-pressed={builder?on:undefined}>{r.name}</button></Html>}
   </group>})}
  {f>1&&!roof&&<Stairs x={-3.2} z={back} color={trim}/>}
  {Array.from({length:Math.max(0,rowsOn[f]-1)},(_,i)=><Block key={i} size={[6.25,low,.12]} position={[0,roof?1.16:low/2+.16,back+(i+1)*CELL_D]} color={wall}/>)}
  {/* An architectural cutaway: the front and right walls are low in the inside view. */}
  <Block size={[6.42,2.02,.16]} position={[0,1.16,back]} color={wall}/><Block size={[.16,2.02,depth+.1]} position={[-3.2,1.16,0]} color={wall}/>
  <Block size={[6.42,roof?2.02:.12,.16]} position={[0,roof?1.16:.21,front]} color={wall}/><Block size={[.16,roof?2.02:.12,depth+.1]} position={[3.2,roof?1.16:.21,0]} color={wall}/>
  <Block size={[6.45,.075,.18]} position={[0,2.22,back]} color={trim}/><Block size={[.18,.075,depth+.1]} position={[-3.2,2.22,0]} color={trim}/>
  {roof&&<>{f===1&&<><Block size={[.73,1.67,.04]} position={[-1.96,1.0,front+.1]} color="#3b4343"/><Block size={[.043,.17,.04]} position={[-1.7,.94,front+.14]} color="#bfc2b8"/></>}
   {(f===1?[.6,1.65]:[-1.65,.6,1.65]).map(x=><group key={x}><Block size={[.83,1.02,.035]} position={[x,1.38,front+.097]} color="#cfbf8d"/><Block size={[.035,1.1,.045]} position={[x,1.38,front+.122]} color="#434b4b"/><Block size={[.9,.035,.045]} position={[x,1.38,front+.12]} color="#434b4b"/></group>)}</>}
  </group>})}
 {roof&&<group position={[0,top,0]}><Gable z={front-.06} color={wall}/><Gable z={back-.08} color={wall}/><Block size={[3.56,.12,depth+.34]} position={[-1.65,2.71,0]} rotation={[0,0,.32]} color="#3d4244"/><Block size={[3.56,.12,depth+.34]} position={[1.65,2.71,0]} rotation={[0,0,-.32]} color="#3d4244"/></group>}
 {!builder&&<>
 <Block size={[.25,.49,.19]} position={[0,.47,front+.18]} color={light?'#c1c7c4':'#646d6b'}/>
 {devices.map(d=>{const p=positions[d.id],active=d.on&&d.online,isSelected=focusDevice===d.id,y=(placed.find(r=>r.name===d.room)||placed[0]).y+.16
  // Upper floors are fed by a riser at the front of the house.
  const wire:Spot[]=y>.2?[[0,.16,front+.2],[0,y,front+.2],[0,y,p[2]],[p[0],y,p[2]]]:[[0,.16,front+.2],[0,.16,p[2]],[p[0],.16,p[2]]]
  return <group key={d.id}>
 {!roof&&<><Line points={wire} color={!d.online?'#e38c47':active?'#00bd82':'#70746e'} lineWidth={isSelected?1.3:.7} transparent opacity={active?.6:.18}/><FlowDot points={wire} active={active}/></>}
 <group position={p} onClick={e=>{e.stopPropagation();if(interactive&&!roof)onSelect(d.id)}}><Appliance d={d}/>{isSelected&&!roof&&<mesh rotation={[-Math.PI/2,0,0]} position={[0,y-.01-p[1],0]}><ringGeometry args={[.37,.392,48]}/><meshBasicMaterial color="#00ce87" transparent opacity={.7}/></mesh>}</group>
 {interactive&&!roof&&<Html position={[p[0],p[1]+(d.kind==='fridge'?1.6:d.kind==='lights'?1.35:d.kind==='ac'?1.6:.9),p[2]]} center zIndexRange={[10,0]}><button className={`node-label ${isSelected?'selected':''} ${!d.online?'stale':''}`} onClick={()=>onSelect(d.id)} aria-label={`Select ${d.name}`}><i style={{background:!d.online?'#e38c47':active?'#00ce87':'#7d8583'}}/><span>{d.name}</span><b>{d.online?`${d.reading} ${powerUnit(s.telemetry).short==='VA'?'VA':'watts'}`:'No reading'}</b></button></Html>}
 </group>})}
 {/* Utility connection and standby generator. */}
 <Block size={[.06,2.1,.06]} position={[4.48,1.01,back+.7]} color={light?'#a3aaa7':'#737c77'}/><Block size={[.71,.06,.08]} position={[4.48,2.03,back+.7]} color={light?'#a3aaa7':'#737c77'}/><Block size={[.23,.39,.16]} position={[4.48,1.45,back+.7]} color={light?'#c6ccc7':'#727d76'}/>
 <Block size={[.76,.48,.56]} position={[4.01,.4,front-.5]} color={light?'#89968e':'#59685e'}/><Block size={[.55,.27,.022]} position={[4.01,.42,front-.2]} color="#272f2d"/>
 {interactive&&!focusRoom&&!focusDevice&&<>
 {data?.sources.generator!=null&&data.sources.generator>0&&<Html position={[4.1,.95,front+.05]} center zIndexRange={[9,0]}><div className="source-callout"><i style={{background:SOURCE_COLORS.generator}}/><b>{Math.round(flow.generator).toLocaleString()} W</b><span>Generator</span></div></Html>}
 <Html position={[4.45,.12,back+.6]} center zIndexRange={[9,0]}><div className="source-callout"><i style={{background:SOURCE_COLORS.grid}}/><b>{data?.sources.grid!=null?`${Math.round(data.sources.grid).toLocaleString()} W`:data?.demand_w!=null&&data.demand_scope==='whole_home'?`${Math.round(data.demand_w).toLocaleString()} ${powerUnit(data).short}`:'Unknown'}</b><span>{data?.sources.grid!=null?'Grid meter':'Whole house'}</span></div></Html>
 </>}
 </>}
 </group>
}
function FocusCamera({layout,floor,room,deviceId,roof,interactive,rotation,resetKey,zoom=1}:{layout:Layout;floor:number;room:Room|null;deviceId:string|null;roof:boolean;interactive:boolean;rotation:boolean;resetKey:number;zoom?:number}) {
 const controls=useRef<OrbitControlsImpl>(null),moving=useRef(false),goal=useRef(new THREE.Vector3()),target=useRef(new THREE.Vector3()),{camera,size}=useThree()
 const devices=useEnergy(s=>s.devices)
 const {placed,depth}=useMemo(()=>pack(layout),[layout])
 useEffect(()=>{
  // The canvas can measure 0 x 0 for a moment when it first opens; 0/0 would make the camera NaN for good.
  if(!size.width||!size.height)return
  const device=devices.find(d=>d.id===deviceId),name=device?.room||room
  const r=name&&!roof?placed.find(x=>x.name===name)||placed[0]:null
  const levelY=roof?layout.floors*FLOOR_H/2:(Math.min(floor,layout.floors)-1)*FLOOR_H
  target.current.set(r?r.cx:0,r?r.y+.55:levelY+.5,r?r.cz:0)
  const offset=new THREE.Vector3(...(r?[5,5.3,7.1]:[8,6.9,10.6]) as Spot)
  offset.multiplyScalar(Math.max(1,1.55/(size.width/size.height))*(r?1:Math.max(1,depth/4.6))*zoom)
  goal.current.copy(target.current).add(offset)
  moving.current=true
 },[room,deviceId,roof,floor,camera,size.width,size.height,resetKey,placed,depth,zoom,layout.floors])
 useFrame((_,dt)=>{
  if(!moving.current||!controls.current)return
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // A camera that ever became NaN jumps straight to its goal instead of blending from nowhere.
  const broken=![camera.position.x,camera.position.y,camera.position.z,controls.current.target.x].every(Number.isFinite)
  const blend=reduced||broken?1:1-Math.exp(-10*dt)
  camera.position.lerp(goal.current,blend);controls.current.target.lerp(target.current,blend);controls.current.update()
  if(camera.position.distanceTo(goal.current)<.015){moving.current=false}
 })
 return <OrbitControls ref={controls} enabled={interactive} makeDefault target={[0,.5,0]} minDistance={zoom<1?6:7} maxDistance={28} maxPolarAngle={Math.PI*.47} enablePan={false} onStart={()=>{moving.current=false}} autoRotate={rotation&&interactive&&!room&&!deviceId} autoRotateSpeed={.45}/>
}
/** The 3D house. It is drawn from the saved home layout, or from `layout` while the home is being built.
 * `floor` is the floor shown in the inside view; the outside view shows every floor.
 * With onEditRoom set it is the builder: rooms are tapped to edit them, and appliances are hidden. */
export default function HouseScene({layout,floor=1,roof,heatmap,rotation,viewKey,interactive=true,onSelect,onRoom,focusRoom,focusDevice,theme,editRoom,onEditRoom}:{layout?:Layout;floor?:number;roof:boolean;heatmap:boolean;rotation:boolean;viewKey:number;interactive?:boolean;onSelect:(id:string)=>void;onRoom:(room:Room)=>void;focusRoom:Room|null;focusDevice:string|null;theme:Theme;editRoom?:string|null;onEditRoom?:(id:string)=>void}) {
 const saved=useHome(s=>s.layout),home=layout||saved
 const light=theme==='light',background=light?'#f5f5f3':'#161718'
 return <ThemeContext.Provider value={theme}><Canvas shadows camera={{position:[8,7.4,10.6],fov:39}} dpr={[1,1.7]} gl={{antialias:true}}><color attach="background" args={[background]}/><fog attach="fog" args={[background,26,60]}/><ambientLight intensity={light?1.3:1.05}/><directionalLight castShadow position={[3,10,5]} intensity={light?2.5:2.1} color="#fff2de" shadow-mapSize={[1024,1024]} shadow-camera-left={-9} shadow-camera-right={9} shadow-camera-top={9} shadow-camera-bottom={-9} shadow-bias={-.001}/><directionalLight position={[-5,4,-4]} intensity={light?.8:.7} color="#d5e6ea"/><House layout={home} floor={floor} roof={roof} heatmap={heatmap} interactive={interactive} onSelect={onSelect} onRoom={onRoom} focusRoom={focusRoom} focusDevice={focusDevice} editRoom={editRoom} onEditRoom={onEditRoom}/><ContactShadows position={[0,-.18,0]} opacity={light?.32:.6} scale={21} blur={2.2} far={4.5} resolution={256} color={light?'#7c817d':'#080b09'}/><FocusCamera layout={home} floor={floor} resetKey={viewKey} room={focusRoom} deviceId={focusDevice} roof={roof} interactive={interactive||!!onEditRoom} rotation={rotation} zoom={onEditRoom?.62:1}/></Canvas></ThemeContext.Provider>
}
