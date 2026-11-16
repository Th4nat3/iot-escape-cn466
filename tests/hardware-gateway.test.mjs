import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/hardware-live.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);

function fakeBrowser({ack='valid', wifi='connected', http='valid'} = {}) {
  const els = new Map();
  function element() {
    return {
      textContent:'', className:'', disabled:false, hidden:false, value:'', href:'', children:[], scrollTop:0,
      handlers:{}, get scrollHeight(){return this.children.length;},
      get firstChild(){return this.children[0];},
      appendChild(child){this.children.push(child);},
      removeChild(child){this.children.splice(this.children.indexOf(child),1);},
      addEventListener(event, handler){this.handlers[event] = handler},
      click(){return this.handlers.click?.()},
    };
  }
  const document = {
    getElementById(id) {if(!els.has(id))els.set(id,element());return els.get(id);},
    createElement:element
  };
  const channels = new Set();
  class BroadcastChannel {
    constructor(name){this.name=name;this.listeners=[];channels.add(this);}
    addEventListener(type,cb){if(type==='message')this.listeners.push(cb);}
    postMessage(data){for(const ch of channels){if(ch!==this && ch.name===this.name){
      for(const listener of ch.listeners) queueMicrotask(() => listener({data}));
    }}}
    close(){channels.delete(this)}
  }
  const sent = [];
  let controller;
  const fakePort = {
    readable:null,writable:null,
    async open(){
      this.readable = new ReadableStream({start(c){controller=c}});
      this.writable = new WritableStream({write(bytes){
        const cmd=JSON.parse(new TextDecoder().decode(bytes).trim());
        sent.push(cmd);
        if (cmd.cmd?.startsWith('WIFI_')) {
          const reply = {type:'ACK',id:cmd.id,cmd:cmd.cmd,ok:true};
          controller.enqueue(new TextEncoder().encode(JSON.stringify(reply)+'\n'));
          if (cmd.cmd === 'WIFI_CONNECT') {
            const connected = wifi === 'connected';
            const state = connected ? 'CONNECTED' : 'TIMEOUT';
            const notice = {type:'WIFI_STATUS',connected,state,ssid:connected ? cmd.ssid : null,
              ip:connected ? '192.168.43.15' : null,rssi_dbm:connected ? -47 : null,
              http_port:connected ? 80 : null,mqtt_connected:false};
            controller.enqueue(new TextEncoder().encode(JSON.stringify(notice)+'\n'));
          }
          if (cmd.cmd === 'WIFI_DISCONNECT') {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'WIFI_STATUS',connected:false,
              state:'DISCONNECTED',ssid:null,ip:null,rssi_dbm:null,http_port:null,mqtt_connected:false})+'\n'));
          }
        } else if (cmd.cmd === 'RGB_SET') {
          const reply = {type:'ACK',id:cmd.id,cmd:'RGB_SET',ok:true,
            data:{board:'ESP32-S2',gpio:18,gpio_command_accepted:true,gpio_tested:false}};
          controller.enqueue(new TextEncoder().encode(JSON.stringify(reply)+'\n'));
        } else if (ack !== 'none') {
          const reply = ack==='wrong-id' ? {type:'ACK',id:cmd.id+'xxx',cmd:'PING',ok:true}
            : ack==='rejected' ? {type:'ACK',id:cmd.id,cmd:'PING',ok:false}
            : {type:'ACK',id:cmd.id,cmd:'PING',ok:true,data:{board:'ESP32-S2'}};
          controller.enqueue(new TextEncoder().encode(JSON.stringify(reply)+'\n'));
        }
      }});
    },
    async close(){},
  };
  const context={document, navigator:{serial:{requestPort:async()=>fakePort}},BroadcastChannel,
    TextEncoder,TextDecoder,Date,Promise,Math,JSON,String,Number,Array,Object,Boolean,
    setTimeout,clearTimeout,queueMicrotask,AbortController,fetch:async(url)=>{
      if(http !== 'valid') throw Error('LAN unreachable');
      return {ok:true,json:async()=>({device:'cucumber-r',board:'ESP32-S2',
        wifi_connected:true,ip:'192.168.43.15',uptime_s:120,rssi_dbm:-47})};
    },
    window:{addEventListener(){}}
  };
  vm.runInNewContext(script,context,{filename:'hardware-live.html'});
  const game=new BroadcastChannel('iot-escape-hardware');
  const messages=[];game.addEventListener('message',e=>messages.push(e.data));
  return {els,game,messages,sent,document,BroadcastChannel,emitSerial:(obj)=>controller.enqueue(new TextEncoder().encode(JSON.stringify(obj)+'\n'))};
}
const pause = () => new Promise(resolve=>setTimeout(resolve,35));

