# Kiến trúc

```text
Browser trên máy trạm
    │ HTTP + WebSocket trên 127.0.0.1
    │ được mang bên trong SSH local-forward
    ▼
127.0.0.1:8080  Node.js gateway / guacamole-lite
    │ Guacamole protocol, loopback
    ▼
127.0.0.1:4822  guacd
    │ RDP hoặc VNC
    ▼
Máy đích IPv4 riêng trong mạng
```

Gateway phục vụ bốn static asset, endpoint `/healthz`, endpoint tạo token
`/api/token` và WebSocket do `guacamole-lite` quản lý. Cùng một process áp dụng
Host/Origin validation, giới hạn body/WebSocket, target allowlist và một phiên
đồng thời.

## Thành phần đã khóa

| Thành phần | Phiên bản/commit |
|---|---|
| Node.js | 20 trở lên từ hệ thống |
| guacamole-lite | 1.2.0 qua `package-lock.json` |
| guacamole-common-js | 1.6.0, checksum trong manifest |
| guacamole-server | `staging/1.6.1` / `f22a2df129d9ecf279466e9bcf44cd026e23e6bd` |

`guacd` được build chỉ với RDP/VNC. Audio, terminal, SSH, Telnet, Kubernetes,
WebP, guacenc và guaclog bị tắt. Cờ `-Wno-deprecated-declarations` là cần thiết
vì bước probe FreeRDP 3 của commit này bật `-Werror`, trong khi header FreeRDP
3.15 trên Debian 13 còn chứa khai báo deprecated.

## Dữ liệu và quyền

- Gateway chạy bằng `DynamicUser` và chỉ đọc source/config.
- `guacd` chạy bằng user hệ thống `guacd`; home là `/var/lib/guacd`.
- Secret chỉ nằm trong `/etc/guacamole-lite/env`, mode `0600`, owner
  `root:root`. systemd đọc file trước khi khởi chạy service.
- Cả hai unit dùng `ProtectSystem=strict`, `NoNewPrivileges`, bỏ capability và
  chỉ cho address family Unix/IPv4/IPv6.

Không có database. Cấu hình kết nối và credential không được lưu bền vững.
