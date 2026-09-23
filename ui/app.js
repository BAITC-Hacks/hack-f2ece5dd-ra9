import {escapeHtml as h,uid,blankMeeting,normalizeResult,dateLabel,timecode,initials,speakerName,reviewNeeded,validateAudio} from './js/domain.js';
import {icon as i} from './js/icons.js';
import {createDemo,demoStages} from './js/demo.js';
import {listMeetings,saveMeeting} from './js/storage.js';
import {getCapabilities,analyzeTranscript,submitAudio,getJob} from './js/api.js';
import {downloadDocx,downloadJson,downloadTranscript} from './js/export.js';
const $=s=>document.querySelector(s);
const state={meetings:[],view:'meetings',active:null,tab:'overview',search:'',transcriptSearch:'',taskFilter:'all',highlight:null,returnTask:null,caps:{asr:false,analyzer:false},saveError:'',saving:0,modal:null};
let toastTimer,saveQueue=Promise.resolve(),audioUrl,audioMeetingId,dialogTrigger,selectedFile,importFile;
const audio=new Audio();audio.preload='metadata';
const stages={upload:'Загрузка записи',transcription:'Распознавание речи',diarization:'Различение говорящих',analysis:'Выделение поручений',protocol:'Подготовка протокола'};
const current=()=>state.meetings.find(m=>m.id===state.active);
const button=(label,action,kind='secondary',ico='',attrs='')=>'<button class="btn '+kind+'" data-action="'+action+'" '+attrs+'>'+(ico?i(ico):'')+label+'</button>';
const badge=(text,kind='neutral')=>'<span class="badge '+kind+'">'+text+'</span>';
const avatar=(name,color=0)=>'<span class="avatar color-'+color+'">'+h(initials(name))+'</span>';
const empty=(title,text,ico='file')=>'<div class="empty-state"><span class="empty-icon">'+i(ico)+'</span><h3>'+title+'</h3><p>'+text+'</p></div>';
const modeLabel=m=>m.mode==='demo'?'Демонстрация':m.mode==='import'?'Импорт транскрипта':'Аудиозапись';
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4500);}
function statusBadge(m){
 if(m.status==='processing')return badge('В обработке','blue');
 if(m.status==='awaiting')return badge('Ожидает подключения','neutral');
 if(m.status==='error')return badge('Ошибка обработки','red');
 if(m.status==='partial')return badge('Частичный результат','amber');
 if(!m.tasks.length)return badge(m.segments.length?'Результат готов':'Пустой результат');
 return m.tasks.some(reviewNeeded)?badge('На проверке','amber'):badge('Проверено','green');
}
function persist(m){
 const snapshot=structuredClone(m);state.saving++;updateSaveStatus();
 saveQueue=saveQueue.catch(()=>{}).then(()=>saveMeeting(snapshot)).then(()=>{state.saveError='';}).catch(e=>{state.saveError=e.message;}).finally(()=>{state.saving--;updateSaveStatus();});
 return saveQueue;
}
function updateSaveStatus(){
 document.querySelectorAll('[data-save-status]').forEach(el=>{el.className='save-status'+(state.saveError?' save-failed':'');el.innerHTML=state.saveError?i('alert')+'Не сохранено · повторить':state.saving?'<span class="spinner tiny"></span> Сохраняем…':i('check')+'Сохранено на устройстве';});
 const banner=$('#save-error');if(banner){banner.hidden=!state.saveError;banner.innerHTML=h(state.saveError)+' '+button('Повторить','retry-save','text')+' '+button('Скачать JSON','json','text');}
}
function shell(){
 const m=current();
 $('#app').innerHTML='<aside class="sidebar"><a class="brand" href="#" data-action="home"><span class="brand-icon">'+i('wave')+'</span><span>протокол<span class="brand-period">.</span><small>РАБОЧЕЕ ПРОСТРАНСТВО</small></span></a>'+
 '<div class="workspace-name"><span class="workspace-avatar">rA9</span><div><strong>Команда rA9</strong><span>HackAlem · локально</span></div>'+i('lock')+'</div><p class="nav-label">ПРОСТРАНСТВО</p><nav aria-label="Главное меню">'+
 '<button data-action="home" class="nav-item '+(state.view!=='tasks'?'active':'')+'">'+i('grid')+'Совещания<span class="nav-count">'+state.meetings.length+'</span></button>'+
 '<button data-action="all-tasks" class="nav-item '+(state.view==='tasks'?'active':'')+'">'+i('tasks')+'Все поручения</button><button data-action="guide" class="nav-item">'+i('play')+'Как показать жюри</button></nav>'+
 '<div class="sidebar-bottom"><div class="local-status"><span class="status-dot '+(state.caps.asr?'green':'')+'"></span><div><strong>Локальное пространство</strong><span>'+(state.caps.asr?'Сервис обработки подключён':'Данные на этом устройстве')+'</span></div></div><button data-action="settings" class="nav-item">'+i('settings')+'Подключение и данные</button><div class="sidebar-footer"><span>ПРОТОКОЛ v2.0</span><span>RU / KZ</span></div></div></aside>'+
 '<div class="main-shell"><header class="topbar"><div class="breadcrumbs">'+i('grid')+'<button data-action="home">'+(state.view==='tasks'?'Все поручения':'Совещания')+'</button>'+(state.view==='meeting'?i('chevron')+'<span>'+h(m?.title||'Совещание')+'</span>':'')+'</div><div class="topbar-right"><span class="private-label">'+i('shield')+'Закрытый контур</span><span class="topbar-divider"></span><span class="profile-avatar">rA9</span></div></header>'+
 '<main id="main" tabindex="-1">'+(state.view==='meeting'?renderMeeting():state.view==='tasks'?renderAllTasks():renderHome())+'</main><footer class="app-footer"><span>'+i('lock')+'Аудио и результаты хранятся на этом устройстве</span><span>Из разговора — в договорённости</span></footer></div>';
 updateSaveStatus();bindAudio();
}
function renderHome(){
 const filtered=state.meetings.filter(m=>m.title.toLocaleLowerCase().includes(state.search.toLocaleLowerCase()));
 return '<div class="page-heading"><div><div class="eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>Совещания<span class="heading-count">'+state.meetings.length+'</span></h1><p>Все решения, поручения и записи — в одном месте.</p></div>'+button('Новое совещание','new','primary','plus')+'</div>'+
 '<section class="welcome-card"><div class="welcome-copy"><span class="mini-label">'+i('spark')+'ГОТОВО К ДЕМОНСТРАЦИИ</span><h2>Встреча закончилась.<br>Договорённости остались.</h2><p>Пройдите весь путь: от записи до протокола.<br>Три участника, два языка и ни одного потерянного поручения.</p><div class="welcome-actions">'+button('Открыть пример','demo-open','primary','play')+button('Показать весь сценарий','demo-run','text','chevron')+'</div><span class="demo-caption">Вымышленные данные · без отправки аудио</span></div><div class="protocol-illustration" aria-hidden="true"><div class="paper-shadow"></div><div class="paper"><div class="paper-brand">'+i('wave')+'ПРОТОКОЛ СОВЕЩАНИЯ<span>01</span></div><div class="paper-title">От слов — к действиям</div><div class="paper-rule"></div><div class="paper-line long"></div><div class="paper-line"></div><div class="paper-task">'+i('check')+'Согласовать план пилота</div><div class="paper-task">'+i('check')+'Распределить поручения</div><div class="paper-task muted">'+i('clock')+'Уточнить сроки</div><div class="paper-bottom"><span class="paper-dot"></span> Всё под контролем</div></div><span class="floating-wave">'+i('wave')+'</span></div></section>'+
 '<div class="section-toolbar"><div><h2>История совещаний</h2><p>Сохраняется в этом браузере</p></div><label class="search-field">'+i('search')+'<input id="meeting-search" placeholder="Найти совещание…" aria-label="Поиск по названию" value="'+h(state.search)+'"><span class="search-key">/</span></label></div>'+
 '<section class="card meeting-list" aria-label="История совещаний">'+(filtered.length?'<div class="list-head"><span>НАЗВАНИЕ СОВЕЩАНИЯ</span><span>ДАТА</span><span>СТАТУС</span><span>ПОРУЧЕНИЯ</span><span></span></div>'+filtered.map(m=>'<button class="meeting-row" data-action="open" data-id="'+m.id+'"><span class="meeting-cell"><span class="file-tile '+(m.mode==='demo'?'blue':'')+'">'+i(m.audioBlob?'audio':'file')+'</span><span><strong>'+h(m.title)+'</strong><small>'+h(modeLabel(m))+' · '+m.speakers.length+' участника</small></span></span><span class="row-date">'+h(dateLabel(m.date,true))+'</span><span>'+statusBadge(m)+'</span><span class="row-task-count">'+(m.status==='awaiting'||m.status==='processing'?'—':i('tasks')+m.tasks.length)+'</span>'+i('chevron')+'</button>').join(''):empty(state.search?'Ничего не найдено':'Ваше первое совещание — здесь',state.search?'Попробуйте другое название.':'Загрузите запись или откройте демонстрационный пример.','audio'))+'</section>'+
 '<div class="home-footnote">'+i('shield')+'Ваши данные остаются у вас.<span>Никаких облачных сервисов, аналитики и внешних шрифтов.</span></div>';
}
function renderAllTasks(){
 const tasks=state.meetings.flatMap(m=>m.tasks.map(t=>({m,t})));
 return '<div class="page-heading"><div><div class="eyebrow">ОТ ДОГОВОРЁННОСТЕЙ К ДЕЙСТВИЯМ</div><h1>Все поручения<span class="heading-count">'+tasks.length+'</span></h1><p>Проверка протокола и выполнение поручения — разные состояния.</p></div></div><section class="card">'+(tasks.length?tasks.map(({m,t})=>'<button class="all-task-row" data-action="open-task" data-id="'+m.id+'" data-task="'+t.id+'"><span class="task-indicator '+(t.completed?'done':'')+'">'+i(t.completed?'check':'tasks')+'</span><span><strong>'+h(t.title)+'</strong><small>'+h(m.title)+' · '+h(t.assignee||'Исполнитель не указан')+'</small></span><span>'+h(t.deadline?dateLabel(t.deadline,true):'Срок не указан')+'</span>'+badge(t.completed?'Выполнено':'Не выполнено',t.completed?'green':'neutral')+i('chevron')+'</button>').join(''):empty('Поручений пока нет','Откройте совещание, чтобы получить и проверить договорённости.','tasks'))+'</section>';
}

