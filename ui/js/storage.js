let database;
export async function openStore() {
 if(database) return database;
 database=await new Promise((resolve,reject)=>{
  const r=indexedDB.open('protokol-local-v2',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('meetings',{keyPath:'id'});
  r.onsuccess=()=>resolve(r.result);
  r.onerror=()=>reject(new Error('Не удалось открыть локальное хранилище. Проверьте настройки браузера.'));
 }); return database;
}
async function transaction(mode,operation) {
 const db=await openStore();
 return new Promise((resolve,reject)=>{
  let tx,request;try{tx=db.transaction('meetings',mode);request=operation(tx.objectStore('meetings'));}catch{reject(new Error('Не удалось записать данные в браузер. Освободите место или скачайте JSON. Правки остаются на экране.'));return;}
  tx.oncomplete=()=>resolve(request.result);
  tx.onerror=()=>reject(new Error('Не удалось сохранить данные. Возможно, хранилище браузера заполнено. Скачайте JSON, чтобы сохранить правки.'));
  tx.onabort=()=>reject(new Error('Сохранение прервано. Правки остались на экране. Повторите сохранение или скачайте JSON.'));
 });
}
export const saveMeeting=m=>transaction('readwrite',store=>store.put({...m,updatedAt:new Date().toISOString()}));
export const listMeetings=async()=>(await transaction('readonly',store=>store.getAll())).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));

