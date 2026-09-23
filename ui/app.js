import {escapeHtml as h, uid, mergeServerMeeting, dateLabel, timecode, reviewNeeded, validateAudio} from './js/domain.js';
import {icon as i} from './js/icons.js';
import {listMeetings, saveMeeting} from './js/storage.js';
import {getCapabilities, getSessions, getResult, getConnection, getDevices, connectMeeting, confirmConnection, disconnectMeeting, stopRecording, submitAudio, transcribeSession} from './js/api.js';
import {downloadDocx, downloadJson, downloadTranscript} from './js/export.js';

const $=selector=>document.querySelector(selector);
const state={meetings:[],view:'meetings',active:null,search:'',caps:{asr:false},connection:null,
  error:'',modal:false,transcriptOpen:false,historyOpen:false,transcriptSearch:'',connecting:false};
let toastTimer,selectedFile,pendingOpen=false,saveQueue=Promise.resolve();
const current=()=>state.meetings.find(m=>m.id===state.active);
const button=(label,action,kind='secondary',ico='',attrs='')=>`<button class="btn ${kind}" data-action="${action}" ${attrs}>${ico?i(ico):''}${label}</button>`;
const badge=(text,kind='neutral')=>`<span class="badge ${kind}">${h(text)}</span>`;
const empty=(title,text)=>`<div class="empty-state">${i('file')}<h3>${h(title)}</h3><p>${h(text)}</p></div>`;
const activeConnection=()=>state.connection && !['finished','error'].includes(state.connection.status);
const labels={recording:'Идёт запись',processing:'Распознаём запись',ready:'Результат готов',awaiting:'Не обработано',partial:'Частичный результат',error:'Ошибка'};
function toast(text){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),5000);}
function persist(m){saveQueue=saveQueue.catch(()=>{}).then(()=>saveMeeting(structuredClone(m))).catch(()=>toast('Правки не сохранились в браузере. Скачайте JSON.'));}
function taskButton(t,m){return `<button class="all-task-row" data-action="edit-task" data-meeting="${h(m.id)}" data-task="${h(t.id)}"><span class="task-indicator ${t.completed?'done':''}">${i(t.completed?'check':'tasks')}</span><span><strong>${h(t.title)}</strong><small>${h(m.title)} · Для: ${h(t.assignee||'исполнитель не указан')}</small></span><span>Срок: ${h(t.deadline||'не указан')}</span>${badge(t.completed?'Выполнено':t.reviewed?'Проверено':'Проверить',t.completed?'green':t.reviewed?'blue':'amber')}${i('chevron')}</button>`;}

function render(){
  if(state.modal)return;
  const existingAudio=$('#meeting-audio');
  const meeting=current();
  $('#app').innerHTML=`<aside class="sidebar"><a class="brand" href="#" data-action="home"><span class="brand-icon">${i('wave')}</span><span>PROTON<small>РАБОЧЕЕ ПРОСТРАНСТВО</small></span></a><div class="workspace-name"><span class="workspace-avatar">rA9</span><div><strong>Команда rA9</strong><span>Совещания и поручения</span></div>${i('lock')}</div><p class="nav-label">ПРОСТРАНСТВО</p><nav aria-label="Главное меню"><button data-action="home" class="nav-item ${state.view!=='tasks'?'active':''}">${i('grid')}Совещания<span class="nav-count">${state.meetings.length}</span></button><button data-action="all-tasks" class="nav-item ${state.view==='tasks'?'active':''}">${i('tasks')}Все поручения</button></nav><div class="sidebar-bottom"><div class="local-status"><span class="status-dot ${state.caps.asr?'green':''}"></span><div><strong>Локальная обработка</strong><span>${state.caps.asr?'Распознавание подключено':'Сервер недоступен'}</span></div></div><div class="sidebar-footer"><span>PROTON</span><span>RU / KZ</span></div></div></aside><div class="main-shell"><header class="topbar"><div class="breadcrumbs">${i('grid')}<button data-action="home">Совещания</button>${state.view==='meeting'?i('chevron')+`<span>${h(meeting?.title||'')}</span>`:''}</div><span class="private-label">${i('shield')}На вашем устройстве</span></header><main id="main" tabindex="-1">${state.error?`<div class="notice warning" role="alert">${h(state.error)}</div>`:''}${connectionCard()}${state.view==='tasks'?renderAllTasks():state.view==='meeting'&&meeting?renderMeeting(meeting):renderHome()}</main><footer class="app-footer"><span>${i('lock')}Аудио и результаты сохраняются локально</span><span>PROTON · Из разговора — в задачи</span></footer></div>`;
  if(existingAudio && meeting && existingAudio.dataset.meeting===meeting.id && $('#meeting-audio'))$('#meeting-audio').replaceWith(existingAudio);
  const transcript=$('#transcript-panel');
  if(transcript)transcript.addEventListener('toggle',()=>{state.transcriptOpen=transcript.open;});
  const history=$('#history-panel');
  if(history)history.addEventListener('toggle',()=>{state.historyOpen=history.open;});
}

