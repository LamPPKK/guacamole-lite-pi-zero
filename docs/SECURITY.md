# Mô hình bảo mật

## Biên tin cậy

Web gateway không phải dịch vụ LAN: cả cổng 8080 và 4822 chỉ bind
`127.0.0.1`. SSH là biên xác thực và mã hóa cho chặng từ máy trạm tới Pi.
Chặng từ Pi tới máy đích là kết nối RDP/VNC riêng và không nằm trong SSH
tunnel. Không nên sửa unit để bind `0.0.0.0`; nếu cần công khai dịch vụ, hãy
đặt một reverse proxy TLS có xác thực phía trước và đánh giá lại Host/Origin
policy.

## Kiểm soát kết nối

- Chỉ `rdp` và `vnc` được chấp nhận.
- Target phải là literal IPv4 thuộc `10/8`, `172.16/12`, `192.168/16` hoặc
  `100.64/10`. Gateway không resolve hostname, giảm rủi ro DNS rebinding.
- Port, kích thước màn hình, DPI và độ dài text đều có giới hạn.
- Request tạo token yêu cầu same-origin khi browser gửi `Origin`.
- Host header chỉ được phép là loopback hoặc tên `.localhost`.
- WebSocket token được kiểm tra trước khi tạo kết nối tới `guacd`.
- Chỉ một session đồng thời; WebSocket payload tối đa 256 KiB.

## Credential và token

Credential được browser gửi tới gateway qua loopback nằm trong SSH tunnel.
Gateway tạo token sống 300 giây bằng AES-256-CBC với IV ngẫu nhiên và ký toàn
bộ envelope bằng HMAC-SHA256. MAC key được tách từ encryption key qua HKDF.
Token được kiểm tra MAC bằng so sánh constant-time trước khi giải mã.

Token có thể xuất hiện trong bộ nhớ và URL WebSocket của browser trong thời
gian ngắn. Không chia sẻ ảnh DevTools hoặc log proxy có query string. Secret
runtime được sinh ngẫu nhiên khi cài và không nằm trong repo.

## Những gì chưa có

- Không có TLS riêng ở cổng 8080; mã hóa đến từ SSH tunnel.
- Gateway đang đặt `ignore-cert=true` cho RDP để dùng được chứng thư tự ký;
  vì vậy nó không xác minh danh tính máy RDP bằng chứng thư. VNC có thể truyền
  dữ liệu không mã hóa tùy server. Hai rủi ro này nằm trên chặng Pi → máy đích.
- Không có multi-user, audit trail hay lưu credential.
- Không tự vá OS hoặc tự nâng dependency.
- Allowlist private-IP không thay thế firewall egress nếu Pi nằm trong mạng
  không tin cậy.

Khi báo lỗ hổng, không đính kèm token, mật khẩu, private key hoặc nội dung file
`/etc/guacamole-lite/env`.
