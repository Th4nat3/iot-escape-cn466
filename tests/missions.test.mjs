import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual deterministic checkMission function in App.tsx, not a parallel rewrite.
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const start = app.indexOf('  function checkMission() {');
const end = app.indexOf('\n  function resetProgress()', start);
assert.ok(start !== -1 && end > start, 'checkMission must exist in App.tsx');
const checkSource = ts.transpileModule(app.slice(start, end), {
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
}).outputText;
const pointsByMission = [10, 15, 15, 20, 20, 20];
const correctPipeline = ['EDGE NODE', 'GATEWAY', 'AI ENGINE', 'USER INTERFACE'];

function checkMission(active, answers, finished = [], {aiResult = null, colorIsValid = true} = {}) {
  const ctx = {
    active, answers, finished:[...finished], aiResult, colorIsValid, correctPipeline, JSON, Number, String,
    setFinished(update) { ctx.finished = update(ctx.finished); },
    setFeedback(update) { ctx.feedback = update; },
    feedback:null,
  };
  vm.runInNewContext(`${checkSource}\ncheckMission();`, ctx, {filename:'App.tsx:checkMission'});
  return {finished:ctx.finished, feedback:ctx.feedback};
}
const solutions = [
  {pipeline:correctPipeline},
  {statusPin:'GPIO2',rgbPin:'GPIO18',bootPin:'GPIO0'},
  {httpMethod:'GET',endpoint:'/status',telemetry:'{"device":"cucumber-r","uptime_s":120,"rssi_dbm":-55}'},
  {aiInstruction:'เปลี่ยนไฟเป็นสีน้ำเงิน',expectedIntent:'SET_RGB'},
  {red:'0',green:'180',blue:'255'},
  {accessCode:'175',sequence:['BLUE','GREEN','RED']},
];
const incorrect = [
  {pipeline:correctPipeline.slice().reverse()},
  {statusPin:'GPIO18',rgbPin:'GPIO2',bootPin:'GPIO0'},
  {httpMethod:'GET',endpoint:'/status',telemetry:'{"device":"cucumber-r","uptime_s":120,"rssi_dbm":"bad"}'},
  {aiInstruction:'เปลี่ยนไฟเป็นสีน้ำเงิน',expectedIntent:'GET_STATUS'},
  {red:'255',green:'180',blue:'0'},
  {accessCode:'999',sequence:['BLUE','RED','GREEN']},
];
for (let active=1;active<=6;active++) {
  test(`M0${active}: correct answer passes once, wrong answer fails`,()=>{
    const finished=Array.from({length:active-1},(_,i)=>i+1);
    const opts={aiResult:active === 4 ? {intent:'SET_RGB',r:0,g:0,b:255}:null};
    const bad=checkMission(active,incorrect[active-1],finished,opts);
    assert.equal(bad.feedback?.ok,false);
    assert.equal(bad.finished.length, finished.length);
    const good=checkMission(active,solutions[active-1],finished,opts);
    assert.equal(good.feedback?.ok,true);
    assert.equal(good.finished.join(','), [...finished,active].join(','));
    const duplicate=checkMission(active,solutions[active-1],good.finished,opts);
    assert.equal(duplicate.finished.length,good.finished.length,'same mission cannot award points twice');
  });
}

test('M06 stays locked even with correct final token when M01–M05 not all passed',()=>{
 const result=checkMission(6,solutions[5],[1,2,3,4]);
 assert.equal(result.feedback?.ok,false);
 assert.ok(!result.finished.includes(6));
});

test('all six solution rules yield exactly 100 simulated points',()=>{
 let finished=[];
 for(let active=1;active<=6;active++) {
  const result=checkMission(active,solutions[active-1],finished,
    {aiResult:active===4 ? {intent:'SET_RGB',r:0,g:0,b:255}:null});
  assert.equal(result.feedback.ok,true,`M0${active}`);
  finished=result.finished;
 }
 const score=pointsByMission.reduce((sum,points,i)=> sum + (finished.includes(i+1) ? points : 0),0);
 assert.equal(score,100);
 assert.equal(finished.join(','),'1,2,3,4,5,6');
});

test('M03 rejects invalid JSON and M05 rejects invalid RGB range',()=>{
 assert.equal(checkMission(3,{httpMethod:'GET',endpoint:'/status',telemetry:'{'},[1,2]).feedback?.ok,false);
 assert.equal(checkMission(5,solutions[4],[1,2,3,4],{colorIsValid:false}).feedback?.ok,false);
});

test('M01–M06 labels, points, persistence, and simulation distinction remain present',()=>{
 for(let i=1;i<=6;i++) assert.ok(app.includes(`code: 'M0${i}'`));
 for(const amount of [10,15,20])assert.ok(app.includes(`points: ${amount}`));
 assert.ok(app.includes('localStorage.setItem(STORAGE_KEY'));
 assert.ok(app.includes('window.confirm('));
 assert.ok(app.includes('ไม่เพิ่มคะแนนเกม'));
 assert.ok(app.includes('DETERMINISTIC PARSER OUTPUT // NOT A REAL LLM'));
});
