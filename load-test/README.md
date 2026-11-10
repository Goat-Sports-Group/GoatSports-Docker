# Load test API đọc (NFR-01)

Cài k6 (`winget install GrafanaLabs.k6`), rồi trong thư mục này:

```bash
k6 run read-api.js                              # chính thức: 20 req/s trong 2 phút vào https://api.goatsports.click
k6 run -e RATE=10 -e DURATION=20s read-api.js   # thử nhanh
```

Chỉ gọi GET công khai (tìm sân, chi tiết sân, tìm giải, tìm CLB, CLB nổi bật). Không đăng nhập, không ghi dữ liệu.
Lỗi quá 1% thì k6 tự dừng. Kết quả lưu ở `results/<thời điểm>-<rate>-<thời lượng>.md` (bảng tóm tắt) và `.json` (số liệu đầy đủ).

## Kết quả 10/11/2026

[results/2026-11-10T03-49-56-411Z-20rps-2m.md](results/2026-11-10T03-49-56-411Z-20rps-2m.md): 2.402 request, 0 lỗi,
0 lần bị 429. Tất cả ngưỡng đều ĐẠT.

| | median | p95 | Ngưỡng |
|---|---|---|---|
| Toàn bộ API | 102 ms | 160 ms | p95 ≤ 500 ms |
| Tìm sân (cache Caffeine) | 99 ms | 160 ms | p95 ≤ 200 ms |

Số đo phía client, đã gồm đường mạng máy đo → Cloudflare → VPS. Thời gian xử lý ở server thấp hơn.

## Vì sao không đo 1.000 req/s

Gateway giới hạn **20 req/s cho mỗi IP, tính riêng từng service** (burst 100,
`backend/api-gateway/.../RateLimiterConfig.java`). Lần đo tăng dần tới 1.000 req/s bị dừng sau 18 giây vì 6,5%
request nhận HTTP 429, toàn bộ ở club-service, phần nhận khoảng 37 req/s
([results/…-ramp1000-dung-vi-429.md](results/2026-11-10T03-45-52-898Z-ramp1000-dung-vi-429.md)).
Một máy đo không thể vượt mức này, và cũng không nên vượt: đây là lớp chống spam.

Lưu ý: production đi qua Cloudflare Tunnel (`cloudflared` → gateway), nên gateway thấy mọi người dùng chung một IP
(IP của container `cloudflared`). Hiện tại giới hạn 20 req/s đang áp cho **toàn hệ thống**, không phải từng người.

## Chống đặt trùng (NFR-02)

Test `BookingConcurrencyTest` trong venue-service: 20 luồng cùng đặt một khung giờ trên PostgreSQL 16 thật
(Testcontainers, cần Docker).

```bash
cd backend/venue-service && mvn test -Dtest=BookingConcurrencyTest
```

| | Thành công | Bị từ chối | Booking trong DB |
|---|---|---|---|
| Có `SELECT … FOR UPDATE` | 1 | 19 | 1 |
| Tạm bỏ khóa (đối chứng) | 20 | 0 | **20** |
