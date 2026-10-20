import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
test('GAS only allows bounded public reads and safe JSONP; POST/admin never write',async()=>{
  const code=await readFile(new URL('../gas/Code.gs',import.meta.url),'utf8');let reads=0;
  const context=vm.createContext({ContentService:{MimeType:{JAVASCRIPT:'js',JSON:'json'},createTextOutput:(text)=>({text,setMimeType(mime){this.mime=mime;return this;}})},PropertiesService:{getScriptProperties:()=>({getProperty:(key)=>key==='ARROW_SPREADSHEET_ID'?'not-public':null})},Sheets:{Spreadsheets:{Values:{get:()=>{reads++;return {values:[]};}}}}});
  vm.runInContext(code,context);
  for(const action of ['init','save','delete','import','admin','unknown'])assert.equal(JSON.parse(context.doGet({parameter:{action}}).text).error,'UNKNOWN_ACTION');
  assert.equal(JSON.parse(context.doPost().text).error,'READ_ONLY');assert.equal(reads,0);
  for(const callback of ['x);alert(1)//','window.callback','x[0]','x'.repeat(65)])assert.equal(JSON.parse(context.doGet({parameter:{callback}}).text).error,'INVALID_CALLBACK');
  const response=context.doGet({parameter:{action:'health',callback:'arrow_callback_1'}});
  assert.ok(response.text.startsWith('arrow_callback_1('));assert.equal(response.mime,'js');
  assert.equal(JSON.parse(context.doGet({parameter:{action:'health'}}).text).schemaVersion,2);
  assert.equal(JSON.parse(context.doGet({parameter:{action:'meta'}}).text).schemaVersion,2);
  assert.equal(context.doGet({parameter:{action:'meta'}}).text.includes('not-public'),false);
  assert.equal(JSON.parse(context.doGet({parameter:{action:'difficulties'}}).text).profiles.length,0);assert.equal(reads,1);
});
test('GAS schema2 requires sizes header and parses only canonical ordered CSV sizes',async()=>{
  const code=await readFile(new URL('../gas/Code.gs',import.meta.url),'utf8');
  const header=['difficulty','width','height','minLength','maxLength','density','profileVersion','sizes'];
  let rows=[header,['easy',20,20,2,30,1,'3.0.0','20,24,28,32','private']];
  const context=vm.createContext({ContentService:{MimeType:{JAVASCRIPT:'js',JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},PropertiesService:{getScriptProperties:()=>({getProperty:key=>key==='ARROW_SPREADSHEET_ID'?'private':'3.0.0'})},Sheets:{Spreadsheets:{Values:{get:(_id,range)=>{assert.equal(range,'DifficultyProfiles!A1:H101');return {values:rows};}}}}});
  vm.runInContext(code,context);
  const request=()=>JSON.parse(context.doGet({parameter:{action:'difficulties'}}).text);
  assert.deepEqual(request().profiles[0].sizes,[20,24,28,32]);assert.equal(JSON.stringify(request()).includes('private'),false);
  for(const value of ['20,24,28','20,24,28,28','32,28,24,20','20,24,28,36','20e0,24,28,32','',20242832,null,['20','24','28','32']]) {
    rows[1][7]=value;assert.deepEqual(request().profiles,[]);
  }
  rows[1][7]=' 20, 24, 28, 32 ';assert.deepEqual(request().profiles[0].sizes,[20,24,28,32]);
  rows=[header.slice(0,7),['easy',20,20,2,30,1,'2.0.0']];assert.equal(request().error,'UNAVAILABLE');
});