function connectionCard(){
  const c=state.connection;
  if(!c || c.status==='finished')return '';
  return `<section class="card connection-banner"><div>${i('link')}<strong>${h(c.platform)} · ${c.status==='recording'?'Подключение активно':'Подключение гостя'}</strong><p>${h(c.error||c.message)}</p></div><div class="connection-actions">${['needs_action','waiting','joining'].includes(c.status)?button('Я уже в звонке','confirm','secondary','check'):''}${c.status!=='error'?button(c.status==='recording'?'Завершить встречу':'Отменить подключение','disconnect','secondary','close'):''}</div></section>`;
}
function renderHome(){
  const meetings=state.meetings.filter(m=>m.title.toLowerCase().includes(state.search.toLowerCase()));
  return `<div class="page-heading"><div><div class="eyebrow">PROTON · РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>Совещания<span class="heading-count">${state.meetings.length}</span></h1><p>Разговор, итоги и поручения в одном месте.</p></div>${button('Новое совещание','new-live','primary','plus')}</div><section class="source-grid"><article class="card source-card"><span class="section-icon blue">${i('link')}</span><h2>Встреча по ссылке</h2><p>Teams, Google Meet или Zoom. Транскрипт пополняется во время разговора, итоги — каждые 5 минут и после завершения.</p>${button('Подключиться к встрече','new-live','primary','link')}</article><article class="card source-card"><span class="section-icon">${i('upload')}</span><h2>Запись разговора</h2><p>Загрузите аудиофайл. PROTON распознает речь и сформирует те же итоги и поручения по времени записи.</p>${button('Загрузить запись','new-upload','secondary','upload')}</article></section><div class="section-toolbar"><div><h2>История совещаний</h2><p>Записи, транскрипты и результаты обработки</p></div><label class="search-field">${i('search')}<input id="meeting-search" value="${h(state.search)}" placeholder="Найти совещание…" aria-label="Поиск совещания"></label></div><section class="card meeting-list">${meetings.length?`<div class="list-head"><span>СОВЕЩАНИЕ</span><span>ДАТА</span><span>СТАТУС</span><span>ПОРУЧЕНИЯ</span><span></span></div>`+meetings.map(m=>`<button class="meeting-row" data-action="open" data-id="${h(m.id)}"><span class="meeting-cell"><span class="file-tile">${i(m.mode==='live'?'link':'audio')}</span><span><strong>${h(m.title)}</strong><small>${h(m.mode==='live'?m.platform||'Созвон':'Аудиофайл')} · ${timecode(m.duration||0)}</small></span></span><span class="row-date">${h(dateLabel(m.date,true))}</span><span>${badge(labels[m.status]||m.status,['recording','processing'].includes(m.status)?'blue':m.status==='error'?'red':'neutral')}</span><span class="row-task-count">${m.tasks.length}</span>${i('chevron')}</button>`).join(''):empty('Совещаний пока нет','Подключитесь к созвону или загрузите запись разговора.')}</section>`;
}
function renderAllTasks(){
  const tasks=state.meetings.flatMap(m=>m.tasks.map(t=>({m,t})));
  return `<div class="page-heading"><div><div class="eyebrow">ДОГОВОРЁННОСТИ</div><h1>Все поручения<span class="heading-count">${tasks.length}</span></h1><p>Для кого, что сделать и к какому сроку. Неуказанные данные остаются пустыми.</p></div></div><section class="card">${tasks.length?tasks.map(({m,t})=>taskButton(t,m)).join(''):empty('Поручений пока нет','Они появятся после первых пяти минут обработанного разговора или при завершении записи.')}</section>`;
}
function renderTranscript(m){
  const q=state.transcriptSearch.toLowerCase();
  const segments=m.segments.filter(s=>s.text.toLowerCase().includes(q));
  return `<details class="card transcript-disclosure" id="transcript-panel" ${state.transcriptOpen?'open':''}><summary>${i('wave')}<strong>Полный транскрипт</strong><span>${m.segments.length} реплик · ${timecode(m.processedSeconds||0)}</span>${i('down')}</summary><div class="transcript-content"><label class="search-field">${i('search')}<input id="transcript-search" value="${h(state.transcriptSearch)}" placeholder="Поиск в разговоре…" aria-label="Поиск в транскрипте"></label><p class="field-hint">Разделение голосов пока не подключено. Имена исполнителей извлекаются из произнесённых поручений.</p><div class="transcript-list">${segments.length?segments.map(s=>`<article class="utterance" id="${h(s.id)}"><span class="avatar color-0">?</span><div class="utterance-body"><div class="utterance-meta"><strong>Говорящий не определён</strong><button class="time-button" data-action="seek" data-time="${s.start||0}">${timecode(s.start)}</button></div><p>${h(s.text)}</p></div></article>`).join(''):empty('Ожидаем речь','Текст появится после обработки первых аудиофрагментов.')}</div></div></details>`;
}
function renderMeeting(m){
  const last=m.snapshots?.at(-1);
  const running=['recording','processing'].includes(m.status);
  const summary=last?.summary;
  const history=(m.snapshots||[]).slice(0,-1);
  return `<div class="meeting-heading"><div><button class="back-link" data-action="home">${i('back')}Все совещания</button><div class="meeting-title-line"><h1>${h(m.title)}</h1></div><div class="meeting-meta"><span>${i('calendar')}${h(dateLabel(m.date))}</span><span>${i('clock')}${timecode(m.duration||0)}</span>${badge(labels[m.status]||m.status,running?'blue':'neutral')}</div></div><div class="heading-actions">${m.status==='recording'?button('Завершить встречу','finish','primary','check'):''}${m.status==='awaiting'?button('Обработать запись','transcribe','primary','wave'):''}${button('Скачать TXT','txt','secondary','download')}${button('Скачать протокол','docx','secondary','file')}</div></div>${m.error?`<div class="notice warning" role="alert">${h(m.error)}</div>`:''}${m.warning?`<div class="notice warning">${h(m.warning)}</div>`:''}${running?`<div class="live-progress"><span class="status-dot green"></span><span>${m.status==='recording'?'Идёт запись':'Обработка записи'} · распознано ${timecode(m.processedSeconds||0)}${m.mode==='audio'?' из '+timecode(m.duration||0):''}</span><span>Следующие итоги: ${timecode((Math.floor((m.processedSeconds||0)/300)+1)*300)}</span></div>`:''}${renderTranscript(m)}<div class="result-layout"><div class="result-main"><section class="card summary-card"><div class="card-heading"><div class="section-title"><span class="section-icon blue">${i('spark')}</span><h2>${m.final?'Итог встречи':'Краткие итоги'}</h2></div>${last?badge(last.kind==='final'?'Финальный результат':'По '+timecode(last.through_seconds),'blue'):''}</div>${summary?`<p class="summary-text">${h(summary.text)}</p>${summary.key_points?.length?'<ul class="key-points">'+summary.key_points.map(p=>'<li>'+h(p)+'</li>').join('')+'</ul>':''}`:'<p class="summary-text">Итоги появятся после пяти минут распознанного разговора или сразу после завершения короткой записи.</p>'}</section><section class="card task-preview"><div class="card-heading"><div class="section-title">${i('tasks')}<h2>Поручения</h2><span class="count-pill">${m.tasks.length}</span></div>${button('Все поручения','all-tasks','text','chevron')}</div>${m.tasks.length?m.tasks.map(t=>taskButton(t,m)).join(''):empty('Поручений пока нет',last?'В обработанной речи модуль не выделил задач.':'Ждём ближайшего обновления итогов.')}</section>${history.length?`<details class="card summary-history" id="history-panel" ${state.historyOpen?'open':''}><summary>Промежуточные итоги · ${history.length}${i('down')}</summary>${history.map(s=>`<article><h3>По ${timecode(s.through_seconds)}</h3><p>${h(s.summary.text)}</p><ul>${(s.summary.key_points||[]).map(p=>'<li>'+h(p)+'</li>').join('')}</ul><p>${s.tasks.length} поручений</p></article>`).join('')}</details>`:''}</div><aside class="result-rail"><section class="card readiness-card"><div class="card-heading"><h2>Запись и файлы</h2>${i('file')}</div>${m.recordingStatus==='completed'?`<audio id="meeting-audio" data-meeting="${h(m.id)}" controls preload="none" src="${h(m.audioUrl)}"></audio><a class="btn secondary" href="${h(m.audioUrl)}" download>Скачать аудио</a>`:'<p>Полная аудиозапись будет доступна после завершения.</p>'}${button('Результаты JSON','json','secondary','download')}<p class="export-note">Проверьте имена и сроки перед использованием поручений.</p>${m.final?`<a class="btn secondary" href="/api/sessions/${m.id}/summary.txt" download>Итоги TXT</a>`:''}</section></aside></div>`;
}

