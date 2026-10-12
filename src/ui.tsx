import {useEffect,useRef,type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import type {Device} from './energy'

export function Icon({name,size=20}:{name:string;size?:number}) {
 const paths:Record<string,string>={moon:'M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2',home:'M3 10 12 3l9 7M5 9v12h14V9M10 21v-7h4v7',bolt:'m13 2-9 12h7l-1 8 10-12h-7l1-8',plug:'M8 3v5m8-5v5M6 8h12v5a6 6 0 0 1-12 0V8m6 11v3',chart:'M4 4v16h16M8 15l4-6 4 3 4-7',sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',settings:'M4 7h16M4 17h16M9 4v6m6 4v6',arrow:'M5 12h14m-6-6 6 6-6 6',back:'M19 12H5m6-6-6 6 6 6',plus:'M12 4v16M4 12h16',close:'m6 6 12 12M6 18 18 6',battery:'M4 7h15v10H4zM21 10v4M7 10v4m4-4v4m4-4v4',grid:'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16m6-16v16',rotate:'M20 7V3l-4 4M20 7a9 9 0 1 0 1 8',export:'M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4',check:'m5 12 4 4L19 6',shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3'}
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]||paths.bolt}/></svg>
}
export function deviceIcon(d:Device){return d.kind==='lights'?'sun':d.kind==='laptop'||d.kind==='tv'?'grid':'plug'}
export function hoursLabel(hours:number){if(!Number.isFinite(hours))return 'No active load';if(hours<=0)return 'Reserve reached';const minutes=Math.round(hours*60);return `${Math.floor(minutes/60)}h ${minutes%60}m`}
export function Modal({title,close,children,side=false}:{title:string;close:()=>void;children:ReactNode;side?:boolean}){
 const ref=useRef<HTMLElement>(null)
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null
  const elements=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,summary,[href],[tabindex="0"]')||[]).filter(e=>e.getClientRects().length>0)
  const first=elements().find(e=>e.tagName==='INPUT'||e.tagName==='SELECT')||elements()[0];first?.focus()
  const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Tab'){const nodes=elements();const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}}
  document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('keydown',onKey);previous?.focus()}
 },[])
 return createPortal(<div className={`modal-backdrop ${side?'side':''}`} onClick={close}><section ref={ref} className="modal panel" role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}><div className="modal-top"><span className="eyebrow">{side?'YOUR APPLIANCE':'CURRENT'}</span><button className="icon-button" onClick={close} aria-label={`Close ${title}`}><Icon name="close"/></button></div><h2>{title}</h2>{children}</section></div>,document.body)
}
