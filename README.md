# Wrestle Arena Online

Game 2 người thời gian thực bằng HTML Canvas + Node.js + WebSocket (`ws`), deploy được trên Render.

## Chạy local

```bash
npm install
npm start
```

Mở http://localhost:10000 trong 2 tab/trình duyệt và dùng cùng mã phòng.

## Deploy Render

- Push thư mục này lên GitHub.
- Render → New → Web Service → chọn repo.
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

Render sẽ cung cấp URL `https://...onrender.com`. Client tự dùng `wss://` khi trang chạy HTTPS.
