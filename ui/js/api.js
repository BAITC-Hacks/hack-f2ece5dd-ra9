const ROOT='/api';
async function request(path,options={},timeout=30000) {
 let response;
 try {response=await fetch(ROOT+path,{...options,signal:AbortSignal.timeout(timeout)});}
 catch(e) {throw new Error(e.name==='TimeoutError'?'Сервер не ответил вовремя. Проверьте подключение и повторите попытку.':'Нет соединения с локальным сервером. Проверьте, что start-ui.cmd запущен.');}
 const data=await response.json().catch(()=>({error:'Сервер вернул ответ в неподдерживаемом формате.'}));
 if(!response.ok) throw new Error(data.error||'Ошибка сервера: '+response.status);
 return data;
}
export async function getCapabilities() {
 const data=await request('/capabilities');
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