for(const ack of ['valid','wrong-id','rejected','none']) {
  test(`USB gateway ACK integration: ${ack}`, async () => {
    const b = fakeBrowser({ack});
    await b.document.getElementById('connect').click();
    const id='pingtest';
    b.game.postMessage({type:'ESP32_COMMAND',source:'IOT_ESCAPE_GAME',cmd:'PING',id,requestId:id,timestamp:Date.now()});
    await pause();
    assert.equal(b.sent.length,1);
    assert.deepEqual(Object.keys(b.sent[0]).sort(),['cmd','id']);
    if(ack==='valid'){
      const result=b.messages.find(m=>m.type==='ESP32_COMMAND_RESULT');
      assert.ok(result, 'expected command result');
      assert.equal(result.requestId,id);
      assert.equal(result.ok,true);
      assert.equal(result.ack.id,id);
      assert.ok(b.document.getElementById('log').children.some(x=>x.textContent.startsWith('RX ACK:')));
    } else if (ack==='rejected') {
      const result=b.messages.find(m=>m.type==='ESP32_COMMAND_RESULT');
      assert.equal(result?.ok,false);
    } else {
      assert.ok(!b.messages.some(m=>m.type==='ESP32_COMMAND_RESULT' && m.ok===true), 'must not invent pass');
    }
    await b.document.getElementById('disconnect').click();
  });
}
test('no device is reported honestly', async()=>{
 const b=fakeBrowser();
 b.game.postMessage({type:'ESP32_COMMAND',source:'IOT_ESCAPE_GAME',cmd:'PING',id:'offline',requestId:'offline',timestamp:Date.now()});
 await pause();
 const result=b.messages.find(m=>m.type==='ESP32_COMMAND_RESULT');
 assert.equal(result?.ok,false);
 assert.equal(b.sent.length,0);
});
test('reject stale or unsupported command, without a port write',async()=>{
 const b=fakeBrowser();
 await b.document.getElementById('connect').click();
 b.game.postMessage({type:'ESP32_COMMAND',source:'IOT_ESCAPE_GAME',cmd:'SET_GPIO',id:'x',requestId:'x',timestamp:Date.now()});
 b.game.postMessage({type:'ESP32_COMMAND',source:'IOT_ESCAPE_GAME',cmd:'PING',id:'x2',requestId:'x2',timestamp:Date.now()-999999});
 await pause();
 assert.equal(b.sent.length,0);
 await b.document.getElementById('disconnect').click();
});
test('test page does not open COM3 itself',()=>{
 const t=fs.readFileSync(new URL('../public/serial-ack-test.html',import.meta.url),'utf8');
 assert.ok(t.includes('BroadcastChannel'));
 assert.ok(!t.includes('navigator.serial.requestPort'));
});
test('M01–M06 and scoring remain in App.tsx',()=>{
 const app=fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 for(let i=1;i<=6;i++)assert.ok(app.includes(`code: 'M0${i}'`));
 assert.ok(app.includes('finished.includes(m.id)'));
 assert.ok(app.includes("'ESP32_COMMAND_RESULT'"));
});


test('standalone ACK test page relays through Hardware Monitor without opening port',async()=>{
 const b = fakeBrowser();
 await b.document.getElementById('connect').click();
 const src = fs.readFileSync(new URL('../public/serial-ack-test.html',import.meta.url),'utf8');
 const js = src.match(/<script>([\s\S]*?)<\/script>/)?.[1];
 assert.ok(js);
 const elements = new Map();
 function element(){return {textContent:'',className:'',disabled:false,handlers:{},
   addEventListener(type,fn){this.handlers[type]=fn},click(){this.handlers.click?.()},scrollTop:0,scrollHeight:0};}
 const doc={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);}};
 const fakeWin={open(){}};
 vm.runInNewContext(js,{document:doc,window:fakeWin,BroadcastChannel:b.BroadcastChannel,
   Date,Math,JSON,Number,String,Object,Boolean,setTimeout,clearTimeout,setInterval:()=>1},
   {filename:'serial-ack-test.html'});
 // Simulate a telemetry packet from the actual monitored Serial connection.
 b.game.postMessage({type:'ESP32_TELEMETRY',source:'ESP32-S2', timestamp:Date.now(),
  payload:{temperature:null,humidity:null,soil_moisture:null,plant_name:'BOARD ONLY - NO SENSOR'}});
 await pause();
 assert.equal(doc.getElementById('ping').disabled,false);
 doc.getElementById('ping').click();
 await pause();
 assert.equal(b.sent.length,1);
 assert.equal(doc.getElementById('ackValue').textContent,'ACK RECEIVED');
 await b.document.getElementById('disconnect').click();
});


