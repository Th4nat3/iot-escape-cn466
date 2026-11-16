import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
function extractFunction(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Cannot find ${name}`);
  return ts.transpileModule(app.slice(start, end), {
    compilerOptions: {target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.None},
  }).outputText;
}
const progressSource = extractFunction('readProgress','interpretCommand');
const parserSource = app.slice(app.indexOf('function interpretCommand('),app.indexOf('function App()'));
const parserJavaScript = ts.transpileModule(parserSource,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
}).outputText;
const missionStart = app.indexOf('  function checkMission() {');
const missionEnd = app.indexOf('\n  function resetProgress()', missionStart);
const missionJavaScript = ts.transpileModule(app.slice(missionStart,missionEnd),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
}).outputText;

function savedProgress(value) {
  const storage = {getItem(){return value}};
  return vm.runInNewContext(`${progressSource}\nreadProgress()`,{localStorage:storage,STORAGE_KEY:"iot-escape-progress-v1",JSON,Number,Array,Set});
}
function parseIntent(s) {
  return vm.runInNewContext(`${parserJavaScript}\ninterpretCommand(${JSON.stringify(s)})`,{String,JSON});
}
function verify(active,answers,finished){
  const context = {
    active,answers,finished:[...finished],correctPipeline:['EDGE NODE','GATEWAY','AI ENGINE','USER INTERFACE'],
    aiResult:parseIntent(answers.aiInstruction ?? ''),
    colorIsValid:[answers.red,answers.green,answers.blue].every(v=>typeof v==='string' && /^(\d{1,3})$/.test(v) && +v<=255),
    JSON,Number,String,Array,
    setFinished(updater){context.finished=updater(context.finished)},
    setFeedback(f){context.feedback=f},feedback:null,
  };
  vm.runInNewContext(`${missionJavaScript}\ncheckMission();`,context);
  return context;
}

test('saved progress is contiguous and ignores corrupt/forged later levels',()=>{
  assert.deepEqual(Array.from(savedProgress('[1,2,3,4,5,6]')),[1,2,3,4,5,6]);
  assert.deepEqual(Array.from(savedProgress('[1,2,2,4,6]')),[1,2]);
  assert.deepEqual(Array.from(savedProgress('[3,4,5]')),[]);
  assert.deepEqual(Array.from(savedProgress('[1,"2",3]')),[1]);
  assert.deepEqual(Array.from(savedProgress('not json')),[]);
  assert.deepEqual(Array.from(savedProgress('{"hacked":true}')),[]);
});

test('missing storage access does not prevent opening the game',()=>{
  const storage={getItem(){throw Error('SecurityError')}};
  const result=vm.runInNewContext(`${progressSource}\nreadProgress()`,{localStorage:storage,STORAGE_KEY:"iot-escape-progress-v1",JSON,Number,Array,Set});
  assert.deepEqual(Array.from(result),[]);
});

test('M02 cannot award points before M01 has passed',()=>{
  const result=verify(2,{statusPin:'GPIO2',rgbPin:'GPIO18',bootPin:'GPIO0'},[]);
  assert.equal(result.feedback?.ok,false);
  assert.deepEqual(result.finished,[]);
});

test('M03 rejects non-finite numeric values and non-object telemetry',()=>{
  const samples=[
    '{"device":"cucumber-r","uptime_s":1e999,"rssi_dbm":-55}',
    '{"device":"cucumber-r","uptime_s":120,"rssi_dbm":-1e999}',
    '[]',
    '{"device":"cucumber-r","uptime_s":-1,"rssi_dbm":-55}',
    '{"device":"cucumber-r","uptime_s":120,"rssi_dbm":55}',
  ];
  for (const telemetry of samples){
    const out=verify(3,{httpMethod:'GET',endpoint:'/status',telemetry},[1,2]);
    assert.equal(out.feedback?.ok,false,telemetry);
    assert.equal(out.finished.includes(3),false);
  }
});

test('M03 accepts a legitimate HTTP schema sample',()=>{
  const out=verify(3,{httpMethod:'GET',endpoint:'/status',telemetry:'{"device":"cucumber-r","uptime_s":120,"rssi_dbm":-55}'},[1,2]);
  assert.equal(out.feedback?.ok,true);
});

test('M04 deterministic parser rejects negated or irrelevant commands',()=>{
  assert.equal(parseIntent('อย่าเปลี่ยนไฟเป็นสีน้ำเงิน'),null);
  assert.equal(parseIntent('ไม่ต้องเปิดไฟสีฟ้า'),null);
  assert.equal(parseIntent('ไม่อยากให้เปิดไฟสีฟ้า'),null);
  assert.equal(parseIntent('ปิดไฟสีน้ำเงิน'),null);
  assert.equal(parseIntent("Don't turn on the blue LED"),null);
  assert.equal(parseIntent("Turn off blue LED"),null);
  assert.equal(parseIntent('เปลี่ยนไฟเป็นสีแดง'),null);
  assert.equal(parseIntent('GET STATUS'),null);
  assert.equal(parseIntent('เปลี่ยนไฟเป็นสีน้ำเงิน')?.intent,'SET_RGB');
  assert.equal(parseIntent('Turn blue LED on')?.intent,'SET_RGB');
});

test('M04 cannot be passed via negative instruction even with SET_RGB selection',()=>{
  const out=verify(4,{aiInstruction:'ห้ามเปิดไฟสีน้ำเงิน',expectedIntent:'SET_RGB'},[1,2,3]);
  assert.equal(out.feedback?.ok,false);
});

test('M05 only accepts the exact target color within 8-bit ranges',()=>{
  assert.equal(verify(5,{red:'0',green:'180',blue:'255'},[1,2,3,4]).feedback?.ok,true);
  assert.equal(verify(5,{red:'0',green:'300',blue:'255'},[1,2,3,4]).feedback?.ok,false);
  assert.equal(verify(5,{red:'0',green:'180.1',blue:'255'},[1,2,3,4]).feedback?.ok,false);
});

test('M06 refuses an incorrect sequence and requires the full previous chain',()=>{
  const correct={accessCode:'175',sequence:['BLUE','GREEN','RED']};
  assert.equal(verify(6,correct,[1,2,3,4]).feedback?.ok,false);
  assert.equal(verify(6,{accessCode:'175',sequence:['GREEN','BLUE','RED']},[1,2,3,4,5]).feedback?.ok,false);
  assert.equal(verify(6,correct,[1,2,3,4,5]).feedback?.ok,true);
});
