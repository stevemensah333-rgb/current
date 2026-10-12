import {Canvas,useFrame,useThree} from '@react-three/fiber'
import {ContactShadows,Edges,Html,Line,OrbitControls} from '@react-three/drei'
import {createContext,useContext,useEffect,useMemo,useRef} from 'react'
import * as THREE from 'three'
import {getFlow,useEnergy} from './store'
import {ROOM_NAMES,SOURCE_COLORS,type Device,type Room} from './energy'
import type {Theme} from './theme'
import type {OrbitControls as OrbitControlsImpl} from 'three-stdlib'

const ThemeContext=createContext<Theme>('dark')
const centers:Record<Room,[number,number,number]>={'Living room':[-1.55,.14,1.15],Kitchen:[1.55,.14,1.15],Bedroom:[-1.55,.14,-1.15],Office:[1.55,.14,-1.15]}
const placements:Record<string,[number,number,number]>={ac:[-2.7,.3,.8],tv:[-.65,.22,.85],fridge:[2.55,.22,.45],kettle:[1.1,.8,1.8],lights:[-2.5,.22,-1.5],fan:[-.9,.2,-1.3],router:[.75,.95,-1.65],laptop:[1.9,.2,-1.25]}
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
function SolarArray(){
 return <group>{[0,1,2].flatMap(x=>[0,1,2,3].map(z=><group key={`${x}-${z}`} position={[(x-1)*.97,0,(z-1.5)*1.06]}><Block size={[.91,.055,1]} color="#252f3c" edges/>{[-.28,0,.28].map(n=><Block key={n} position={[n,.031,0]} size={[.006,.006,.96]} color="#505b69"/>)}<Block position={[0,.032,0]} size={[.87,.006,.008]} color="#505b69"/></group>))}</group>
}
function Gable({z,color}:{z:number;color:string}){
 const shape=useMemo(()=>{const s=new THREE.Shape();s.moveTo(-3.2,2.18);s.lineTo(0,3.27);s.lineTo(3.2,2.18);s.closePath();return s},[])
 return <mesh position={[0,0,z]} castShadow receiveShadow><extrudeGeometry args={[shape,{depth:.14,bevelEnabled:false}]}/><meshStandardMaterial color={color} roughness={.7}/></mesh>
}
function Furniture(){
 const light=useContext(ThemeContext)==='light',fabric=light?'#b0b8b2':'#596561',wood=light?'#a39177':'#776955'
 return <group>
 {/* Living room sofa and a low coffee table. */}
 <Block size={[1.45,.38,.66]} position={[-1.75,.43,1.85]} color={fabric}/><Block size={[1.45,.48,.13]} position={[-1.75,.8,2.11]} color={fabric}/>{[-2.49,-1.01].map(x=><Block key={x} size={[.12,.46,.73]} position={[x,.62,1.85]} color={fabric}/>)}
 <Block size={[.83,.07,.5]} position={[-1.76,.51,.85]} color={wood}/>{[-2.08,-1.44].map(x=><Block key={x} size={[.04,.27,.34]} position={[x,.33,.85]} color="#545a5a"/>)}
 {/* Kitchen cabinets and a counter supporting the kettle. */}
 <Block size={[1.45,.59,.57]} position={[1.33,.49,1.82]} color={light?'#d1d4cc':'#657064'}/><Block size={[1.57,.08,.67]} position={[1.33,.825,1.82]} color={light?'#e0dfd7':'#9c9a8b'}/>{[.87,1.32,1.77].map(x=><Block key={x} size={[.012,.49,.015]} position={[x,.5,2.112]} color="#777c74"/>)}
 {/* Bedroom bed, pillow and a small bedside table. */}
 <Block size={[1.18,.27,1.55]} position={[-1.45,.36,-1.14]} color={wood}/><Block size={[1.12,.16,1.46]} position={[-1.45,.56,-1.14]} color={light?'#e1ddd5':'#b1b1a9'}/><Block size={[1.12,.05,1.05]} position={[-1.45,.66,-.9]} color={fabric}/><Block size={[.65,.11,.34]} position={[-1.45,.69,-1.66]} color={light?'#f2efe8':'#d1cbbf'}/><Block size={[1.25,.7,.09]} position={[-1.45,.59,-1.98]} color={wood}/>
 {/* Office chair. */}
 <Block size={[.45,.1,.45]} position={[1.9,.48,-.43]} color={fabric}/><Block size={[.45,.5,.08]} position={[1.9,.75,-.18]} color={fabric}/><Block size={[.035,.32,.035]} position={[1.9,.26,-.43]} color="#707575"/>
 </group>
}
function House({roof,heatmap,interactive,onSelect,onRoom,focusRoom,focusDevice}:{roof:boolean;heatmap:boolean;interactive:boolean;onSelect:(id:string)=>void;onRoom:(room:Room)=>void;focusRoom:Room|null;focusDevice:string|null}) {
 const theme=useContext(ThemeContext),light=theme==='light',s=useEnergy(),{devices}=s,flow=getFlow(s)
 const wall=light?'#d5d5ce':'#686c69',trim=light?'#e3e4df':'#979b97',floor=light?'#b7a793':'#89806f'
 const positions=useMemo(()=>{
  const result:Record<string,[number,number,number]>={}
  ROOM_NAMES.forEach(r=>devices.filter(d=>d.room===r).forEach((d,i)=>{const c=centers[r];result[d.id]=placements[d.id]||[c[0]+((i%3)-1)*.75,.22,c[2]+(Math.floor(i/3)%3-1)*.46]}))
  return result
 },[devices])
 return <group>
 <Block size={[6.7,.23,5.1]} position={[0,-.04,0]} color={light?'#a6aaa5':'#494d4b'}/>
 {ROOM_NAMES.map(r=>{const c=centers[r],load=devices.filter(d=>d.room===r&&d.online).reduce((sum,d)=>sum+d.reading,0);return <group key={r}><Block size={[3.04,.055,2.2]} position={[c[0],.11,c[2]]} color={(focusRoom===r||devices.find(d=>d.id===focusDevice)?.room===r)?light?'#acbaa9':'#728578':heatmap?load>700?light?'#beab68':'#a39753':load>100?light?'#a1b2a3':'#6d8777':floor:floor}/>{[0,1,2,3,4,5].map(n=><Block key={n} size={[.007,.003,2.15]} position={[c[0]-1.3+n*.5,.14,c[2]]} color={light?'#9e907d':'#716957'}/>)}{interactive&&!roof&&<Html position={[c[0],.18,c[2]+.83]} center zIndexRange={[8,0]}><button className={`room-label ${focusRoom===r?'active':''}`} onClick={()=>onRoom(r)} aria-label={`Explore ${r}`}>{r}</button></Html>}</group>})}
 {/* An actual architectural cutaway: front and right walls are removed in Inside view. */}
 <Block size={[6.42,2.02,.16]} position={[0,1.16,-2.34]} color={wall}/><Block size={[.16,2.02,4.7]} position={[-3.2,1.16,0]} color={wall}/>
 <Block size={[6.42,roof?2.02:.12,.16]} position={[0,roof?1.16:.21,2.34]} color={wall}/><Block size={[.16,roof?2.02:.12,4.7]} position={[3.2,roof?1.16:.21,0]} color={wall}/>
 <Block size={[.12,roof?2:1.1,4.55]} position={[0,roof?1.16:.73,0]} color={wall}/><Block size={[6.25,roof?2:.8,.12]} position={[0,roof?1.16:.58,0]} color={wall}/>
 <Block size={[6.45,.075,.18]} position={[0,2.22,-2.34]} color={trim}/><Block size={[.18,.075,4.7]} position={[-3.2,2.22,0]} color={trim}/>
 {roof&&<group><Gable z={2.28} color={wall}/><Gable z={-2.42} color={wall}/><Block size={[3.56,.12,5.04]} position={[-1.65,2.71,0]} rotation={[0,0,.32]} color="#3d4244"/><Block size={[3.56,.12,5.04]} position={[1.65,2.71,0]} rotation={[0,0,-.32]} color="#3d4244"/><group position={[1.65,2.8,0]} rotation={[0,0,-.32]}><SolarArray/></group>
 <Block size={[.73,1.67,.04]} position={[-1.96,1.0,2.44]} color="#3b4343"/><Block size={[.043,.17,.04]} position={[-1.7,.94,2.48]} color="#bfc2b8"/>
 {[.6,1.65].map(x=><group key={x}><Block size={[.83,1.02,.035]} position={[x,1.38,2.437]} color="#cfbf8d"/><Block size={[.035,1.1,.045]} position={[x,1.38,2.462]} color="#434b4b"/><Block size={[.9,.035,.045]} position={[x,1.38,2.46]} color="#434b4b"/></group>)}
 </group>}
 {!roof&&<group position={[-.25,.29,-3.45]} scale={.6} rotation={[.16,0,0]}><SolarArray/></group>}
 <Furniture/>
 <Block size={[.25,.49,.19]} position={[0,.47,2.52]} color={light?'#c1c7c4':'#646d6b'}/>
 {devices.map(d=>{const p=positions[d.id],active=d.on&&d.online,isSelected=focusDevice===d.id;const wire:[number,number,number][]=[[0,.16,2.54],[0,.16,p[2]],[p[0],.16,p[2]]];return <group key={d.id}>
 {!roof&&<><Line points={wire} color={!d.online?'#e38c47':active?'#00bd82':'#70746e'} lineWidth={isSelected?1.3:.7} transparent opacity={active?.6:.18}/><FlowDot points={wire} active={active}/></>}
 <group position={p} onClick={e=>{e.stopPropagation();if(interactive&&!roof)onSelect(d.id)}}><Appliance d={d}/>{isSelected&&!roof&&<mesh rotation={[-Math.PI/2,0,0]} position={[0,-p[1]+.15,0]}><ringGeometry args={[.37,.392,48]}/><meshBasicMaterial color="#00ce87" transparent opacity={.7}/></mesh>}</group>
 {interactive&&!roof&&<Html position={[p[0],p[1]+(d.kind==='fridge'?1.6:d.kind==='lights'?1.35:d.kind==='ac'?1.6:.9),p[2]]} center zIndexRange={[10,0]}><button className={`node-label ${isSelected?'selected':''} ${!d.online?'stale':''}`} onClick={()=>onSelect(d.id)} aria-label={`Select ${d.name}`}><i style={{background:!d.online?'#e38c47':active?'#00ce87':'#7d8583'}}/><span>{d.name}</span><b>{d.online?`${d.reading} watts`:'No reading'}</b></button></Html>}
 </group>})}
 {/* Neutral home battery, utility connection and standby generator. */}
 <Block size={[.19,1.12,.74]} position={[-3.46,.7,-1.35]} color={light?'#eceeeb':'#c4ccc8'}/><Block size={[.024,.42,.015]} position={[-3.57,.78,-.99]} color="#00ce87"/>
 <Block size={[.06,2.1,.06]} position={[4.48,1.01,-1.6]} color={light?'#a3aaa7':'#737c77'}/><Block size={[.71,.06,.08]} position={[4.48,2.03,-1.6]} color={light?'#a3aaa7':'#737c77'}/><Block size={[.23,.39,.16]} position={[4.48,1.45,-1.6]} color={light?'#c6ccc7':'#727d76'}/>
 <Block size={[.76,.48,.56]} position={[4.01,.4,1.8]} color={light?'#89968e':'#59685e'}/><Block size={[.55,.27,.022]} position={[4.01,.42,2.097]} color="#272f2d"/>{[-.18,0,.18].map(x=><Block key={x} size={[.015,.22,.025]} position={[4.01+x,.43,2.114]} color="#6d7771"/>)}
 {interactive&&!focusRoom&&!focusDevice&&<>
 <Html position={roof?[.2,3.35,-.55]:[-.25,.35,-3.83]} center zIndexRange={[9,0]}><div className="source-callout"><i style={{background:SOURCE_COLORS.solar}}/><b>{Math.round(flow.solar).toLocaleString()} W</b><span>Solar</span></div></Html>
 <Html position={[-4.05,.21,1.7]} center zIndexRange={[9,0]}><div className="source-callout"><i style={{background:SOURCE_COLORS.battery}}/><b>{s.soc.toFixed(0)}% charged</b><span>Battery · {Math.round(flow.battery)} W</span></div></Html>
 {s.scenario==='generator'&&<Html position={[4.1,.95,2.35]} center zIndexRange={[9,0]}><div className="source-callout"><i style={{background:SOURCE_COLORS.generator}}/><b>{Math.round(flow.generator).toLocaleString()} W</b><span>Generator</span></div></Html>}
 <Html position={[4.45,.12,-1.7]} center zIndexRange={[9,0]}><div className="source-callout"><i style={{background:SOURCE_COLORS.grid}}/><b>{Math.round(flow.grid).toLocaleString()} W</b><span>Grid {s.scenario==='outage'||s.scenario==='generator'?'unavailable':''}</span></div></Html>
 </>}
 </group>
}
function FocusCamera({room,deviceId,roof,interactive,rotation,resetKey}:{room:Room|null;deviceId:string|null;roof:boolean;interactive:boolean;rotation:boolean;resetKey:number}) {
 const controls=useRef<OrbitControlsImpl>(null),moving=useRef(false),goal=useRef(new THREE.Vector3()),target=useRef(new THREE.Vector3()),{camera,size}=useThree()
 const devices=useEnergy(s=>s.devices)
 useEffect(()=>{
  const device=devices.find(d=>d.id===deviceId),r=device?.room||room
  const center=r&&!roof?centers[r]:[0,.5,0]
  target.current.set(center[0],r&&!roof?.55:.5,center[2])
  const offset=new THREE.Vector3(...(r&&!roof?[5,5.3,7.1]:[8,6.9,10.6]) as [number,number,number])
  offset.multiplyScalar(Math.max(1,1.55/(size.width/size.height)))
  goal.current.copy(target.current).add(offset)
  moving.current=true
 },[room,deviceId,roof,camera,size.width,size.height,resetKey])
 useFrame((_,dt)=>{
  if(!moving.current||!controls.current)return
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const blend=reduced?1:1-Math.exp(-10*dt)
  camera.position.lerp(goal.current,blend);controls.current.target.lerp(target.current,blend);controls.current.update()
  if(camera.position.distanceTo(goal.current)<.015){moving.current=false}
 })
 return <OrbitControls ref={controls} enabled={interactive} makeDefault target={[0,.5,0]} minDistance={7} maxDistance={23} maxPolarAngle={Math.PI*.47} enablePan={false} onStart={()=>{moving.current=false}} autoRotate={rotation&&interactive&&!room&&!deviceId} autoRotateSpeed={.45}/>
}
export default function HouseScene({roof,heatmap,rotation,viewKey,interactive=true,onSelect,onRoom,focusRoom,focusDevice,theme}:{roof:boolean;heatmap:boolean;rotation:boolean;viewKey:number;interactive?:boolean;onSelect:(id:string)=>void;onRoom:(room:Room)=>void;focusRoom:Room|null;focusDevice:string|null;theme:Theme}) {
 const light=theme==='light',background=light?'#f5f5f3':'#161718'
 return <ThemeContext.Provider value={theme}><Canvas shadows camera={{position:[8,7.4,10.6],fov:39}} dpr={[1,1.7]} gl={{antialias:true}}><color attach="background" args={[background]}/><fog attach="fog" args={[background,22,50]}/><ambientLight intensity={light?1.3:1.05}/><directionalLight castShadow position={[3,8,5]} intensity={light?2.5:2.1} color="#fff2de" shadow-mapSize={[1024,1024]} shadow-camera-left={-8} shadow-camera-right={8} shadow-camera-top={8} shadow-camera-bottom={-8} shadow-bias={-.001}/><directionalLight position={[-5,4,-4]} intensity={light?.8:.7} color="#d5e6ea"/><House roof={roof} heatmap={heatmap} interactive={interactive} onSelect={onSelect} onRoom={onRoom} focusRoom={focusRoom} focusDevice={focusDevice}/><ContactShadows position={[0,-.18,0]} opacity={light?.32:.6} scale={19} blur={2.2} far={4.5} resolution={256} color={light?'#7c817d':'#080b09'}/><FocusCamera resetKey={viewKey} room={focusRoom} deviceId={focusDevice} roof={roof} interactive={interactive} rotation={rotation}/></Canvas></ThemeContext.Provider>
}
