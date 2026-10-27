const fs=require('fs');const vm=require('vm');
// Minimal in-memory imitation of the Sheets API pieces Util_Sheet uses.
class Range{constructor(s,r,c,h,w){Object.assign(this,{s,r,c,h,w});}
 getValues(){const out=[];for(let i=0;i<this.h;i++){const row=[];for(let j=0;j<this.w;j++){const v=(this.s.d[this.r-1+i]||[])[this.c-1+j];row.push(v===undefined?'':v);}out.push(row);}return out;}
 setValues(v){if(v.length!==this.h||v.some(r=>r.length!==this.w))throw new Error('dimension mismatch');v.forEach((row,i)=>{const t=this.s.d[this.r-1+i]=this.s.d[this.r-1+i]||[];row.forEach((x,j)=>t[this.c-1+j]=x);});}}
class Sheet{constructor(n){this.n=n;this.d=[];this.maxCols=26;}
 getName(){return this.n}
 getLastRow(){let l=0;this.d.forEach((r,i)=>{if(r&&r.some(v=>v!==''&&v!==undefined))l=i+1});return l}
 getLastColumn(){let l=0;this.d.forEach(r=>(r||[]).forEach((v,j)=>{if(v!==''&&v!==undefined)l=Math.max(l,j+1)}));return l}
 getRange(r,c,h,w){if(c-1+w>this.maxCols)throw new Error('range beyond max columns');return new Range(this,r,c,h,w)}
 getMaxColumns(){return this.maxCols} insertColumnsAfter(a,n){this.maxCols+=n} setFrozenRows(){}}
const sheets={};
const ss={getSheetByName:n=>sheets[n]||null,insertSheet:n=>(sheets[n]=new Sheet(n)),deleteSheet:s=>{delete sheets[s.n]}};
const ctx={Logger:{log:s=>console.log(s)},SpreadsheetApp:{getActiveSpreadsheet:()=>ss},console};
vm.createContext(ctx);
for(const f of ['Util_Json.gs','Util_Template.gs','Api.gs','Util_Sheet.gs','Tests.gs','Tests_Sheet.gs']) vm.runInContext(fs.readFileSync(f,'utf8'),ctx,{filename:f});
vm.runInContext('runAllTests(); testSheetUtils();',ctx);
