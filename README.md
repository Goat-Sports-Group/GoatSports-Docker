# GoatSports Infrastructure

Cấu hình triển khai toàn bộ hệ thống GOAT Sports bằng Docker Compose (chạy local và trên VPS qua Dokploy),
cùng Keycloak tùy biến, sao lưu / khôi phục, MongoDB Vector Search và load test.

## Cấu trúc

```
.
├── compose/                     # Docker Compose theo từng nhóm
├── Dockerfile.keycloak-custom   # image Keycloak kèm theme và plugin Kafka
├── realm-export.json            # realm "goatsports" (client, role, cấu hình Google)
├── themes/goatsports/login/     # giao diện trang đăng nhập Keycloak
├── keycloak-kafka-listener/     # plugin Keycloak phát sự kiện người dùng sang Kafka
├── providers/                   # bản build .jar của plugin
├── jenkins/                     # Jenkins nhận lệnh deploy từ GitLab CI
├── backup/                      # sao lưu hằng đêm và khôi phục (xem backup/README.md)
├── mongodb-search/              # MongoDB + mongot cho Vector Search (xem mongodb-search/README.md)
└── load-test/                   # k6 load test API đọc (xem load-test/README.md)
```

## Các file Compose

| File | Dịch vụ |
|---|---|
| `docker-compose-infra.yml` | PostgreSQL, Redis, Kafka, Eureka server |
| `docker-compose-core.yml` | Keycloak, API Gateway, Cloudflare Tunnel |
| `docker-compose-apps.yml` | 11 microservice: auth, venue, notification, report, storage, audit, payment, club, social, workflow, ai |
| `docker-compose-camunda.yml` | Camunda 8 + Elasticsearch (cho workflow-service, khoảng 2 GB RAM) |
| `docker-compose-geocoding.yml` | Nominatim (geocoding tự host) |
| `docker-compose-backup.yml` | Job sao lưu hằng đêm lên Cloudflare R2 |
| `docker-compose-restore-drill.yml` | Diễn tập khôi phục trên mạng và DB riêng |

Tất cả dùng chung mạng `goatsports-network`. Giám sát (Prometheus, Grafana, Loki) nằm ở repo `GoatSports-Observability`.

## Chạy local

Biến môi trường đặt trong `.env` / `.env.dev` (bị `.gitignore`, xin từ nhóm). Khởi động theo thứ tự:

```bash
docker compose -p compose --env-file .env.dev -f compose/docker-compose-infra.yml up -d
docker compose -p compose --env-file .env.dev -f compose/docker-compose-core.yml up -d
docker compose -p compose --env-file .env.dev -f compose/docker-compose-apps.yml up -d
# khi cần hủy sân / vòng đời đặt sân:
docker compose -p compose --env-file .env.dev -f compose/docker-compose-camunda.yml up -d
```

Cổng mặc định: Gateway `7070`, auth `7071`, venue `7072`, notification `7073`, report `7074`, storage `7075`,
workflow `7076`, audit `7077`, payment `7078`, club `7079`, social `7080`, ai `7081`, Eureka `8761`.

**Lưu ý:** container `cloudflared` trong `docker-compose-core.yml` nối vào tunnel của môi trường production.
Tắt nó khi làm việc local.

## Keycloak

- `Dockerfile.keycloak-custom` đóng gói theme đăng nhập và plugin `keycloak-kafka-listener`.
- Plugin phát sự kiện đăng ký / cập nhật người dùng sang Kafka để auth-service đồng bộ tài khoản.
- `.gitlab-ci.yml` build plugin, build và đẩy image Keycloak, rồi gọi Jenkins deploy.

## Triển khai production

GitLab CI của từng service đẩy image lên Docker Hub rồi gọi Jenkins job `GoatSports-CD`; Jenkins
(`jenkins/jenkins.yml`) khởi động lại đúng container trên VPS. Truy cập từ Internet đi qua Cloudflare Tunnel,
VPS không mở cổng ứng dụng ra ngoài.
