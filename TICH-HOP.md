# Tích hợp Vorbis .wem encoder (v2 — khớp format thật) vào nhac-sanh-modder

## Bối cảnh quan trọng
Bản đầu tiên mình gửi (dùng biến thể "header triad") **SAI** — không phải
format game AOV thực tế dùng. Sau khi bạn gửi 2 file `.wem` thật tạo từ
SBank Editor để đối chiếu (`142682346.wem`, `251044735.wem`), mình hex-dump
và phát hiện format thật khác hẳn: `fmt` chunk 66 byte tự chứa luôn field
kiểu `vorb` (không tách chunk riêng), packet header chỉ 2 byte (không có
granule), và quan trọng nhất — **codebook bị nén lại + audio packet bị cắt
bit window-flag (`mod_packets`)**. Bản `v2` này viết lại đúng theo phát
hiện đó, đã test bit-level khớp 100% với 2 file thật.

## File trong gói này
**Mới, copy vào `server/lib/`:**
- `oggParse.js` — bóc gói tin Vorbis thô từ Ogg do ffmpeg tạo
- `bitio.js` — đọc/ghi bit kiểu LSB-first (đúng convention Vorbis)
- `codebookPack.js` — nén codebook chuẩn Vorbis → định dạng Wwise (đảo
  ngược logic `codebook_library::rebuild` của `ww2ogg`)
- `setupPack.js` — nén toàn bộ setup packet (floor/residue/mapping/mode)
  theo đúng bit-width rút gọn của Wwise
- `packAudioPacket.js` — cắt bit packet-type + window-flag khỏi từng gói
  audio (`mod_packets`)
- `wemWriteV2.js` — đóng gói tất cả vào container RIFF/WAVE đúng layout
  thật (fmt 66 byte tự chứa vorb, packet header 2 byte)
- `wemVorbis.js` — **giữ lại nhưng KHÔNG dùng nữa** (biến thể "header
  triad" cũ, sai format thật — chỉ để tham khảo/lịch sử)

**Thay thế:**
- `audioConvert.js` — thêm `toWwiseVorbisBufferV2()` (dùng chính thức),
  giữ nguyên `toWwiseVorbisBuffer()` cũ (không dùng) + toàn bộ hàm PCM cũ
- `index.js` — đổi 1 import + 2 dòng trong route `/api/build`, dùng
  `toWwiseVorbisBufferV2` thay vì bản v1

Không đụng `bnkParser.js`, `bnkPatcher.js`, `supabaseStore.js`,
`bnkCache.js`, `public/*.html`, `package.json`.

## Đã kiểm chứng thế nào
1. Encode thử 2 file WAV test (1 sine đơn giản, 1 pha trộn nhiễu + tremolo
   để ép chuyển đổi short/long block liên tục — bài test khó hơn cho logic
   `mod_packets`) bằng chính pipeline Node này (dùng đúng `ffmpeg-static`
   sẽ chạy trên Render).
2. Build `ww2ogg` (hcs64/ww2ogg, mã nguồn mở) với flag `--inline-codebooks`,
   decode ngược file `.wem` vừa tạo — **thành công cả 2 lần**, ra đúng
   audio Vorbis phát được, duration khớp gốc, âm lượng đúng mức tín hiệu
   (không phải nhiễu/rác).
3. Đối chiếu byte-level cấu trúc `fmt`/`vorb`/packet-header của file do
   tool này tạo với 2 file `.wem` thật bạn gửi — khớp cấu trúc.

## Việc BẠN cần tự làm trước khi tin tưởng 100%
**Test bằng game thật** — đây vẫn là bước duy nhất mình không tự làm được.
`ww2ogg` xác nhận đúng bitstream Vorbis + đúng cấu trúc container y hệt
file thật, độ tin cậy giờ cao hơn nhiều so với bản v1, nhưng chỉ Wwise SDK
thật trong game mới xác nhận 100% được.

## Giới hạn đã biết
- Nếu source Vorbis (từ `libvorbis` chuẩn) dùng `lookup_type` 2 hoặc 3 cho
  codebook, hoặc floor không phải `floor1`, tool sẽ báo lỗi rõ ràng thay vì
  tạo ra file sai — nhưng trường hợp này gần như không xảy ra với
  `ffmpeg`/`libvorbis` mặc định (luôn dùng floor1 + lookup_type 0/1).
- Chưa test loop points (chunk `smpl`) — nếu nhạc cần loop, cần bổ sung.
- `mod_signal` cố định = `0xD9` (theo gợi ý trong comment của `ww2ogg`
  source, không phải giá trị suy ra từ 2 file mẫu) — nếu game từ chối file,
  đây là 1 trong những điểm đầu tiên nên thử đổi thử các giá trị khác.

