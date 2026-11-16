import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/miniAi.ts',import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {predictIntent} = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('on-device ML classifier infers common Thai/English intent classes', () => {
  assert.equal(predictIntent('เปลี่ยนไฟเป็นสีน้ำเงิน').intent,'SET_RGB');
  assert.equal(predictIntent('ดูค่าเซนเซอร์ล่าสุด').intent,'GET_STATUS');
  assert.equal(predictIntent('รีสตาร์ทบอร์ด').intent,'RESTART');
  assert.equal(predictIntent('change the RGB LED color').intent,'SET_RGB');
});

test('on-device ML classifier handles negative commands without actuating hardware', () => {
  assert.equal(predictIntent('ห้ามเปลี่ยนสี LED').intent,'NO_ACTION');
  assert.equal(predictIntent('do not turn on blue light').intent,'NO_ACTION');
  assert.equal(predictIntent('hi').intent,'UNKNOWN');
});