function showModal(title,body){state.modal=true;$('#overlay').innerHTML=`<dialog class="modal wide" aria-labelledby="dialog-title"><div class="modal-heading"><div><span class="eyebrow">PROTON</span><h2 id="dialog-title">${h(title)}</h2></div><button class="icon-btn" data-action="close" aria-label="Закрыть">${i('close')}</button></div>${body}</dialog>`;const dialog=$('dialog');dialog.showModal();dialog.addEventListener('cancel',e=>{e.preventDefault();closeModal();});}
function closeModal(){if($('dialog'))$('dialog').close();$('#overlay').replaceChildren();state.modal=false;render();}
function modalError(text){const el=$('#modal-error');if(el){el.hidden=false;el.textContent=text;}else toast(text);}
const errorSlot=()=>'<p id="modal-error" class="field-error" role="alert" hidden></p>';
async function liveModal(){
  showModal('Подключиться к встрече',`<form id="live-form"><label>Название совещания<input name="title" value="Совещание" maxlength="180" required></label><label>Ссылка Teams, Google Meet или Zoom<input name="url" type="url" placeholder="https://teams.microsoft.com/meet/…" required autofocus></label><label>Устройство звука встречи<select name="device" id="audio-device" required><option value="">Загружаем устройства…</option></select><small>Встреча должна воспроизводить звук через выбранные динамики или наушники.</small></label><label class="checkbox-label"><input name="acknowledged" type="checkbox" required>Участники уведомлены о записи; источник звука выбран</label><p class="field-hint">PROTON откроет гостевое окно. Допуск организатора, проверку аккаунта или CAPTCHA при необходимости нужно пройти в этом окне. После входа запись начнётся автоматически.</p>${errorSlot()}<div class="modal-footer">${button('Отмена','close','secondary','','type="button"')}<button class="btn primary" type="submit">${i('link')}Подключиться</button></div></form>`);
  try {const response=await getDevices();const select=$('#audio-device');if(select)select.innerHTML=response.devices.map(d=>`<option value="${d.id}" ${d.default?'selected':''}>${h(d.name)}</option>`).join('')||'<option value="">Устройства не найдены</option>';}catch(e){modalError(e.message);}
}
function uploadModal(){
  selectedFile=null;
  const extensions=state.caps.extensions||['mp3','wav','m4a','ogg','opus','flac','webm','mp4'];
  showModal('Загрузить запись разговора',`<form id="upload-form"><label>Название совещания<input name="title" value="Запись совещания" maxlength="180" required></label><label class="drop-zone" id="drop-zone"><input id="audio-file" type="file" accept="${extensions.map(e=>'.'+e).join(',')}" required><span class="upload-symbol">${i('upload')}</span><strong>Выберите или перетащите аудиофайл</strong><span>До 200 МБ · ${extensions.join(', ').toUpperCase()}</span></label><p id="selected-file" class="field-hint"></p><p class="field-hint">Обработка идёт по времени записи. Итоги формируются каждые 5 минут аудио и в конце файла.</p>${errorSlot()}<div class="modal-footer">${button('Отмена','close','secondary','','type="button"')}<button class="btn primary" type="submit">${i('wave')}Начать обработку</button></div></form>`);
  const zone=$('#drop-zone');zone.addEventListener('dragover',e=>e.preventDefault());zone.addEventListener('drop',e=>{e.preventDefault();selectFile(e.dataTransfer.files[0]);$('#audio-file').required=false;});
}
function selectFile(file){const error=validateAudio(file,state.caps);if(error){selectedFile=null;modalError(error);return;}selectedFile=file;$('#selected-file').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(1)} МБ`;$('#modal-error').hidden=true;}
function editTask(meetingId,taskId){
  const m=state.meetings.find(m=>m.id===meetingId),task=m?.tasks.find(t=>t.id===taskId);if(!task)return;
  showModal('Поручение',`<form id="task-form" data-meeting="${h(m.id)}" data-task="${h(task.id)}"><label>Суть задачи<textarea name="title" rows="3" maxlength="3000" required>${h(task.title)}</textarea></label><div class="form-grid"><label>Для кого<input name="assignee" value="${h(task.assignee||'')}" placeholder="Не указан" maxlength="180"></label><label>Срок<input name="deadline" value="${h(task.deadline||'')}" placeholder="Не указан" maxlength="180"></label></div>${task.quote?`<blockquote class="edit-source">${h(task.quote)}</blockquote>`:''}<label class="checkbox-label"><input name="reviewed" type="checkbox" ${task.reviewed?'checked':''}>Содержание, исполнитель и срок проверены</label><label class="checkbox-label"><input name="completed" type="checkbox" ${task.completed?'checked':''}>Задача выполнена</label>${errorSlot()}<div class="modal-footer"><span>Правки сохраняются на устройстве</span>${button('Отмена','close','secondary','','type="button"')}<button class="btn primary" type="submit">Сохранить</button></div></form>`);
}
function openMeeting(id){state.active=id;state.view='meeting';state.transcriptOpen=false;state.transcriptSearch='';state.historyOpen=false;render();window.scrollTo(0,0);}

const actions={home:()=>{state.view='meetings';render();},'all-tasks':()=>{state.view='tasks';render();},open:el=>openMeeting(el.dataset.id),
  'new-live':liveModal,'new-upload':uploadModal,close:closeModal,
  confirm:async()=>{await confirmConnection();toast('Подтверждение отправлено. Запускаем запись.');},
  disconnect:async()=>{await disconnectMeeting();await sync();},
  finish:async()=>{if(activeConnection())await disconnectMeeting();else await stopRecording();await sync();},
  transcribe:async()=>{await transcribeSession(current().id);await sync();},
  'edit-task':el=>editTask(el.dataset.meeting,el.dataset.task),
  seek:el=>{const player=$('#meeting-audio');if(player){player.currentTime=Number(el.dataset.time);player.play().catch(()=>toast('Нажмите воспроизведение в плеере.'));}},
  txt:()=>downloadTranscript(current()),docx:()=>downloadDocx(current()),json:()=>downloadJson(current())};
document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(!el||el.disabled)return;e.preventDefault();Promise.resolve().then(()=>actions[el.dataset.action]?.(el)).catch(e=>toast(e.message));});
document.addEventListener('change',e=>{if(e.target.id==='audio-file')selectFile(e.target.files[0]);});
document.addEventListener('input',e=>{
  if(e.target.tagName==='TEXTAREA'){e.target.style.height='auto';e.target.style.height=e.target.scrollHeight+'px';}
  if(['meeting-search','transcript-search'].includes(e.target.id)){const id=e.target.id,position=e.target.selectionStart;state[id==='meeting-search'?'search':'transcriptSearch']=e.target.value;render();const input=$('#'+id);input.focus();input.setSelectionRange(position,position);}
});
document.addEventListener('submit',async e=>{
  const form=e.target;if(!['live-form','upload-form','task-form'].includes(form.id))return;e.preventDefault();
  const submit=form.querySelector('[type="submit"]');submit.disabled=true;
  const data=new FormData(form);
  try {
    if(form.id==='live-form'){
      state.connection=await connectMeeting({url:data.get('url'),title:data.get('title'),device_id:Number(data.get('device')),acknowledged:data.has('acknowledged')});pendingOpen=true;closeModal();
    }else if(form.id==='upload-form'){
      if(!selectedFile)throw new Error('Выберите запись разговора.');
      submit.textContent='Загружаем…';
      const result=await submitAudio(selectedFile,{title:data.get('title'),timezone:'Asia/Qyzylorda',participants:[]},form.dataset.requestId||(form.dataset.requestId=uid()));
      state.active=result.id;state.view='meeting';closeModal();await sync();
    }else{
      const m=state.meetings.find(m=>m.id===form.dataset.meeting);const task=m.tasks.find(t=>t.id===form.dataset.task);
      const edit={title:String(data.get('title')).trim(),assignee:String(data.get('assignee')).trim()||null,deadline:String(data.get('deadline')).trim()||null,reviewed:data.has('reviewed'),completed:data.has('completed')};
      if(!edit.title)throw new Error('Укажите суть задачи.');
      m.taskEdits={...m.taskEdits,[task.id]:edit};Object.assign(task,edit);persist(m);closeModal();
    }
  }catch(error){modalError(error.message);if(submit.isConnected){submit.disabled=false;submit.textContent='Повторить';}}
});

let syncing=false;
async function sync(){
  if(syncing)return;syncing=true;
  try{
    const [list,connection]=await Promise.all([getSessions(),getConnection()]);state.connection=connection.connection;
    const targets=list.sessions.filter(s=>!state.meetings.some(m=>m.id===s.id)||s.id===state.active||state.meetings.some(m=>m.id===s.id&&['processing','recording','awaiting'].includes(m.status)));
    await Promise.all(targets.map(async s=>{
      const raw=await getResult(s.id),previous=state.meetings.find(m=>m.id===s.id),merged=mergeServerMeeting(raw,previous);
      if(!previous||JSON.stringify(merged)!==JSON.stringify(previous)){const index=state.meetings.findIndex(m=>m.id===s.id);if(index<0)state.meetings.unshift(merged);else state.meetings[index]=merged;persist(merged);}
    }));
    state.meetings.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    state.error='';
    if(pendingOpen&&state.connection?.session_id){state.active=state.connection.session_id;state.view='meeting';pendingOpen=false;}
    // Do not replace inputs while the user types or move focus during a dialog.
    if(!state.modal&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))render();
  }catch(error){state.error=error.message;if(!state.modal)render();}finally{syncing=false;}
}
async function init(){
  try{state.meetings=(await listMeetings()).filter(m=>m.mode!=='demo');}catch(e){state.error=e.message;}
  render();
  try{state.caps=await getCapabilities();}catch(e){state.error=e.message;}
  await sync();setInterval(sync,2000);
}
init();
