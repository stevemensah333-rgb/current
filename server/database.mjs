import {DatabaseSync} from 'node:sqlite'
import {createHash,randomBytes} from 'node:crypto'
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs'
import {dirname,join} from 'node:path'
export const hash=v=>createHash('sha256').update(v).digest('hex')
export function openDatabase(filename){
 mkdirSync(dirname(filename),{recursive:true,mode:0o700})
 const db=new DatabaseSync(filename);db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS gateways(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,mode TEXT NOT NULL CHECK(mode IN ('hardware','simulator')));
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,gateway_id TEXT NOT NULL REFERENCES gateways(id),metadata TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS readings(id INTEGER PRIMARY KEY,gateway_id TEXT NOT NULL,device_id TEXT NOT NULL REFERENCES devices(id),message_id TEXT NOT NULL,measured_at TEXT NOT NULL,received_at TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER,UNIQUE(gateway_id,message_id),UNIQUE(device_id,measured_at));
 CREATE UNIQUE INDEX IF NOT EXISTS reading_sequence ON readings(device_id,boot_id,sequence) WHERE sequence IS NOT NULL;
 CREATE INDEX IF NOT EXISTS readings_device_time ON readings(device_id,measured_at);
 CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS simulation(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);`)
 db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?)').run(JSON.stringify({battery:{capacity_kwh:null,reserve_pct:20,efficiency:.9,max_discharge_w:null},rates:{grid:null,generator:null,battery:null},currency:'GHS',stale_after_s:15,max_integration_gap_s:30}))
 db.prepare('INSERT OR IGNORE INTO simulation VALUES(1,?)').run(JSON.stringify({enabled:false,paused:false,scenario:'day',states:{},offline_ids:[],soc:72}))
 return db
}
export function localToken(directory,name){const path=join(directory,name);if(!existsSync(path))writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600});chmodSync(path,0o600);return readFileSync(path,'utf8').trim()}
export function config(db){return JSON.parse(db.prepare('SELECT payload FROM settings WHERE id=1').get().payload)}
export function simulation(db){return JSON.parse(db.prepare('SELECT payload FROM simulation WHERE id=1').get().payload)}
export function allDevices(db){return db.prepare('SELECT metadata FROM devices WHERE active=1 ORDER BY id').all().map(d=>JSON.parse(d.metadata))}
export function putDevice(db,d){db.prepare('INSERT INTO devices(id,gateway_id,metadata) VALUES(?,?,?)').run(d.id,d.gateway_id,JSON.stringify(d))}
