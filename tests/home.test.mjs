import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {roomMoves} from '../src/home/layout.ts'
import {openDatabase} from '../server/database.mjs'
import {createService} from '../server/service.mjs'

const room=(id,name,floor=1)=>({id,kind:'bedroom',name,size:1,floor})
const before={home:'detached',floors:1,rooms:[room('a','Bedroom'),room('b','Kitchen'),room('c','Office')]}

test('appliances follow their room when the house is edited',()=>{
 const devices=[{id:'fan',room:'Bedroom'},{id:'kettle',room:'Kitchen'},{id:'laptop',room:'Office'},{id:'pump',room:'Garden'}]
 const after={...before,rooms:[room('a','Kids room'),room('b','Kitchen')]}           // Bedroom renamed, Office removed
 assert.deepEqual(roomMoves(before,after,devices),[{id:'fan',room:'Kids room'},{id:'laptop',room:'Kids room'}])
 // pump is in a room this house never had: left alone. kettle: same room, same name: no move.
})

test('a new home type keeps appliances in rooms of the same name',()=>{
 const after={home:'apartment',floors:1,rooms:[room('x','Living room'),room('y','Kitchen')]}
 assert.deepEqual(roomMoves(before,after,[{id:'kettle',room:'Kitchen'},{id:'fan',room:'Bedroom'}]),[{id:'fan',room:'Living room'}])
})

test('the backend changes an appliance room and keeps it',()=>{
 const dir=mkdtempSync(join(tmpdir(),'home-')),db=openDatabase(join(dir,'t.sqlite'))
 try{
  const s=createService(db);s.registerGateway({id:'g',name:'G'})
  s.registerDevice({id:'fan',name:'Fan',gateway_id:'g',room:'Bedroom'})
  assert.equal(s.patchDevice('fan',{room:'Kids room'}).room,'Kids room')
  assert.equal(s.snapshot().devices.find(d=>d.id==='fan').room,'Kids room')
  assert.equal(s.patchDevice('fan',{critical:true}).room,'Kids room')                 // other changes keep the room
  assert.throws(()=>s.patchDevice('fan',{room:''}),/room/)
  assert.throws(()=>s.patchDevice('fan',{colour:'red'}),/Unknown field/)
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
