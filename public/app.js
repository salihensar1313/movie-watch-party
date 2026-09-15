// ==========================================
// SECTION 1: Socket & DOM refs
// ==========================================
const socketUrl = window.APP_CONFIG?.socketUrl || window.location.origin;
const socket = io(socketUrl, { transports: ['websocket', 'polling'] });

const nameInput          = document.querySelector('#nameInput');
const roomCodeInput      = document.querySelector('#roomCodeInput');
const videoUrlInput      = document.querySelector('#videoUrlInput');
const roomStatusText     = document.querySelector('#roomStatusText');
const roomCodeValue      = document.querySelector('#roomCodeValue');
const rolePill           = document.querySelector('#rolePill');
const movieTitle         = document.querySelector('#movieTitle');
const videoEl            = document.querySelector('#videoPlayer');
const ytContainer        = document.querySelector('#youtubeContainer');
const emptyState         = document.querySelector('#emptyState');
const shareBox           = document.querySelector('#shareBox');
const shareLinkInput     = document.querySelector('#shareLinkInput');
const chatMessages       = document.querySelector('#chatMessages');
const chatInput          = document.querySelector('#chatInput');
const chatCounter        = document.querySelector('#chatCounter');
const syncDiffText       = document.querySelector('#syncDiffText');
const bufferNotice       = document.querySelector('#bufferNotice');
const bufferUserEl       = document.querySelector('#bufferUser');
const autoplayOverlay    = document.querySelector('#autoplayOverlay');
const unlockAudioBtn     = document.querySelector('#unlockAudioBtn');
const playbackSpeedBadge = document.querySelector('#playbackSpeedBadge');
const loadSampleBtn      = document.querySelector('#loadSampleBtn');

// ==========================================
// SECTION 2: State
// ==========================================
let currentRoomCode    = '';
let currentRole        = 'guest';
let isRemoteAction     = false;
let isBufferingLocally = false;
let currentPlayerType  = 'html5';
let youtubePlayer      = null;
let hlsInstance        = null;
let ytApiReady         = false;
let ytApiCallbacks     = [];
let lastSyncUrl        = '';

// ==========================================
// SECTION 3: YouTube API
// ==========================================
window.onYouTubeIframeAPIReady = () => {
  ytApiReady = true;
  ytApiCallbacks.forEach(cb => cb());
  ytApiCallbacks = [];
};

function whenYoutubeReady(cb) {
  if (ytApiReady) cb();
  else ytApiCallbacks.push(cb);
}

// ==========================================
// SECTION 4: Player abstraction
// ==========================================
function playerGetCurrentTime() {
  if (currentPlayerType === 'youtube' && youtubePlayer) {
    try { return youtubePlayer.getCurrentTime() || 0; } catch (e) { return 0; }
  }
  return videoEl.currentTime || 0;
}

function playerIsPaused() {
  if (currentPlayerType === 'youtube' && youtubePlayer) {
    try {
      const s = youtubePlayer.getPlayerState();
      return s !== YT.PlayerState.PLAYING && s !== YT.PlayerState.BUFFERING;
    } catch (e) { return true; }
  }
  return videoEl.paused;
}

function playerSetRate(rate) {
  if (currentPlayerType === 'youtube') return;
  if (Math.abs(videoEl.playbackRate - rate) > 0.005) videoEl.playbackRate = rate;
  if (playbackSpeedBadge) {
    playbackSpeedBadge.textContent = `Hiz: ${rate.toFixed(2)}x`;
    playbackSpeedBadge.style.color = rate === 1.0 ? 'var(--muted)' : 'var(--pink)';
  }
}

function playerSeek(time) {
  isRemoteAction = true;
  if (currentPlayerType === 'youtube' && youtubePlayer) {
    try { youtubePlayer.seekTo(time, true); } catch (e) {}
    setTimeout(() => { isRemoteAction = false; }, 800);
  } else {
    videoEl.currentTime = time;
    setTimeout(() => { isRemoteAction = false; }, 300);
  }
}

function playerPause() {
  if (currentPlayerType === 'youtube' && youtubePlayer) {
    try { youtubePlayer.pauseVideo(); } catch (e) {}
  } else {
    if (currentRoomCode) isRemoteAction = true;
    videoEl.pause();
    setTimeout(() => { isRemoteAction = false; }, 200);
  }
}

