require('tsx/cjs');
const {parentPort,workerData}=require('node:worker_threads');
const {openDatabase}=require('../../src/data/connection');
const operations=require('../../src/main/repositories/wms/operations');
const outbound=require('../../src/main/repositories/wms/outbound');
const db=openDatabase(workerData.path);
try {
 const c={db,actor:{id:null,name:'Concurrent warehouse test'},nowIso:workerData.now};
 let result;
 if(workerData.action==='receive')result=operations.receive(c,workerData.input);
 else if(workerData.action==='release')result=outbound.releaseDispatch(c,workerData.input.id,workerData.input.packingBinId);
 else if(workerData.action==='complete')result=operations.completeTask(c,workerData.input);
 else throw new Error('Unknown test operation.');
 parentPort.postMessage({ok:true,result});
}catch(error){parentPort.postMessage({ok:false,message:error.message});}
finally{db.close();}
