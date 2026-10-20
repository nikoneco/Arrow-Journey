/** Public read-only metadata API. No user saves, tokens, or management IDs. */
function doGet(e) {
  var p = e && e.parameter ? e.parameter : {};
  var callback = p.callback;
  if (callback && !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(callback)) return output_({ok:false,error:'INVALID_CALLBACK'});
  var action = p.action || 'health';
  var data;
  try {
    if (action === 'health') data = {ok:true,app:'Arrow Journey',schemaVersion:1};
    else if (action === 'meta') data = {ok:true,schemaVersion:1,generationMode:'local',distributionVersion:publicVersion_()};
    else if (action === 'difficulties') data = {ok:true,profiles:difficulties_()};
    else data = {ok:false,error:'UNKNOWN_ACTION'};
  } catch (error) { data = {ok:false,error:'UNAVAILABLE'}; }
  return output_(data,callback);
}
function doPost() { return output_({ok:false,error:'READ_ONLY'}); }
function output_(data,callback) {
  var json=JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return ContentService.createTextOutput(callback ? callback+'('+json+');' : json).setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
function publicVersion_() {
  var v=PropertiesService.getScriptProperties().getProperty('DISTRIBUTION_VERSION') || '1';
  return /^[A-Za-z0-9._-]{1,40}$/.test(v) ? v : '1';
}
function difficulties_() {
  var sheetId=PropertiesService.getScriptProperties().getProperty('ARROW_SPREADSHEET_ID');
  if (!sheetId) return [];
  var sheet=SpreadsheetApp.openById(sheetId).getSheetByName('DifficultyProfiles');
  if (!sheet || sheet.getLastRow()<2) return [];
  // Read only a bounded public schema, even if the sheet has internal columns.
  var rows=sheet.getRange(1,1,Math.min(sheet.getLastRow(),101),7).getValues();
  var header=['difficulty','width','height','minLength','maxLength','density','profileVersion'];
  if (!header.every(function(k,i){return rows[0][i]===k;})) throw new Error('SCHEMA');
  return rows.slice(1).filter(function(r){ return ['easy','normal','hard','expert'].indexOf(r[0])>=0 && Number.isInteger(r[1]) && r[1]>=4 && r[1]<=64 && Number.isInteger(r[2]) && r[2]>=4 && r[2]<=64 && Number.isInteger(r[3]) && r[3]>=2 && r[3]<=30 && Number.isInteger(r[4]) && r[4]>=r[3] && r[4]<=30 && typeof r[5]==='number' && r[5]>0 && r[5]<=1 && /^[A-Za-z0-9._-]{1,40}$/.test(String(r[6])); }).map(function(r){return {difficulty:r[0],width:r[1],height:r[2],minLength:r[3],maxLength:r[4],density:r[5],profileVersion:String(r[6])};});
}