function safePlay() {
  if (currentPlayerType === 'youtube' && youtubePlayer) {
    isRemoteAction = true;
    try { youtubePlayer.playVideo(); } catch (e) {}
    setTimeout(() => { isRemoteAction = false; }, 600);
    return;
  }
  if (currentRoomCode) isRemoteAction = true;
  const p = videoEl.play();
  if (p) {
    p.then(() => { if (autoplayOverlay) autoplayOverlay.classList.add('hidden'); })
     .catch(() => {
       if (autoplayOverlay) autoplayOverlay.classList.remove('hidden');
       setRoomStatus('Oynatmak icin ekrana tikla');
     })
     .finally(() => setTimeout(() => { isRemoteAction = false; }, 300));
  } else {
    setTimeout(() => { isRemoteAction = false; }, 300);
  }
}

// ==========================================
// SECTION 5: URL detection & video loading
// ==========================================
function detectUrlType(url) {
  if (!url) return 'html5';
  const u = url.toLowerCase().trim();
  if (/youtube\.com\/watch|youtu\.be\/|youtube\.com\/embed/.test(u)) return 'youtube';
  if (u.includes('.m3u8')) return 'hls';
  return 'html5';
}

function extractYoutubeId(url) {
  const patterns = [/[?&]v=([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/, /embed\/([a-zA-Z0-9_-]{11})/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function showHtml5Player() {
  ytContainer.classList.add('hidden');
  videoEl.classList.remove('hidden');
  if (playbackSpeedBadge) playbackSpeedBadge.style.display = '';
}

function showYoutubePlayer() {
  videoEl.classList.add('hidden');
  ytContainer.classList.remove('hidden');
  if (playbackSpeedBadge) playbackSpeedBadge.style.display = 'none';
  currentPlayerType = 'youtube';
}

function destroyHls() {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
}

function onYoutubeStateChange(event) {
  if (isRemoteAction) return;
  const t = playerGetCurrentTime();
  if (event.data === YT.PlayerState.PLAYING) {
    if (isBufferingLocally) { isBufferingLocally = false; sendVideoAction('buffering-ended', t); }
    sendVideoAction('play', t);
  } else if (event.data === YT.PlayerState.PAUSED) {
    sendVideoAction('pause', t);
  } else if (event.data === YT.PlayerState.BUFFERING) {
    if (!isBufferingLocally) { isBufferingLocally = true; sendVideoAction('buffering', t); }
  } else if (event.data === YT.PlayerState.ENDED) {
    sendVideoAction('pause', t);
  }
}

function loadYoutubeVideo(videoId, startTime) {
  startTime = startTime || 0;
  destroyHls();
  showYoutubePlayer();
  if (youtubePlayer && typeof youtubePlayer.loadVideoById === 'function') {
    isRemoteAction = true;
    youtubePlayer.loadVideoById({ videoId, startSeconds: Math.floor(startTime) });
    setTimeout(() => { isRemoteAction = false; }, 800);
    return;
  }
  ytContainer.innerHTML = '<div id="ytInner"></div>';
  youtubePlayer = null;
  whenYoutubeReady(() => {
    youtubePlayer = new YT.Player('ytInner', {
      width: '100%', height: '100%', videoId,
      playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
      events: {
        onStateChange: onYoutubeStateChange,
        onReady: (e) => {
          if (startTime > 0) {
            isRemoteAction = true;
            e.target.seekTo(startTime, true);
            setTimeout(() => { isRemoteAction = false; }, 800);
          }
        }
      }
    });
  });
}

function loadHlsVideo(url) {
  destroyHls(); showHtml5Player(); currentPlayerType = 'hls';
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    hlsInstance = new Hls({ enableWorker: true });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(videoEl);
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    isRemoteAction = !!currentRoomCode;
    videoEl.src = url; videoEl.load();
    setTimeout(() => { isRemoteAction = false; }, 300);
  } else {
    setRoomStatus('Tarayicin HLS desteklemiyor, Chrome kullan.');
  }
}

function loadHtml5Video(url) {
  destroyHls(); showHtml5Player(); currentPlayerType = 'html5';
  isRemoteAction = !!currentRoomCode;
  videoEl.src = url; videoEl.load();
  setTimeout(() => { isRemoteAction = false; }, 300);
}

function loadVideoFromUrl(url, title) {
  title = title || 'Secilen film';
  if (!url) return;
  const type = detectUrlType(url);
  movieTitle.textContent = title;
  emptyState.classList.add('hidden');
  if (type === 'youtube') {
    const videoId = extractYoutubeId(url);
    if (!videoId) { setRoomStatus('Gecersiz YouTube linki'); return; }
    loadYoutubeVideo(videoId);
  } else if (type === 'hls') {
    loadHlsVideo(url);
  } else {
    loadHtml5Video(url);
  }
  if (currentRoomCode) {
    socket.emit('set-video', { roomCode: currentRoomCode, videoUrl: url, title });
  }
}

// ==========================================
// SECTION 6: Sync
// ==========================================
function setRoomStatus(text) { roomStatusText.textContent = text; }

function updateSyncDisplay(absDiff, rate) {
  if (!syncDiffText) return;
  if (!currentRoomCode) { syncDiffText.textContent = 'Solo Izleme'; return; }
  if (absDiff < 0.15) {
    syncDiffText.textContent = `Tam Senkron (±${Math.round(absDiff * 1000)}ms)`;
  } else if (absDiff <= 1.5) {
    syncDiffText.textContent = `Esitleniyor (${(rate || 1).toFixed(2)}x)`;
  } else {
    syncDiffText.textContent = `Fark: ${absDiff.toFixed(1)}s`;
  }
}

function adjustPlaybackDrift(diff) {
  const absDiff = Math.abs(diff);
  if (currentPlayerType === 'youtube') {
    if (absDiff > 3) playerSeek(playerGetCurrentTime() - diff);
    updateSyncDisplay(absDiff, 1.0); return;
  }
  if (absDiff < 0.12) { playerSetRate(1.0); }
  else if (absDiff <= 1.5) { playerSetRate(diff < 0 ? 1.08 : 0.92); }
  else { playerSeek(videoEl.currentTime - diff); playerSetRate(1.0); }
  updateSyncDisplay(absDiff, videoEl.playbackRate);
}

function sendVideoAction(action, time) {
  if (!currentRoomCode || isRemoteAction) return;
  socket.emit('video-action', { roomCode: currentRoomCode, action, currentTime: typeof time === 'number' ? time : playerGetCurrentTime() });
}

function applySyncState(state) {
  if (!state || !state.videoUrl) return;
  if (state.videoUrl !== lastSyncUrl) {
    lastSyncUrl = state.videoUrl;
    movieTitle.textContent = state.title || 'Secilen film';
    emptyState.classList.add('hidden');
    const type = detectUrlType(state.videoUrl);
    if (type === 'youtube') {
      const id = extractYoutubeId(state.videoUrl);
      if (id) loadYoutubeVideo(id, state.currentTime || 0);
    } else if (type === 'hls') {
      loadHlsVideo(state.videoUrl);
    } else {
      isRemoteAction = true;
      videoEl.src = state.videoUrl; videoEl.load();
      setTimeout(() => { isRemoteAction = false; }, 300);
    }
    return;
  }
  if (state.title) movieTitle.textContent = state.title;
  emptyState.classList.add('hidden');
  if (state.bufferingUser) {
    if (bufferUserEl) bufferUserEl.textContent = state.bufferingUser;
    if (bufferNotice) bufferNotice.classList.remove('hidden');
  } else {
    if (bufferNotice) bufferNotice.classList.add('hidden');
  }
  const elapsed = state.isPlaying ? Math.max(0, (Date.now() - (state.lastUpdated || Date.now())) / 1000) : 0;
  const expectedTime = Number(state.currentTime || 0) + elapsed;
  const diff = playerGetCurrentTime() - expectedTime;
  const absDiff = Math.abs(diff);
  if (state.isPlaying) {
    if (playerIsPaused()) {
      if (currentPlayerType !== 'youtube') videoEl.currentTime = expectedTime;
      safePlay();
    } else { adjustPlaybackDrift(diff); }
  } else {
    if (!playerIsPaused()) { isRemoteAction = true; playerPause(); }
    if (absDiff > 0.5) playerSeek(expectedTime);
    if (currentPlayerType !== 'youtube') playerSetRate(1.0);
    updateSyncDisplay(absDiff, 1.0);
  }
}

// ==========================================
// SECTION 7: Chat
// ==========================================
function formatChatMessage(msg) {
  const w = document.createElement('div');
  w.className = `chat-message${msg.isSystem ? ' system-chat-message' : ''}`;
  const h = document.createElement('div'); h.className = 'chat-meta';
  h.innerHTML = `<strong>${msg.sender}</strong><span>${msg.time}</span>`;
  const t = document.createElement('div'); t.className = 'chat-text'; t.textContent = msg.text;
  w.appendChild(h); w.appendChild(t); return w;
}
function renderChatHistory(messages = []) {
  chatMessages.innerHTML = '';
  messages.forEach(m => chatMessages.appendChild(formatChatMessage(m)));
  chatCounter.textContent = messages.length;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function appendChatMessage(msg) {
  chatMessages.appendChild(formatChatMessage(msg));
  chatCounter.textContent = chatMessages.children.length;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !currentRoomCode) return;
  socket.emit('send-message', { roomCode: currentRoomCode, sender: nameInput.value.trim() || 'Kullanici', text });
  chatInput.value = '';
}

// ==========================================
// SECTION 8: Room helpers
// ==========================================
function generateShareLink(code) {
  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
  return url.toString();
}
function updateShareBox() {
  const link = currentRoomCode ? generateShareLink(currentRoomCode) : '';
  shareLinkInput.value = link;
  shareBox.classList.toggle('hidden', !currentRoomCode);
}
function setRole(role) {
  currentRole = role;
  rolePill.textContent = role === 'host' ? 'Ev sahibi' : 'Misafir';
  rolePill.style.color = role === 'host' ? '#34d399' : '#60a5fa';
  rolePill.style.background = role === 'host' ? 'rgba(52,211,153,0.1)' : 'rgba(96,165,250,0.1)';
}
function createRoom() {
  const name = nameInput.value.trim() || 'Sevgilim';
  nameInput.value = name;
  socket.emit('create-room', { name });
}
function joinRoom() {
  const roomCode = (roomCodeInput.value || '').trim().toUpperCase();
  const name = nameInput.value.trim() || 'Misafir';
  if (!roomCode) { setRoomStatus('Once oda kodunu gir'); return; }
  socket.emit('join-room', { roomCode, name });
}
function handleAutoJoinFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) { roomCodeInput.value = room; joinRoom(); }
}

// ==========================================
// SECTION 9: Socket events
// ==========================================
socket.on('connect', () => { setRoomStatus('Baglandi'); handleAutoJoinFromUrl(); });
socket.on('room-created', ({ roomCode, role, name }) => {
  currentRoomCode = roomCode; roomCodeValue.textContent = roomCode; roomCodeInput.value = roomCode;
  updateShareBox(); setRole(role); setRoomStatus(`${name} odasi hazir`);
});
socket.on('room-joined', ({ roomCode, role, name }) => {
  currentRoomCode = roomCode; roomCodeValue.textContent = roomCode; roomCodeInput.value = roomCode;
  updateShareBox(); setRole(role); setRoomStatus(`${name} odasina katildin`);
});
socket.on('sync-state', (state) => {
  if (!state) return;
  if (currentRoomCode) setRoomStatus('Eszamanlama aktif');
  applySyncState(state);
});
socket.on('video-action', ({ action, currentTime, isPlaying, sender, serverTime }) => {
  if (!currentRoomCode) return;
  if (action === 'buffering') {
    if (bufferUserEl) bufferUserEl.textContent = sender || 'Diger izleyici';
    if (bufferNotice) bufferNotice.classList.remove('hidden');
    if (!playerIsPaused()) { isRemoteAction = true; playerPause(); }
    return;
  }
  if (action === 'buffering-ended') {
    if (bufferNotice) bufferNotice.classList.add('hidden');
    if (isPlaying && playerIsPaused()) safePlay();
    return;
  }
  if (bufferNotice) bufferNotice.classList.add('hidden');
  const latency = Math.max(0, (Date.now() - (serverTime || Date.now())) / 1000);
  isRemoteAction = true;
  if (action === 'pause') {
    playerPause();
    if (typeof currentTime === 'number') playerSeek(currentTime);
    setTimeout(() => { isRemoteAction = false; }, 700);
  } else if (action === 'play') {
    const target = currentTime + latency;
    if (Math.abs(playerGetCurrentTime() - target) > 0.5) playerSeek(target);
    safePlay();
    setTimeout(() => { isRemoteAction = false; }, 700);
  } else if (action === 'seek') {
    playerSeek(currentTime);
    setTimeout(() => { isRemoteAction = false; }, 700);
  } else {
    setTimeout(() => { isRemoteAction = false; }, 300);
  }
});
socket.on('chat-history', (msgs) => renderChatHistory(msgs || []));
socket.on('chat-message', appendChatMessage);
socket.on('guest-joined', ({ name }) => setRoomStatus(`${name} odaya katildi`));
socket.on('peer-left', ({ name }) => setRoomStatus(`${name} baglantiyi kesti`));
socket.on('room-error', (msg) => setRoomStatus(msg));

// ==========================================
// SECTION 10: HTML5 video native events
// ==========================================
videoEl.addEventListener('play',    () => { if (!isRemoteAction) sendVideoAction('play',  videoEl.currentTime); });
videoEl.addEventListener('pause',   () => { if (!isRemoteAction) sendVideoAction('pause', videoEl.currentTime); });
videoEl.addEventListener('seeking', () => { if (!isRemoteAction) sendVideoAction('seek',  videoEl.currentTime); });
videoEl.addEventListener('waiting', () => {
  if (!isBufferingLocally) { isBufferingLocally = true; sendVideoAction('buffering', videoEl.currentTime); }
});
videoEl.addEventListener('playing', () => {
  if (isBufferingLocally) { isBufferingLocally = false; sendVideoAction('buffering-ended', videoEl.currentTime); }
});
videoEl.addEventListener('canplay', () => {
  if (isBufferingLocally) { isBufferingLocally = false; sendVideoAction('buffering-ended', videoEl.currentTime); }
});
setInterval(() => {
  if (currentRoomCode && !playerIsPaused()) {
    socket.emit('sync-check', { roomCode: currentRoomCode, currentTime: playerGetCurrentTime(), isPlaying: true });
  }
}, 3500);

// ==========================================
// SECTION 11: Button handlers
// ==========================================
document.querySelector('#createRoomBtn').addEventListener('click', createRoom);
document.querySelector('#joinRoomBtn').addEventListener('click', joinRoom);
document.querySelector('#quickJoinBtn').addEventListener('click', joinRoom);
document.querySelector('#copyLinkBtn').addEventListener('click', async () => {
  if (!currentRoomCode) return;
  await navigator.clipboard.writeText(generateShareLink(currentRoomCode));
  setRoomStatus('Paylasim linki kopyalandi');
});
document.querySelector('#loadVideoBtn').addEventListener('click', () => {
  const url = videoUrlInput.value.trim();
  if (!url) { setRoomStatus('Video URL adresini ekle'); return; }
  const label = (movieTitle.textContent === 'Film baslatilmadi' || movieTitle.textContent === 'Secilen film')
    ? 'Secilen film' : movieTitle.textContent;
  loadVideoFromUrl(url, label);
  setRoomStatus(currentRoomCode ? 'Video yuklendi; her iki tarafta da hazir' : 'Video yuklendi, iyi seyirler!');
});
if (loadSampleBtn) {
  loadSampleBtn.addEventListener('click', () => {
    const url = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    videoUrlInput.value = url;
    loadVideoFromUrl(url, 'Big Buck Bunny (Ornek Test)');
    setRoomStatus('Ornek video yuklendi');
  });
}
if (unlockAudioBtn) {
  unlockAudioBtn.addEventListener('click', () => {
    safePlay();
    if (autoplayOverlay) autoplayOverlay.classList.add('hidden');
  });
}
document.querySelector('#playBtn').addEventListener('click', () => {
  safePlay(); sendVideoAction('play', playerGetCurrentTime());
});
document.querySelector('#pauseBtn').addEventListener('click', () => {
  if (currentRoomCode) isRemoteAction = true;
  playerPause();
  setTimeout(() => { isRemoteAction = false; }, 200);
  sendVideoAction('pause', playerGetCurrentTime());
});
document.querySelector('#syncBtn').addEventListener('click', () => {
  if (!currentRoomCode) return;
  socket.emit('sync-check', { roomCode: currentRoomCode, currentTime: playerGetCurrentTime(), isPlaying: !playerIsPaused() });
  setRoomStatus('Zaman esitlemesi kontrol edildi');
});
document.querySelector('#sendChatBtn').addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });
roomCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

// ==========================================
// SECTION 12: Init
// ==========================================
nameInput.value = 'Sevgilim';
setRole('guest');
updateShareBox();
renderChatHistory([]);
