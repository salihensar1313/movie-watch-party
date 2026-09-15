const socketUrl = window.APP_CONFIG?.socketUrl || window.location.origin;
const socket = io(socketUrl, {
  transports: ['websocket', 'polling']
});

const nameInput = document.querySelector('#nameInput');
const roomCodeInput = document.querySelector('#roomCodeInput');
const videoUrlInput = document.querySelector('#videoUrlInput');
const roomStatusText = document.querySelector('#roomStatusText');
const roomCodeValue = document.querySelector('#roomCodeValue');
const rolePill = document.querySelector('#rolePill');
const movieTitle = document.querySelector('#movieTitle');
const videoPlayer = document.querySelector('#videoPlayer');
const emptyState = document.querySelector('#emptyState');
const shareBox = document.querySelector('#shareBox');
const shareLinkInput = document.querySelector('#shareLinkInput');
const chatMessages = document.querySelector('#chatMessages');
const chatInput = document.querySelector('#chatInput');
const chatCounter = document.querySelector('#chatCounter');

// Yeni UI elementleri
const syncDiffText = document.querySelector('#syncDiffText');
const bufferNotice = document.querySelector('#bufferNotice');
const bufferUser = document.querySelector('#bufferUser');
const autoplayOverlay = document.querySelector('#autoplayOverlay');
const unlockAudioBtn = document.querySelector('#unlockAudioBtn');
const playbackSpeedBadge = document.querySelector('#playbackSpeedBadge');
const loadSampleBtn = document.querySelector('#loadSampleBtn');

let currentRoomCode = '';
let currentRole = 'guest';
let isRemoteAction = false;
let isBufferingLocally = false;
let lastSyncState = null;

function setRoomStatus(text) {
  roomStatusText.textContent = text;
}

function setPlaybackRate(rate) {
  if (Math.abs(videoPlayer.playbackRate - rate) > 0.01) {
    videoPlayer.playbackRate = rate;
  }
  if (playbackSpeedBadge) {
    playbackSpeedBadge.textContent = `Hız: ${rate.toFixed(2)}x`;
    playbackSpeedBadge.style.color = rate === 1.0 ? 'var(--muted)' : 'var(--pink)';
  }
}

function updateSyncDisplay(absDiff, rate) {
  if (!syncDiffText) return;
  if (!currentRoomCode) {
    syncDiffText.textContent = 'Solo İzleme';
    return;
  }
  if (absDiff < 0.15) {
    syncDiffText.textContent = `Tam Senkron (±${Math.round(absDiff * 1000)}ms)`;
  } else if (absDiff <= 1.5) {
    syncDiffText.textContent = `Hızla Eşitleniyor (${(rate || 1).toFixed(2)}x)`;
  } else {
    syncDiffText.textContent = `Fark: ${absDiff.toFixed(1)}s`;
  }
}

