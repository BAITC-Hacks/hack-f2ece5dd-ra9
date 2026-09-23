"use strict";

// Hand-authored examples only. No audio capture, model call, or Assets access.
const example = [
  { at: "00:04", speaker: "s1", text: "Коллеги, сегодня согласуем план демо. Алия, подготовь сценарий показа к пятнице." },
  { at: "00:12", speaker: "s2", text: "Хорошо, подготовлю сценарий к пятнице. Начнём с короткой встречи в Teams.", task: { id: "t1", title: "Подготовить сценарий демонстрации", owner: "s2", deadline: "К пятнице · дата не уточнена", quote: "Алия, подготовь сценарий показа к пятнице.", evidenceAt: "00:04" }, summary: "Демо начнётся с короткой встречи в Teams." },
  { at: "00:23", speaker: "s3", text: "Мен дыбысты тексеремін. Сначала проверю Teams, потом Zoom." },
  { at: "00:31", speaker: "s1", text: "Данияр, тогда проверь звук в обеих платформах до завтра, до 15:00.", task: { id: "t2", title: "Проверить звук в Teams и Zoom", owner: "s3", deadline: "Завтра, 15:00 · дата не уточнена", quote: "Данияр, тогда проверь звук в обеих платформах до завтра, до 15:00.", evidenceAt: "00:31" } },
  { at: "00:42", speaker: "s3", text: "Жақсы, ертең сағат үшке дейін тексеріп шығамын.", summary: "Данияр проверит звук в Teams и Zoom до завтра, 15:00." },
  { at: "00:53", speaker: "s1", text: "Ещё нужно подготовить инструкцию запуска. Ответственного определим позже.", task: { id: "t3", title: "Подготовить инструкцию запуска", owner: null, deadline: "Не указан", quote: "Ещё нужно подготовить инструкцию запуска. Ответственного определим позже.", evidenceAt: "00:53" }, summary: "Для инструкции запуска пока не назначены ответственный и срок." }
];

const $ = (id) => document.getElementById(id);
const initialNames = { s1: "Спикер 1", s2: "Алия", s3: "Данияр" };
let state;
let interval;
let toastTimeout;
let uploadedAudioUrl;
let uploadedAudio;
const emptyTranscript = $("transcript").innerHTML;
const emptyTasks = $("tasks").innerHTML;
const emptySummary = $("summary-content").innerHTML;

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function displayName(id) { return id ? state.names[id] : "Не указан"; }
function showToast(text) {
  clearTimeout(toastTimeout);
  $("toast").textContent = text;
  $("toast").classList.add("visible");
  toastTimeout = setTimeout(() => $("toast").classList.remove("visible"), 3500);
}

function renderTranscript() {
  const target = $("transcript");
  if (!state.entries.length) { target.innerHTML = emptyTranscript; return; }
  target.replaceChildren();
  state.entries.forEach((entry) => {
    const row = make("article", "utterance");
    row.append(make("span", "avatar " + entry.speaker, entry.speaker.slice(1).padStart(2, "0")));
    const content = make("div", "utterance-content");
    const meta = make("div", "utterance-meta");
    meta.append(make("strong", "", displayName(entry.speaker)), make("time", "", entry.at));
    content.append(meta, make("p", "", entry.text));
    row.append(content);
    target.append(row);
  });
  target.scrollTop = target.scrollHeight;
}

function renderSpeakers() {
  const target = $("speakers");
  const ids = [...new Set(state.entries.map((entry) => entry.speaker))];
  $("speaker-count").textContent = ids.length;
  target.replaceChildren();
  if (!ids.length) target.append(make("p", "muted-empty", "Здесь появятся говорящие."));
  ids.forEach((id) => {
    const row = make("div", "speaker-row");
    row.append(make("span", "avatar " + id, id.slice(1).padStart(2, "0")));
    const fields = make("div", "speaker-fields");
    const label = make("label", "", "Спикер " + id.slice(1));
    label.htmlFor = "name-" + id;
    const input = make("input");
    input.id = label.htmlFor;
    input.maxLength = 60;
    input.value = state.names[id];
    input.addEventListener("input", () => {
      state.names[id] = input.value.trim() || "Спикер " + id.slice(1);
      // Renaming an identity invalidates previous confirmation of its tasks.
      state.tasks.filter((task) => task.owner === id).forEach((task) => { task.reviewed = false; });
      renderTranscript();
      renderTasks();
      renderSummary();
    });
    fields.append(label, input);
    row.append(fields);
    target.append(row);
  });
}

