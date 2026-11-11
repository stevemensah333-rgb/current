import {useState} from 'react'
import HouseScene from '../HouseScene'
import {Icon} from '../ui'
import type {Theme} from '../theme'
import {APPLIANCES, HERO, HOMES, LESSONS, ROOMS, WATTS} from './art'
import {HOME_NAMES, KIND_NAMES, MAX_FLOORS, NAME_MAX, fits, makeRoom, removeFloor, starter, uniqueName, useHome, type HomeKind, type Layout, type RoomKind, type Size} from '../home/layout'
import './onboarding.css'

type App = keyof typeof APPLIANCES
const APP_NAMES: Record<App, string> = {fridge: 'Fridge', kettle: 'Kettle', fan: 'Fan', tv: 'TV', ac: 'Air con', iron: 'Iron', pump: 'Pump', lights: 'Lights'}
const LESSON_LIST: [keyof typeof LESSONS, string, string][] = [
  ['live', 'See what is on, room by room', 'Your home updates live as appliances switch on and off.'],
  ['ask', 'Ask about your power', 'Ask in your own words. You get a short, clear answer.'],
  ['heads_up', 'Hear about problems early', 'If an appliance starts to act strangely, you get a warning before it breaks.'],
  ['teach', 'Onboard your appliances', ''],
]
const STEPS = 5   // welcome, lessons, home, appliances, done
const power = (w: number) => (w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${w} W`)

/** Our own static illustrations (src/onboarding/art.ts), drawn inline so their parts can animate. */
function Art({svg, className = ''}: {svg: string; className?: string}) {
  return <span className={`ob-art ${className}`} dangerouslySetInnerHTML={{__html: svg}}/>
}

/** Pick a home type, then shape it in the 3D house: pick a floor, add rooms, tap one to change it. */
export function Builder({draft, setDraft, theme, title = 'Build your home'}: {draft: Layout; setDraft: (l: Layout) => void; theme: Theme; title?: string}) {
  const [selected, setSelected] = useState<string | null>(null), [renaming, setRenaming] = useState(false), [name, setName] = useState('')
  const [floor, setFloor] = useState(1)
  const here = draft.rooms.filter(r => r.floor === floor)
  const room = draft.rooms.find(r => r.id === selected), i = room ? here.indexOf(room) : -1
  const update = (rooms: Layout['rooms'], floors = draft.floors) => { const next = {...draft, rooms, floors}; if (fits(next)) setDraft(next) }
  const can = (rooms: Layout['rooms'], floors = draft.floors) => fits({rooms, floors})
  // Moving left or right swaps the room with its neighbour on the same floor.
  const swap = (d: number) => {
    const other = here[i + d]; if (!room || !other) return
    const rooms = [...draft.rooms], a = rooms.indexOf(room), b = rooms.indexOf(other);[rooms[a], rooms[b]] = [rooms[b], rooms[a]]; update(rooms)
  }
  const sized = (d: number) => room && draft.rooms.map(r => r.id === room.id ? {...r, size: Math.min(4, Math.max(1, r.size + d)) as Size} : r)
  const rename = () => { const n = name.trim().slice(0, NAME_MAX); if (n && room) update(draft.rooms.map(r => r.id === room.id ? {...r, name: uniqueName(n, draft.rooms, r.id)} : r)); setRenaming(false) }
  const add = (kind: RoomKind) => { const r = makeRoom(kind, draft.rooms, floor), rooms = [...draft.rooms, r]; if (can(rooms)) { update(rooms); setSelected(r.id); setRenaming(false) } }
  const choose = (id: string) => { setSelected(s => s === id ? null : id); setRenaming(false) }
  const goTo = (f: number) => { setFloor(f); setSelected(null); setRenaming(false) }
  const addFloor = () => { if (draft.floors < MAX_FLOORS) { setDraft({...draft, floors: draft.floors + 1}); goTo(draft.floors + 1) } }
  const dropFloor = (f: number) => { setDraft(removeFloor(draft, f)); goTo(Math.max(1, Math.min(floor, draft.floors - 1))) }
  const less = sized(-1), more = sized(1)
  return <>
    <div className="ob-copy"><h1>{title}</h1><p>{room ? `Change the ${room.name.toLowerCase()} with the buttons below.` : here.length ? 'Tap a room in the house to change it, or add one below.' : `Floor ${floor} is empty. Add a room below.`}</p></div>
    <div className="ob-types" role="radiogroup" aria-label="Home type">{(Object.keys(HOMES) as HomeKind[]).map(h =>
      <button key={h} role="radio" aria-checked={draft.home === h} className={`ob-type ${draft.home === h ? 'sel' : ''}`} onClick={() => { if (h !== draft.home) { setDraft(starter(h)); goTo(1) } }}><Art svg={HOMES[h]}/><span>{HOME_NAMES[h]}</span></button>)}</div>
    <div className="ob-floors" role="tablist" aria-label="Floors">
      {Array.from({length: draft.floors}, (_, k) => k + 1).map(f => <span key={f} className={`ob-floor ${f === floor ? 'sel' : ''}`}>
        <button role="tab" aria-selected={f === floor} onClick={() => goTo(f)}>Floor {f}</button>
        {f === floor && draft.floors > 1 && !draft.rooms.some(r => r.floor === f) && <button className="ob-floor-x" onClick={() => dropFloor(f)} aria-label={`Remove floor ${f}`} title="Remove this empty floor">×</button>}
      </span>)}
      {draft.floors < MAX_FLOORS && <button className="ob-floor ob-floor-add" onClick={addFloor} aria-label="Add a floor" title="Add a floor"><Icon name="plus" size={14}/> Floor</button>}
    </div>
    <div className="ob-house"><HouseScene layout={draft} floor={floor} theme={theme} roof={false} heatmap={false} rotation={false} viewKey={0} interactive={false} onSelect={() => {}} onRoom={() => {}} focusRoom={null} focusDevice={null} editRoom={selected} onEditRoom={choose}/></div>
    {room ? <div className="ob-tools" aria-label={`Change ${room.name}`}>
      {renaming ? <form className="ob-rename" onSubmit={e => { e.preventDefault(); rename() }}><input autoFocus value={name} maxLength={NAME_MAX} onChange={e => setName(e.target.value)} aria-label="Room name"/><button className="ob-tool" type="submit"><Icon name="check" size={18}/><small>Save</small></button></form> : <>
        <button className="ob-tool" onClick={() => swap(-1)} disabled={i <= 0}><Icon name="back" size={18}/><small>Left</small></button>
        <div className="ob-size" role="group" aria-label={`Size ${room.size} of 4`}>
          <button onClick={() => update(less!)} disabled={room.size === 1} aria-label="Smaller">−</button>
          <span aria-hidden="true">{[1, 2, 3, 4].map(n => <i key={n} className={n <= room.size ? 'on' : ''}/>)}</span>
          <button onClick={() => update(more!)} disabled={room.size === 4 || !can(more!)} aria-label="Bigger">+</button>
          <small>Size</small>
        </div>
        <button className="ob-tool" onClick={() => { setName(room.name); setRenaming(true) }}><Icon name="pencil" size={18}/><small>Rename</small></button>
        <button className="ob-tool" onClick={() => swap(1)} disabled={i < 0 || i >= here.length - 1}><Icon name="arrow" size={18}/><small>Right</small></button>
        <button className="ob-tool" onClick={() => { update(draft.rooms.filter(r => r.id !== room.id)); setSelected(null) }} disabled={draft.rooms.length === 1}><Icon name="trash" size={18}/><small>Remove</small></button>
        <button className="ob-tool" onClick={() => setSelected(null)}><Icon name="close" size={18}/><small>Done</small></button>
      </>}
    </div> :
    <div className="ob-chips" aria-label={`Add a room to floor ${floor}`}>{(Object.keys(ROOMS) as RoomKind[]).map(k => {
      const ok = can([...draft.rooms, makeRoom(k, draft.rooms, floor)])
      return <button key={k} className="ob-chip" disabled={!ok} title={ok ? `Add a ${KIND_NAMES[k].toLowerCase()} to floor ${floor}` : 'This floor is full'} onClick={() => add(k)}><Art svg={ROOMS[k]}/><b aria-hidden="true">+</b><span>{KIND_NAMES[k]}</span></button>
    })}</div>}
  </>
}

/** First-open setup: a short lesson, then the user builds their home. Finishing saves the house the app shows. */
export default function Onboarding({theme, onDone}: {theme: Theme; onDone?: () => void}) {
  const finish = useHome(s => s.finish), saved = useHome(s => s.layout)
  const [step, setStep] = useState(0), [lesson, setLesson] = useState(0), [play, setPlay] = useState(0)
  // Setup always starts from a one-floor home of the saved type; floors are added on purpose.
  const [draft, setDraft] = useState<Layout>(() => starter(saved.home))
  const [apps, setApps] = useState<Set<App>>(() => new Set(['fridge', 'kettle', 'lights']))
  const next = () => {
    if (step === 1 && lesson < LESSON_LIST.length - 1) setLesson(lesson + 1)
    else if (step < STEPS - 1) setStep(step + 1)
    else { let done = draft; for (let f = done.floors; f >= 1; f--) done = removeFloor(done, f); finish(done); onDone?.() }   // empty floors are dropped
  }
  const back = () => { if (step === 1 && lesson > 0) setLesson(lesson - 1); else if (step > 0) setStep(step - 1) }
  const toggle = (a: App) => setApps(s => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n })
  const [key, title, line] = LESSON_LIST[lesson]

  return <div className="ob-screen" role="dialog" aria-modal="true" aria-label="Set up your home">
    <main className={`ob ${step === 2 ? 'wide' : ''}`}>
      <div className="ob-bar" aria-hidden="true">{Array.from({length: STEPS}, (_, i) => <i key={i} className={i <= step ? 'on' : ''}/>)}</div>
      <section className="ob-stage" key={`${step}-${lesson}`} aria-live="polite">
        {step === 0 && <><button className="ob-hero play" key={play} onClick={() => setPlay(p => p + 1)} aria-label="Play again"><Art svg={HERO.welcome}/></button>
          <div className="ob-copy"><h1>Welcome to Current</h1><p>See and understand your home’s power. Setup takes about 2 minutes.</p></div></>}
        {step === 1 && <><button className={`ob-scene ${key} play`} key={play} onClick={() => setPlay(p => p + 1)} aria-label="Play again"><Art svg={LESSONS[key]}/></button>
          <div className="ob-copy"><h1>{title}</h1>{line && <p>{line}</p>}</div>
          <div className="ob-pips">{LESSON_LIST.map((_, i) => <button key={i} className={i === lesson ? 'on' : ''} aria-label={`Lesson ${i + 1}`} aria-current={i === lesson} onClick={() => setLesson(i)}/>)}</div></>}
        {step === 2 && <Builder draft={draft} setDraft={setDraft} theme={theme}/>}
        {step === 3 && <><div className="ob-copy"><h1>Pick your appliances</h1><p>Tap the ones you have. Typical power is filled in for you.</p></div>
          <div className="ob-grid apps">{(Object.keys(APPLIANCES) as App[]).map(a =>
            <button key={a} className={`ob-tile art ${apps.has(a) ? 'on sel' : ''}`} aria-pressed={apps.has(a)} onClick={() => toggle(a)}><Art svg={APPLIANCES[a]}/><em>{power(WATTS[a])}</em><span>{APP_NAMES[a]}</span></button>)}</div></>}
        {step === 4 && <><div className="ob-hero done play"><Art svg={HERO.done}/></div>
          <div className="ob-copy"><h1>Your home is ready</h1><p>{draft.rooms.length} rooms{draft.floors>1?` on ${draft.floors} floors`:''} in your {HOME_NAMES[draft.home].toLowerCase()}. Next, onboard your first appliance.</p></div>
          <div className="ob-summary"><Art className="sum-home" svg={HOMES[draft.home]}/><div className="sum-apps">{[...apps].map(a => <Art key={a} className="art on" svg={APPLIANCES[a]}/>)}</div></div></>}
      </section>
      <nav className="ob-foot">
        <button className="ob-round" onClick={back} aria-label="Back" style={{visibility: step ? 'visible' : 'hidden'}}><Icon name="back" size={18}/></button>
        <button className={`ob-round ob-go ${step === STEPS - 1 ? 'finish' : ''}`} onClick={next} aria-label={step === STEPS - 1 ? 'Open my home' : 'Next'}>{step === STEPS - 1 ? <><span>Open my home</span><Icon name="arrow" size={18}/></> : <Icon name="arrow" size={18}/>}</button>
      </nav>
    </main>
  </div>
}