function renderMeeting(){
 const m=current();if(!m)return empty('Совещание не найдено','Вернитесь к списку.');
 const count=m.tasks.filter(reviewNeeded).length;
 const body=m.status==='processing'?renderProcessing(m):m.status==='awaiting'?renderAwaiting(m):m.status==='error'?renderError(m):'<div class="result-layout"><div class="result-main"><div class="tabs" role="tablist" aria-label="Результаты совещания">'+[['overview','Итоги','file'],['tasks','Поручения','tasks'],['transcript','Транскрипт','wave']].map(([key,label,ico])=>'<button role="tab" aria-selected="'+(state.tab===key)+'" tabindex="'+(state.tab===key?'0':'-1')+'" id="tab-'+key+'" aria-controls="result-panel" data-action="tab" data-tab="'+key+'" class="tab '+(state.tab===key?'selected':'')+'">'+i(ico)+label+(key==='tasks'?'<span>'+m.tasks.length+'</span>':key==='transcript'?'<span>'+m.segments.length+'</span>':'')+'</button>').join('')+'</div><section id="result-panel" role="tabpanel" aria-labelledby="tab-'+state.tab+'">'+(state.tab==='overview'?renderOverview(m):state.tab==='tasks'?renderTasks(m):renderTranscript(m))+'</section>'+renderPlayer(m)+'</div>'+renderRail(m)+'</div>';
 return '<div class="meeting-heading"><div><button class="back-link" data-action="home">'+i('back')+'Все совещания</button><div class="meeting-title-line"><h1>'+h(m.title)+'</h1><button class="icon-btn" data-action="edit-meta" aria-label="Изменить название и дату">'+i('edit')+'</button></div><div class="meeting-meta"><span>'+i('calendar')+h(dateLabel(m.date))+'</span><span>'+i('clock')+h(m.timezone)+'</span><span>'+i('users')+m.speakers.length+' голоса</span>'+statusBadge(m)+'</div></div><div class="heading-actions"><button class="save-status" data-save-status data-action="retry-save"></button>'+button('Экспорт протокола','export','primary','download',(m.status==='processing'||m.status==='awaiting')?'disabled':'')+'</div></div><div id="save-error" class="notice error" role="alert" hidden></div>'+
 (m.mode==='demo'?'<div class="demo-banner">'+i('info')+'<strong>Демонстрационный пример</strong><span>Реплики и поручения подготовлены заранее. Это не результат распознавания записи.</span></div>':'')+
 (m.status==='partial'?'<div class="notice warning">'+i('alert')+'Получен частичный результат. Проверьте полноту транскрипта перед экспортом.</div>':'')+
 (m.status==='ready'&&count?'<div class="review-banner"><span class="review-icon">'+i('tasks')+'</span><div><strong>Проверим детали, прежде чем отправить протокол</strong><span>'+count+' из '+m.tasks.length+' поручений требуют проверки. Уточните исполнителей и сроки.</span></div>'+button('К поручениям','tab','text','chevron','data-tab="tasks"')+'</div>':'')+body;
}
function renderOverview(m){
 return '<section class="card summary-card"><div class="card-heading"><div class="section-title"><span class="section-icon blue">'+i('spark')+'</span><h2>Краткие итоги</h2></div>'+button('Редактировать','edit-summary','text','edit')+'</div><p class="summary-text">'+h(m.summary||'Саммари пока нет. Добавьте краткие итоги вручную.').replace(/\n/g,'<br>')+'</p>'+
 (m.keyPoints?.length?'<ul class="key-points">'+m.keyPoints.map(x=>'<li>'+h(x)+'</li>').join('')+'</ul>':'')+
 (m.decisions.length?'<div class="section-separator"></div><h3 class="subsection-title">'+i('check')+'Принятые решения</h3><ol class="decision-list">'+m.decisions.map((x,k)=>'<li><span>'+String(k+1).padStart(2,'0')+'</span><p>'+h(x)+'</p></li>').join('')+'</ol>':'')+'</section>'+
 (m.questions.length?'<section class="clarify-card"><span>'+i('help')+'</span><div><h3>Нужно уточнить</h3>'+m.questions.map(q=>'<p>'+h(q)+'</p>').join('')+'</div></section>':'')+
 '<section class="card task-preview"><div class="card-heading"><div class="section-title"><span class="section-icon">'+i('tasks')+'</span><h2>Поручения</h2><span class="count-pill">'+m.tasks.length+'</span></div>'+button('Открыть все','tab','text','chevron','data-tab="tasks"')+'</div>'+
 (m.tasks.length?m.tasks.map((t,k)=>'<button class="preview-row" data-action="task-edit" data-task="'+t.id+'"><span class="task-index">'+String(k+1).padStart(2,'0')+'</span><div><strong>'+h(t.title)+'</strong><span>'+h(t.assignee||'Исполнитель не указан')+'</span></div><span class="deadline '+(!t.deadline?'missing':'')+'">'+i(t.deadline?'calendar':'alert')+h(t.deadline?dateLabel(t.deadline,true):'Уточнить срок')+'</span>'+i('chevron')+'</button>').join(''):empty('Поручения не найдены','Добавьте договорённость вручную в разделе «Поручения».','tasks'))+'</section>';
}
function renderTasks(m){
 const tasks=state.taskFilter==='review'?m.tasks.filter(reviewNeeded):m.tasks;
 return '<div class="tab-toolbar"><div class="segmented"><button data-action="task-filter" data-filter="all" class="'+(state.taskFilter==='all'?'selected':'')+'">Все '+m.tasks.length+'</button><button data-action="task-filter" data-filter="review" class="'+(state.taskFilter==='review'?'selected':'')+'">На проверке '+m.tasks.filter(reviewNeeded).length+'</button></div>'+button('Добавить','task-add','text','plus')+'</div><div class="task-cards">'+
 (tasks.length?tasks.map(t=>'<article class="card task-card" id="'+t.id+'"><div class="task-card-top"><span class="task-index">'+String(m.tasks.indexOf(t)+1).padStart(2,'0')+'</span>'+badge(t.reviewed?'Проверено секретарём':'Нужна проверка',t.reviewed?'green':'amber')+'<button class="icon-btn" data-action="task-edit" data-task="'+t.id+'" aria-label="Редактировать поручение: '+h(t.title)+'">'+i('edit')+'</button></div><h3>'+h(t.title)+'</h3><div class="task-details"><span>'+i('users')+'<span class="'+(!t.assignee?'missing':'')+'">'+h(t.assignee||'Исполнитель не указан')+'</span></span><span>'+i('calendar')+'<span class="'+(!t.deadline?'missing':'')+'">'+h(t.deadline?dateLabel(t.deadline):'Срок не указан')+'</span></span></div>'+
 (t.quote?'<button class="source-quote" data-action="source" data-task="'+t.id+'">'+i('quote')+'<span>'+h(t.quote)+'</span><span class="source-time">'+(t.start===null?'Источник':timecode(t.start))+i('chevron')+'</span></button>':'<p class="field-hint">Добавлено вручную · источник не указан</p>')+
 '<div class="task-card-bottom"><label class="checkbox-label"><input type="checkbox" data-review="'+t.id+'" '+(t.reviewed?'checked':'')+'>Проверено секретарём</label><label class="checkbox-label completion"><input type="checkbox" data-completed="'+t.id+'" '+(t.completed?'checked':'')+'>Выполнено</label></div></article>').join(''):empty(m.tasks.length?'Всё проверено':'Поручений пока нет',m.tasks.length?'Все поручения проверены. Переключитесь на «Все».':'Поручений пока нет. Добавьте первое вручную.','check'))+'</div>';
}
function renderTranscript(m){
 const q=state.transcriptSearch.toLocaleLowerCase(),segments=m.segments.filter(s=>s.text.toLocaleLowerCase().includes(q)||speakerName(m,s.speakerId).toLocaleLowerCase().includes(q));
 return '<div class="tab-toolbar transcript-toolbar"><label class="search-field">'+i('search')+'<input id="transcript-search" value="'+h(state.transcriptSearch)+'" placeholder="Поиск по транскрипту…" aria-label="Поиск по транскрипту"></label><span>'+segments.length+' реплик</span></div>'+
 (state.returnTask?'<div class="source-return">'+i('link')+'Источник выбранного поручения'+button('Назад к поручению','return-task','text','back')+'</div>':'')+
 '<section class="card transcript-list">'+(segments.length?segments.map(s=>{const speaker=m.speakers.find(x=>x.id===s.speakerId);return '<article class="utterance '+(state.highlight===s.id?'highlighted':'')+'" id="'+s.id+'">'+avatar(speakerName(m,s.speakerId),speaker?.color)+'<div class="utterance-body"><div class="utterance-meta"><strong>'+h(speakerName(m,s.speakerId))+'</strong>'+(s.language?'<span class="language">'+h(s.language)+'</span>':'')+'<button class="time-button" data-action="seek" data-segment="'+s.id+'" '+(s.start===null?'disabled':'')+'>'+timecode(s.start)+'</button><button class="icon-btn" data-action="segment-edit" data-segment="'+s.id+'" aria-label="Редактировать реплику">'+i('edit')+'</button></div><p>'+highlightText(s.text,state.transcriptSearch)+'</p></div></article>';}).join(''):empty(q?'Совпадений не найдено':'Транскрипт пуст',q?'Попробуйте другое слово.':'Сервис не вернул реплики. Вы можете импортировать транскрипт.','wave'))+'</section>';
}
function highlightText(text,q){if(!q)return h(text);const idx=text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());return idx<0?h(text):h(text.slice(0,idx))+'<mark>'+h(text.slice(idx,idx+q.length))+'</mark>'+h(text.slice(idx+q.length));}
function renderRail(m){
 const reviewed=m.tasks.filter(t=>t.reviewed).length;
 return '<aside class="result-rail"><section class="card participants-card"><div class="card-heading"><h2>Участники</h2><span class="count-pill">'+m.speakers.length+'</span></div><p class="rail-description">Сопоставьте голоса с именами</p><div class="participants">'+m.speakers.map((s,k)=>'<button class="participant" data-action="speakers">'+avatar(s.name,s.color)+'<span><strong>'+h(s.name)+'</strong><small>Голос '+String(k+1).padStart(2,'0')+'</small></span>'+i('edit')+'</button>').join('')+'</div>'+button('Настроить имена','speakers','secondary','users')+'</section>'+
 '<section class="card readiness-card"><div class="card-heading"><h2>Перед экспортом</h2>'+i('file')+'</div><p class="rail-description">Последний взгляд на детали</p><div class="checklist-item '+(m.segments.length?'checked':'')+'">'+i(m.segments.length?'check':'clock')+'<span>Транскрипт получен</span></div><div class="checklist-item '+(reviewed===m.tasks.length?'checked':'')+'">'+i(reviewed===m.tasks.length?'check':'clock')+'<span>Поручения проверены<small>'+reviewed+' из '+m.tasks.length+'</small></span></div><div class="checklist-item '+(m.tasks.every(t=>t.assignee&&t.deadline)?'checked':'')+'">'+i(m.tasks.every(t=>t.assignee&&t.deadline)?'check':'alert')+'<span>Исполнители и сроки<small>'+(m.tasks.every(t=>t.assignee&&t.deadline)?'Все указаны':'Есть данные для уточнения')+'</small></span></div><div class="rail-divider"></div><p class="export-note">В протокол попадут актуальные исправления.</p>'+button('Скачать DOCX','docx','secondary','download')+'</section><div class="rail-note">'+i('shield')+'<p><strong>Под вашим контролем</strong>Результаты можно исправить. Окончательное решение остаётся за человеком.</p></div></aside>';
}
function renderPlayer(m){
 if(!m.audioBlob)return '<div class="no-audio">'+i('audio')+'<span>'+(m.mode==='demo'?'Текстовый пример · аудиозапись не прилагается':'Аудиозапись не прикреплена · доступен текст транскрипта')+'</span></div>';
 return '<section class="audio-dock" aria-label="Аудиоплеер"><button id="audio-play" class="play-button" data-action="audio-play" aria-label="Воспроизвести запись">'+i(audio.paused?'play':'pause')+'</button><div class="audio-body"><div class="audio-title"><strong>'+h(m.audioName||'Запись совещания')+'</strong><span id="audio-time">00:00 / —</span></div><input id="audio-seek" type="range" min="0" max="100" value="0" step="0.1" aria-label="Позиция воспроизведения"></div><select id="audio-rate" aria-label="Скорость воспроизведения"><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></section><p id="audio-error" class="field-error" role="alert"></p>';
}
function renderProcessing(m){
 const index=demoStages.indexOf(m.stage);
 return '<section class="card processing-card"><div class="processing-symbol">'+i('wave')+'</div><span class="mini-label">'+(m.mode==='demo'?'ДЕМОНСТРАЦИЯ ЭТАПОВ':'ЛОКАЛЬНАЯ ОБРАБОТКА')+'</span><h2>'+(stages[m.stage]||'Обрабатываем совещание')+'</h2><p>'+(m.mode==='demo'?'Показываем сценарий на заранее подготовленных данных.':'Запись обрабатывается в локальном контуре. Можно продолжить работу со списком.')+'</p><div class="process-track"><div class="'+(Number.isFinite(m.progress)?'determinate':'indeterminate')+'" '+(Number.isFinite(m.progress)?'style="width:'+Math.max(0,Math.min(100,m.progress))+'%"':'')+'></div></div><div class="process-steps">'+demoStages.map((s,k)=>'<div class="process-step '+(k===index?'active':k<index?'finished':'')+'"><span>'+(k<index?i('check'):k===index?'<span class="spinner tiny"></span>':k+1)+'</span><div><strong>'+stages[s]+'</strong><small>'+(k<index?'Завершено':k===index?'В процессе':'Ожидает')+'</small></div></div>').join('')+'</div><span class="processing-bottom">'+i('lock')+(m.mode==='demo'?'Аудио не обрабатывается':'Прогресс показывается только по данным сервиса')+'</span></section>';
}
function renderAwaiting(m){return '<section class="card waiting-card"><span class="empty-icon">'+i('audio')+'</span><h2>Запись сохранена на устройстве</h2><p>Подключите локальный модуль распознавания, чтобы получить транскрипт и поручения.</p>'+renderPlayer(m)+'<div class="waiting-actions">'+button('Проверить подключение','reconnect','secondary','refresh')+button('Распознать запись','process-audio','primary','wave',state.caps.asr?'':'disabled')+'</div><p class="field-hint">Пока сервис не подключён, можно открыть демонстрационный пример или импортировать готовый транскрипт.</p></section>';}
function renderError(m){return '<section class="card waiting-card error-state"><span class="empty-icon">'+i('alert')+'</span><h2>Не удалось завершить обработку</h2><p>'+h(m.error||'Сервис временно недоступен.')+'</p><p class="field-hint">Запись сохранена. Повторная попытка использует то же задание.</p>'+button('Повторить попытку','process-audio','primary','refresh')+renderPlayer(m)+'</section>';}

