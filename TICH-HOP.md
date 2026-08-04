# Tích hợp Vorbis .wem encoder (v3 — external codebooks, đã fix crash) vào nhac-sanh-modder

## CẬP NHẬT MỚI NHẤT #2 (sau khi bạn gửi logcat + đối chiếu byte-level với sbank_tạo.wem)
Logcat không có dòng nào từ Wwise (bản release đã strip log) — không dò
thêm được qua log. Chuyển sang so sánh byte-by-byte TOÀN BỘ chunk `fmt `
giữa `sbank_tạo.wem` (chạy được) và file web tạo ra (encode cùng 1 file
WAV gốc bạn gửi, để so sánh công bằng) — phát hiện **4 field trong `vorb`
mà bản trước để = 0 nhưng thực tế KHÔNG phải 0**. Đối chiếu thêm 2 file
mẫu thật khác (`142682346.wem`, `251044735.wem`) để có 3 điểm dữ liệu:

- offset `0x08`: luôn bằng chính xác **kích thước chunk `data`** — đã điền đúng
- offset `0x1c`: luôn là **hằng số 16080** ở cả 3 file — đã điền cứng
- offset `0x20`: luôn là **hằng số 16560** ở cả 3 file — đã điền cứng
  (16560−16080=480 không đổi, rất có thể là setting "prefetch" cấp
  project của Wwise, không tính riêng từng file)
- offset `0x18`: biến thiên theo file (392/673/666) — **CHƯA tìm ra công
  thức**, vẫn để 0, là ẩn số cuối cùng còn lại

`ww2ogg` không hề đọc 4 field này (đó là lý do để 0 vẫn "decode được" qua
`ww2ogg`), nhưng Wwise SDK thật trong game có thể dùng chúng để cấp phát
buffer prefetch — nếu sai/thiếu, có thể khiến engine âm thầm từ chối phát
mà không báo lỗi gì.

## CẬP NHẬT MỚI NHẤT #1 (sau khi bạn test: hết crash, nhưng vẫn im lặng không phát)
File giờ decode được bằng SBank Editor (không lỗi), nhưng game vẫn không
phát tiếng. Đối chiếu `mod_signal` giữa 3 file `.wem` thật đã có
(`142682346.wem`, `251044735.wem`, `sbank_tạo.wem`) phát hiện: **`mod_signal`
luôn bằng đúng `first_audio_packet_offset`** (kích thước setup packet + 2),
KHÔNG phải hằng số cố định như suy đoán ban đầu (`0xD9`, theo gợi ý trong
comment của `ww2ogg`). Đã sửa `wemWriteV2.js` để tính `mod_signal` chính
xác theo công thức này thay vì hardcode.


## CẬP NHẬT QUAN TRỌNG (sau khi bạn test và game crash)
Bản v2 trước đó dùng **inline codebook** (nhúng nguyên dữ liệu codebook vào
mỗi file) — SAI. Nhờ bạn gửi crash log (`libAkSoundEngine.so`) + file
`.wem` thật từ SBank Editor để đối chiếu, phát hiện: file thật dùng
**external codebook** (chỉ tham chiếu ID tới thư viện codebook dùng
chung `packed_codebooks.bin`, setup packet ~200 byte) — còn bản inline
của mình tạo setup packet ~3600 byte, gấp 18 lần, khiến
`libAkSoundEngine.so` đọc sai cấu trúc → tràn bộ nhớ → crash cứng game.

**Tin quan trọng:** không cần build encoder mới (aoTuV/managed mode) như
dự tính ban đầu. Đã kiểm chứng bằng thực nghiệm: **100% codebook do
`ffmpeg`/`libvorbis` chuẩn tạo ra (ở mọi mức chất lượng test) đều khớp
sẵn với 1 mục trong `packed_codebooks.bin`** — vì bản chất Vorbis không
"học" codebook riêng từng file, mà luôn chọn từ 1 bộ preset cố định nhỏ.
Nên chỉ cần tra cứu ID thay vì tự nén codebook.

## File trong gói này
**Mới, copy vào `server/lib/`:**
- `packed_codebooks.bin` — **file dữ liệu**, bảng codebook dùng chung (từ
  `hcs64/ww2ogg`, mã nguồn mở), bắt buộc phải có, không phải code
- `oggParse.js`, `bitio.js` — như v2
- `codebookLibrary.js` — **mới**, load `packed_codebooks.bin`, tra cứu ID
  theo "chữ ký cấu trúc" (dims/entries/ordered/lengths) của mỗi codebook
- `codebookPack.js` — giữ lại (dùng chung hàm `bookMaptype1Quantvals`),
  không còn dùng để nhúng inline nữa
- `setupPack.js` — **sửa**: thay vì nhúng full codebook, giờ tra cứu ID
  qua `codebookLibrary.js` rồi ghi 10-bit ID (đúng format thật)
- `packAudioPacket.js`, `wemWriteV2.js` — không đổi so với v2

**Thay thế:**
- `audioConvert.js` — load `packed_codebooks.bin` 1 lần (cache), truyền
  vào `packSetupPacket`
- `index.js` — không đổi thêm gì so với v2 (vẫn gọi `toWwiseVorbisBufferV2`)

## Đã kiểm chứng bằng CHÍNH file thật của bạn
1. Encode thử `MotNgayChangNang-Phao-9400644_hq.wav` (60 giây đầu, quality
   4 ≈ 128kbps gần khớp bitrate ~124kbps của `sbank_tạo.wem`).
2. So sánh cấu trúc: setup packet 217 byte (web) vs 203 byte (sbank thật)
   — cùng tầm cỡ, khác hẳn 3637 byte của bản lỗi trước.
3. `ww2ogg` (không cần cờ `--inline-codebooks` nữa) tự nhận diện đúng
   **"external codebooks (packed_codebooks.bin)"** — giống hệt cách nó
   đọc file `sbank_tạo.wem` thật.
4. Decode ra đúng 60.00 giây, âm lượng thật (mean -12.8dB, max 0dB —
   không phải nhiễu/rác).
5. Test cả Python lẫn Node (đúng `ffmpeg-static` sẽ chạy trên Render) —
   kết quả giống hệt nhau.

## Việc BẠN cần tự làm
**Test bằng game thật** — vẫn là bước cuối duy nhất mình không tự làm
được. Độ tin cậy lần này cao hơn hẳn 2 bản trước (đã đối chiếu trực tiếp
với chính file `.wem` chạy được + log crash thật, không còn suy đoán).

## Nếu VẪN còn lỗi
Rất nên gửi lại: crash log mới (nếu có) + file `.wem` web tạo ra lần này.
Còn 1 khác biệt nhỏ mình cố ý CHƯA xử lý (không nghĩ là nguyên nhân,
nhưng liệt kê để bạn nắm): `mod_signal` cố định `0xD9` khác giá trị thật
(`0xCB`/`0xE6` ở các file mẫu) — theo hiểu biết hiện tại giá trị này chỉ
cần "khác 4 giá trị đặc biệt" để bật `mod_packets`, không cần khớp chính
xác, nhưng nếu game vẫn từ chối, đây là điểm đáng thử đổi tiếp theo.


