const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');
const startBtn = document.getElementById('start');
const panelBtn = document.getElementById('panel');
const stopBtn = document.getElementById('stop');
refreshStatus();

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  setMessage('字幕を読み込み中…');
  const r = await send({ type: 'START_CAPTURE' });
  setMessage(r.ok ? '録音を開始しました。字幕は辞書補正だけで右側へ表示します。' : r.error, !r.ok);
  startBtn.disabled = false;
  await refreshStatus();
});

panelBtn.addEventListener('click', async () => {
  panelBtn.disabled = true;
  setMessage('字幕を読み込み中…');
  const r = await send({ type: 'OPEN_TRANSCRIPT_PANEL', focusCurrent: true });
  setMessage(r.ok ? '字幕パネルを表示しました。' : r.error, !r.ok);
  panelBtn.disabled = false;
  await refreshStatus();
});

stopBtn.addEventListener('click', async () => {
  setMessage('');
  stopBtn.disabled = true;
  const r = await send({ type: 'STOP_CAPTURE' });
  setMessage(r.ok ? '録音を停止しました。' : r.error, !r.ok);
  stopBtn.disabled = false;
  await refreshStatus();
});

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function refreshStatus() {
  const r = await send({ type: 'GET_STATUS' });
  if (r.recording) {
    statusEl.textContent = `録音中: ${r.title || '動画'}`;
    statusEl.classList.add('on');
  } else {
    statusEl.textContent = '停止中';
    statusEl.classList.remove('on');
  }
}

function setMessage(text, error = false) {
  messageEl.textContent = text || '';
  messageEl.className = `message${error ? ' error' : ''}`;
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch(err => ({ ok: false, error: err.message }));
}
