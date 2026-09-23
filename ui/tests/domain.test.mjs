import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeResult,seconds,timecode,validateAudio} from '../js/domain.js';
import {createDemo} from '../js/demo.js';
import {docxFiles,zip,exportData} from '../js/export.js';
test('missing values and timestamps are never invented',()=>{
 const m=normalizeResult({segments:[{speaker:'A',text:'Подготовить отчёт.'}],tasks:[{title:'Подготовить отчёт',evidence:{quote:'Подготовить отчёт.'}}]});
 assert.equal(m.segments[0].start,null);assert.equal(m.tasks[0].start,null);
 assert.equal(m.tasks[0].assignee,null);assert.equal(m.tasks[0].deadline,null);
 assert.equal(m.tasks[0].sourceId,'seg-1');
});
test('responsible is independent from the speaker',()=>{
 const m=normalizeResult({segments:[{speaker:'Марат',start:92,text:'Данияр, проверь звук.'}],tasks:[{title:'Проверить звук',responsible:'Данияр',evidence:{start:'01:32',quote:'Данияр, проверь звук.'}}]});
 assert.equal(m.tasks[0].assignee,'Данияр');assert.equal(m.tasks[0].sourceId,'seg-1');assert.equal(m.tasks[0].start,92);
});
test('malformed responses rejected rather than shown as success',()=>{
 assert.throws(()=>normalizeResult({tasks:[]}),/segments/);assert.throws(()=>normalizeResult({segments:[{}]}),/text/);
 assert.throws(()=>normalizeResult({segments:[],tasks:{}}),/массивом/);
 assert.throws(()=>normalizeResult({segments:[],tasks:[{title:''}]}),/название/);
});
test('timecode parsing preserves missing and valid long values',()=>{
 assert.equal(seconds(null),null);assert.equal(seconds(''),null);assert.equal(seconds(-1),null);assert.equal(seconds('1:02:03'),3723);
 assert.equal(timecode(3723),'1:02:03');assert.equal(timecode(null),'Нет таймкода');
});
test('upload restrictions follow capabilities',()=>{
 const caps={asr:true,extensions:['wav'],maxBytes:100};
 assert.match(validateAudio({name:'a.mp3',size:4},caps),/WAV/);
 assert.match(validateAudio({name:'a.wav',size:101},caps),/Размер/);
 assert.equal(validateAudio({name:'a.wav',size:100},caps),null);
});
test('DOCX is a real ZIP with OOXML, escaped edits and demo notice',()=>{
 const m=createDemo();m.tasks[0].title='Исправлено <Ә Ғ Қ Ң Ө Ұ Ү Һ І> & результат';m.tasks[0].reviewed=true;
 const files=docxFiles(m),data=zip(files);
 assert.equal(new DataView(data.buffer).getUint32(0,true),0x04034b50);
 assert.ok(files['[Content_Types].xml'].includes('wordprocessingml.document.main'));
 assert.match(files['word/document.xml'],/Исправлено &lt;Ә Ғ Қ Ң Ө Ұ Ү Һ І&gt; &amp; результат/);
 assert.match(files['word/document.xml'],/ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ/);
 assert.match(files['word/document.xml'],/Не указан/);
 assert.match(files['word/document.xml'],/Проверено секретарём/);
});
test('JSON export keeps metadata, actual edits and independent completion',()=>{
 const m=createDemo();m.tasks[0].completed=true;m.speakers[2].name='Данияр';
 const data=exportData(m);assert.equal(data.demo,true);assert.equal(data.tasks[0].completed,true);
 assert.equal(data.tasks[0].reviewed,false);assert.equal(data.speakers[2].name,'Данияр');
 assert.equal(data.segments[0].speaker,'speaker-1');
});

