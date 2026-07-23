# Hướng dẫn Deploy lên Render

Vì máy bạn không chạy được `npm` local, cách nhanh nhất để test là deploy thẳng lên
Render — miễn phí cho project nhỏ, không cần cài gì trên máy ngoài Git.

---

## Bước 0 — Chuẩn bị tài khoản

1. Tạo tài khoản GitHub (nếu chưa có): https://github.com/signup
2. Tạo tài khoản Render: https://dashboard.render.com/register — có thể đăng nhập
   thẳng bằng GitHub cho nhanh (Render sẽ tự xin quyền truy cập repo sau).

---

## Bước 1 — Đưa code lên GitHub

Render build từ một repo Git, nên cần đẩy code lên GitHub trước.

### Cách A — Dùng GitHub Desktop (không cần dòng lệnh)

1. Cài GitHub Desktop: https://desktop.github.com/
2. Đăng nhập bằng tài khoản GitHub.
3. `File → Add Local Repository` → chọn thư mục `nhac-sanh-modder` bạn đã giải nén.
4. Nếu nó báo "not a git repository", chọn **"create a repository"** ngay trong hộp
   thoại đó.
5. Điền commit message (vd: "initial commit") → bấm **Commit to main**.
6. Bấm **Publish repository** ở góc trên → đặt tên repo (vd: `nhac-sanh-modder`) →
   bỏ chọn "Keep this code private" nếu muốn public, hoặc giữ private cũng được
   (Render đọc được cả private repo sau khi cấp quyền) → **Publish Repository**.

### Cách B — Dùng web GitHub (kéo thả file, không cần cài gì)

1. Vào https://github.com/new → đặt tên repo (vd: `nhac-sanh-modder`) → **Create repository**.
2. Ở trang repo vừa tạo, bấm **uploading an existing file**.
3. Kéo thả **toàn bộ nội dung bên trong** thư mục `nhac-sanh-modder` (không kéo cả
   thư mục cha) vào khung upload — bao gồm cả các thư mục `server/`, `public/`.
   GitHub web upload giữ được cấu trúc thư mục con khi bạn kéo thả cả folder trên
   Chrome/Edge.
4. Cuộn xuống, bấm **Commit changes**.

> ⚠️ Lưu ý: `server/data/Music_Login.bnk` nặng khoảng 9MB — vẫn nằm trong giới hạn
> upload của GitHub (100MB/file) nên không vấn đề gì, chỉ hơi lâu một chút lúc upload.

---

## Bước 2 — Tạo Web Service trên Render

1. Vào https://dashboard.render.com/ → **New +** → **Web Service**.
2. Chọn **Build and deploy from a Git repository** → **Next**.
3. Nếu chưa kết nối GitHub, bấm **Connect account** và cấp quyền cho Render đọc repo
   (có thể chọn "All repositories" hoặc chỉ chọn riêng repo `nhac-sanh-modder`).
4. Chọn đúng repo `nhac-sanh-modder` vừa tạo → **Connect**.
5. Điền cấu hình:

| Trường | Giá trị |
|---|---|
| **Name** | `nhac-sanh-modder` (hoặc tên tuỳ ý) |
| **Region** | Singapore (gần VN nhất, độ trễ thấp hơn) |
| **Branch** | `main` |
| **Root Directory** | để trống (repo đã đúng cấu trúc gốc) |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | **Free** |

6. Bấm **Create Web Service**.

Render sẽ tự clone repo, chạy `npm install` (bước này tự tải binary `ffmpeg-static` /
`ffprobe-static` — không cần bạn làm gì thêm), rồi chạy `npm start`. Theo dõi log build
ngay trên dashboard, thường mất 1–3 phút cho lần đầu.

---

## Bước 3 — Test

1. Khi log hiện dòng `Nhạc sảnh modder server đang chạy tại http://localhost:...` và
   trạng thái chuyển sang **Live** (chấm xanh), bấm vào URL dạng
   `https://nhac-sanh-modder-xxxx.onrender.com` ở đầu trang.
2. Trang web hiện ra đúng như giao diện `public/index.html` — upload thử một file
   `.wav` hoặc `.mp3` ngắn để kiểm tra.
3. Nhấn nút tạo zip → tải về → giải nén → kiểm tra:
   - `.../985479411.wem` có đúng nội dung file bạn upload không (nếu là .wav/.mp3,
     đây sẽ là PCM WAV đổi tên).
   - `.../Music_Login.bnk` — có thể mở lại bằng chính `bnk-analyzer.html` để soi field
     duration đã đổi đúng theo audio mới chưa.

Nếu muốn kiểm tra nhanh qua `curl` thay vì giao diện web:

```bash
curl -D - -o Nhac_sanh.zip \
  https://nhac-sanh-modder-xxxx.onrender.com/api/build \
  -F "audio=@bai-nhac-cua-ban.wav"
```

Header `X-Patch-Report` trong response sẽ in ra JSON tóm tắt các field duration đã patch.

---

## Cập nhật code sau này

Mỗi lần bạn đẩy commit mới lên nhánh `main` (qua GitHub Desktop: **Commit** → **Push
origin**, hoặc sửa trực tiếp trên web GitHub), Render tự động phát hiện và **deploy
lại** — không cần bấm gì thêm trên dashboard, trừ khi bạn tắt Auto-Deploy.

---

## Lưu ý khi dùng gói Free của Render

- Instance Free sẽ **ngủ (spin down)** sau ~15 phút không có request. Lần truy cập
  đầu tiên sau khi ngủ có thể mất **30–60 giây** để "đánh thức" lại — không phải lỗi,
  cứ đợi.
- Giới hạn 750 giờ chạy/tháng cho gói Free — đủ dùng để test/demo cá nhân.
- Nếu tương lai muốn dùng thật (không bị sleep), có thể nâng lên gói trả phí thấp nhất
  (Starter) trong phần **Settings** của service.

---

## Troubleshooting

**Build fail ở bước `npm install`, log báo lỗi tải `ffmpeg-static`/`ffprobe-static`:**
Thường do rớt mạng tạm thời lúc build — vào dashboard bấm **Manual Deploy → Deploy
latest commit** để build lại.

**Trang mở lên nhưng bấm nút tạo zip báo lỗi 500:**
Xem log real-time trong tab **Logs** trên dashboard Render để đọc thông báo lỗi chi
tiết (thường do file audio upload lỗi định dạng, hoặc quá giới hạn 100MB đã đặt trong
`server/index.js`).

**Muốn đổi PORT hoặc thêm biến môi trường:**
Vào **Environment** trong service → **Add Environment Variable**. Server đã tự đọc
`process.env.PORT` nên bình thường không cần set tay biến này (Render tự inject).
