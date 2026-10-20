import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
test('GAS only allows bounded public reads and safe JSONP; POST/admin never write',async()=>{
  const code=await readFile(new URL('../gas/Code.gs',import.meta.url),'utf8');let reads=0;
  const context=vm.createContext({ContentService:{MimeType:{JAVASCRIPT:'js',JSON:'json'},createTextOutput:(text)=>({text,setMimeType(mime){this.mime=mime;return this;}})},PropertiesService:{getScriptProperties:()=>({getProperty:(key)=>key==='ARROW_SPREADSHEET_ID'?'not-public':null})},SpreadsheetApp:{openById:()=>{reads++;return {getSheetByName:()=>null};}}});
  vm.runInContext(code,context);
  for(const action of ['init','save','delete','import','admin','unknown'])assert.equal(JSON.parse(context.doGet({parameter:{action}}).text).error,'UNKNOWN_ACTION');
  assert.equal(JSON.parse(context.doPost().text).error,'READ_ONLY');assert.equal(reads,0);
  for(const callback of ['x);alert(1)//','window.callback','x[0]','x'.repeat(65)])assert.equal(JSON.parse(context.doGet({parameter:{callback}}).text).error,'INVALID_CALLBACK');
  const response=context.doGet({parameter:{action:'health',callback:'arrow_callback_1'}});
  assert.ok(response.text.startsWith('arrow_callback_1('));assert.equal(response.mime,'js');
  assert.equal(context.doGet({parameter:{action:'meta'}}).text.includes('not-public'),false);
  assert.equal(JSON.parse(context.doGet({parameter:{action:'difficulties'}}).text).profiles.length,0);assert.equal(reads,1);
});
