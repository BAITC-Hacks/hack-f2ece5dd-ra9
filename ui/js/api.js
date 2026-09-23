const ROOT='/api';
let token='';
async function request(path,options={},timeout=30000) {
 if(options.method && options.method!=='GET') {
  if(!token) await getCapabilities();
  options.headers={...options.headers,'X-Recorder-Token':token};
 }
 let response;
 try {response=await fetch(ROOT+path,{...options,signal:AbortSignal.timeout(timeout)});}
 catch(e) {throw new Error(e.name==='TimeoutError'?'Сервер не ответил вовремя. Проверьте подключение и повторите попытку.':'Нет соединения с локальным сервером. Проверьте, что start-ui.cmd запущен.');}
 const data=await response.json().catch(()=>({error:'Сервер вернул ответ в неподдерживаемом формате.'}));
 if(!response.ok) {if(response.status===403)token='';throw new Error(data.detail||data.error||'Ошибка сервера: '+response.status);}
 return data;
}
export async function getCapabilities() {
 const data=await request('/capabilities');
 token=data.csrf_token||'';
 if(data.asr&&(!Array.isArray(data.extensions)||!data.extensions.length||!Number.isFinite(data.maxBytes)||data.maxBytes<=0)) throw new Error('Сервер не сообщил допустимые форматы и размер аудио.');
 return data;
}
export const analyzeTranscript=payload=>request('/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)},90000);
export async function submitAudio(file,metadata,requestId) {
 const body=new FormData(); body.append('audio',file); body.append('metadata',JSON.stringify(metadata));
 const result=await request('/jobs',{method:'POST',body,headers:{'Idempotency-Key':requestId}},120000);
 if(!result.id||typeof result.id!=='string') throw new Error('Сервер не вернул идентификатор задания.');
 return result;
}
export const getJob=id=>request('/jobs/'+encodeURIComponent(id));
export const getSessions=()=>request('/sessions');
export const getResult=id=>request('/sessions/'+encodeURIComponent(id)+'/result');
export const getConnection=()=>request('/connection');
export const getDevices=()=>request('/devices');
const post=(path,body={})=>request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export const connectMeeting=body=>post('/meetings/connect',body);
export const confirmConnection=()=>post('/meetings/confirm');
export const disconnectMeeting=()=>post('/meetings/disconnect');
export const stopRecording=()=>post('/recordings/stop');
export const transcribeSession=id=>post('/sessions/'+encodeURIComponent(id)+'/transcribe');

