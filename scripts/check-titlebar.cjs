/** 标题栏渲染对比：独立窗口和临时数据目录，不连接 Pi Web、不修改用户配置。 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-titlebar-'));
app.setPath('userData', directory);
let window;
const timeout = setTimeout(() => app.exit(1), 15000);
(async () => {
  await app.whenReady();
  window = new BrowserWindow({width:1100,height:220,frame:false,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadFile(path.resolve(__dirname, '../build/desktop.html'));
  await window.webContents.executeJavaScript(`state = {...state, activeId:'1', tabs:[{id:'1',title:'标题栏对齐测试',color:'#7796b5',loading:false,running:false}]};renderTabs();void 0;`);
  const measure = () => window.webContents.executeJavaScript(`(() => {
    const rect = selector => {const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,center:r.top+r.height/2};};
    return {bar:rect('#tabbar'),tab:rect('.tab'),title:rect('.tab-title'),plus:rect('#newTabBtn'),button:rect('#winMax'),icon:rect('#winMax svg'),bodyPadding:getComputedStyle(document.body).paddingTop};
  })()`);
  const old = await window.webContents.insertCSS('#tabbar { padding:4px 0 0 8px !important; } .tab {height:32px !important;} .bar-btn {margin:1px 2px 0 !important;align-self:flex-start !important;} .win-btn {height:36px !important;}');
  await new Promise(resolve=>setTimeout(resolve,200));
  const before = await measure();
  fs.writeFileSync(path.join(directory,'before.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.removeInsertedCSS(old);
  await new Promise(resolve=>setTimeout(resolve,200));
  const after = await measure();
  fs.writeFileSync(path.join(directory,'after.png'), (await window.webContents.capturePage()).toPNG());
  assert.equal(before.button.top,4);
  assert.equal(before.tab.top,7);
  assert.equal(after.button.top,0);
  assert.equal(after.button.height,40);
  assert.equal(after.tab.top,3);
  assert.equal(after.bodyPadding,'0px');
  assert.ok(Math.abs(after.title.center-after.icon.center)<=2);
  console.log(JSON.stringify({directory,before,after},null,2));
})().then(()=>finish(0),error=>{console.error(error);finish(1);});
function finish(code){clearTimeout(timeout);if(window&&!window.isDestroyed())window.destroy();app.exit(code);}
