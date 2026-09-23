/* Real audio recording is independent of app.js's clearly marked demo data. */
(() => {
  "use strict";
  const el = id => document.getElementById(id);
  let token = "", connected = false, busy = false, recording = null, lastStatus = "";
  const active = () => recording && ["starting", "recording", "stopping"].includes(recording.status);
  const time = seconds => `${String(Math.floor((seconds || 0) / 60)).padStart(2,"0")}:${String(Math.floor((seconds || 0) % 60)).padStart(2,"0")}`;
  const labels = {starting:"Открываем устройство",recording:"Идёт запись",stopping:"Сохраняем…",completed:"Запись сохранена",error:"Ошибка записи",interrupted:"Запись прервана"};
  const node = (tag, cls, text) => {const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  function error(message) { el("backend-error").textContent = message || ""; el("backend-error").hidden = !message; }
  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : {"Content-Type":"application/json","X-Recorder-Token":token},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000)
    });
    if (!(response.headers.get("content-type") || "").includes("application/json")) throw new Error("Открыт старый сервер UI. Запустите start-ui.cmd вместо python -m http.server.");
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Проверьте данные запроса.");
    return data;
  }
  function controls() {
    const running = Boolean(active());
    window.recordingBusy = running || busy;
    el("start-recording").disabled = !connected || busy || running || el("audio-source").value === "" || !el("recording-consent").checked;
    el("stop-recording").disabled = busy || !running;
    el("audio-source").disabled = !connected || busy || running;
    el("refresh-devices").disabled = busy || running;
    el("recording-consent").disabled = busy || running;
    el("meeting-name").disabled = running || state.running;
    el("meeting-url").disabled = running;
    document.querySelectorAll('input[name="platform"]').forEach(input => {input.disabled = running || state.running;});
    el("open-teams").disabled = !connected || busy || running || !el("meeting-url").value.trim();
    updateControls();
    // app.js owns demo state; real recording owns these controls while active.
    if (running) {
      el("meeting-name").disabled = true;
      document.querySelectorAll('input[name="platform"]').forEach(input => {input.disabled = true;});
    }
  }
  function render() {
    controls();
    el("live-status").textContent = !connected ? "Backend недоступен" : recording ? labels[recording.status] || recording.status : "Готов к записи";
    el("live-dot").classList.toggle("active", Boolean(active()));
    el("live-timer").textContent = time(recording?.elapsed_seconds);
    el("audio-level").value = recording?.level || 0;
    el("live-details").textContent = recording ? `Аудио: ${time(recording.duration_seconds)} · фрагментов: ${recording.chunks.length}` : "WAV · фрагменты по 5 секунд";
    if (recording?.error || recording?.warning) error(recording.error || recording.warning);
  }
  async function devices() {
    const response = await api('/api/devices');
    const selected = el("audio-source").value;
    el("audio-source").replaceChildren();
    for (const d of response.devices) {
      const option = node('option','',d.name);
      option.value = d.id;
      option.selected = selected ? String(d.id) === selected : d.default;
      el("audio-source").append(option);
    }
    if (!response.devices.length) {
      const option = node('option','','Нет устройств воспроизведения');option.value='';el("audio-source").append(option);
      throw new Error('Windows не показывает устройства вывода. Подключите динамики или наушники и обновите список.');
    }
    controls();
  }
  async function sessions() {
    const response = await api('/api/sessions');
    const list = el('recordings-list');list.replaceChildren();
    if (!response.sessions.length) list.append(node('p','recordings-empty','Пока нет записей. Подключитесь к встрече и нажмите «Начать запись».'));
    for (const s of response.sessions) {
      const row = node('article','saved-recording');
      row.append(node('h3','',s.title),node('p','field-help',`${labels[s.status] || s.status} · ${time(s.duration_seconds)} · ${new Date(s.created_at).toLocaleString('ru-RU')} · ${s.chunks.length} фрагм.`));
      const results = node('button', 'button secondary', 'Транскрипт и итоги');
      results.addEventListener('click', () => window.openMeetingResults(s.id));
      row.append(results);
      if (s.error) row.append(node('p','upload-error',s.error));
      if (!['starting','recording','stopping'].includes(s.status) && s.duration_seconds > 0) {
        const url = `/api/sessions/${encodeURIComponent(s.id)}/files/recording.wav`;
        const audio = node('audio','saved-player');audio.controls=true;audio.preload='none';audio.src=url;audio.setAttribute('aria-label',`Прослушать ${s.title}`);
        const link = node('a','wav-link','↓ Скачать WAV');link.href=url;link.download=`meeting-${s.id}.wav`;
        row.append(audio,link);
      }
      list.append(row);
    }
  }
  async function action(fn) {
    busy = true;error('');controls();
    try { await fn(); } catch (e) {error(e.message);} finally {busy=false;render();}
  }
  el('meeting-url').addEventListener('input',controls);
  el('recording-consent').addEventListener('change',controls);
  el('audio-source').addEventListener('change',controls);
  document.querySelectorAll('input[name="platform"]').forEach(input => input.addEventListener('change',()=>{el('teams-controls').hidden=input.value!=='Teams';}));
  el('open-teams').addEventListener('click',()=>action(async()=>{
    const result = await api('/api/teams/open',{url:el('meeting-url').value.trim()});
    el('teams-status').textContent = result.message;
  }));
  el('refresh-devices').addEventListener('click',()=>action(devices));
  el('refresh-sessions').addEventListener('click',()=>action(sessions));
  el('start-recording').addEventListener('click',()=>action(async()=>{
    resetDemo();
    recording=await api('/api/recordings/start',{device_id:Number(el('audio-source').value),title:el('meeting-name').value.trim() || 'Совещание',platform:document.querySelector('input[name="platform"]:checked').value,acknowledged:el('recording-consent').checked});
    window.openMeetingResults(recording.id);
    await sessions();
  }));
  el('stop-recording').addEventListener('click',()=>action(async()=>{
    recording=(await api('/api/recordings/stop',{})).recording;
    await sessions();
  }));
  async function poll() {
    try {
      const response = await api('/api/status');
      const wasConnected=connected;
      connected=true;token=response.csrf_token;recording=response.recording;
      if(!wasConnected) {error('');await devices();await sessions();}
      const signature = recording ? `${recording.id}/${recording.status}` : '';
      if(signature !== lastStatus) {lastStatus=signature;await sessions();}
    } catch(e) {connected=false;error(`Не удалось связаться с backend: ${e.message}`);}
    render();
    setTimeout(poll,1000);
  }
  window.addEventListener('beforeunload', event => {if(active()){event.preventDefault();event.returnValue='';}});
  poll();
})();