function formatChatMessage(message) {
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message${message.isSystem ? ' system-chat-message' : ''}`;

  const header = document.createElement('div');
  header.className = 'chat-meta';
  header.innerHTML = `<strong>${message.sender}</strong><span>${message.time}</span>`;

  const text = document.createElement('div');
  text.className = 'chat-text';
  text.textContent = message.text;

  wrapper.appendChild(header);
  wrapper.appendChild(text);
  return wrapper;
}

function renderChatHistory(messages = []) {
  chatMessages.innerHTML = '';
  messages.forEach((message) => {
    chatMessages.appendChild(formatChatMessage(message));
  });
  chatCounter.textContent = messages.length;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendChatMessage(message) {
  const item = formatChatMessage(message);
  chatMessages.appendChild(item);
  chatCounter.textContent = chatMessages.children.length;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

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
  rolePill.style.background = role === 'host' ? 'rgba(52, 211, 153, 0.1)' : 'rgba(96, 165, 250, 0.1)';
}

function loadVideoFromUrl(url, title = 'Seçilen film') {
  if (!url) return;

  if (currentRoomCode) isRemoteAction = true;
  videoPlayer.src = url;
  videoPlayer.load();
  movieTitle.textContent = title;
  emptyState.classList.add('hidden');
  setTimeout(() => { isRemoteAction = false; }, 300);

  if (currentRoomCode) {
    socket.emit('set-video', {
      roomCode: currentRoomCode,
      videoUrl: url,
      title
    });
  }
}

function safePlay() {
  if (currentRoomCode) isRemoteAction = true;
  const promise = videoPlayer.play();
  if (promise !== undefined) {
    promise
      .then(() => {
        if (autoplayOverlay) autoplayOverlay.classList.add('hidden');
      })
      .catch((err) => {
        console.warn('Autoplay uyarısı:', err);
        if (autoplayOverlay) autoplayOverlay.classList.remove('hidden');
        setRoomStatus('Oynatmak ve sesi açmak için ekrana tıkla');
      })
      .finally(() => {
        setTimeout(() => { isRemoteAction = false; }, 250);
      });
  } else {
    setTimeout(() => { isRemoteAction = false; }, 250);
  }
}

function sendVideoAction(action, time = null) {
  if (!currentRoomCode || isRemoteAction) return;
  const currentTime = typeof time === 'number' ? time : videoPlayer.currentTime;

  socket.emit('video-action', {
    roomCode: currentRoomCode,
    action,
    currentTime
  });
}

function adjustPlaybackDrift(diff) {
  const absDiff = Math.abs(diff);

  if (absDiff < 0.12) {
    // Kusursuz salise senkronu (<120ms)
    setPlaybackRate(1.0);
  } else if (absDiff <= 1.5) {
    // Takılma ve duraksama olmadan yumuşak hız ayarı
    if (diff < 0) {
      setPlaybackRate(1.08); // Gerideyiz, hafifçe hızlanıp yakala
    } else {
      setPlaybackRate(0.92); // Öndeyiz, hafifçe yavaşlayıp bekle
    }
  } else {
    // Fark 1.5 saniyeden büyükse direkt zamanı eşitle
    isRemoteAction = true;
    const expectedTime = videoPlayer.currentTime - diff;
    videoPlayer.currentTime = expectedTime;
    setPlaybackRate(1.0);
    setTimeout(() => { isRemoteAction = false; }, 300);
  }

  updateSyncDisplay(absDiff, videoPlayer.playbackRate);
}

function applySyncState(state) {
  if (!state || !state.videoUrl) return;
  lastSyncState = state;

  if (videoPlayer.src !== state.videoUrl) {
    isRemoteAction = true;
    videoPlayer.src = state.videoUrl;
    videoPlayer.load();
    setTimeout(() => { isRemoteAction = false; }, 300);
  }

  if (state.title) {
    movieTitle.textContent = state.title;
  }
  emptyState.classList.add('hidden');

  if (state.bufferingUser) {
    if (bufferUser) bufferUser.textContent = state.bufferingUser;
    if (bufferNotice) bufferNotice.classList.remove('hidden');
  } else {
    if (bufferNotice) bufferNotice.classList.add('hidden');
  }

  const elapsed = state.isPlaying
    ? Math.max(0, (Date.now() - (state.lastUpdated || Date.now())) / 1000)
    : 0;
  const expectedTime = Number(state.currentTime || 0) + elapsed;
  const diff = videoPlayer.currentTime - expectedTime;
  const absDiff = Math.abs(diff);

  if (state.isPlaying) {
    if (videoPlayer.paused) {
      isRemoteAction = true;
      videoPlayer.currentTime = expectedTime;
      safePlay();
    } else {
      adjustPlaybackDrift(diff);
    }
  } else {
    if (!videoPlayer.paused) {
      isRemoteAction = true;
      videoPlayer.pause();
      setTimeout(() => { isRemoteAction = false; }, 200);
    }
    if (absDiff > 0.5) {
      isRemoteAction = true;
      videoPlayer.currentTime = expectedTime;
      setTimeout(() => { isRemoteAction = false; }, 200);
    }
    setPlaybackRate(1.0);
    updateSyncDisplay(absDiff, 1.0);
  }
}

function createRoom() {
  const name = nameInput.value.trim() || 'Sevgilim';
  nameInput.value = name;
  socket.emit('create-room', { name });
}

function joinRoom() {
  const roomCode = (roomCodeInput.value || '').trim().toUpperCase();
  const name = nameInput.value.trim() || 'Misafir';
  if (!roomCode) {
    setRoomStatus('Önce oda kodunu gir');
    return;
  }

  socket.emit('join-room', { roomCode, name });
}

function handleAutoJoinFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) {
    roomCodeInput.value = room;
    joinRoom();
  }
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !currentRoomCode) return;

  socket.emit('send-message', {
    roomCode: currentRoomCode,
    sender: nameInput.value.trim() || 'Kullanıcı',
    text
  });

  chatInput.value = '';
}

socket.on('connect', () => {
  setRoomStatus('Bağlandı');
  handleAutoJoinFromUrl();
});

socket.on('room-created', ({ roomCode, role, name }) => {
  currentRoomCode = roomCode;
  roomCodeValue.textContent = roomCode;
  roomCodeInput.value = roomCode;
  updateShareBox();
  setRole(role);
  setRoomStatus(`${name} odası hazır`);
});

socket.on('room-joined', ({ roomCode, role, name }) => {
  currentRoomCode = roomCode;
  roomCodeValue.textContent = roomCode;
  roomCodeInput.value = roomCode;
  updateShareBox();
  setRole(role);
  setRoomStatus(`${name} odasına katıldın`);
});

socket.on('sync-state', (state) => {
  if (!state) return;
  if (currentRoomCode) {
    setRoomStatus('Eşzamanlama aktif');
  }
  applySyncState(state);
});

// Çift yönlü aksiyonlar (Diğer kullanıcıdan gelen eylemler)
socket.on('video-action', ({ action, currentTime, isPlaying, bufferingUser, sender, serverTime }) => {
  if (!currentRoomCode) return;

  if (action === 'buffering') {
    if (bufferUser) bufferUser.textContent = sender || 'Diğer izleyici';
    if (bufferNotice) bufferNotice.classList.remove('hidden');
    if (!videoPlayer.paused) {
      isRemoteAction = true;
      videoPlayer.pause();
      setTimeout(() => { isRemoteAction = false; }, 200);
    }
    return;
  }

  if (action === 'buffering-ended') {
    if (bufferNotice) bufferNotice.classList.add('hidden');
    if (isPlaying && videoPlayer.paused) {
      safePlay();
    }
    return;
  }

  if (bufferNotice) bufferNotice.classList.add('hidden');

  const networkLatency = Math.max(0, (Date.now() - (serverTime || Date.now())) / 1000);
  const targetTime = currentTime + (action === 'play' ? networkLatency : 0);

  if (action === 'pause') {
    isRemoteAction = true;
    videoPlayer.pause();
    if (typeof currentTime === 'number') {
      videoPlayer.currentTime = currentTime;
    }
    setTimeout(() => { isRemoteAction = false; }, 250);
  } else if (action === 'play') {
    isRemoteAction = true;
    if (Math.abs(videoPlayer.currentTime - targetTime) > 0.4) {
      videoPlayer.currentTime = targetTime;
    }
    safePlay();
  } else if (action === 'seek') {
    isRemoteAction = true;
    videoPlayer.currentTime = currentTime;
    setTimeout(() => { isRemoteAction = false; }, 300);
  }
});

socket.on('chat-history', (messages) => {
  renderChatHistory(messages || []);
});

socket.on('chat-message', (message) => {
  appendChatMessage(message);
});

socket.on('guest-joined', ({ name }) => {
  setRoomStatus(`${name} odaya katıldı`);
});

socket.on('peer-left', ({ name }) => {
  setRoomStatus(`${name} bağlantıyı kesti`);
});

socket.on('room-error', (message) => {
  setRoomStatus(message);
});

// Video oynatıcı olayları (Kullanıcının doğrudan video üzerinden yaptığı eylemler)
videoPlayer.addEventListener('play', () => {
  if (isRemoteAction) return;
  sendVideoAction('play', videoPlayer.currentTime);
});

videoPlayer.addEventListener('pause', () => {
  if (isRemoteAction) return;
  sendVideoAction('pause', videoPlayer.currentTime);
});

videoPlayer.addEventListener('seeking', () => {
  if (isRemoteAction) return;
  sendVideoAction('seek', videoPlayer.currentTime);
});

videoPlayer.addEventListener('waiting', () => {
  if (!isBufferingLocally) {
    isBufferingLocally = true;
    sendVideoAction('buffering', videoPlayer.currentTime);
  }
});

videoPlayer.addEventListener('playing', () => {
  if (isBufferingLocally) {
    isBufferingLocally = false;
    sendVideoAction('buffering-ended', videoPlayer.currentTime);
  }
});

videoPlayer.addEventListener('canplay', () => {
  if (isBufferingLocally) {
    isBufferingLocally = false;
    sendVideoAction('buffering-ended', videoPlayer.currentTime);
  }
});

// Kontrol Butonları (Hem host hem misafir için aktif)
document.querySelector('#createRoomBtn').addEventListener('click', createRoom);
document.querySelector('#joinRoomBtn').addEventListener('click', joinRoom);
document.querySelector('#quickJoinBtn').addEventListener('click', joinRoom);
document.querySelector('#copyLinkBtn').addEventListener('click', async () => {
  if (!currentRoomCode) return;
  const link = generateShareLink(currentRoomCode);
  await navigator.clipboard.writeText(link);
  setRoomStatus('Paylaşım linki kopyalandı');
});

document.querySelector('#loadVideoBtn').addEventListener('click', () => {
  const url = videoUrlInput.value.trim();
  const label = movieTitle.textContent === 'Film başlatılmadı' ? 'Seçilen film' : movieTitle.textContent;
  if (!url) {
    setRoomStatus('Video URL adresini ekle');
    return;
  }
  loadVideoFromUrl(url, label || 'Seçilen film');
  setRoomStatus(currentRoomCode ? 'Video yüklendi; her iki tarafta da hazır' : 'Video yüklendi, iyi seyirler!');
});

if (loadSampleBtn) {
  loadSampleBtn.addEventListener('click', () => {
    const sampleUrl = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    videoUrlInput.value = sampleUrl;
    loadVideoFromUrl(sampleUrl, 'Big Buck Bunny (Örnek Test Filmi)');
    setRoomStatus('Örnek video yüklendi');
  });
}

if (unlockAudioBtn) {
  unlockAudioBtn.addEventListener('click', () => {
    safePlay();
    if (autoplayOverlay) autoplayOverlay.classList.add('hidden');
  });
}

document.querySelector('#playBtn').addEventListener('click', () => {
  safePlay();
  sendVideoAction('play', videoPlayer.currentTime);
});

document.querySelector('#pauseBtn').addEventListener('click', () => {
  if (currentRoomCode) isRemoteAction = true;
  videoPlayer.pause();
  setTimeout(() => { isRemoteAction = false; }, 200);
  sendVideoAction('pause', videoPlayer.currentTime);
});

document.querySelector('#syncBtn').addEventListener('click', () => {
  if (!currentRoomCode) return;
  socket.emit('sync-check', {
    roomCode: currentRoomCode,
    currentTime: videoPlayer.currentTime,
    isPlaying: !videoPlayer.paused
  });
  setRoomStatus('Zaman eşitlemesi kontrol edildi');
});

// Periyodik kontrol: Oynatma esnasında sapmaları sessizce düzelt
setInterval(() => {
  if (currentRoomCode && !videoPlayer.paused) {
    socket.emit('sync-check', {
      roomCode: currentRoomCode,
      currentTime: videoPlayer.currentTime,
      isPlaying: !videoPlayer.paused
    });
  }
}, 3500);

document.querySelector('#sendChatBtn').addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendChatMessage();
});

roomCodeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinRoom();
});

nameInput.value = 'Sevgilim';
setRole('guest');
updateShareBox();
renderChatHistory([]);
