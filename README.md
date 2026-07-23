# Nhạc Sảnh Modder

Web tool: upload `.wem` / `.wav` / `.mp3` → server chuyển sang PCM (nếu cần), đo duration
chính xác, **patch lại `Music_Login.bnk`** cho khớp duration, rồi đóng gói tất cả vào
`Nhac_sanh.zip` theo đúng cấu trúc thư mục cài đặt của game.

## Vì sao cần patch cả `.bnk`, không chỉ đổi tên `.wem`?

`Music_Login.bnk` lưu duration (double, ms) của track nhạc sảnh ở **2 chỗ khác nhau**,
phát hiện được từ bản `bnk-analyzer.html` mới nhất:

- **Segment-level** (trong payload `MusicSegment` cha) — lưu lặp 2 lần, đây là field
  chính mà tool ưu tiên hiển thị/sort.
- **Track-own** (trong payload chính `MusicTrack`, gần source struct) — lưu 1 lần,
  giá trị có thể **lệch vài chục ms** so với bản segment (ví dụ thực tế đo được:
  126134.732ms vs 126101.708ms — chênh 33ms, khả năng do trim/fade).

Vì không rõ game thực sự đọc field nào lúc runtime, tool patch **cả 2** để không có
field nào bị lệch/stale so với audio mới.

Nếu chỉ thay `985479411.wem` mà không sửa các giá trị này, game vẫn dùng duration cũ
để tính loop point / timeline — dễ gây cắt nhạc hoặc loop sai chỗ khi bài mod dài/ngắn
khác bài gốc.

## Cấu trúc repo

```
nhac-sanh-modder/
├── package.json
├── public/
│   └── index.html        # frontend (drag&drop upload, gọi /api/build)
└── server/
    ├── index.js           # Express app + endpoint /api/build
    ├── data/
    │   └── Music_Login.bnk   # bản gốc dùng làm reference để patch (KHÔNG bị ghi đè)
    └── lib/
        ├── bnkParser.js    # parser .bnk, port từ bnk-analyzer.html — giữ absolute offset
        ├── bnkPatcher.js   # định vị + ghi đè field duration trong buffer
        └── audioConvert.js # ffmpeg-static/ffprobe-static: đo duration + convert PCM
```

## Cách hoạt động (`/api/build`)

1. Nhận file upload (`multipart/form-data`, field `audio`).
2. Theo phần mở rộng:
   - `.wem` → giữ nguyên byte, không re-encode. Không tự đo được duration (Wwise-Vorbis
     là codec riêng, ffprobe không đọc được) — nếu người dùng biết trước duration, có thể
     gửi kèm field `durationMs` để vẫn patch bnk; nếu không, bnk giữ nguyên.
   - `.wav` / `.mp3` → `ffprobe` đo duration chính xác (ms), `ffmpeg` transcode sang
     PCM 16-bit (`pcm_s16le`) rồi đóng gói dưới tên `.wem`.
3. Đọc `server/data/Music_Login.bnk` (reference gốc), gọi `patchDuration()`:
   - Tìm HIRC object (Sound/MusicTrack) tham chiếu `sourceId = 985479411`.
   - Tìm MusicSegment cha (qua `refIds`) → lấy field duration segment-level (2 offset).
   - Lấy field duration track-own ngay trong payload track đó (1 offset, gần source
     struct — có thể lệch vài chục ms so với bản segment do trim/fade).
   - Ghi đè TẤT CẢ offset tìm được bằng duration mới (giữ nguyên kích thước file —
     chỉ sửa 8 byte double tại từng chỗ).
4. Trả về `Nhac_sanh.zip` chứa cả `985479411.wem` và `Music_Login.bnk` đã patch.

⚠️ **Đường dẫn `Music_Login.bnk` trong zip (`ZIP_BNK_PATH` trong `server/index.js`) là
giả định cùng thư mục với `.wem`.** Cần tự kiểm tra vị trí thật của file `.bnk` trong
game trước khi dùng thật — SoundBank thường không nằm chung thư mục với media rời.

## Chạy local

```bash
npm install
npm start
# mở http://localhost:3000
```

`ffmpeg-static` / `ffprobe-static` tự tải binary phù hợp hệ điều hành lúc `npm install`,
không cần cài ffmpeg hệ thống.

## Deploy lên Render

Xem hướng dẫn chi tiết từng bước (kể cả cách đưa code lên GitHub không cần dòng lệnh)
trong [`DEPLOY.md`](./DEPLOY.md).

Tóm tắt cấu hình Render:
- Build command: `npm install`
- Start command: `npm start`
- Không cần biến môi trường bắt buộc (server tự lấy `process.env.PORT`).
- `ffmpeg-static`/`ffprobe-static` tự tải binary native theo platform lúc `npm install`
  — Render (Linux) tự tải đúng bản, không cần cấu hình thêm.

## Việc còn để ngỏ / hướng phát triển tiếp

- [ ] Xác nhận lại đường dẫn thật của `Music_Login.bnk` trong cấu trúc thư mục game.
- [ ] Cân nhắc cho phép người dùng tự upload `Music_Login.bnk` của họ thay vì dùng bản
      bundle sẵn trong `server/data/`, để tránh lệch version.
- [ ] Vorbis encode thật (thay vì PCM) — cần Wwise Authoring Tool / WwiseConsole, không
      làm được thuần server-side/browser (xem trao đổi trước).
- [ ] Giới hạn rate limit / kích thước upload nếu deploy public.