function renderTasks() {
  const target = $("tasks");
  $("task-count").textContent = state.tasks.length;
  const reviewed = state.tasks.filter((task) => task.reviewed).length;
  $("review-count").textContent = state.tasks.length ? `ПРОВЕРЕНО ${reviewed} / ${state.tasks.length}` : "ДЛЯ ПРОВЕРКИ";
  if (!state.tasks.length) { target.innerHTML = emptyTasks; return; }
  target.replaceChildren();
  state.tasks.forEach((task, index) => {
    const item = make("article", "task-item");
    const heading = make("div", "task-topline");
    heading.append(make("h3", "", task.title), make("span", "task-number", String(index + 1).padStart(2, "0")));
    const meta = make("div", "task-meta");
    meta.append(make("span", "", "Ответственный: " + displayName(task.owner)), make("span", "", "Срок: " + task.deadline));
    const quote = make("blockquote", "", `${task.evidenceAt} · «${task.quote}»`);
    const label = make("label", "review-label");
    const check = make("input");
    check.type = "checkbox";
    check.checked = task.reviewed;
    check.addEventListener("change", () => {
      task.reviewed = check.checked;
      const total = state.tasks.filter((entry) => entry.reviewed).length;
      $("review-count").textContent = `ПРОВЕРЕНО ${total} / ${state.tasks.length}`;
    });
    label.append(check, document.createTextNode("Поручение проверено"));
    item.append(heading, meta, quote, label);
    target.append(item);
  });
}

function summaryPoints() {
  return state.tasks.map((task) => `${task.title}. Ответственный: ${displayName(task.owner)}. Срок: ${task.deadline}.`);
}

function renderSummary() {
  const target = $("summary-content");
  if (!state.tasks.length) { target.innerHTML = emptySummary; return; }
  const list = make("ul", "summary-points");
  summaryPoints().forEach((point) => list.append(make("li", "", point)));
  target.replaceChildren(list);
}

function updateControls() {
  $("start-demo").disabled = state.running || state.entries.length > 0 || Boolean(uploadedAudio) || Boolean(window.recordingBusy);
  $("start-demo").title = uploadedAudio ? "Уберите загруженный файл, чтобы запустить вымышленный пример" : "Показать вымышленные реплики и поручения";
  $("stop-demo").disabled = !state.running;
  $("reset-demo").disabled = !state.entries.length && !state.running;
  $("download-transcript").disabled = !state.entries.length;
  $("download-json").disabled = !state.tasks.length;
  $("meeting-name").disabled = state.running;
  document.querySelectorAll('input[name="platform"]').forEach((input) => { input.disabled = state.running; });
  $("session-status").textContent = state.running ? "Пример воспроизводится" : state.entries.length ? "Пример завершён" : "Ожидает запуска";
  $("status-dot").classList.toggle("active", state.running);
  $("transcript-tag").textContent = state.running ? "Демонстрация" : state.entries.length ? "Пример" : "Нет данных";
  $("transcript-tag").className = "tag " + (state.running ? "live" : "neutral");
  $("summary-status").textContent = state.running ? "Черновик · пример" : state.entries.length ? "Итоги примера" : "Ожидаем реплики";
  $("transcript-count").textContent = `Реплик: ${state.entries.length}`;
}

function appendNext() {
  if (state.entries.length >= example.length) { stopDemo(); return; }
  const next = example[state.entries.length];
  const existingSpeakers = new Set(state.entries.map((entry) => entry.speaker));
  state.entries.push(next);
  if (next.task) state.tasks.push({ ...next.task, reviewed: false });
  $("timer").textContent = next.at;
  renderTranscript();
  if (!existingSpeakers.has(next.speaker)) renderSpeakers();
  renderTasks();
  renderSummary();
  updateControls();
  if (state.entries.length === example.length) stopDemo();
}

function stopDemo() {
  clearInterval(interval);
  state.running = false;
  updateControls();
}

function resetDemo() {
  clearInterval(interval);
  state = { running: false, entries: [], tasks: [], names: { ...initialNames } };
  $("timer").textContent = "00:00";
  renderTranscript();
  renderSpeakers();
  renderTasks();
  renderSummary();
  updateControls();
}

