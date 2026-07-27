# Batch WAV→WEM debug tool (không đụng bnk)

## Mục đích
Tool riêng để bạn tạo hàng loạt file `.wem` từ nhiều `.wav` cùng lúc, tải
về dạng zip giữ nguyên tên gốc — phục vụ việc gửi hàng loạt cho mình đối
chiếu với file SBank Editor tạo, KHÔNG đụng gì tới `Music_Login.bnk` hay
logic đóng gói đường dẫn `ZIP_DIR`.

## File trong gói này
- `batchRoute.js` → copy vào `server/batchRoute.js` (ngang hàng với
  `index.js`, KHÔNG phải trong `lib/`)
- `batch.html` → copy vào `public/batch.html`

## Nối vào index.js (chỉ thêm, không sửa gì logic cũ)
Thêm 2 dòng sau vào `server/index.js`, đặt sau các `require` khác ở đầu
file và trước `app.listen(...)` ở cuối:

```js
// gần đầu file, cạnh các require khác:
const batchRoute = require('./batchRoute');

// sau các app.use/app.get khác, trước app.listen:
app.use(batchRoute);
```

Không cần sửa gì khác trong `index.js` — route cũ (`/api/build`, patch
bnk...) vẫn giữ nguyên 100%, hoạt động song song bình thường.

## Cách dùng
Vào `https://<domain-của-bạn>/batch.html`, kéo thả nhiều file `.wav`,
bấm "Encode & Tải zip" → được 1 file `batch_wem.zip` chứa từng `.wem`
tương ứng, tên giữ y nguyên bản gốc (chỉ đổi đuôi).

## Lưu ý
- Không patch bnk, không đóng gói theo `ZIP_DIR` — chỉ thuần encode +
  zip, đúng như bạn yêu cầu.
- Nếu 1 file lỗi (ví dụ codebook không khớp thư viện), zip vẫn trả về
  bình thường, chỉ riêng file đó sẽ có thêm file `.ERROR.txt` ghi rõ lỗi,
  không làm hỏng cả batch.