function openMeeting(id,tab='overview'){audio.pause();state.active=id;state.view='meeting';state.tab=tab;state.highlight=null;state.returnTask=null;state.transcriptSearch='';shell();window.scrollTo(0,0);}
function addMeeting(m){state.meetings.unshift(m);persist(m);openMeeting(m.id);}
function bindAudio(){
 const m=current();if(state.view!=='meeting'||!m?.audioBlob){audio.pause();return;}
 if(audioMeetingId!==m.id){audio.pause();if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=URL.createObjectURL(m.audioBlob);audio.src=audioUrl;audioMeetingId=m.id;}
 if($('#audio-rate'))$('#audio-rate').value=String(audio.playbackRate);updateAudio();
}
function updateAudio(){
 if($('#audio-time'))$('#audio-time').textContent=timecode(audio.currentTime)+' / '+(Number.isFinite(audio.duration)?timecode(audio.duration):'—');
 if($('#audio-seek')){$('#audio-seek').max=Number.isFinite(audio.duration)?audio.duration:100;$('#audio-seek').value=audio.currentTime;}
 if($('#audio-play')){$('#audio-play').innerHTML=i(audio.paused?'play':'pause');$('#audio-play').setAttribute('aria-label',audio.paused?'Воспроизвести запись':'Пауза');}
}
['timeupdate','loadedmetadata','play','pause','ended'].forEach(e=>audio.addEventListener(e,updateAudio));
audio.addEventListener('error',()=>{if($('#audio-error'))$('#audio-error').textContent='Браузер не смог воспроизвести запись. Проверьте файл или используйте MP3 / WAV.';});
function showModal(title,body,wide=false){
 dialogTrigger=document.activeElement;state.modal=title;
 $('#overlay').innerHTML='<dialog aria-labelledby="dialog-title" class="modal '+(wide?'wide':'')+'"><div class="modal-heading"><div><span class="eyebrow">ПРОТОКОЛ · РАБОЧЕЕ ПРОСТРАНСТВО</span><h2 id="dialog-title">'+title+'</h2></div><button class="icon-btn" data-action="close" aria-label="Закрыть">'+i('close')+'</button></div>'+body+'</dialog>';
 const dialog=$('dialog');dialog.showModal();dialog.addEventListener('cancel',e=>{e.preventDefault();closeModal();});
}
function closeModal(){const dialog=$('dialog');if(dialog)dialog.close();$('#overlay').replaceChildren();state.modal=null;dialogTrigger?.focus?.();}
function modalError(text){const el=$('#modal-error');if(el){el.textContent=text;el.hidden=false;}else toast(text);}
function errorSlot(){return '<p id="modal-error" class="field-error" role="alert" hidden></p>';}
function newMeetingModal(){
 selectedFile=null;importFile=null;
 showModal('Новое совещание','<form id="new-meeting-form"><div class="form-grid"><label class="full">Название совещания<input name="title" required maxlength="180" placeholder="Например, планирование проекта" autofocus></label><label>Дата совещания<input name="date" type="date" required value="'+new Date().toLocaleDateString('sv-SE')+'"></label><label>Часовой пояс<select name="timezone"><option>Asia/Qyzylorda</option><option>Asia/Almaty</option><option>Europe/Moscow</option><option>UTC</option></select></label><label class="full">Участники<span class="optional">необязательно</span><input name="participants" placeholder="Айдана, Марат, Данияр"><small>Имена через запятую. Голоса сопоставим после обработки.</small></label></div><div class="upload-tabs"><button type="button" class="selected" data-action="upload-mode" data-mode="audio">'+i('audio')+'Аудиозапись</button><button type="button" data-action="upload-mode" data-mode="json">'+i('file')+'Готовый транскрипт JSON</button></div><input type="hidden" name="uploadMode" value="audio"><div id="upload-content"></div>'+errorSlot()+'<div class="local-upload-note">'+i('shield')+'Файлы остаются на устройстве. Обработка — только через настроенный локальный сервис.</div><div class="modal-footer"><span id="upload-submit-hint">'+(state.caps.asr?'Сервис распознавания подключён':'Распознавание пока не подключено')+'</span>'+button('Отмена','close','secondary','','type="button"')+'<button type="submit" class="btn primary" id="upload-submit">'+i('upload')+(state.caps.asr?'Начать обработку':'Сохранить запись')+'</button></div></form>',true);
 renderUploadContent('audio');
}
function renderUploadContent(mode){
 const formats=state.caps.asr?state.caps.extensions:['mp3','wav','m4a','ogg','opus','flac','webm'];
 $('#upload-content').innerHTML='<label class="drop-zone" id="drop-zone"><input id="upload-file" type="file" accept="'+(mode==='audio'?formats.map(x=>'.'+x).join(','):'.json,application/json')+'"><span class="upload-symbol">'+i(mode==='audio'?'upload':'file')+'</span><strong>Перетащите '+(mode==='audio'?'запись':'JSON-файл')+' сюда</strong><span>или <u>выберите файл на компьютере</u></span><small>'+(mode==='audio'?formats.join(' · ').toUpperCase()+' · '+(state.caps.asr?'до '+Math.round(state.caps.maxBytes/1024/1024)+' МБ':'для прослушивания, до 200 МБ'):'segments / transcript + необязательные summary и tasks · до 10 МБ')+'</small></label><div id="selected-file"></div>'+(mode==='json'?'<p class="field-hint">Транскрипт без поручений обработает локальный анализатор команды. Готовые результаты можно импортировать вместе с поручениями.</p>':'');
 const zone=$('#drop-zone');zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragging');});zone.addEventListener('dragleave',()=>zone.classList.remove('dragging'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragging');acceptFile(e.dataTransfer.files[0],mode);});
 $('#upload-file').addEventListener('change',e=>acceptFile(e.target.files[0],mode));showSelectedFile(mode);
}
function acceptFile(file,mode){
 if(!file)return;
 const error=mode==='audio'?validateAudio(file,state.caps):!file.name.toLowerCase().endsWith('.json')?'Выберите файл JSON.':file.size>10*1024*1024?'JSON не должен превышать 10 МБ.':!file.size?'Файл пуст.':null;
 if(error){modalError(error);return;}$('#modal-error').hidden=true;if(mode==='audio')selectedFile=file;else importFile=file;showSelectedFile(mode);
}
function showSelectedFile(mode){const f=mode==='audio'?selectedFile:importFile;$('#selected-file').innerHTML=f?'<div class="selected-file">'+i(mode==='audio'?'audio':'file')+'<div><strong>'+h(f.name)+'</strong><span>'+(f.size/1024/1024).toFixed(2)+' МБ · готов к загрузке</span></div>'+i('check')+'</div>':'';}
async function submitMeeting(form){
 const d=new FormData(form),meta={title:String(d.get('title')).trim(),date:String(d.get('date')),timezone:String(d.get('timezone')),participants:String(d.get('participants')).split(',').map(x=>x.trim()).filter(Boolean)};
 if(!meta.title)return modalError('Укажите название совещания.');
 const mode=d.get('uploadMode'),file=mode==='audio'?selectedFile:importFile;
 if(!file)return modalError('Сначала выберите файл.');
 const submit=$('#upload-submit');submit.disabled=true;submit.innerHTML='<span class="spinner tiny"></span> Обрабатываем…';
 try{
  let m;
  if(mode==='audio')m=blankMeeting({...meta,mode:'real',status:'awaiting',audioBlob:file,audioName:file.name});
  else{
   let payload;try{payload=JSON.parse(await file.text());}catch{throw new Error('Не удалось прочитать JSON. Проверьте формат файла.');}
   const validated=normalizeResult(payload,meta);
   if(payload.tasks===undefined){
    const result=await analyzeTranscript(payload);
    for(const task of result.tasks||[]){const source=validated.segments.find(s=>s.text.includes(task.evidence?.quote||'\u0000'));if(source?.start===null){task.evidence.start=null;task.evidence.end=null;}}
    payload={...payload,...result};
   }
   m=normalizeResult(payload,{...meta,mode:payload.demo?'demo':'import'});
  }
  closeModal();addMeeting(m);
  if(mode==='audio'&&state.caps.asr)processAudio(m);else toast(mode==='audio'?'Запись добавлена. Обработка станет доступна после подключения сервиса.':'Транскрипт импортирован');
 }catch(e){modalError(e.message);if(submit.isConnected){submit.disabled=false;submit.textContent=mode==='json'?'Импортировать':'Сохранить запись';}}
}
async function processAudio(m){
 if(!m?.audioBlob)return;
 m.status='processing';m.stage='upload';m.error=null;persist(m);shell();
 try{if(!m.jobId){const response=await submitAudio(m.audioBlob,{title:m.title,date:m.date,timezone:m.timezone,participants:m.participants},m.requestId||m.id);m.jobId=response.id;await persist(m);}await pollJob(m);}
 catch(e){m.status='error';m.error=e.message;persist(m);if(state.active===m.id)shell();}
}
const pollTokens=new Map();
async function pollJob(m){
 if(pollTokens.has(m.id))return;pollTokens.set(m.id,true);
 try{for(;;){
  const job=await getJob(m.jobId);
  if(job.status==='failed'){m.jobId=null;m.requestId=uid();throw new Error(job.error||'Сервис не смог обработать запись.');}
  if(job.status==='completed'||job.status==='partial'){
   const result=normalizeResult({...job.result,status:job.status==='partial'?'partial':'ready'},{id:m.id,title:m.title,date:m.date,timezone:m.timezone,participants:m.participants,mode:'real',createdAt:m.createdAt,audioBlob:m.audioBlob,audioName:m.audioName});
   Object.assign(m,result);delete m.error;await persist(m);if(state.active===m.id)shell();toast('Протокол готов к проверке');break;
  }
  if(!['queued','processing'].includes(job.status))throw new Error('Сервис вернул неизвестный статус задания.');
  m.stage=demoStages.includes(job.stage)?job.stage:null;m.progress=typeof job.progress==='number'&&Number.isFinite(job.progress)?job.progress:null;
  persist(m);if(state.active===m.id&&state.view==='meeting')shell();await new Promise(r=>setTimeout(r,2000));
 }}finally{pollTokens.delete(m.id);}
}
function runDemo(simulate){
 const m=createDemo();if(!simulate){addMeeting(m);return;}
 m.status='processing';m.stage='upload';addMeeting(m);let step=0;
 const advance=()=>{step++;if(step<demoStages.length){m.stage=demoStages[step];persist(m);if(state.active===m.id)shell();setTimeout(advance,1000);}else{m.status='ready';delete m.stage;persist(m);if(state.active===m.id)shell();toast('Демонстрационный протокол готов');}};
 setTimeout(advance,800);
}
function editTask(id){
 const m=current(),task=m.tasks.find(t=>t.id===id),t=task||{id:uid(),title:'',assignee:null,deadline:null,quote:'',start:null,sourceId:null,reviewed:false,completed:false};
 showModal(task?'Редактировать поручение':'Новое поручение','<form id="task-form"><label>Что нужно сделать<textarea name="title" required maxlength="3000" rows="3">'+h(t.title)+'</textarea></label><div class="form-grid"><label>Ответственный<input name="assignee" list="participant-options" value="'+h(t.assignee||'')+'" placeholder="Не указан" maxlength="180"><datalist id="participant-options">'+[...new Set([...m.participants,...m.speakers.map(s=>s.name)])].map(n=>'<option value="'+h(n)+'">').join('')+'</datalist><small>Исполнитель может отличаться от говорящего.</small></label><label>Срок<input name="deadline" value="'+h(t.deadline||'')+'" placeholder="Не указан · например, 2026-09-25" maxlength="180"><small>Исходная формулировка или конкретная дата.</small></label></div>'+(t.quote?'<blockquote class="edit-source">'+h(t.quote)+'</blockquote>':'')+'<label class="checkbox-label"><input type="checkbox" name="reviewed" '+(t.reviewed?'checked':'')+'>Я проверил содержание, исполнителя и срок</label>'+errorSlot()+'<div class="modal-footer"><span>Изменения сохранятся на устройстве</span>'+button('Отмена','close','secondary','','type="button"')+'<button class="btn primary" type="submit">'+i('check')+'Сохранить</button></div></form>',true);
 $('#task-form').addEventListener('submit',e=>{e.preventDefault();const d=new FormData(e.target);if(!String(d.get('title')).trim())return modalError('Поручение не может быть пустым.');Object.assign(t,{title:String(d.get('title')).trim(),assignee:String(d.get('assignee')).trim()||null,deadline:String(d.get('deadline')).trim()||null,reviewed:d.has('reviewed')});if(!task)m.tasks.push(t);persist(m);closeModal();shell();});
}
function speakerModal(){
 const m=current();showModal('Голоса и участники','<p class="modal-intro">Укажите, кому принадлежит каждый голос. Имена исполнителей в поручениях редактируются отдельно.</p><form id="speakers-form"><div class="speaker-map">'+m.speakers.map((s,k)=>'<label>'+avatar(s.name,s.color)+'<span>Голос '+String(k+1).padStart(2,'0')+'<small>'+m.segments.filter(x=>x.speakerId===s.id).length+' реплик</small></span>'+i('chevron')+'<input name="'+h(s.id)+'" value="'+h(s.name)+'" list="known-participants" required maxlength="120" aria-label="Имя для голоса '+(k+1)+'"></label>').join('')+'</div><datalist id="known-participants">'+m.participants.map(x=>'<option value="'+h(x)+'">').join('')+'</datalist><p class="field-hint">Диаризация различает голоса, но не устанавливает имена людей.</p>'+errorSlot()+'<div class="modal-footer">'+button('Отмена','close','secondary','','type="button"')+'<button class="btn primary" type="submit">'+i('check')+'Сохранить имена</button></div></form>',true);
 $('#speakers-form').addEventListener('submit',e=>{e.preventDefault();const d=new FormData(e.target);if(m.speakers.some(s=>!String(d.get(s.id)).trim()))return modalError('Укажите имя или оставьте метку участника.');for(const s of m.speakers)s.name=String(d.get(s.id)).trim();persist(m);closeModal();shell();toast('Имена обновлены. Проверьте исполнителей поручений отдельно.');});
}
function textEditor(kind,id){
 const m=current(),segment=m.segments.find(s=>s.id===id),summary=kind==='summary';
 showModal(summary?'Редактировать итоги':'Редактировать реплику','<form id="text-form"><label>'+(summary?'Краткие итоги':'Текст реплики')+'<textarea name="text" rows="7" maxlength="30000">'+h(summary?m.summary:segment.text)+'</textarea></label>'+(summary?'<label>Принятые решения<small>Каждое решение — с новой строки.</small><textarea name="decisions" rows="4">'+h(m.decisions.join('\n'))+'</textarea></label><label>Вопросы для уточнения<small>Каждый вопрос — с новой строки.</small><textarea name="questions" rows="3">'+h(m.questions.join('\n'))+'</textarea></label>':'<p class="field-hint">Связанные поручения потребуют повторной проверки. Исходные цитаты сохранятся.</p>')+'<div class="modal-footer">'+button('Отмена','close','secondary','','type="button"')+'<button class="btn primary" type="submit">Сохранить</button></div></form>',true);
 $('#text-form').addEventListener('submit',e=>{e.preventDefault();const d=new FormData(e.target);if(summary){m.summary=String(d.get('text'));m.decisions=String(d.get('decisions')).split('\n').map(x=>x.trim()).filter(Boolean);m.questions=String(d.get('questions')).split('\n').map(x=>x.trim()).filter(Boolean);}else{segment.text=String(d.get('text'));m.tasks.filter(t=>t.sourceId===segment.id).forEach(t=>t.reviewed=false);}persist(m);closeModal();shell();});
}
function editMeta(){
 const m=current();showModal('Данные совещания','<form id="meta-form"><label>Название<input name="title" required maxlength="180" value="'+h(m.title)+'"></label><label>Дата<input name="date" type="date" required value="'+h(m.date)+'"></label><label>Участники через запятую<input name="participants" value="'+h(m.participants.join(', '))+'"></label><p class="field-hint">Изменение даты не пересчитывает автоматически сроки поручений.</p>'+errorSlot()+'<div class="modal-footer">'+button('Отмена','close','secondary','','type="button"')+'<button class="btn primary" type="submit">Сохранить</button></div></form>');
 $('#meta-form').addEventListener('submit',e=>{e.preventDefault();const d=new FormData(e.target);if(!String(d.get('title')).trim())return modalError('Укажите название.');m.title=String(d.get('title')).trim();m.date=String(d.get('date'));m.participants=String(d.get('participants')).split(',').map(x=>x.trim()).filter(Boolean);persist(m);closeModal();shell();});
}

