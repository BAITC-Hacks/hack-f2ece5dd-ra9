/* Real session results; all model text is rendered through textContent. */
(() => {
  const el = id => document.getElementById(id);
  const make = (tag, cls, text) => {
    const n = document.createElement(tag); n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const time = value => `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}`;
  let meeting = null, segments = [], generation = 0;
  el('audio-file').addEventListener('change', () => {
    el('transcribe-file').disabled = !uploadedAudio;
  });
  el('transcribe-file').addEventListener('click', async () => {
    if (!uploadedAudio) return;
    el('transcribe-file').disabled = true;
    el('upload-status').textContent = 'Передаём файл локальному серверу';
    try {
      const status = await request('/api/status');
      const query = new URLSearchParams({filename: uploadedAudio.name, title: el('meeting-name').value || uploadedAudio.name});
      const result = await request('/api/recordings/upload?' + query, {method: 'POST',
        headers: {'Content-Type': 'application/octet-stream', 'X-Recorder-Token': status.csrf_token},
        body: uploadedAudio, signal: AbortSignal.timeout(120000)});
      el('upload-status').textContent = 'Файл принят, идёт обработка';
      window.openMeetingResults(result.id);
      el('refresh-sessions').click();
    } catch (error) {
      el('upload-status').textContent = error.message;
    } finally {el('transcribe-file').disabled = !uploadedAudio;}
  });
  const base = id => `/api/sessions/${encodeURIComponent(id)}`;
  const name = id => meeting?.speaker_names?.[id] || (id === 'speaker-unknown' ? 'Говорящий не определён' : id);
  async function request(path, options) {
    const response = await fetch(path, {signal: AbortSignal.timeout(15000), ...options});
    if (!response.ok) {
      const data = await response.json();
      throw new Error(typeof data.detail === 'string' ? data.detail : 'Ошибка получения результата');
    }
    return response.json();
  }
  function renderTranscript() {
    const target = el('transcript'); target.replaceChildren();
    for (const s of segments) {
      const row = make('article', 'utterance');
      const content = make('div', 'utterance-content');
      content.append(make('strong', '', `${time(s.start)} · ${name(s.speaker_id || s.speaker)}`), make('p', '', s.text));
      row.append(content); target.append(row);
    }
    target.scrollTop = target.scrollHeight;
    el('transcript-count').textContent = `Реплик: ${segments.length}`;
    el('download-transcript').disabled = !segments.length;
  }
  function renderMeeting() {
    segments = meeting.transcript.segments;
    renderTranscript();
    el('task-count').textContent = meeting.tasks.length;
    el('review-count').textContent = 'ПРОВЕРЬТЕ ИМЕНА И СРОКИ';
    el('tasks').replaceChildren();
    for (const task of meeting.tasks) {
      const row = make('article', 'task-item');
      row.append(make('h3', '', task.title),
        make('p', 'task-meta', `Ответственный: ${task.responsible || 'Не указан'} · Срок: ${task.deadline || 'Не указан'}`),
        make('blockquote', '', `${task.evidence.start}–${task.evidence.end} · ${task.evidence.quote}`));
      if (task.requires_review) row.append(make('p', 'field-help', 'Требует проверки'));
      el('tasks').append(row);
    }
    if (!meeting.tasks.length) el('tasks').append(make('p', 'field-help', 'Поручения автоматически не выделены.'));
    el('summary-content').replaceChildren();
    for (const warning of meeting.warnings) el('summary-content').append(make('p', 'upload-error', warning));
    const list = make('ul', 'summary-points');
    for (const point of meeting.summary.key_points) list.append(make('li', '', point));
    el('summary-content').append(list);
    if (!meeting.summary.key_points.length) el('summary-content').append(make('p', 'field-help', meeting.summary.text));
    el('summary-status').textContent = 'Итоги · проверьте перед экспортом';
    el('download-json').disabled = false;
    el('download-docx').disabled = false;
    const speakers = [...new Set(segments.map(s => s.speaker_id || s.speaker))].filter(id => id !== 'speaker-unknown');
    el('speaker-count').textContent = speakers.length;
    el('speakers').replaceChildren();
    const inputs = {};
    for (const id of speakers) {
      const label = make('label', 'field-label', id);
      const input = document.createElement('input'); input.maxLength = 100;
      input.value = meeting.speaker_names[id] || ''; input.placeholder = 'Имя участника';
      label.append(input); el('speakers').append(label); inputs[id] = input;
    }
    if (!speakers.length) el('speakers').append(make('p', 'field-help', 'Голоса пока не разделены.'));
    else {
      const save = make('button', 'button secondary', 'Сохранить имена');
      save.addEventListener('click', async () => {
        const id = window.realSessionId, current = generation; save.disabled = true;
        try {
          const status = await request('/api/status');
          const names = Object.fromEntries(Object.entries(inputs).filter(([, input]) => input.value.trim()).map(([sid, input]) => [sid, input.value.trim()]));
          const result = await request(base(id) + '/speakers', {method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Recorder-Token': status.csrf_token}, body: JSON.stringify({names})});
          if (current === generation && window.realSessionId === id) {meeting = result; renderMeeting();}
        } catch (error) {showToast(error.message);} finally {save.disabled = false;}
      });
      el('speakers').append(save);
    }
  }
  window.openMeetingResults = async id => {
    resetDemo();
    const current = ++generation;
    window.realSessionId = id; meeting = null; segments = [];
    el('download-json').disabled = true; el('download-docx').disabled = true;
    renderTranscript(); updateControls();
    async function poll() {
      if (current !== generation || window.realSessionId !== id) return;
      try {
        const response = await request(base(id) + '/transcript');
        if (current !== generation || window.realSessionId !== id) return;
        if (response.segments.length !== segments.length) {segments = response.segments; renderTranscript();}
        const labels = {waiting: 'Ожидаем речь', processing: 'Распознавание', finalizing: 'Формирование итогов', completed: 'Готово', error: 'Ошибка', unavailable: 'Модель недоступна', interrupted: 'Обработка прервана'};
        el('transcript-tag').textContent = labels[response.status] || response.status;
        el('summary-status').textContent = response.status === 'finalizing' ? 'Формирование итогов' : 'Ожидаем окончания обработки';
        if (response.status === 'completed') {
          try {
            const result = await request(base(id) + '/result');
            if (current === generation && window.realSessionId === id) {meeting = result; renderMeeting();}
          } catch (error) {
            if (current === generation) {
              el('summary-status').textContent = 'Итоги недоступны';
              el('summary-content').textContent = error.message + ' Для старой записи загрузите WAV повторно.';
            }
          }
          return;
        }
        if (['error', 'unavailable', 'interrupted'].includes(response.status)) {
          el('summary-content').textContent = response.error || labels[response.status]; return;
        }
      } catch (error) {if (current === generation) el('summary-content').textContent = error.message;}
      if (current === generation && window.realSessionId === id) setTimeout(poll, 1500);
    }
    poll();
  };
  function intercept(id, handler) {
    el(id).addEventListener('click', event => {
      if (!window.realSessionId) return;
      event.stopImmediatePropagation(); handler();
    }, true);
  }
  intercept('download-transcript', () => {window.location.href = base(window.realSessionId) + '/transcript.txt';});
  intercept('download-json', () => {if (meeting) download('meeting-result.json', JSON.stringify(meeting, null, 2), 'application/json');});
  intercept('download-docx', () => {if (meeting) window.location.href = base(window.realSessionId) + '/protocol.docx';});
})();
