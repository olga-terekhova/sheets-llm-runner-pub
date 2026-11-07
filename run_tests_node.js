const fs=require('fs');const vm=require('vm');
// Minimal in-memory imitation of the Sheets API pieces Util_Sheet uses.
class Range{constructor(s,r,c,h,w){Object.assign(this,{s,r,c,h,w});}
 getValues(){const out=[];for(let i=0;i<this.h;i++){const row=[];for(let j=0;j<this.w;j++){const v=(this.s.d[this.r-1+i]||[])[this.c-1+j];row.push(v===undefined?'':v);}out.push(row);}return out;}
 // Like Sheets, a leading apostrophe marks text and is not stored.
 setValues(v){if(v.length!==this.h||v.some(r=>r.length!==this.w))throw new Error('dimension mismatch');v.forEach((row,i)=>{const t=this.s.d[this.r-1+i]=this.s.d[this.r-1+i]||[];row.forEach((x,j)=>t[this.c-1+j]=typeof x==='string'&&x[0]==="'"?x.slice(1):x);});}}
class Sheet{constructor(n){this.n=n;this.d=[];this.maxCols=26;this.maxRows=1000;}
 getName(){return this.n}
 getLastRow(){let l=0;this.d.forEach((r,i)=>{if(r&&r.some(v=>v!==''&&v!==undefined))l=i+1});return l}
 getLastColumn(){let l=0;this.d.forEach(r=>(r||[]).forEach((v,j)=>{if(v!==''&&v!==undefined)l=Math.max(l,j+1)}));return l}
 getRange(r,c,h,w){if(c-1+w>this.maxCols)throw new Error('range beyond max columns');if(r-1+h>this.maxRows)throw new Error('range beyond max rows');return new Range(this,r,c,h,w)}
 getMaxColumns(){return this.maxCols} insertColumnsAfter(a,n){this.maxCols+=n} deleteColumns(a,n){this.maxCols-=n}
 getMaxRows(){return this.maxRows} insertRowsAfter(a,n){this.maxRows+=n} setFrozenRows(){}}
const sheets={};
const ss={getSheetByName:n=>sheets[n]||null,insertSheet:n=>(sheets[n]=new Sheet(n)),deleteSheet:s=>{delete sheets[s.n]}};
const ctx={Logger:{log:s=>console.log(s)},SpreadsheetApp:{getActiveSpreadsheet:()=>ss},console};
vm.createContext(ctx);
for(const f of ['Util_Json.gs','Util_Template.gs','Api.gs','Util_Sheet.gs','Config.gs','Selection.gs','Pipeline.gs','Results.gs','Writeback.gs','Run.gs','Menu.gs','Tests.gs','Tests_Sheet.gs','Tests_Config.gs','Tests_Results.gs','Tests_Selection.gs','Tests_Writeback.gs']) vm.runInContext(fs.readFileSync('library/'+f,'utf8'),ctx,{filename:'library/'+f});
vm.runInContext('runAllTests(); testSheetUtils();',ctx);
// Bound script (bound/Code.gs) against the library: like Apps Script, the library shows only names without a trailing _.
const lib={};for(const k of Object.keys(ctx))if(typeof ctx[k]==='function'&&!k.endsWith('_'))lib[k]=ctx[k];
const items=[];const ui={createMenu:()=>({addItem(l,f){items.push(f);return this},addToUi(){}})};
const bctx={LLMRunner:lib,SpreadsheetApp:{getUi:()=>ui,getActiveSpreadsheet:()=>ss},Logger:ctx.Logger,console};
vm.createContext(bctx);const bsrc=fs.readFileSync('bound/Code.gs','utf8');vm.runInContext(bsrc,bctx,{filename:'bound/Code.gs'});
bctx.onOpen();
const bad=items.filter(f=>typeof bctx[f]!=='function').map(f=>'menu item '+f+' has no wrapper')
 .concat([...bsrc.matchAll(/LLMRunner\.(\w+)/g)].map(m=>m[1]).filter(n=>!lib[n]).map(n=>'LLMRunner.'+n+' is not a public library function'));
console.log('testSheetUtils through the bound script:');bctx.testSheetUtils();
console.log(bad.length?'Bound script: FAIL\n'+bad.join('\n'):'Bound script: PASS ('+items.length+' menu items, '+new Set(bsrc.match(/LLMRunner\.\w+/g)).size+' library calls)');