function exportModal(){
 const m=current();showModal('Экспорт протокола','<p class="modal-intro">Скачайте актуальную версию с вашими исправлениями.</p>'+(m.tasks.some(reviewNeeded)?'<div class="notice warning">'+i('alert')+'Есть непроверенные поручения или незаполненные поля. Они будут отмечены в документе.</div>':'')+'<div class="export-options"><button data-action="docx"><span class="export-type">W</span><span><strong>Протокол совещания</strong><small>DOCX · итоги, участники и таблица поручений</small></span>'+i('download')+'</button><button data-action="txt"><span class="export-type gray">T</span><span><strong>Полный транскрипт</strong><small>TXT · реплики, имена и таймкоды</small></span>'+i('download')+'</button><button data-action="json"><span class="export-type gray">{ }</span><span><strong>Все результаты</strong><small>JSON · резервная копия данных без аудио</small></span>'+i('download')+'</button></div><p class="field-hint">Файлы создаются на этом устройстве. Демонстрационные данные отмечаются внутри документа.</p>');
}
function guideModal(){
 showModal('Сценарий для жюри','<p class="modal-intro">Пять шагов от разговора до проверенного поручения.</p><ol class="guide-list">'+[
 ['Начните с записи','Нажмите «Новое совещание». Покажите загрузку файла, дату и участников.'],
 ['Покажите обработку','Запустите демонстрационный сценарий. Этапы помечены как имитация. Реальные этапы поступят от подключённого сервиса.'],
 ['Назовите участников','Откройте «Настроить имена» и сопоставьте «Участник 3» с Данияром.'],
 ['Проверьте договорённости','Откройте источник поручения без срока, вернитесь и внесите исправления.'],
 ['Скачайте протокол','Отметьте проверенные поручения и скачайте DOCX. Покажите, что правки попали в файл.']
 ].map(([a,b],k)=>'<li><span>'+String(k+1).padStart(2,'0')+'</span><div><h3>'+a+'</h3><p>'+b+'</p></div></li>').join('')+'</ol><div class="modal-footer">'+button('Запустить демонстрацию','guide-demo','primary','play')+'</div>',true);
}
function settingsModal(){
 showModal('Подключение и данные','<div class="connection-card">'+i(state.caps.asr?'check':'info')+'<div><h3>'+(state.caps.asr?'Распознавание подключено':'Распознавание ожидает подключения')+'</h3><p>'+(state.caps.error?h(state.caps.error):'Путь к модулю можно добавить позже. Загрузка и опрос заданий уже предусмотрены.')+'</p></div></div><dl class="settings-list"><div><dt>Анализ готового текста</dt><dd>'+(state.caps.analyzer?'Локальный анализатор команды':'Недоступен')+'</dd></div><div><dt>Хранение</dt><dd>IndexedDB · текущий браузер</dd></div><div><dt>Экспорт</dt><dd>DOCX / TXT / JSON · локально</dd></div><div><dt>Внешние сервисы</dt><dd>Не используются</dd></div></dl><p class="field-hint">Для разработчика: адрес сервиса задаётся в LOCAL_ASR_URL перед запуском. Контракт — в docs/API.md. Аудио отправляется только при запуске обработки.</p><p class="field-hint">История привязана к браузеру и адресу приложения. Очистка данных браузера удаляет записи. Сохраняйте резервные копии JSON.</p><div class="modal-footer">'+button('Проверить соединение','reconnect','primary','refresh')+'</div>',true);
}
async function reconnect(){
 try{state.caps=await getCapabilities();}catch(e){state.caps={asr:false,analyzer:false,error:e.message};}
 if(state.modal==='Подключение и данные'){closeModal();settingsModal();}else if(!state.modal)shell();
}
const actions={
 home:()=>{audio.pause();state.view='meetings';state.search='';shell();},
 'all-tasks':()=>{audio.pause();state.view='tasks';shell();},
 new:newMeetingModal,open:el=>openMeeting(el.dataset.id),
 'open-task':el=>{openMeeting(el.dataset.id,'tasks');document.getElementById(el.dataset.task)?.scrollIntoView({block:'center'});},
 'demo-open':()=>runDemo(false),'demo-run':()=>runDemo(true),'guide-demo':()=>{closeModal();runDemo(true);},
 tab:el=>{state.tab=el.dataset.tab;shell();$('#tab-'+state.tab)?.focus();},
 'task-filter':el=>{state.taskFilter=el.dataset.filter;shell();},
 'task-edit':el=>editTask(el.dataset.task),'task-add':()=>editTask(null),
 source:el=>{const t=current().tasks.find(t=>t.id===el.dataset.task);if(!t.sourceId){toast('Исходная реплика отсутствует в транскрипте. Цитата сохранена.');return;}state.returnTask=t.id;state.highlight=t.sourceId;state.tab='transcript';state.transcriptSearch='';shell();document.getElementById(t.sourceId)?.scrollIntoView({block:'center',behavior:'smooth'});},
 'return-task':()=>{const id=state.returnTask;state.tab='tasks';state.taskFilter='all';shell();document.getElementById(id)?.scrollIntoView({block:'center'});},
 seek:el=>{const s=current().segments.find(s=>s.id===el.dataset.segment);state.highlight=s.id;document.querySelectorAll('.utterance').forEach(x=>x.classList.toggle('highlighted',x.id===s.id));if(current().audioBlob&&s.start!==null){audio.currentTime=s.start;audio.play().catch(()=>toast('Нажмите воспроизведение в плеере.'));}else toast('У этого транскрипта нет аудиозаписи. Показана выбранная реплика.');},
 'audio-play':()=>audio.paused?audio.play().catch(()=>toast('Не удалось воспроизвести файл. Проверьте его формат.')):audio.pause(),
 speakers:speakerModal,'edit-summary':()=>textEditor('summary'),'segment-edit':el=>textEditor('segment',el.dataset.segment),'edit-meta':editMeta,
 export:exportModal,docx:()=>{downloadDocx(current());toast('Протокол DOCX подготовлен');},txt:()=>{downloadTranscript(current());toast('Транскрипт TXT подготовлен');},json:()=>{downloadJson(current());toast('Результаты JSON подготовлены');},
 'retry-save':()=>{if(current())persist(current());else state.meetings.forEach(persist);},
 close:closeModal,guide:guideModal,settings:settingsModal,reconnect:async()=>{await reconnect();toast(state.caps.asr?'Сервис распознавания доступен':'Распознавание пока не подключено.');},
 'process-audio':()=>processAudio(current()),
 'upload-mode':el=>{const mode=el.dataset.mode;$('#new-meeting-form [name="uploadMode"]').value=mode;document.querySelectorAll('.upload-tabs button').forEach(x=>x.classList.toggle('selected',x===el));renderUploadContent(mode);$('#upload-submit').innerHTML=i(mode==='json'?'file':'upload')+(mode==='json'?'Импортировать':state.caps.asr?'Начать обработку':'Сохранить запись');$('#upload-submit-hint').textContent=mode==='json'?'Результаты можно редактировать':state.caps.asr?'Сервис подключён':'Распознавание пока не подключено';}
};
document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(!el||el.disabled)return;e.preventDefault();try{const result=actions[el.dataset.action]?.(el);if(result?.catch)result.catch(e=>toast(e.message));}catch(error){toast(error.message);}});
document.addEventListener('submit',e=>{if(e.target.id==='new-meeting-form'){e.preventDefault();submitMeeting(e.target);}});
document.addEventListener('input',e=>{
 if(e.target.id==='meeting-search'||e.target.id==='transcript-search'){
  const id=e.target.id,pos=e.target.selectionStart;
  if(id==='meeting-search')state.search=e.target.value;else state.transcriptSearch=e.target.value;
  shell();const input=$('#'+id);input.focus();input.setSelectionRange(pos,pos);
 }
 if(e.target.id==='audio-seek')audio.currentTime=Number(e.target.value);
});
document.addEventListener('change',e=>{
 if(e.target.dataset.review){const t=current().tasks.find(t=>t.id===e.target.dataset.review);t.reviewed=e.target.checked;persist(current());shell();document.querySelector('[data-review="'+CSS.escape(t.id)+'"]')?.focus({preventScroll:true});}
 if(e.target.dataset.completed){const t=current().tasks.find(t=>t.id===e.target.dataset.completed);t.completed=e.target.checked;persist(current());}
 if(e.target.id==='audio-rate')audio.playbackRate=Number(e.target.value);
});
document.addEventListener('keydown',e=>{
 if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)&&!state.modal){const field=$('#meeting-search')||$('#transcript-search');if(field){e.preventDefault();field.focus();}}
 if(e.target.matches('[role="tab"]')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const tabs=[...document.querySelectorAll('[role="tab"]')],n=tabs.indexOf(e.target),index=e.key==='Home'?0:e.key==='End'?2:(n+(e.key==='ArrowRight'?1:2))%3;tabs[index].click();}
});
window.addEventListener('beforeunload',e=>{if(state.saving||state.saveError||$('dialog form')){e.preventDefault();e.returnValue='';}});
async function init(){
 try{state.meetings=await listMeetings();}catch(e){state.saveError=e.message;}
 for(const m of state.meetings)if(m.status==='processing'&&m.mode==='demo')m.status='ready';
 shell();await reconnect();
 for(const m of state.meetings)if(m.status==='processing'&&m.jobId)pollJob(m).catch(e=>{m.status='error';m.error=e.message;persist(m);if(current()?.id===m.id)shell();});
}
init();
