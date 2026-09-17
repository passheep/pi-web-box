/** 只在临时窗口和内存数据库验证消息分页，不写用户消息库。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { NoticeStore } = require(root + '/build/notice-store.js');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'box-notice-pages-')));
const wait = ms => new Promise(r => setTimeout(r, ms));
let win, store; const queries = [];
const timer = setTimeout(() => finish(1), 20000);
async function until(fn) { for(let i=0;i<100;i++){if(await fn()) return; await wait(40);} throw Error('等待分页超时'); }
(async () => {
  await app.whenReady();
  store = new NoticeStore(':memory:');
  for(let i=1;i<=75;i++) store.add({eventId:String(i),message:'分页测试消息 ' + i,source:'test'});
  const state = {tabs:[],activeId:'',unread:75,maximized:false,messagePanelOpen:true,maxTabs:6};
  ipcMain.handle('pi-web-box:get-desktop-state', () => state);
  ipcMain.handle('pi-web-box:query-notices', (_event, query) => {queries.push(query); return store.query(query);});
  ipcMain.handle('pi-web-box:mark-notices-read', (_event, seq) => store.markRead(seq));
  win = new BrowserWindow({width:1100,height:700,frame:false,show:true,webPreferences:{preload:root+'/build/preload.js',sandbox:true,contextIsolation:true}});
  await win.loadFile(root+'/build/desktop.html');
  const count = () => win.webContents.executeJavaScript("document.querySelectorAll('#noticeList .notice').length");
  const status = () => win.webContents.executeJavaScript("document.querySelector('#noticeStatus').textContent");
  const bottom = () => win.webContents.executeJavaScript("document.querySelector('#noticeList').scrollTop = document.querySelector('#noticeList').scrollHeight; void 0;");
  await until(async () => await count() === 30); await wait(300);
  assert.equal(queries.length,1); assert.equal(await status(),'');
  console.log('PASS 首次30条，未滚动不预取第二页');
  await bottom(); await until(async () => await count() === 60); await wait(300);
  assert.equal(queries.length,2); assert.equal(queries[1].before,46); assert.equal(await status(),'');
  console.log('PASS 第一次到底60条，游标46');
  await bottom(); await until(async () => await count() === 75); await wait(300);
  assert.equal(queries.length,3); assert.equal(queries[2].before,16); assert.equal(await status(),'没有更早的消息了');
  const texts = await win.webContents.executeJavaScript("[...document.querySelectorAll('#noticeList .notice-text')].map(e=>e.textContent)");
  assert.deepEqual(texts,Array.from({length:75},(_,i)=>'分页测试消息 '+(75-i)));
  await bottom(); await wait(300); assert.equal(queries.length,3);
  console.log('PASS 第二次到底75条，游标16；倒序无遗漏无重复，结束后不再查询');
  const geometry = () => win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#noticeList'), status = document.querySelector('#noticeStatus');
    const a = list.getBoundingClientRect(), b = status.getBoundingClientRect();
    return { inside: status.parentElement === list, last: list.lastElementChild === status, visible: b.top < a.bottom && b.bottom > a.top };
  })()`);
  assert.deepEqual(await geometry(), {inside:true,last:true,visible:true});
  await win.webContents.executeJavaScript("document.querySelector('#noticeList').scrollTop = 0; void 0;");
  await wait(100);
  assert.deepEqual(await geometry(), {inside:true,last:true,visible:false});
  // 重新打开只查询首页，短列表结束提示也跟着内容滚动。
  state.messagePanelOpen = false;
  win.webContents.send('pi-web-box:desktop-state', state); await wait(100);
  store.close(); store = new NoticeStore(':memory:');
  for(let i=1;i<=25;i++) store.add({eventId:String(i),message:'短列表测试 '+i});
  state.messagePanelOpen = true;
  win.webContents.send('pi-web-box:desktop-state', state);
  await until(async () => await count() === 25 && await status() === '没有更早的消息了');
  assert.deepEqual(await geometry(), {inside:true,last:true,visible:false});
  await bottom(); await wait(200);
  assert.deepEqual(await geometry(), {inside:true,last:true,visible:true});
  assert.equal(queries.length,4);
  console.log('PASS 75/25条结束提示随列表滚动，顶部不可见，到底可见，重开正常');
})().then(()=>finish(0),e=>{console.error(e);finish(1);});
function finish(code){clearTimeout(timer);if(win&&!win.isDestroyed())win.destroy();store?.close();app.exit(code);}
