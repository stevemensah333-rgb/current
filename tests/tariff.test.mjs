import test from 'node:test'
import assert from 'node:assert/strict'
import {ecgBill,ecgCostForPeriod,ecgKwhForCredit,ecgAveragePrice} from '../shared/calculations.ts'

// Rows copied from the PURC Electricity Tariff Reckoner, effective 1 April 2026 (ECG "Current Tariff" page).
// Residential: kWh, energy, street light, NEL, service, total, refund, net.
const RESIDENTIAL=[
 [0,0,0,0,2.13,2.13,0,2.13],[1,1.97,0.06,0.04,2.13,4.20,1.15,3.05],[2,3.94,0.12,0.08,2.13,6.27,2.31,3.96],[3,5.91,0.18,0.12,2.13,8.34,3.46,4.88],
 [4,7.88,0.24,0.16,2.13,10.41,4.62,5.79],[5,9.84,0.30,0.20,2.13,12.47,5.77,6.70],[10,19.69,0.59,0.39,2.13,22.80,11.55,11.25],
 [20,39.38,1.18,0.79,2.13,43.48,23.10,20.38],[25,49.22,1.48,0.98,2.13,53.81,28.87,24.94],[30,59.06,1.77,1.18,2.13,64.14,34.64,29.50],
 [31,61.03,1.83,1.22,10.73,74.81,0,74.81],[50,98.44,2.95,1.97,10.73,114.09,0,114.09],[100,196.88,5.91,3.94,10.73,217.46,0,217.46],
 [150,295.32,8.86,5.91,10.73,320.82,0,320.82],[200,393.76,11.81,7.88,10.73,424.18,0,424.18],[300,590.64,17.72,11.81,10.73,630.90,0,630.90],
 [301,593.24,17.80,11.86,10.73,633.63,0,633.63],[350,720.72,21.62,14.41,10.73,767.48,0,767.48],[600,1371.09,41.13,27.42,10.73,1450.37,0,1450.37],
 [601,1373.69,41.21,27.47,10.73,1453.10,0,1453.10],[1000,2411.69,72.35,48.23,10.73,2543.00,0,2543.00],[5000,12817.69,384.53,256.35,10.73,13469.30,0,13469.30],
 [10000,25825.19,774.76,516.50,10.73,27127.18,0,27127.18]]
// Non-residential: kWh, energy, street light, NEL, service, NHIL & GETFund, VAT, total.
// Every part matches exactly. The printed non-residential totals are not always the sum of the printed parts
// (300 kWh: parts add to 681.48, printed 681.49; 1000 kWh: 2575.77 vs 2575.76), so totals are checked to 1 pesewa.
const NON_RESIDENTIAL=[
 [0,0,0,0,12.43,0.62,1.86,14.92],[1,1.78,0.05,0.04,12.43,0.71,2.13,17.14],[10,17.78,0.53,0.36,12.43,1.51,4.53,37.14],
 [30,53.33,1.60,1.07,12.43,3.29,9.86,81.58],[100,177.75,5.33,3.56,12.43,9.51,28.53,237.11],[300,533.25,16.00,10.67,12.43,27.28,81.85,681.49],
 [301,535.41,16.06,10.71,12.43,27.39,82.18,684.18],[600,1182.72,35.48,23.65,12.43,59.76,179.27,1493.31],[1000,2048.68,61.46,40.97,12.43,103.06,309.17,2575.76],
 [10000,21532.78,645.98,430.66,12.43,1077.26,3231.78,26930.89]]

test('residential bill matches the reckoner to the pesewa, part by part',()=>{
 for(const [kwh,energy,street,nel,service,total,refund,net] of RESIDENTIAL){
  const b=ecgBill(kwh,'residential')
  assert.deepEqual([b.energy,b.street_light,b.nel,b.service,b.total,b.refund,b.net],[energy,street,nel,service,total,refund,net],`${kwh} kWh`)
 }
})

test('non-residential bill matches the reckoner, with NHIL, GETFund and VAT',()=>{
 for(const [kwh,energy,street,nel,service,nhil,vat,total] of NON_RESIDENTIAL){
  const b=ecgBill(kwh,'non_residential')
  assert.deepEqual([b.energy,b.street_light,b.nel,b.service,b.nhil_getfund,b.vat],[energy,street,nel,service,nhil,vat],`${kwh} kWh parts`)
  assert.ok(Math.abs(b.net-total)<=0.0100001,`${kwh} kWh total ${b.net} vs ${total}`)
 }
})

test('the lifeline edge: 30 kWh costs GHS 29.50, 31 kWh costs GHS 74.81',()=>{
 assert.equal(ecgBill(30).net,29.50);assert.equal(ecgBill(31).net,74.81);assert.equal(ecgBill(30).lifeline,true);assert.equal(ecgBill(31).lifeline,false)
})

test('a period is priced as its monthly equivalent',()=>{
 assert.equal(ecgCostForPeriod(100,30),217.46)                                    // a whole month is the bill itself
 assert.ok(Math.abs(ecgCostForPeriod(50,15)-217.46/2)<1e-9)                        // half a month at the same pace
})

test('kWh for a prepaid credit is the inverse of the period cost',()=>{
 const k=ecgKwhForCredit(100,14)
 assert.ok(ecgCostForPeriod(k,14)<=100+1e-6&&ecgCostForPeriod(k+0.01,14)>100,`${k} kWh`)
 assert.equal(ecgKwhForCredit(0.5,30),0)                                           // less than the service charge buys nothing
 // at the lifeline edge the cheaper side is the most a small credit can buy: GHS 29.50 a month buys exactly 30 kWh
 assert.ok(Math.abs(ecgKwhForCredit(29.50,30)-30)<1e-6)
 assert.ok(ecgKwhForCredit(100,14,'non_residential')<k)                           // VAT and levies: fewer kWh per cedi
})

test('average price with every charge included',()=>{
 assert.ok(Math.abs(ecgAveragePrice(100)-2.1746)<1e-9);assert.equal(ecgAveragePrice(0),null)
})

test('the app prices the home with the ECG tariff by default, or a flat price when chosen',async()=>{
 const {tariffView}=await import('../server/service.mjs')
 const ecg=tariffView({tariff:{scheme:'ecg',category:'residential'},rates:{grid:null}},4000)       // 4 kWh in the last 24 hours
 assert.equal(ecg.day_cost_ghs,ecgCostForPeriod(4,1));assert.ok(Math.abs(ecg.average_price_ghs_per_kwh-ecgAveragePrice(120))<1e-12)
 const flat=tariffView({tariff:{scheme:'flat',category:'residential'},rates:{grid:2}},4000)
 assert.equal(flat.day_cost_ghs,8);assert.equal(flat.average_price_ghs_per_kwh,2)
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {openDatabase}=await import('../server/database.mjs'),{createService}=await import('../server/service.mjs')
 const dir=mkdtempSync(join(tmpdir(),'tariff-')),db=openDatabase(join(dir,'t.sqlite'))
 try{
  const svc=createService(db)
  assert.deepEqual(svc.snapshot().settings.tariff,{scheme:'ecg',category:'residential'})               // the default
  assert.deepEqual(svc.updateSettings({tariff:{category:'non_residential'}}).tariff,{scheme:'ecg',category:'non_residential'})
  assert.throws(()=>svc.updateSettings({tariff:{scheme:'cheap'}}),/scheme/)
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})
