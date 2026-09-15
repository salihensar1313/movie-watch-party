const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms = new Map();
const ROOM_CLEANUP_DELAY = 10 * 60 * 1000; // 10 dakika oda koruma süresi

app.use(express.static(path.join(__dirname, 'public')));

function normalizeRoomCode(code) {
  return String(code || '').trim().toUpperCase();
}

function ensureRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      code: roomCode,
      hostId: null,
      hostName: 'Host',
      cleanupTimer: null,
      state: {
        videoUrl: '',
        title: 'Henüz video seçilmedi',
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        lastUpdated: Date.now(),
        bufferingUser: null
      },
      messages: []
    });
  }

  const room = rooms.get(roomCode);
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  return room;
}

function pushSystemMessage(room, text) {
  const payload = {
    id: Date.now() + Math.random(),
    sender: 'Sistem',
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    isSystem: true
  };
  room.messages.push(payload);
  if (room.messages.length > 50) room.messages.shift();
  return payload;
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name }) => {
    const roomCode = Array.from({ length: 5 }, () => Math.floor(Math.random() * 26) + 65)
      .map((char) => String.fromCharCode(char))
      .join('');

    const normalized = normalizeRoomCode(roomCode);
    const room = ensureRoom(normalized);

    socket.join(normalized);
    socket.data.roomCode = normalized;
    socket.data.name = String(name || 'Ev Sahibi').trim().slice(0, 18);

    room.hostId = socket.id;
    room.hostName = socket.data.name;

    const welcomeMsg = pushSystemMessage(room, `${socket.data.name} odayı oluşturdu.`);

    socket.emit('room-created', {
      roomCode: normalized,
      role: 'host',
      name: socket.data.name
    });

    socket.emit('chat-history', room.messages);
    socket.emit('sync-state', {
      ...room.state,
      serverTime: Date.now()
    });
  });

  socket.on('join-room', ({ roomCode, name }) => {
    const normalized = normalizeRoomCode(roomCode);
    if (!rooms.has(normalized)) {
      socket.emit('room-error', 'Bu oda bulunamadı veya süresi dolmuş.');
      return;
    }

    const room = ensureRoom(normalized);

    socket.join(normalized);
    socket.data.roomCode = normalized;
    socket.data.name = String(name || 'Misafir').trim().slice(0, 18);

    const isHost = room.hostId === socket.id || !room.hostId;
    if (isHost) {
      room.hostId = socket.id;
      room.hostName = socket.data.name;
    }

    const joinMsg = pushSystemMessage(room, `${socket.data.name} odaya katıldı.`);

    socket.emit('room-joined', {
      roomCode: normalized,
      role: isHost ? 'host' : 'guest',
      name: socket.data.name
    });

    socket.emit('chat-history', room.messages);
    socket.emit('sync-state', {
      ...room.state,
      serverTime: Date.now()
    });

    socket.to(normalized).emit('guest-joined', {
      name: socket.data.name
    });
    io.to(normalized).emit('chat-message', joinMsg);
  });

  // Çift Yönlü Video Aksiyonları (Play, Pause, Seek, Buffering)
  socket.on('video-action', ({ roomCode, action, currentTime }) => {
    const normalized = normalizeRoomCode(roomCode);
    const room = rooms.get(normalized);
    if (!room) return;

    const senderName = socket.data.name || 'Biri';
    const now = Date.now();
    let sysText = '';

    if (action === 'play') {
      room.state.isPlaying = true;
      if (typeof currentTime === 'number') room.state.currentTime = currentTime;
      room.state.lastUpdated = now;
      room.state.bufferingUser = null;
      sysText = `${senderName} videoyu başlattı.`;
    } else if (action === 'pause') {
      room.state.isPlaying = false;
      if (typeof currentTime === 'number') room.state.currentTime = currentTime;
      room.state.lastUpdated = now;
      sysText = `${senderName} videoyu durdurdu.`;
    } else if (action === 'seek') {
      if (typeof currentTime === 'number') room.state.currentTime = currentTime;
      room.state.lastUpdated = now;
      const mins = Math.floor(room.state.currentTime / 60);
      const secs = Math.floor(room.state.currentTime % 60).toString().padStart(2, '0');
      sysText = `${senderName} videoyu ${mins}:${secs} konumuna sardı.`;
    } else if (action === 'buffering') {
      room.state.bufferingUser = senderName;
    } else if (action === 'buffering-ended') {
      if (room.state.bufferingUser === senderName) {
        room.state.bufferingUser = null;
      }
    }

    // Olayı diğer kullanıcılara yayınla
    socket.to(normalized).emit('video-action', {
      action,
      currentTime: room.state.currentTime,
      isPlaying: room.state.isPlaying,
      bufferingUser: room.state.bufferingUser,
      sender: senderName,
      serverTime: now
    });

    if (sysText) {
      const msg = pushSystemMessage(room, sysText);
      io.to(normalized).emit('chat-message', msg);
    }
  });

  // Her iki taraf da video yükleyebilir
  socket.on('set-video', ({ roomCode, videoUrl, title }) => {
    const normalized = normalizeRoomCode(roomCode);
    const room = ensureRoom(normalized);

    const senderName = socket.data.name || 'Biri';
    const now = Date.now();

    room.state = {
      ...room.state,
      videoUrl: String(videoUrl || '').trim(),
      title: title || 'Seçilen film',
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      lastUpdated: now,
      bufferingUser: null
    };

    const sysMsg = pushSystemMessage(room, `${senderName} yeni bir video yükledi: "${room.state.title}"`);
    io.to(normalized).emit('chat-message', sysMsg);

    io.to(normalized).emit('sync-state', {
      ...room.state,
      serverTime: now
    });
  });

  // Periyodik kontrol veya manuel eşzamanlama
  socket.on('sync-check', ({ roomCode, currentTime, isPlaying }) => {
    const normalized = normalizeRoomCode(roomCode);
    const room = rooms.get(normalized);
    if (!room) return;

    if (typeof currentTime === 'number' && isPlaying) {
      room.state.currentTime = currentTime;
      room.state.lastUpdated = Date.now();
    }

    socket.emit('sync-state', {
      ...room.state,
      serverTime: Date.now()
    });
  });

  // Geriye dönük uyumluluk için host-update'i de destekle
  socket.on('host-update', ({ roomCode, state }) => {
    const normalized = normalizeRoomCode(roomCode);
    const room = rooms.get(normalized);
    if (!room) return;

    room.state = {
      ...room.state,
      ...state,
      lastUpdated: Date.now()
    };

    socket.to(normalized).emit('sync-state', {
      ...room.state,
      serverTime: Date.now()
    });
  });

  socket.on('send-message', ({ roomCode, text, sender }) => {
    const normalized = normalizeRoomCode(roomCode);
    const room = ensureRoom(normalized);
    const message = String(text || '').trim();

    if (!message) return;

    const payload = {
      id: Date.now() + Math.random(),
      sender: String(sender || socket.data.name || 'Kullanıcı').slice(0, 18),
      text: message.slice(0, 220),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isSystem: false
    };

    room.messages.push(payload);
    if (room.messages.length > 50) room.messages.shift();

    io.to(normalized).emit('chat-message', payload);
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const remainingSockets = io.sockets.adapter.rooms.get(roomCode);
    const memberCount = remainingSockets ? remainingSockets.size : 0;

    if (memberCount === 0) {
      // Kimse kalmadıysa odayı 10 dakika sonra temizle (F5 veya geçici kopmalara karşı koruma)
      room.cleanupTimer = setTimeout(() => {
        rooms.delete(roomCode);
      }, ROOM_CLEANUP_DELAY);
    } else {
      if (room.hostId === socket.id) {
        room.hostId = null;
      }
      socket.to(roomCode).emit('peer-left', {
        name: socket.data.name || 'Bir kullanıcı'
      });
      const leaveMsg = pushSystemMessage(room, `${socket.data.name || 'Bir kullanıcı'} ayrıldı.`);
      socket.to(roomCode).emit('chat-message', leaveMsg);
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Aynı izleme odası çalışıyor: http://localhost:${PORT}`);
});
