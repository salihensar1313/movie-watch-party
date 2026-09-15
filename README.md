# Movie Sync

Aynı anda film izleme odası uygulaması.

## Lokal çalıştırma

```bash
npm install
node server.js
```

Açık adres:

```text
http://localhost:3000
```

## Vercel + Render/Railway için

### 1) Backend (Socket.IO)
- Render veya Railway üzerinde Node uygulaması olarak yayınla
- `server.js` dosyasını çalıştıran proje olarak deploy et
- port: `process.env.PORT || 3000`

### 2) Frontend
- Vercel'e repo ekle
- `public` klasörünü servis eden bir yapı kur
- `config.js` içindeki socket URL'yi publish edilen backend URL'si ile güncelle

Örnek:

```js
window.APP_CONFIG = {
  socketUrl: 'https://your-backend-url.onrender.com'
};
```

## Not

Video içeriği doğrudan tarayıcıdan gelir. Bazı platformlar CORS nedeniyle direkt MP4 URL kabul etmeyebilir. Bu yüzden en güvenli kullanım: doğrudan erişilebilen bir MP4 dosyası veya uygun host üzerinde sunulan dosya linki kullanmak.
