# Tích hợp Vorbis .wem encoder vào nhac-sanh-modder

## File trong gói này
- `oggParse.js`   → **mới**, copy vào `server/lib/oggParse.js`
- `wemVorbis.js`  → **mới**, copy vào `server/lib/wemVorbis.js`
- `audioConvert.js` → **thay thế** `server/lib/audioConvert.js` (đã giữ
  nguyên toàn bộ hàm cũ, chỉ thêm `toWwiseVorbisBuffer` + import 2 file mới)
- `index.js` → **thay thế** `server/index.js` (chỉ đổi 2 chỗ: import
  `toWwiseVorbisBuffer` thay vì `toWwisePcmBuffer`, và đổi 3 dòng trong
  nhánh `.wav`/`.mp3` của `/api/build`)

Không đụng gì tới `bnkParser.js`, `bnkPatcher.js`, `supabaseStore.js`,
`bnkCache.js`, `public/*.html`, `package.json` — giữ nguyên 100%.

## Cách hoạt động (tóm tắt)
1. `ffmpeg-static` (đã có sẵn trong `package.json`, không cần cài thêm gì
   trên Render) encode `.wav`/`.mp3` → Ogg Vorbis chuẩn.
2. `oggParse.js` bóc tách các gói tin thô (raw packet) Vorbis từ file Ogg đó.
3. `wemVorbis.js` đóng gói lại các gói tin đó vào container RIFF/WAVE theo
   đúng layout Wwise dùng cho biến thể "header triad present" — biến thể
   **duy nhất** không cần bẻ lại bit-level codebook, nên không cần binary
   độc quyền của Audiokinetic.

Đã build `ww2ogg` (mã nguồn mở, hcs64/ww2ogg) để decode thử ngược file do
chính pipeline Node này tạo ra (dùng đúng `ffmpeg-static`/`ffprobe-static`
sẽ chạy trên Render) — kết quả: decode thành công, audio khớp gốc.

## Việc BẠN cần tự làm trước khi tin tưởng 100%
- **Test bằng file thật trong game** — đây là bước duy nhất mình không thể
  tự làm (không có game). `ww2ogg` xác nhận đúng *bitstream Vorbis*, nhưng
  chỉ Wwise SDK thật trong game mới xác nhận được engine chấp nhận file.
- Nếu game vẫn im lặng không phát: khả năng cao là track gốc dùng loop
  points phức tạp hơn (chunk `smpl`) mà bản này chưa implement — báo mình
  biết để bổ sung.

## Không đổi kiến trúc "wem mới đi kèm bnk"
`toWwiseVorbisBuffer()` chỉ trả về `Buffer` của file `.wem` — index.js vẫn
đóng gói nó vào zip dưới tên `{replacementId}.wem`, y hệt luồng cũ, **không
đụng tới byte nào bên trong `Music_Login.bnk`**. `bnkPatcher.js` vẫn chỉ lo
phần patch ID/duration như trước — đúng như bạn muốn (không sửa wem trong bnk).