test('hotspot provisioning uses one Serial owner, reports connected only from firmware WIFI_STATUS',async()=>{
 const b=fakeBrowser();
 await b.document.getElementById('connect').click();
 b.document.getElementById('wifi-ssid').value='MyPhone';
 b.document.getElementById('wifi-password').value='private-PASS123';
 b.document.getElementById('wifi-connect').click();
 await pause();
 const cmd=b.sent.find(c=>c.cmd==='WIFI_CONNECT');
 assert.equal(cmd.ssid,'MyPhone');
 assert.equal(cmd.password,'private-PASS123');
 assert.equal(b.document.getElementById('wifi-password').value,'');
 assert.equal(b.document.getElementById('wifi-state').textContent,'CONNECTED / IP RECEIVED');
 const status=b.messages.find(m=>m.type==='ESP32_WIFI_STATUS' && m.payload.connected);
 assert.ok(status);
 assert.equal(status.payload.ip,'192.168.43.15');
 const logs=b.document.getElementById('log').children.map(x=>x.textContent).join('\n');
 assert.ok(!logs.includes('private-PASS123'),'password must not leak to UI log');
 assert.ok(!JSON.stringify(b.messages).includes('private-PASS123'),'password must not be broadcast');
 await b.document.getElementById('http-check').click();
 assert.equal(b.document.getElementById('http-state').textContent,'HTTP GET /status PASS');
 assert.ok(b.messages.some(m=>m.type==='ESP32_HTTP_STATUS' && m.ok===true));
 await b.document.getElementById('disconnect').click();
});

test('hotspot timeout does not claim connected or HTTP success',async()=>{
 const b=fakeBrowser({wifi:'timeout'});
 await b.document.getElementById('connect').click();
 b.document.getElementById('wifi-ssid').value='MyPhone';
 b.document.getElementById('wifi-password').value='private-PASS123';
 b.document.getElementById('wifi-connect').click();
 await pause();
 assert.equal(b.document.getElementById('wifi-state').textContent,'TIMEOUT');
 assert.equal(b.document.getElementById('http-check').disabled,true);
 assert.ok(!b.messages.some(m=>m.type==='ESP32_HTTP_STATUS' && m.ok===true));
 await b.document.getElementById('disconnect').click();
});

test('HTTP failure is reported as unverified',async()=>{
 const b=fakeBrowser({http:'failed'});
 await b.document.getElementById('connect').click();
 b.document.getElementById('wifi-ssid').value='MyPhone';
 b.document.getElementById('wifi-password').value='private-PASS123';
 b.document.getElementById('wifi-connect').click();
 await pause();
 await b.document.getElementById('http-check').click();
 assert.equal(b.document.getElementById('http-state').textContent,'HTTP NOT VERIFIED');
 assert.ok(!b.messages.some(m=>m.type==='ESP32_HTTP_STATUS' && m.ok===true));
 await b.document.getElementById('disconnect').click();
});


test('RGB bonus: command is transmitted by sole Serial owner and ACK stays independent of PING', async () => {
  const b = fakeBrowser();
  await b.document.getElementById('connect').click();
  b.document.getElementById('rgb-red').value='0';
  b.document.getElementById('rgb-green').value='180';
  b.document.getElementById('rgb-blue').value='255';
  await b.document.getElementById('rgb-send').click();
  await pause();
  assert.equal(b.sent.length,1);
  assert.equal(b.sent[0].cmd,'RGB_SET');
  assert.equal(b.sent[0].r,0);
  assert.equal(b.sent[0].g,180);
  assert.equal(b.sent[0].b,255);
  assert.match(b.document.getElementById('rgb-state').textContent,/ACK RECEIVED/);
  assert.equal(b.messages.filter(m=>m.type==='ESP32_COMMAND_RESULT').length,0,
    'RGB should not create a fake PING result');
});

test('RGB bonus: invalid channel is rejected without Serial write', async () => {
  const b = fakeBrowser();
  await b.document.getElementById('connect').click();
  b.document.getElementById('rgb-red').value='-1';
  await b.document.getElementById('rgb-send').click();
  await pause();
  assert.equal(b.sent.length,0);
  assert.match(b.document.getElementById('rgb-state').textContent,/INVALID RGB/);
});
