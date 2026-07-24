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
├── README.md
├── DEPLOY.md
├── public/
│   ├── index.html         # frontend chính (drag&drop upload, gọi /api/build)
│   └── admin.html          # trang admin (nhập link Catbox + sourceId mới)
└── server/
    ├── index.js            # Express app + /api/build, /api/admin/*
    ├── data/
    │   └── Music_Login.bnk    # bản mặc định bundle sẵn — fallback khi Supabase
    │                           # chưa cấu hình / chưa có admin nào cập nhật
    └── lib/
        ├── bnkParser.js     # parser .bnk, port từ bnk-analyzer.html — giữ absolute offset
        ├── bnkPatcher.js    # định vị + ghi đè sourceId + duration (segment + track) trong buffer
        ├── audioConvert.js  # ffmpeg-static/ffprobe-static: đo duration + convert PCM
        ├── supabaseStore.js # đọc/ghi 1 dòng config { sourceId, replacementId, bnkUrl } trên Supabase
        └── bnkCache.js      # tải .bnk từ link Catbox, cache in-memory (TTL 30s)
```

## Kiến trúc cấu hình động (Supabase + Catbox)

Thay vì upload trực tiếp file `.bnk` (nặng, khó version), admin chỉ nhập **3 giá trị nhỏ**:
- **Source ID** — Media ID nhạc sảnh **gốc** game đang dùng (vd `520249413`). Dùng để
  *tìm* track/duration cần patch trong file `.bnk`.
- **Replacement ID** — Media ID **tuỳ ý, mới** (vd `218149148`). File `.bnk` output sẽ
  được patch để trỏ từ Source ID sang ID này, và file `.wem` trong zip output cũng đặt
  tên theo ID này. Nhờ vậy file `{Source ID}.wem` gốc trên máy game **không bao giờ bị
  ghi đè** — tự động đóng vai trò bản backup, không cần thao tác gì thêm.
- **Link Catbox** — link tới file `Music_Login.bnk` mới nhất, tự upload lên
  [catbox.moe](https://catbox.moe/) trước.

3 giá trị này lưu trong **1 dòng duy nhất** trên bảng Supabase `nhac_sanh_active_config`
(đặt tên có tiền tố riêng để dùng ké chung project Supabase khác mà không đụng bảng có
sẵn) — dữ liệu
ở ngoài Render nên **sống sót qua mọi lần redeploy** (khác bản trước dùng đĩa local, mất
config mỗi lần deploy). Khi có request, server:
1. Đọc config từ Supabase (cache 30 giây để đỡ gọi liên tục).
2. Tải file `.bnk` từ link Catbox trong config đó (cache theo URL — chỉ tải lại khi URL đổi).
3. Nếu Supabase chưa cấu hình / chưa có dòng nào / link lỗi → tự fallback về
   `server/data/Music_Login.bnk` + Source ID mặc định `985479411` bundle sẵn trong repo
   (trường hợp này Replacement ID = Source ID, tức ghi đè tại chỗ như bản cũ).

**Bảo mật:** Supabase Service Role Key chỉ nằm trên server (biến môi trường), không bao
giờ gửi ra browser. Trình duyệt chỉ nói chuyện với `/api/admin/*` của chính app này
(có khoá bằng `ADMIN_PASSWORD`), không gọi thẳng Supabase.

### Schema Supabase cần tạo (chạy 1 lần trong SQL Editor)

```sql
create table if not exists nhac_sanh_active_config (
  id int primary key default 1,
  source_id bigint not null default 985479411,
  replacement_id bigint,
  bnk_url text,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint singleton check (id = 1)
);
```

**Nếu bảng đã tạo từ trước (chưa có cột `replacement_id`)**, chỉ cần chạy thêm:

```sql
alter table nhac_sanh_active_config add column if not exists replacement_id bigint;
```

Không cần thêm RLS policy nào cho client — mọi truy cập đều qua Service Role Key ở
server (tự động bypass RLS), bảng có thể để RLS mặc định (enabled, không có policy nào
cho anon/authenticated) mà vẫn hoạt động bình thường.

## Cách hoạt động (`/api/build`)

1. Nhận file upload (`multipart/form-data`, field `audio`).
2. Theo phần mở rộng:
   - `.wem` → giữ nguyên byte, không re-encode. Không tự đo được duration (Wwise-Vorbis
     là codec riêng, ffprobe không đọc được) — nếu người dùng biết trước duration, có thể
     gửi kèm field `durationMs` để vẫn patch bnk; nếu không, bnk giữ nguyên.
   - `.wav` / `.mp3` → `ffprobe` đo duration chính xác (ms), `ffmpeg` transcode sang
     PCM 16-bit (`pcm_s16le`) rồi đóng gói dưới tên `.wem`.
3. Lấy `.bnk` + `sourceId`/`replacementId` đang active (từ Supabase, hoặc fallback mặc
   định), gọi `patchIdAndDuration()`:
   - Tìm HIRC object (Sound/MusicTrack) tham chiếu `sourceId` (ID gốc game đang dùng).
   - Ghi đè chính field `sourceId` đó thành `replacementId` — bnk giờ trỏ sang ID mới.
   - Tìm MusicSegment cha (qua `refIds`) → lấy field duration segment-level.
   - Lấy field duration track-own ngay trong payload track đó (có thể lệch vài chục ms
     tới vài giây so với bản segment do trim/fade).
   - Ghi đè TẤT CẢ offset duration tìm được bằng duration mới (giữ nguyên kích thước file
     — chỉ sửa field cố định-độ-dài tại từng chỗ, không đổi cấu trúc file).
4. Trả về `Nhac_sanh.zip` chứa `{replacementId}.wem` và `Music_Login.bnk` đã patch —
   file `{sourceId}.wem` gốc trên máy game không đụng tới, tự nhiên thành bản backup.

⚠️ **Đường dẫn `Music_Login.bnk` trong zip (`ZIP_BNK_PATH` trong `server/index.js`) là
giả định cùng thư mục với `.wem`.** Cần tự kiểm tra vị trí thật của file `.bnk` trong
game trước khi dùng thật — SoundBank thường không nằm chung thư mục với media rời.

## Admin panel — cập nhật ID/bnk mới không cần đụng vào repo

Vì game cập nhật liên tục (đổi `.bnk`, đổi Media ID nhạc sảnh), thay vì sửa code + push
lại mỗi lần, dùng trang **`/admin`**:

1. Set 3 biến môi trường trên Render (**Environment**): `ADMIN_PASSWORD`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`. Thiếu `ADMIN_PASSWORD` → trang admin khoá hoàn toàn (503).
   Thiếu 2 biến Supabase → trang vẫn xem được trạng thái nhưng không lưu update mới được.
2. Chạy schema SQL ở trên trong Supabase (1 lần duy nhất).
3. Upload file `.bnk` mới tải từ game lên [catbox.moe](https://catbox.moe/) → copy link.
4. Vào `https://<domain-render-cua-ban>/admin`, đăng nhập, dán **link Catbox** và/hoặc
   nhập **Source ID mới** → **Lưu cấu hình**.
5. Server **validate trước khi lưu**: tải file từ link Catbox, thử định vị field duration
   ứng với sourceId trong đó — không tìm thấy thì báo lỗi ngay, không lưu đè cấu hình
   đang hoạt động (nghĩa là user thật không bao giờ bị ảnh hưởng bởi 1 lần nhập sai).
6. `/api/build` từ giờ tự dùng sourceId + bnk vừa cập nhật (chậm nhất ~30s do cache TTL,
   thường là ngay lập tức vì code đã tự "warm" cache lại sau khi lưu).

Có nút **Reset về bản mặc định** nếu muốn quay lại `.bnk`/ID bundle sẵn trong repo.

✅ Vì config nằm trên Supabase (ngoài Render), **sống sót qua mọi lần redeploy** — khác
hẳn bản trước lưu trên đĩa local của instance. Chỉ cần chú ý: nếu **xoá file trên
Catbox** mà không cập nhật link mới, lần build tiếp theo (sau khi cache hết hạn) sẽ lỗi
tải file — Catbox không cam kết lưu file vĩnh viễn nếu ít người tải, nên nếu dùng lâu dài
nên cân nhắc lưu file `.bnk` ở nơi ổn định hơn (Supabase Storage, S3...).

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
