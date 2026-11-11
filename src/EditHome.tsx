import {useEffect, useState} from 'react'
import {Builder} from './onboarding/Onboarding'
import {Icon} from './ui'
import {useEnergy} from './store'
import {removeFloor, roomMoves, useHome, type Layout} from './home/layout'
import type {Theme} from './theme'

/** Change the house after setup, with the same builder as onboarding. Nothing changes until Save. */
export function EditHome({theme, close}: {theme: Theme; close: () => void}) {
  const saved = useHome(s => s.layout), finish = useHome(s => s.finish)
  const [draft, setDraft] = useState<Layout>(saved), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [close])
  const save = async () => {
    setBusy(true); setError('')
    let done = draft; for (let f = done.floors; f >= 1; f--) done = removeFloor(done, f)   // empty floors are dropped, as in setup
    const appliances = useEnergy.getState().telemetry?.devices.filter(d => d.role === 'appliance') ?? []
    try {
      for (const m of roomMoves(saved, done, appliances)) await useEnergy.getState().moveDevice(m.id, m.room)
      finish(done); close()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <div className="ob-screen" role="dialog" aria-modal="true" aria-label="Edit your home">
    <main className="ob wide">
      <section className="ob-stage" aria-live="polite"><Builder draft={draft} setDraft={setDraft} theme={theme} title="Edit your home"/></section>
      {error && <p className="attention" role="alert">{error}</p>}
      <nav className="ob-foot">
        <button className="ob-round" onClick={close} aria-label="Cancel" title="Cancel"><Icon name="close" size={18}/></button>
        <button className="ob-round ob-go finish" onClick={() => void save()} disabled={busy} aria-label="Save my home"><span>Save</span><Icon name="check" size={18}/></button>
      </nav>
    </main>
  </div>
}
