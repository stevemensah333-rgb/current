import {useMemo} from 'react'
import {create} from 'zustand'

/** The home the user builds: rooms on one to three floors. On each floor, rooms fill rows four squares wide. */
export type RoomKind = 'living' | 'kitchen' | 'bedroom' | 'bathroom' | 'office' | 'store' | 'porch'
export type HomeKind = 'apartment' | 'compound' | 'detached' | 'shop'
export type Size = 1 | 2 | 3 | 4
export type LayoutRoom = {id: string; kind: RoomKind; name: string; size: Size; floor: number}
export type Layout = {home: HomeKind; floors: number; rooms: LayoutRoom[]}

export const KIND_NAMES: Record<RoomKind, string> = {living: 'Living room', kitchen: 'Kitchen', bedroom: 'Bedroom', bathroom: 'Bathroom', office: 'Office', store: 'Store room', porch: 'Porch'}
export const HOME_NAMES: Record<HomeKind, string> = {apartment: 'Apartment', compound: 'Compound', detached: 'House', shop: 'Shop + home'}
export const STARTER: Record<HomeKind, [RoomKind, Size][]> = {
  apartment: [['living', 2], ['kitchen', 1], ['bathroom', 1], ['bedroom', 2]],
  compound: [['living', 2], ['kitchen', 1], ['porch', 1], ['bedroom', 1], ['bedroom', 1], ['bathroom', 1]],
  detached: [['living', 2], ['kitchen', 2], ['bedroom', 2], ['office', 1], ['bathroom', 1]],
  shop: [['store', 2], ['office', 1], ['kitchen', 1], ['bedroom', 2], ['bathroom', 1]],
}

export const COLS = 4, MAX_ROWS = 3, MAX_FLOORS = 3, MAX_PER_FLOOR = 10, MAX_ROOMS = 20, NAME_MAX = 16
export const CELL_W = 1.6, CELL_D = 2.3, FLOOR_H = 2.3   // metres in the 3D scene

let next = 0
const newId = () => `room-${Date.now().toString(36)}-${(next++).toString(36)}`

