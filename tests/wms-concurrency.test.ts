import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {openDatabase,type SqliteDatabase} from '../src/data/connection';
import {runMigrations} from '../src/data/migrator';
import {migrations} from '../src/data/migrations';
import {item,NOW} from './planning-fixtures';
import {SYSTEM_ACTOR} from '../src/main/audit-writer';
import * as wms from '../src/main/repositories/wms/operations';
import {createDispatch} from '../src/main/repositories/wms/outbound';
import {postMovement} from '../src/main/repositories/ims/stock';
let dir:string,path:string,db:SqliteDatabase,c:wms.WmsContext,warehouse:number,receiving:number,storage:number,packing:number,product:number;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'eyerflow-wms-race-'));path=join(dir,'race.db');db=openDatabase(path);runMigrations(db,migrations);c={db,actor:SYSTEM_ACTOR,nowIso:NOW};product=item(db,'RACE-SKU');warehouse=wms.saveWarehouse(c,{code:'WH',name:'Race warehouse'}).id;receiving=wms.saveBin(c,{warehouseId:warehouse,code:'REC',type:'receiving'});storage=wms.saveBin(c,{warehouseId:warehouse,code:'BIN',type:'storage',capacityMilli:100_000});packing=wms.saveBin(c,{warehouseId:warehouse,code:'PACK',type:'packing'});});
afterEach(()=>{if(db.open)db.close();rmSync(dir,{recursive:true,force:true});});
function race(action:string,input:unknown):Promise<{ok:boolean;result?:number;message?:string}>{return new Promise((resolveResult,reject)=>{const worker=new Worker(resolve('tests/fixtures/wms-race.cjs'),{workerData:{path,now:NOW,action,input}});let result:{ok:boolean;result?:number;message?:string}|undefined;worker.on('message',message=>{result=message;});worker.on('error',reject);worker.on('exit',code=>{if(code!==0||!result)reject(Error(`Warehouse worker exited with ${code}`));else resolveResult(result);});});}
function stock(binId:number,qty:number){const location=wms.snapshot(db,NOW).bins.find(b=>b.id===binId)!.location_id;postMovement(wms.stock(c),{productId:product,locationId:location,quantityMilli:qty,kind:'receipt',movementDate:NOW.slice(0,10)});}
it('two independent SQLite connections replay one receipt without double stock',async()=>{
 const inbound=wms.createInbound(c,{warehouseId:warehouse,reference:'RACE-RECEIPT',lines:[{productId:product,quantityMilli:100_000}]});wms.arriveInbound(c,inbound);const line=wms.snapshot(db,NOW).inbounds[0]!.lines[0]!;
 const input={lineId:line.id,binId:receiving,quantityMilli:70_000,damagedMilli:0,commandKey:randomUUID()};db.close();
 const results=await Promise.all([race('receive',input),race('receive',input)]);expect(results.every(r=>r.ok)).toBe(true);expect(results[0]!.result).toBe(results[1]!.result);
 db=openDatabase(path);expect(db.prepare('SELECT quantity_milli FROM products WHERE id=?').get(product)).toEqual({quantity_milli:70_000});expect(db.prepare('SELECT count(*) n FROM wms_receipts').get()).toEqual({n:1});expect(wms.snapshot(db,NOW).reconciliation).toEqual([]);
},30_000);
it('two independent connections cannot reserve the same last twenty units',async()=>{
 stock(storage,20_000);const requests=[1,2].map(i=>createDispatch(c,{warehouseId:warehouse,reference:`RACE-${i}`,recipient:'Customer',requiredDate:NOW.slice(0,10),commandKey:randomUUID(),lines:[{productId:product,quantityMilli:20_000}]}));db.close();
 const results=await Promise.all(requests.map(id=>race('release',{id,packingBinId:packing})));expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.find(r=>!r.ok)?.message).toMatch(/Insufficient/);
 db=openDatabase(path);expect(db.prepare("SELECT SUM(quantity_milli) qty FROM ims_reservations WHERE status='active'").get()).toEqual({qty:20_000});expect(wms.snapshot(db,NOW).tasks).toHaveLength(1);expect(wms.snapshot(db,NOW).reconciliation).toEqual([]);
},30_000);
it('competing putaways serialize capacity checks and preserve both ledger legs',async()=>{
 stock(storage,50_000);const ids:number[]=[];
 for(let i=0;i<2;i++){const inbound=wms.createInbound(c,{warehouseId:warehouse,reference:`PUT-${i}`,lines:[{productId:product,quantityMilli:40_000}]});wms.arriveInbound(c,inbound);const line=wms.snapshot(db,NOW).inbounds.find(d=>d.id===inbound)!.lines[0]!;wms.receive(c,{lineId:line.id,binId:receiving,quantityMilli:40_000,commandKey:randomUUID()});ids.push(wms.snapshot(db,NOW).tasks[0]!.id);}
 db.close();const results=await Promise.all(ids.map(id=>race('complete',{id,destinationBinId:storage,sourceScan:'REC',destinationScan:'BIN',productScan:'RACE-SKU',quantityMilli:40_000,commandKey:randomUUID()})));expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.find(r=>!r.ok)?.message).toMatch(/capacity/);
 db=openDatabase(path);expect(wms.snapshot(db,NOW).positions.find(p=>p.bin_id===storage)?.quantity_milli).toBe(90_000);expect(db.prepare('SELECT quantity_milli FROM products WHERE id=?').get(product)).toEqual({quantity_milli:130_000});expect(wms.snapshot(db,NOW).reconciliation).toEqual([]);
},30_000);
