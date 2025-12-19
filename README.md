# 📡 EMG Frame Stream Server

Một server thời gian thực để thu thập, lưu trữ và trực quan hóa dữ liệu EMG từ thiết bị ESP32 với giao diện dashboard và API đầy đủ.

## 🌐 Server Host
```
https://dimension-remarks-promising-notebooks.trycloudflare.com
```

## 🚀 Tính năng chính

- **📡 Real-time WebSocket Streaming**: Truyền dữ liệu EMG thời gian thực
- **💾 Frame Storage**: Lưu trữ tối đa 1000 frames gần nhất
- **📊 Interactive Dashboard**: Giao diện trực quan hóa dữ liệu
- **🔌 RESTful API**: API endpoints để truy vấn dữ liệu
- **📈 Thống kê thời gian thực**: Theo dõi hiệu suất và chất lượng dữ liệu
- **🔧 Multi-device Support**: Hỗ trợ nhiều thiết bị ESP32 cùng lúc

## 📡 API Endpoints

### 🔌 Data Ingestion
| Method | Endpoint | Mô tả |
|--------|----------|--------|
| **POST** | `/api/emg` | Nhận dữ liệu frame từ ESP32 |
| **GET** | `/api/status` | Kiểm tra trạng thái server |

### 💾 Frame Storage & Retrieval
| Method | Endpoint | Query Parameters | Mô tả |
|--------|----------|------------------|--------|
| **GET** | `/api/frames` | `limit`, `deviceId` | Lấy tất cả frames đang lưu |
| **GET** | `/api/frames/latest` | `deviceId` | Lấy frame mới nhất |
| **GET** | `/api/frames/range` | `start`, `end`, `deviceId` | Lấy frames theo khoảng thời gian |
| **GET** | `/api/frames/:sequence` | `deviceId` | Lấy frame theo số thứ tự |
| **DELETE** | `/api/frames` | - | Xóa tất cả frames |

### ⚙️ Server Management
| Method | Endpoint | Query Parameters | Mô tả |
|--------|----------|------------------|--------|
| **POST** | `/api/reset` | `clearFrames=true` | Đặt lại thống kê (và xóa frames nếu cần) |

## 🔗 WebSocket Events

Server hỗ trợ WebSocket cho kết nối thời gian thực:

### 📤 Events từ Server:
- **`frame`**: Dữ liệu frame mới
- **`stats`**: Cập nhật thống kê
- **`reset`**: Thông báo reset server

### 📥 Messages đến Server:
- **JSON data**: Gửi dữ liệu tùy ý để broadcast

## 📊 Dashboard Features

Dashboard truy cập tại `/` cung cấp:

- **📈 Real-time Data Visualization**: Hiển thị dữ liệu EMG thời gian thực
- **🔢 Live Statistics**: 
  - Frames nhận được
  - Samples tổng cộng
  - Frames bị mất
  - Frame rate hiện tại
  - Số frames đang lưu
- **🎮 Control Panel**:
  - Pause/Resume stream
  - Reset statistics
  - Download stored data
  - Clear stored frames
- **📋 Data Log**: Hiển thị log frames theo thời gian thực

## 📦 Cấu trúc dữ liệu

### Frame Data Format (POST `/api/emg`):
```json
{
  "deviceId": "ESP32_001",
  "frameSequence": 123,
  "samplingRate": 1000,
  "samplesInFrame": 10,
  "samples": [
    {
      "timestamp": 1640995200000,
      "ch0": { "raw": 512, "filtered": 510 },
      "ch1": { "raw": 498, "filtered": 500 }
    }
  ]
}
```

### Response Format:
```json
{
  "success": true,
  "frameSequence": 123,
  "samplesReceived": 10
}
```

### Stored Frame Format:
```json
{
  "deviceId": "ESP32_001",
  "frameSequence": 123,
  "samplingRate": 1000,
  "samplesInFrame": 10,
  "samples": [...],
  "receivedAt": "2024-01-01T00:00:00.000Z",
  "serverTimestamp": 1640995200000
}
```

## 🛠️ Cài đặt & Chạy

### Yêu cầu:
- Node.js ≥ 14.x
- npm hoặc yarn