/** "Bedroom", then "Bedroom 2", "Bedroom 3": names stay unique across the whole house, because appliances find their room by name. */
export function uniqueName(base: string, rooms: LayoutRoom[], skip?: string) {
  const taken = new Set(rooms.filter(r => r.id !== skip).map(r => r.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}
export function makeRoom(kind: RoomKind, rooms: LayoutRoom[], floor = 1, size: Size = 1): LayoutRoom {
  return {id: newId(), kind, name: uniqueName(KIND_NAMES[kind], rooms), size, floor}
}
export function starter(home: HomeKind): Layout {
  const rooms: LayoutRoom[] = []
  for (const [kind, size] of STARTER[home]) rooms.push(makeRoom(kind, rooms, 1, size))
  return {home, floors: 1, rooms}
}
/** The original four-room house, so existing setups look the same until the user builds their own. */
export const DEFAULT_LAYOUT: Layout = {home: 'detached', floors: 1, rooms: [
  {id: 'bedroom', kind: 'bedroom', name: 'Bedroom', size: 2, floor: 1}, {id: 'office', kind: 'office', name: 'Office', size: 2, floor: 1},
  {id: 'living', kind: 'living', name: 'Living room', size: 2, floor: 1}, {id: 'kitchen', kind: 'kitchen', name: 'Kitchen', size: 2, floor: 1},
]}

export type Placed = LayoutRoom & {col: number; row: number; x: number; z: number; w: number; d: number; cx: number; cz: number; y: number}
/** Each floor packs on its own: rooms fill a row from the left, and a room that does not fit starts the next row.
 * Every floor shares one footprint (the deepest floor sets it), centred on 0,0. */
export function pack(layout: Pick<Layout, 'rooms' | 'floors'>) {
  const cells: (LayoutRoom & {col: number; row: number})[] = [], rowsOn: number[] = []
  for (let f = 1; f <= layout.floors; f++) {
    let col = 0, row = 0, any = false
    for (const r of layout.rooms.filter(r => r.floor === f)) {
      if (col + r.size > COLS) { col = 0; row++ }
      cells.push({...r, col, row}); col += r.size; any = true
    }
    rowsOn[f] = any ? row + 1 : 0
  }
  const rows = Math.max(1, ...rowsOn.filter(Boolean)), width = COLS * CELL_W, depth = rows * CELL_D
  const placed: Placed[] = cells.map(c => {
    const x = -width / 2 + c.col * CELL_W, z = -depth / 2 + c.row * CELL_D, w = c.size * CELL_W
    return {...c, x, z, w, d: CELL_D, cx: x + w / 2, cz: z + CELL_D / 2, y: (c.floor - 1) * FLOOR_H}
  })
  return {placed, rows, rowsOn, width, depth}
}
/** The house is valid when it has a room, no floor holds more than its limit, and no floor needs more than three rows. */
export function fits(layout: Pick<Layout, 'rooms' | 'floors'>) {
  if (layout.rooms.length < 1 || layout.rooms.length > MAX_ROOMS || layout.floors > MAX_FLOORS) return false
  for (let f = 1; f <= layout.floors; f++) if (layout.rooms.filter(r => r.floor === f).length > MAX_PER_FLOOR) return false
  return pack(layout).rowsOn.every(n => n <= MAX_ROWS)
}
/** Removes an empty floor; the floors above it move down one. */
export function removeFloor(layout: Layout, floor: number): Layout {
  if (layout.floors <= 1 || layout.rooms.some(r => r.floor === floor)) return layout
  return {...layout, floors: layout.floors - 1, rooms: layout.rooms.map(r => r.floor > floor ? {...r, floor: r.floor - 1} : r)}
}
export const floorOf = (layout: Layout, name: string | null | undefined) => layout.rooms.find(r => r.name === name)?.floor ?? 1

/** Older saves have no floors: every room goes on floor 1. */
function upgrade(raw: any): Layout {
  const rooms: LayoutRoom[] = raw.rooms.map((r: any) => ({...r, floor: Number(r.floor) || 1, size: Math.min(4, Math.max(1, Number(r.size) || 1)) as Size}))
  return {home: raw.home || 'detached', floors: Math.min(MAX_FLOORS, Math.max(1, Number(raw.floors) || 1, ...rooms.map(r => r.floor))), rooms}
}
const KEY = 'current-home'
function load(): {layout: Layout; onboarded: boolean} {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (raw?.layout?.rooms?.length) return {layout: upgrade(raw.layout), onboarded: !!raw.onboarded}
  } catch { /* A missing or broken saved home falls back to the default house. */ }
  return {layout: DEFAULT_LAYOUT, onboarded: false}
}
function save(layout: Layout, onboarded: boolean) {
  try { localStorage.setItem(KEY, JSON.stringify({layout, onboarded})) } catch { /* The house still works without browser storage. */ }
}

interface HomeState {layout: Layout; onboarded: boolean; finish: (layout: Layout) => void; replay: () => void}
export const useHome = create<HomeState>((set, get) => ({
  ...load(),
  finish: layout => { save(layout, true); set({layout, onboarded: true}) },
  replay: () => { save(get().layout, false); set({onboarded: false}) },
}))
export const roomNames = (layout: Layout) => layout.rooms.map(r => r.name)
/** The room names of the saved home: floor 1 first, then each floor up, in layout order. */
export function useRoomNames() { const layout = useHome(s => s.layout); return useMemo(() => [...layout.rooms].sort((a, b) => a.floor - b.floor).map(r => r.name), [layout]) }

/** Where each appliance should be after the house changes. Rooms keep their id when renamed, so an appliance
 * follows its room's new name; an appliance whose room was removed moves to the first room left.
 * Example: "Bedroom" renamed "Kids room" -> the fan in "Bedroom" is now in "Kids room". */
export function roomMoves(before: Layout, after: Layout, devices: {id: string; room: string}[]) {
  const oldId = new Map(before.rooms.map(r => [r.name, r.id])), newName = new Map(after.rooms.map(r => [r.id, r.name]))
  const first = after.rooms[0]?.name, names = new Set(after.rooms.map(r => r.name)), moves: {id: string; room: string}[] = []
  for (const d of devices) {
    const id = oldId.get(d.room)
    if (id == null) continue                                  // not a room of this house: leave it
    // renamed -> its new name; gone but a room of the same name exists (a new home type) -> stays; else the first room
    const room = newName.get(id) ?? (names.has(d.room) ? d.room : first)
    if (room && room !== d.room) moves.push({id: d.id, room})
  }
  return moves
}
