const fs = require('node:fs');
const zlib = require('node:zlib');
const source = fs.readFileSync('C:/Users/ST/Downloads/EyerFlow_Complete_Product_Architecture_and_Workflows.pdf').toString('latin1');
function decode85(s) {
  s=s.replace(/\s/g,'').replace(/~>$/,''); const out=[]; let group=[];
  for(const c of s) { if(c==='z' && !group.length){out.push(0,0,0,0);continue;} group.push(c.charCodeAt(0)-33); if(group.length===5){emit(group,4);group=[];} }
  if(group.length){const count=group.length-1;while(group.length<5)group.push(84);emit(group,count);}
  function emit(g,n){let v=g.reduce((a,x)=>a*85+x,0);const b=Buffer.alloc(4);b.writeUInt32BE(v>>>0);out.push(...b.subarray(0,n));}
  return Buffer.from(out);
}
let pages=[];
for(const m of source.matchAll(/\/Filter \[ \/ASCII85Decode \/FlateDecode \] \/Length \d+\s*>>\s*stream\r?\n/g)) {
  const end=source.indexOf('endstream',m.index+m[0].length);
  const content=zlib.inflateSync(decode85(source.slice(m.index+m[0].length,end))).toString('latin1');
  const strings=[...content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map(m=>m[1].replace(/\\([0-7]{3})/g,(_,v)=>String.fromCharCode(parseInt(v,8))).replace(/\\([()\\])/g,'$1'));
  pages.push(strings.join('\n'));
}
fs.writeFileSync('.tmp/wms-spec.txt',pages.map((p,i)=>`\n=== PAGE ${i+1} ===\n${p}`).join('\n'));
console.log(`Extracted ${pages.length} pages to .tmp/wms-spec.txt`);