### Cài đặt:
```bash
# Clone repository (nếu có)
git clone <repository-url>
cd <project-directory>

# Cài đặt dependencies
npm install express ws body-parser
```

### Chạy server:
```bash
node server.js
```

Hoặc với cổng tùy chỉnh:
```bash
PORT=3000 node server.js
```

### Docker (tùy chọn):
```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

## 📡 ESP32 Integration

Gửi dữ liệu từ ESP32 đến server:

```cpp
// Ví dụ code ESP32
void sendEMGFrame(String serverUrl) {
  HTTPClient http;
  http.begin(serverUrl + "/api/emg");
  http.addHeader("Content-Type", "application/json");
  
  String jsonData = "{";
  jsonData += "\"deviceId\":\"ESP32_001\",";
  jsonData += "\"frameSequence\":1,";
  jsonData += "\"samplingRate\":1000,";
  jsonData += "\"samplesInFrame\":10,";
  jsonData += "\"samples\":[";
  // Thêm dữ liệu samples
  jsonData += "]";
  jsonData += "}";
  
  int httpCode = http.POST(jsonData);
  
  if (httpCode > 0) {
    String response = http.getString();
    Serial.println("Response: " + response);
  }
  
  http.end();
}
```

## 📊 Thống kê Server

Server theo dõi các metrics sau:
- **Frames Received**: Tổng số frames nhận được
- **Samples Received**: Tổng số samples
- **Dropped Frames**: Frames bị mất do network issues
- **Per-device Stats**: Thống kê riêng cho từng thiết bị
- **Frame Rate**: Tốc độ nhận frames hiện tại

## 🔒 Bảo mật & Tối ưu

### Cấu hình hiện tại:
- **Body Size Limit**: 10MB cho POST requests
- **Frame Storage**: Giới hạn 1000 frames (có thể điều chỉnh)
- **WebSocket Timeout**: Tự động reconnect khi mất kết nối

### Mở rộng (nếu cần):
1. Thêm authentication cho API endpoints
2. Implement rate limiting
3. Thêm database persistence
4. Enable CORS cho cross-origin requests
5. Implement SSL/TLS cho production

## 🐛 Debug & Monitoring

### Logs Server:
```
✓ Frame #123 from ESP32_001: 10 samples @ 1000Hz
⚠️  Dropped 2 frame(s) from ESP32_001
📱 Client connected via WebSocket
📴 Client disconnected
```

### Kiểm tra trạng thái:
```bash
# Kiểm tra server status
curl https://dimension-remarks-promising-notebooks.trycloudflare.com/api/status

# Kiểm tra stored frames
curl https://dimension-remarks-promising-notebooks.trycloudflare.com/api/frames?limit=5
```

## 📝 Sử dụng ví dụ

### 1. Gửi dữ liệu từ ESP32:
```bash
curl -X POST https://dimension-remarks-promising-notebooks.trycloudflare.com/api/emg \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "ESP32_TEST",
    "frameSequence": 1,
    "samplingRate": 1000,
    "samplesInFrame": 5,
    "samples": [
      {"timestamp": 1640995200000, "ch0": {"raw": 500}, "ch1": {"raw": 490}}
    ]
  }'
```

### 2. Truy vấn dữ liệu:
```bash
# Lấy 10 frames mới nhất
curl https://dimension-remarks-promising-notebooks.trycloudflare.com/api/frames?limit=10

# Lấy frames từ 1 giờ trước
curl "https://dimension-remarks-promising-notebooks.trycloudflare.com/api/frames/range?start=$(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%SZ)"

# Lấy frame số 123
curl https://dimension-remarks-promoting-notebooks.trycloudflare.com/api/frames/123
```

### 3. WebSocket Connection:
```javascript
const ws = new WebSocket('wss://dimension-remarks-promising-notebooks.trycloudflare.com');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

## 📁 Project Structure
```
server.js              # Main server file
public/                # Static files (if any)
README.md              # This documentation
```

## 🤝 Đóng góp

1. Fork repository
2. Tạo feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Mở Pull Request

## 📄 License

MIT License - xem file LICENSE để biết thêm chi tiết.

## 👥 Tác giả

- **Maintainer**: Server Development Team
- **Contact**: [Server Host URL](#-server-host)