function download(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = make("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Файл подготовлен для скачивания");
}

$("start-demo").addEventListener("click", () => {
  state.running = true;
  appendNext();
  interval = setInterval(appendNext, 1600);
});
$("stop-demo").addEventListener("click", stopDemo);
$("reset-demo").addEventListener("click", resetDemo);
document.querySelectorAll('input[name="platform"]').forEach((input) => {
  input.addEventListener("change", () => {
    $("platform-help").textContent = input.value === 'Teams' ? 'Teams: откройте встречу гостем, затем включите запись.' : 'Zoom: войдите во встречу вручную, затем включите запись системного звука.';
  });
});
$("download-transcript").addEventListener("click", () => {
  const title = $("meeting-name").value.trim() || "Совещание";
  const text = [title, "ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ — не результат распознавания аудио.", "", ...state.entries.map((entry) => `[${entry.at}] ${displayName(entry.speaker)}: ${entry.text}`)].join("\r\n");
  download("demo-transcript.txt", "\ufeff" + text, "text/plain;charset=utf-8");
});
$("download-json").addEventListener("click", () => {
  const result = {
    schemaVersion: 1,
    demo: true,
    notice: "Вымышленный пример. Запись и ИИ не подключены.",
    title: $("meeting-name").value.trim() || "Совещание",
    platform: document.querySelector('input[name="platform"]:checked').value,
    complete: state.entries.length === example.length,
    summary: summaryPoints(),
    tasks: state.tasks.map(({ owner, ...task }) => ({ ...task, speakerId: owner, assignee: owner ? displayName(owner) : null }))
  };
  download("demo-summary.json", JSON.stringify(result, null, 2), "application/json;charset=utf-8");
});
function clearAudio() {
  const player = $("audio-preview");
  player.pause();
  player.removeAttribute("src");
  player.load();
  if (uploadedAudioUrl) URL.revokeObjectURL(uploadedAudioUrl);
  uploadedAudioUrl = undefined;
  uploadedAudio = undefined;
  $("audio-file").value = "";
  $("upload-details").hidden = true;
  $("upload-error").hidden = true;
  if (state) updateControls();
}

$("audio-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  clearAudio();
  let error = "";
  if (!/\.(mp3|wav|m4a|ogg|opus|flac|webm)$/i.test(file.name)) error = "Выберите аудиофайл MP3, WAV, M4A, OGG, OPUS, FLAC или WebM.";
  else if (!file.size) error = "Файл пуст. Выберите другую запись.";
  else if (file.size > 200 * 1024 * 1024) error = "Файл больше 200 МБ. Для первого прогона выберите короткую запись.";
  if (error) {
    $("upload-error").textContent = error;
    $("upload-error").hidden = false;
    return;
  }
  resetDemo();
  uploadedAudio = file;
  uploadedAudioUrl = URL.createObjectURL(file);
  $("upload-name").textContent = file.name;
  $("upload-info").textContent = `${(file.size / 1024 / 1024).toFixed(1)} МБ · определяем длительность`;
  $("upload-status").textContent = "Файл выбран · модель не подключена";
  $("upload-details").hidden = false;
  $("audio-preview").src = uploadedAudioUrl;
  updateControls();
});
$("audio-preview").addEventListener("loadedmetadata", () => {
  if (!uploadedAudio) return;
  const seconds = $("audio-preview").duration;
  const duration = Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "длительность неизвестна";
  $("upload-info").textContent = `${(uploadedAudio.size / 1024 / 1024).toFixed(1)} МБ · ${duration}`;
});
$("audio-preview").addEventListener("error", () => {
  if (!uploadedAudio) return;
  $("upload-info").textContent = `${(uploadedAudio.size / 1024 / 1024).toFixed(1)} МБ`;
  $("upload-status").textContent = "Предпрослушивание недоступно";
  $("upload-error").textContent = "Браузер не смог прочитать аудио. Попробуйте MP3 или WAV; файл может быть повреждён или его кодек не поддерживается.";
  $("upload-error").hidden = false;
});
$("clear-file").addEventListener("click", clearAudio);

window.addEventListener("beforeunload", (event) => {
  if (state.running) { event.preventDefault(); event.returnValue = ""; }
});
resetDemo();
