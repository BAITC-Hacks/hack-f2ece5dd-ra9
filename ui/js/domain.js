/** @typedef {import('./types').Meeting} Meeting */
export const SCHEMA_VERSION = 2;
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const uid = () => crypto.randomUUID();
export function seconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(value)) return value.split(':').reduce((a,b)=>a*60+Number(b),0);
  return null;
}
export function timecode(value) {
  const s=seconds(value); if(s===null) return 'Нет таймкода';
  const whole=Math.floor(s);
  return (whole>=3600 ? Math.floor(whole/3600)+':' : '')+String(Math.floor(whole/60)%60).padStart(2,'0')+':'+String(whole%60).padStart(2,'0');
}
export function dateLabel(value, short=false) {
  if(!value) return 'Дата не указана';
  const d=new Date(value.length===10 ? value+'T12:00:00' : value);
  if(Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:short?'short':'long',year:'numeric'}).format(d).replace(' г.','');
}
export function initials(name) {return name.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toLocaleUpperCase('ru')||'?';}
export function speakerName(meeting,id) {return meeting.speakers.find(s=>s.id===id)?.name||id||'Говорящий не определён';}
export function reviewNeeded(task) {return !task.reviewed || !task.assignee || !task.deadline;}
export function blankMeeting(meta={}) {
  return {schemaVersion:SCHEMA_VERSION,id:uid(),title:'Новое совещание',date:new Date().toLocaleDateString('sv-SE'),timezone:'Asia/Qyzylorda',participants:[],speakers:[],segments:[],tasks:[],summary:'',decisions:[],questions:[],mode:'import',status:'ready',createdAt:new Date().toISOString(),...meta};
}
export function normalizeResult(raw,meta={}) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new Error('Ожидается JSON-объект с массивом segments или transcript.');
  const source=raw.segments??raw.transcript;
  if(!Array.isArray(source)) throw new Error('В результате нет массива segments или transcript.');
  const meeting=blankMeeting(meta), speakerMap=new Map();
  meeting.segments=source.map((s,i)=>{
    if(!s||typeof s.text!=='string') throw new Error('Реплика '+(i+1)+': поле text должно быть строкой.');
    const key=String(s.speaker_id??s.speaker??'unknown');
    if(!speakerMap.has(key)) speakerMap.set(key,{id:key,name:key,color:speakerMap.size%5});
    return {id:'seg-'+(i+1),speakerId:key,start:seconds(s.start),end:seconds(s.end),text:s.text,language:typeof s.language==='string'?s.language:null};
  });
  meeting.speakers=[...speakerMap.values()];
  if(Array.isArray(raw.speakers)) for(const s of raw.speakers) {
    const found=meeting.speakers.find(x=>x.id===String(s.id));
    if(found&&typeof s.name==='string') found.name=s.name;
  }
  meeting.summary=typeof raw.summary==='string'?raw.summary:String(raw.summary?.text??'');
  meeting.decisions=Array.isArray(raw.decisions)?raw.decisions.map(String):[];
  meeting.questions=Array.isArray(raw.questions)?raw.questions.map(String):[];
  meeting.keyPoints=Array.isArray(raw.summary?.key_points)?raw.summary.key_points.map(String):[];
  if(raw.tasks!==undefined&&!Array.isArray(raw.tasks)) throw new Error('Поле tasks должно быть массивом.');
  meeting.tasks=(raw.tasks??[]).map((t,i)=>{
    if(!t||typeof t.title!=='string'||!t.title.trim()) throw new Error('Поручение '+(i+1)+': не задано название.');
    const evidence=t.evidence||{}, at=seconds(evidence.start), quote=String(evidence.quote??t.quote??'');
    const segment=meeting.segments.find(s=>quote&&s.text.includes(quote))??meeting.segments.find(s=>at!==null&&s.start===at&&(!evidence.speaker||s.speakerId===evidence.speaker));
    return {id:'task-'+(i+1),title:t.title,assignee:typeof(t.responsible??t.assignee)==='string'?(t.responsible??t.assignee):null,deadline:typeof t.deadline==='string'?t.deadline:null,reviewed:raw.schema_version===2&&t.reviewed===true,completed:raw.schema_version===2&&t.completed===true,sourceId:segment?.id??null,quote,start:segment?segment.start:at,needsReview:t.requires_review!==false};
  });
  meeting.status=raw.status==='partial'?'partial':'ready';
  return meeting;
}
export function validateAudio(file,capabilities) {
  if(!file?.size) return 'Файл пуст. Выберите другую запись.';
  const extensions=capabilities?.asr?capabilities.extensions:['mp3','wav','m4a','ogg','opus','flac','webm'];
  const ext=file.name.split('.').pop().toLowerCase();
  if(!extensions?.includes(ext)) return 'Выберите файл '+(extensions?.join(', ').toUpperCase()||'поддерживаемого формата')+'.';
  const limit=capabilities?.asr?capabilities.maxBytes:200*1024*1024;
  if(file.size>limit) return 'Размер файла превышает '+Math.round(limit/1024/1024)+' МБ.';
  return null;
}

export function mergeServerMeeting(raw,previous) {
  const m=normalizeResult({segments:raw.segments,summary:raw.analysis.summary,tasks:raw.analysis.tasks},{id:raw.id});
  const segmentIds=new Map(m.segments.map((s,index)=>[s.id,raw.segments[index].id||s.id]));
  for(const segment of m.segments)segment.id=segmentIds.get(segment.id);
  const edits=previous?.taskEdits||{};
  m.tasks=m.tasks.map((task,index)=>({...task,id:raw.analysis.tasks[index].id,
    sourceId:segmentIds.get(task.sourceId)||null,...(edits[raw.analysis.tasks[index].id]||{})}));
  for(const speaker of m.speakers)if(['speaker-unknown','unknown','Не определён'].includes(speaker.id))speaker.name='Говорящий не определён';
  return {...m,title:raw.title,date:raw.created_at.slice(0,10),createdAt:raw.created_at,
    status:raw.status,mode:raw.source==='audio_upload'?'audio':'live',serverId:raw.id,
    audioUrl:raw.audio_url,duration:raw.duration_seconds,processedSeconds:raw.processed_seconds,
    progress:raw.progress,snapshots:raw.analysis.snapshots,final:raw.analysis.final,
    analysisRevision:raw.analysis.revision,platform:raw.platform,error:raw.error,warning:raw.warning,
    transcriptionStatus:raw.transcription_status,recordingStatus:raw.recording_status,taskEdits:edits,
    participants:raw.metadata?.participants||[],serverRevision:JSON.stringify(raw.revision)};
}

