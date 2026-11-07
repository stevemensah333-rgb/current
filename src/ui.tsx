import {useEffect,useRef,useState,type ReactNode,type PointerEvent,type KeyboardEvent as ReactKeyboardEvent} from 'react'
import {createPortal} from 'react-dom'
import type {Device} from './energy'

export function Icon({name,size=20}:{name:string;size?:number}) {
 const paths:Record<string,string>={chat:'M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12',info:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20m0-6v-5m0-3h.01',pulse:'M3 12h4l2-6 4 12 2-6h6',eye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12m10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6',layers:'m12 3 9 5-9 5-9-5 9-5m-9 9 9 5 9-5',expand:'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',alert:'M12 3 2 20h20L12 3m0 6v5m0 3h.01',moon:'M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2',home:'M3 10 12 3l9 7M5 9v12h14V9M10 21v-7h4v7',bolt:'m13 2-9 12h7l-1 8 10-12h-7l1-8',plug:'M8 3v5m8-5v5M6 8h12v5a6 6 0 0 1-12 0V8m6 11v3',chart:'M4 4v16h16M8 15l4-6 4 3 4-7',sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',settings:'M4 7h16M4 17h16M9 4v6m6 4v6',arrow:'M5 12h14m-6-6 6 6-6 6',back:'M19 12H5m6-6-6 6 6 6',plus:'M12 4v16M4 12h16',close:'m6 6 12 12M6 18 18 6',battery:'M4 7h15v10H4zM21 10v4M7 10v4m4-4v4m4-4v4',grid:'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16m6-16v16',rotate:'M20 7V3l-4 4M20 7a9 9 0 1 0 1 8',export:'M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4',check:'m5 12 4 4L19 6',shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3',pencil:'M4 20h4L19 9l-4-4L4 16v4m11-15 4 4',trash:'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3'}
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]||paths.bolt}/></svg>
}
export function deviceIcon(d:Device){return d.kind==='lights'?'sun':d.kind==='laptop'||d.kind==='tv'?'grid':'plug'}
export function hoursLabel(hours:number){if(!Number.isFinite(hours))return 'No active load';if(hours<=0)return 'Reserve reached';const minutes=Math.round(hours*60);return `${Math.floor(minutes/60)}h ${minutes%60}m`}
export function Modal({title,close,children,side=false,eyebrow,className=''}:{title:string;close:()=>void;children:ReactNode;side?:boolean;eyebrow?:string;className?:string}){
 const ref=useRef<HTMLElement>(null)
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null
  const elements=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,summary,[href],[tabindex="0"]')||[]).filter(e=>e.getClientRects().length>0)
  const first=elements().find(e=>e.tagName==='INPUT'||e.tagName==='SELECT')||elements()[0];first?.focus()
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Tab'){const nodes=elements();const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}}
  document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('keydown',onKey);previous?.focus()}
 },[])
 return createPortal(<div className={`modal-backdrop ${side?'side':''}`} onClick={close}><section ref={ref} className={`modal panel ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}><div className="modal-top"><span className="eyebrow">{eyebrow??(side?'YOUR APPLIANCE':'CURRENT')}</span><button className="icon-button" onClick={close} aria-label={`Close ${title}`}><Icon name="close"/></button></div><h2>{title}</h2>{children}</section></div>,document.body)
}

const clamp=(v:number,lo:number,hi:number)=>Math.min(Math.max(v,lo),Math.max(lo,hi))

/** A see-through card that floats over the house, without hiding it. Drag it by its top bar; Escape or × closes it.
 * side: where it first appears. */
export function FloatingCard({title,eyebrow,close,children,side='right'}:{title:string;eyebrow:string;close:()=>void;children:ReactNode;side?:'left'|'right'}){
 const card=useRef<HTMLElement>(null),grab=useRef<{dx:number;dy:number}|null>(null)
 const [pos,setPos]=useState(()=>({x:side==='left'?24:Math.max(16,window.innerWidth-460),y:side==='left'?170:140}))
 const heading=useRef<HTMLHeadingElement>(null),headingId=useRef(`card-${Math.random().toString(36).slice(2)}`).current
 // Escape closes only this card, and not when a modal on top of it already handled the key.
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('.modal'))close()};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[close])
 // Move focus into the card when it opens, and give it back to the button that opened it when it closes.
 useEffect(()=>{const opener=document.activeElement as HTMLElement|null;heading.current?.focus({preventScroll:true});return()=>{if(opener?.isConnected)opener.focus({preventScroll:true});else setTimeout(()=>document.querySelector<HTMLElement>('[data-opens-card]')?.focus({preventScroll:true}),0)}},[])
 // Keep the card inside the window when the window changes size.
 useEffect(()=>{
  const fit=()=>setPos(p=>({x:clamp(p.x,0,window.innerWidth-(card.current?.offsetWidth??420)),y:clamp(p.y,0,window.innerHeight-60)}))
  fit();window.addEventListener('resize',fit);return()=>window.removeEventListener('resize',fit)
 },[])
 const down=(e:PointerEvent<HTMLDivElement>)=>{if((e.target as HTMLElement).closest('button:not(.drag-grip)'))return;grab.current={dx:e.clientX-pos.x,dy:e.clientY-pos.y};e.currentTarget.setPointerCapture(e.pointerId)}
 const move=(e:PointerEvent<HTMLDivElement>)=>{
  if(!grab.current)return
  const w=card.current?.offsetWidth??420
  setPos({x:clamp(e.clientX-grab.current.dx,0,window.innerWidth-w),y:clamp(e.clientY-grab.current.dy,0,window.innerHeight-60)})
 }
 const nudge=(e:ReactKeyboardEvent)=>{const step={ArrowLeft:[-24,0],ArrowRight:[24,0],ArrowUp:[0,-24],ArrowDown:[0,24]}[e.key];if(!step)return;e.preventDefault()
  const w=card.current?.offsetWidth??420;setPos(p=>({x:clamp(p.x+step[0],0,window.innerWidth-w),y:clamp(p.y+step[1],0,window.innerHeight-60)}))}
 return createPortal(<section ref={card} className="float-card" role="region" aria-labelledby={headingId} style={{left:pos.x,top:pos.y}}>
  <div className="float-top" onPointerDown={down} onPointerMove={move} onPointerUp={()=>{grab.current=null}} title="Drag to move">
   <span className="eyebrow">{eyebrow}</span><button className="drag-grip" onKeyDown={nudge} aria-label="Move this card with the arrow keys" title="Drag, or use the arrow keys, to move">⠿</button>
   <button className="icon-button" onClick={close} aria-label={`Close ${title}`} title="Close"><Icon name="close"/></button>
  </div>
  <h2 ref={heading} id={headingId} tabIndex={-1}>{title}</h2>{children}
 </section>,document.body)
}
