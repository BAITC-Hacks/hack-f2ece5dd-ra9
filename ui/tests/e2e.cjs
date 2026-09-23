const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 const page=await context.newPage();page.on('dialog',d=>d.accept());
 let posts=0,polls=0,keys=[];const stages=[];
 await page.route('**/api/capabilities',r=>r.fulfill({json:{asr:true,analyzer:true,extensions:['wav'],maxBytes:1000000}}));
 await page.route('**/api/jobs',async r=>{posts++;keys.push(r.request().headers()['idempotency-key']);assert.match(r.request().postData(),/metadata/);await r.fulfill({status:202,json:{id:'stub-job-'+posts}});});
 await page.route('**/api/jobs/*',async r=>{
  polls++;
  if(posts===1)return r.fulfill({json:{status:'failed',error:'Тест: модуль недоступен'}});
  if(polls===2){stages.push('diarization');return r.fulfill({json:{status:'processing',stage:'diarization',progress:63}});}
  return r.fulfill({json:{status:'partial',result:{segments:[{speaker:'voice-1',start:1,end:2,text:'Подготовить документ.'}],summary:'Частичный протокол',tasks:[{title:'Подготовить документ',responsible:null,deadline:null,evidence:{start:1,quote:'Подготовить документ.'}}]}}});
 });
 try{
  await page.goto(process.env.TEST_URL||'http://127.0.0.1:8766');await page.getByRole('button',{name:'Новое совещание',exact:true}).click();
  await page.locator('[name=title]').fill('API adapter test');
  const wav=Buffer.alloc(44+48000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(48000,40);
  await page.locator('#upload-file').setInputFiles({name:'stub.wav',mimeType:'audio/wav',buffer:wav});await page.locator('#upload-submit').click();
  await page.getByRole('heading',{name:'Не удалось завершить обработку'}).waitFor();
  assert.equal(await page.locator('.summary-card').count(),0);
  await page.getByRole('button',{name:'Повторить попытку',exact:true}).click();
  await page.getByRole('heading',{name:'Различение говорящих'}).waitFor();
  assert.equal(await page.locator('.determinate').getAttribute('style'),'width:63%');
  await page.locator('.summary-card').waitFor({timeout:15000});
  assert.match(await page.locator('.notice.warning').innerText(),/частичный/);
  assert.notEqual(keys[0],keys[1]);assert.equal(posts,2);assert.deepEqual(stages,['diarization']);
  await page.getByRole('tab',{name:'Транскрипт 1'}).click();await page.locator('.time-button').click();
  await page.waitForFunction(()=>document.querySelector('#audio-time').textContent.startsWith('00:01'));
  const broken=await browser.newContext();const p=await broken.newPage();p.on('dialog',d=>d.accept());
  await p.addInitScript(()=>{IDBObjectStore.prototype.put=function(){throw new DOMException('Test disk full','QuotaExceededError');};});
  await p.goto(process.env.TEST_URL||'http://127.0.0.1:8766');await p.getByRole('button',{name:'Открыть пример',exact:true}).click();
  await p.locator('[data-save-status]').filter({hasText:'Не сохранено'}).waitFor();
  assert.equal(await p.locator('.summary-card').count(),1);
  await p.locator('#save-error:not([hidden])').waitFor();
  await p.getByRole('tab',{name:'Поручения 4'}).click();assert.equal(await p.locator('.task-card').count(),4);
  await broken.close();
  console.log('PASS: mocked ASR contract, actual server stage/percent, failed job without demo fallback, explicit retry with new key, partial result, audio seek, storage failure retains visible data.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
