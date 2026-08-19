# Xử lý sự cố

## UI không mở được

Trên Pi, chạy `sudo ./scripts/verify.sh`. Nếu dịch vụ đều tốt, mở tunnel với
`-o ExitOnForwardFailure=yes` hoặc dùng `scripts/open-tunnel.sh`. Kiểm tra cổng
local 8080 chưa bị tiến trình khác chiếm; có thể chọn 9080 làm tham số thứ hai.

## Health trả `degraded`

```sh
sudo systemctl status guacd
sudo journalctl -u guacd -n 100 --no-pager
sudo ss -ltnp | grep ':4822'
```

`guacd` phải bind đúng `127.0.0.1:4822`. Kiểm tra native library:

```sh
ldd /opt/guacamole-server/1.6.1-staging/lib/libguac-client-rdp.so.0
ldd /opt/guacamole-server/1.6.1-staging/lib/libguac-client-vnc.so.0
```

Không được có dòng `not found`.

## Kết nối RDP/VNC thất bại

Kiểm tra máy đích dùng literal private IPv4, port đúng và có thể truy cập từ Pi.
Với RDP, thử security `NLA`, `TLS` hoặc `Any`; tài khoản domain có thể cần điền
field Domain. Với VNC, xác nhận server hỗ trợ password auth và color depth 16.

Log gateway cố ý không in credential/token:

```sh
sudo journalctl -u guacamole-lite -u guacd -f
```

## Build guacd lỗi

Xác nhận Pi là ARM64, Debian 13 có repository hoạt động và còn dung lượng:

```sh
uname -m
df -h /opt /tmp
free -h
```

Build dùng `make -j1`. Nếu máy OOM, bật swap trước khi chạy lại. Prefix cũ khi
dùng `--force` được đổi tên thành `.backup-<timestamp>` cạnh prefix hiện tại.

## MemoryMax không có tác dụng

Kiểm tra controller:

```sh
cat /sys/fs/cgroup/cgroup.controllers
systemctl show guacamole-lite -p MemoryCurrent -p MemoryMax
```

Nếu danh sách controller không có `memory`, kernel/boot config phải được thay
đổi trước khi systemd có thể cưỡng chế giới hạn. Đây không phải lỗi unit; V8
heap 80 MiB và giới hạn một phiên vẫn hoạt động.
