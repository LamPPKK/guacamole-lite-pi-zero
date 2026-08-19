# Guacamole Lite cho Raspberry Pi Zero 2 W

Web UI RDP/VNC tối giản dành cho Raspberry Pi ARM64 ít RAM. Gateway Node.js và
`guacd` chỉ lắng nghe trên loopback; người dùng truy cập qua SSH local-forward,
không mở cổng web ra LAN.

![Giao diện PI//REMOTE](docs/ui-preview.svg)

## Có gì trong repo

- UI responsive từ 320 px, hỗ trợ chuột, bàn phím, cảm ứng và toàn màn hình.
- Gateway `guacamole-lite` 1.2.0 với token 5 phút, mã hóa AES-256-CBC và xác
  thực HMAC-SHA256.
- Chỉ cho phép RDP/VNC tới IPv4 riêng (RFC1918 và CGNAT), tối đa một phiên.
- Apache `guacd` khóa tại commit
  `f22a2df129d9ecf279466e9bcf44cd026e23e6bd` của nhánh `staging/1.6.1`.
- Service systemd được sandbox, giới hạn V8 heap 80 MiB và khai báo giới hạn
  bộ nhớ cho cgroup.
- Script build, cài, kiểm tra, mở tunnel, rollback và gỡ cài đặt.

Không dùng Docker, Tomcat, Java, database hay reverse proxy. Bộ cài không sửa
cấu hình SSH, WARP, Cloudflared, Samba hoặc Pi Connect.

## Yêu cầu

- Raspberry Pi OS/Debian 13 ARM64 (`aarch64`).
- Node.js và npm; Node.js 20 trở lên.
- systemd và kết nối Internet trong lần build/cài đầu tiên.
- Máy trạm có SSH client.

Pi Zero 2 W build `guacd` bằng một luồng để tránh cạn RAM. Quá trình có thể mất
khá lâu; nên bật swap và giữ một phiên SSH dự phòng. Source và npm dependency
đều được khóa bằng commit/version, nhưng gói Debian vẫn lấy từ repository đang
cấu hình trên máy.

## Cài đặt

Trên Pi:

```sh
git clone https://github.com/LamPPKK/guacamole-lite-pi-zero.git
cd guacamole-lite-pi-zero
sudo ./scripts/install.sh
```

Nếu `guacd` đúng phiên bản đã có sẵn:

```sh
sudo ./scripts/install.sh --skip-guacd-build
```

`--no-apt` bỏ qua cài build dependency và phù hợp khi máy đã có đủ thư viện.
Script tạo bản sao cấu hình cũ trong `/var/backups/guacamole-lite-pi/` trước
khi thay thế gateway.

## Truy cập

Từ Mac/Linux/WSL, tại checkout của repo:

```sh
./scripts/open-tunnel.sh pi@pi-host
```

Sau đó mở [http://127.0.0.1:8080](http://127.0.0.1:8080). Có thể chọn một cổng
local khác, ví dụ `./scripts/open-tunnel.sh pi@pi-host 9080`.

Địa chỉ máy RDP/VNC phải là IPv4 riêng. Mặc định RDP dùng cổng 3389 và VNC dùng
cổng 5900. Mật khẩu chỉ tồn tại trong bộ nhớ của tab và token kết nối ngắn hạn;
gateway không ghi credential xuống đĩa hoặc log.

## Kiểm tra và vận hành

```sh
sudo ./scripts/verify.sh
sudo systemctl status guacd guacamole-lite
sudo journalctl -u guacd -u guacamole-lite --since today
curl http://127.0.0.1:8080/healthz
```

Kiểm tra source trước khi commit:

```sh
npm ci --ignore-scripts
./scripts/check.sh
```

Các đường dẫn cài đặt:

| Thành phần | Đường dẫn |
|---|---|
| Gateway và UI | `/opt/guacamole-lite/1.2.0` |
| `guacd` | `/opt/guacamole-server/1.6.1-staging` |
| Secret runtime | `/etc/guacamole-lite/env` |
| Backup installer | `/var/backups/guacamole-lite-pi` |
| Web / guacd | `127.0.0.1:8080` / `127.0.0.1:4822` |

## Rollback và gỡ cài đặt

Khôi phục bản backup gần nhất:

```sh
sudo ./scripts/rollback.sh
```

Hoặc chỉ định một thư mục timestamp cụ thể dưới
`/var/backups/guacamole-lite-pi/`. Rollback giữ lại prefix `guacd` đã build để
không phải biên dịch lại.

Gỡ gateway nhưng giữ secret, `guacd` và backup:

```sh
sudo ./scripts/uninstall.sh
```

Xóa thêm secret và prefix `guacd`:

```sh
sudo ./scripts/uninstall.sh --purge
```

Các plugin FreeRDP do upstream `make install` đặt trong thư mục plugin hệ thống
không bị tự động xóa, vì chúng có thể đang được chương trình khác sử dụng.
Build cưỡng bức có thể ghi đè plugin cùng tên từ một bản Guacamole khác; nên
dùng Pi chuyên dụng hoặc tự backup các plugin đó trước khi chạy `--force`.

## Ghi chú giới hạn

Build staging này được dùng vì FreeRDP 3 trên Debian 13 cần phần tương thích mới
hơn release Guacamole 1.6.0. Đây là code staging và phần FreeRDP 3 được upstream
đánh dấu thử nghiệm; hãy kiểm thử máy đích trước khi dùng dài hạn.

`MemoryHigh`/`MemoryMax` chỉ có hiệu lực khi kernel bật cgroup v2 memory
controller. Dù không có controller, gateway vẫn giữ V8 heap ở 80 MiB và chặn
phiên đồng thời thứ hai. Xem thêm [kiến trúc](docs/ARCHITECTURE.md),
[mô hình bảo mật](docs/SECURITY.md) và [xử lý sự cố](docs/TROUBLESHOOTING.md).

## Giấy phép

Code riêng của repo dùng MIT. `guacamole-lite`, Apache Guacamole Server và file
client vendored dùng Apache-2.0; xem [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
