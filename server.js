const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Store connected clients and stats
let clients = [];
let stats = {
  messagesReceived: 0,
  lastReceiveTime: null,
  devices: {}
};

// Store recent data points
const MAX_STORED_POINTS = 1000;
let recentData = [];

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('📱 Client connected via WebSocket');
  clients.push(ws);

  // Send current stats to new client
  ws.send(JSON.stringify({ type: 'stats', data: stats }));

  ws.on('close', () => {
    console.log('📴 Client disconnected');
    clients = clients.filter(client => client !== ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// HTTP POST endpoint to receive data from ESP32 C6
app.post('/api/emg', (req, res) => {
  try {
    const data = req.body;
    const deviceId = data.deviceId || 'unknown';
    
    // Format nhận từ ESP32 C6:
    // {
    //   "timestamp": 12345,
    //   "deviceId": "ESP32_C6_001",
    //   "channel0": { "rawValue": 100, "averageValue": 95 },
    //   "channel1": { "rawValue": 200, "averageValue": 195 }
    // }
    
    // Update stats
    stats.messagesReceived++;
    stats.lastReceiveTime = new Date().toISOString();
    
    // Track per-device stats
    if (!stats.devices[deviceId]) {
      stats.devices[deviceId] = {
        messagesReceived: 0,
        lastTimestamp: 0
      };
    }
    
    const deviceStats = stats.devices[deviceId];
    deviceStats.messagesReceived++;
    deviceStats.lastTimestamp = data.timestamp;
    
    // Store data point
    const dataPoint = {
      ...data,
      receivedAt: new Date().toISOString(),
      serverTimestamp: Date.now()
    };
    
    recentData.push(dataPoint);
    
    // Keep only recent data
    if (recentData.length > MAX_STORED_POINTS) {
      recentData.shift();
    }
    
    // Log received data
    console.log(`✓ Data from ${deviceId}:`, 
      `CH0[raw:${data.channel0?.rawValue}, avg:${data.channel0?.averageValue}]`,
      `CH1[raw:${data.channel1?.rawValue}, avg:${data.channel1?.averageValue}]`);
    
    // Broadcast to all WebSocket clients
    broadcast({
      type: 'data',
      data: dataPoint,
      stats: {
        totalMessages: stats.messagesReceived,
        device: deviceId
      }
    });
    
    // Quick response to ESP32
    res.json({ 
      success: true,
      timestamp: data.timestamp,
      received: true
    });
    
  } catch (error) {
    console.error('❌ Error processing request:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error processing data',
      error: error.message
    });
  }
});

// Get all recent data
app.get('/api/data', (req, res) => {
  const limit = parseInt(req.query.limit) || recentData.length;
  const deviceId = req.query.deviceId;
  
  let data = recentData;
  
  if (deviceId) {
    data = data.filter(d => d.deviceId === deviceId);
  }
  
  const result = data.slice(-limit);
  
  res.json({
    success: true,
    count: result.length,
    totalStored: recentData.length,
    data: result
  });
});

// Get latest data point
app.get('/api/data/latest', (req, res) => {
  const deviceId = req.query.deviceId;
  
  let dataPoint = null;
  
  if (deviceId) {
    for (let i = recentData.length - 1; i >= 0; i--) {
      if (recentData[i].deviceId === deviceId) {
        dataPoint = recentData[i];
        break;
      }
    }
  } else {
    dataPoint = recentData[recentData.length - 1] || null;
  }
  
  if (dataPoint) {
    res.json({
      success: true,
      data: dataPoint
    });
  } else {
    res.status(404).json({
      success: false,
      message: 'No data available'
    });
  }
});

// Get data by time range
app.get('/api/data/range', (req, res) => {
  const startTime = req.query.start ? new Date(req.query.start).getTime() : 0;
  const endTime = req.query.end ? new Date(req.query.end).getTime() : Date.now();
  const deviceId = req.query.deviceId;
  
  let data = recentData.filter(d => {
    const dataTime = d.serverTimestamp;
    return dataTime >= startTime && dataTime <= endTime;
  });
  
  if (deviceId) {
    data = data.filter(d => d.deviceId === deviceId);
  }
  
  res.json({
    success: true,
    count: data.length,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    data: data
  });
});

// Delete all stored data
app.delete('/api/data', (req, res) => {
  const previousCount = recentData.length;
  recentData = [];
  
  res.json({
    success: true,
    message: 'All data deleted',
    deletedCount: previousCount
  });
});

// Server status
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    connectedClients: clients.length,
    stats: stats,
    storedDataPoints: recentData.length,
    maxStoredPoints: MAX_STORED_POINTS,
    timestamp: new Date().toISOString()
  });
});

// Reset stats
app.post('/api/reset', (req, res) => {
  stats = {
    messagesReceived: 0,
    lastReceiveTime: null,
    devices: {}
  };
  
  if (req.query.clearData === 'true') {
    recentData = [];
  }
  
  broadcast({ type: 'reset' });
  res.json({ 
    success: true, 
    message: 'Stats reset',
    dataCleared: req.query.clearData === 'true'
  });
});

// Broadcast function
function broadcast(message) {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch (error) {
        console.error('Error broadcasting to client:', error);
      }
    }
  });
}

// Serve HTML dashboard
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>EMG Real-time Dashboard</title>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: 'Segoe UI', Arial, sans-serif; 
          background: #0a0a0a; 
          color: #fff;
          padding: 20px;
        }
        .container { max-width: 1600px; margin: 0 auto; }
        h1 { 
          font-size: 28px; 
          margin-bottom: 20px;
          background: linear-gradient(90deg, #00ff88, #00ccff);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 15px;
          margin-bottom: 20px;
        }
        .stat-card {
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          padding: 20px;
          border-radius: 12px;
          border: 1px solid #00ff8844;
          box-shadow: 0 4px 20px rgba(0,255,136,0.1);
        }
        .stat-label {
          font-size: 11px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 8px;
        }
        .stat-value {
          font-size: 32px;
          font-weight: bold;
          background: linear-gradient(90deg, #00ff88, #00ccff);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .controls {
          display: flex;
          gap: 10px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        button {
          padding: 12px 24px;
          background: linear-gradient(135deg, #00ff88, #00ccff);
          color: #0a0a0a;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: bold;
          font-size: 14px;
          transition: all 0.3s;
        }
        button:hover { 
          transform: translateY(-2px);
          box-shadow: 0 4px 20px rgba(0,255,136,0.4);
        }
        button.secondary {
          background: #2a2a3e;
          color: #00ff88;
          border: 1px solid #00ff8844;
        }
        button.secondary:hover { 
          background: #3a3a4e;
          box-shadow: 0 4px 20px rgba(0,255,136,0.2);
        }
        #status {
          display: inline-block;
          padding: 6px 16px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: bold;
          animation: pulse 2s infinite;
        }
        #status.connected {
          background: #00ff88;
          color: #0a0a0a;
        }
        #status.disconnected {
          background: #ff3b30;
          color: #fff;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
        .chart-section {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 20px;
        }
        .chart-container {
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          padding: 20px;
          border-radius: 12px;
          border: 1px solid #00ff8844;
        }
        .chart-container h3 {
          color: #00ff88;
          margin-bottom: 15px;
          font-size: 18px;
        }
        canvas {
          width: 100% !important;
          height: 250px !important;
        }
        #dataLog {
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          padding: 20px;
          height: 400px;
          overflow-y: auto;
          border-radius: 12px;
          border: 1px solid #00ff8844;
          font-family: 'Courier New', monospace;
          font-size: 13px;
        }
        .log-entry {
          padding: 10px;
          border-bottom: 1px solid #00ff8822;
          display: grid;
          grid-template-columns: auto 1fr 1fr;
          gap: 20px;
          transition: all 0.2s;
        }
        .log-entry:hover { 
          background: #00ff8811;
          border-left: 3px solid #00ff88;
          padding-left: 17px;
        }
        .log-time {
          color: #888;
        }
        .log-channel {
          color: #00ff88;
          font-weight: bold;
        }
        .log-value {
          color: #00ccff;
        }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #1a1a2e; }
        ::-webkit-scrollbar-thumb { 
          background: linear-gradient(180deg, #00ff88, #00ccff);
          border-radius: 4px;
        }
        @media (max-width: 768px) {
          .chart-section {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    </head>
    <body>
      <div class="container">
        <h1>⚡ EMG Real-time Monitor</h1>
        
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Connection</div>
            <div class="stat-value">
              <span id="status" class="disconnected">●</span>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Messages</div>
            <div class="stat-value" id="messagesReceived">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Stored Points</div>
            <div class="stat-value" id="storedPoints">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Data Rate</div>
            <div class="stat-value" id="dataRate">0 Hz</div>
          </div>
        </div>

        <div class="controls">
          <button onclick="clearLog()">🗑️ Clear Log</button>
          <button class="secondary" onclick="resetStats()">🔄 Reset Stats</button>
          <button class="secondary" onclick="downloadData()">💾 Download</button>
          <button class="secondary" onclick="togglePause()">
            <span id="pauseBtn">⏸️ Pause</span>
          </button>
        </div>

        <div class="chart-section">
          <div class="chart-container">
            <h3>📊 Channel 0 (Raw & Average)</h3>
            <canvas id="chart0"></canvas>
          </div>
          <div class="chart-container">
            <h3>📊 Channel 1 (Raw & Average)</h3>
            <canvas id="chart1"></canvas>
          </div>
        </div>

        <div class="chart-container">
          <h3>📜 Live Data Stream</h3>
          <div id="dataLog"></div>
        </div>
      </div>

      <script>
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let ws = new WebSocket(wsProtocol + '//' + window.location.host);
        let isPaused = false;
        let lastDataTime = Date.now();
        let dataCount = 0;

        // Chart setup
        const maxDataPoints = 50;
        const chartConfig = {
          type: 'line',
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
              y: { 
                beginAtZero: true,
                grid: { color: '#00ff8822' },
                ticks: { color: '#888' }
              },
              x: { 
                display: false,
                grid: { color: '#00ff8822' }
              }
            },
            plugins: {
              legend: { 
                labels: { color: '#fff' },
                position: 'top'
              }
            }
          }
        };

        const chart0 = new Chart(document.getElementById('chart0'), {
          ...chartConfig,
          data: {
            labels: [],
            datasets: [
              {
                label: 'Raw',
                data: [],
                borderColor: '#00ff88',
                backgroundColor: 'rgba(0,255,136,0.1)',
                borderWidth: 2,
                tension: 0.4
              },
              {
                label: 'Average',
                data: [],
                borderColor: '#00ccff',
                backgroundColor: 'rgba(0,204,255,0.1)',
                borderWidth: 2,
                tension: 0.4
              }
            ]
          }
        });

        const chart1 = new Chart(document.getElementById('chart1'), {
          ...chartConfig,
          data: {
            labels: [],
            datasets: [
              {
                label: 'Raw',
                data: [],
                borderColor: '#ff6b6b',
                backgroundColor: 'rgba(255,107,107,0.1)',
                borderWidth: 2,
                tension: 0.4
              },
              {
                label: 'Average',
                data: [],
                borderColor: '#ffd93d',
                backgroundColor: 'rgba(255,217,61,0.1)',
                borderWidth: 2,
                tension: 0.4
              }
            ]
          }
        });

        ws.onopen = function() {
          console.log('✓ Connected to server');
          updateStatus(true);
        };

        ws.onmessage = function(event) {
          const message = JSON.parse(event.data);
          
          if (message.type === 'data') {
            handleData(message.data, message.stats);
          } else if (message.type === 'stats') {
            updateStats(message.data);
          } else if (message.type === 'reset') {
            location.reload();
          }
        };

        ws.onerror = function(error) {
          console.error('WebSocket error:', error);
          updateStatus(false);
        };

        ws.onclose = function() {
          console.log('✗ Disconnected from server');
          updateStatus(false);
          setTimeout(() => location.reload(), 3000);
        };

        function handleData(data, stats) {
          if (isPaused) return;

          dataCount++;
          const now = Date.now();
          const elapsed = (now - lastDataTime) / 1000;
          
          if (elapsed >= 1) {
            document.getElementById('dataRate').textContent = 
              Math.round(dataCount / elapsed) + ' Hz';
            dataCount = 0;
            lastDataTime = now;
          }

          if (stats) {
            document.getElementById('messagesReceived').textContent = 
              stats.totalMessages.toLocaleString();
          }

          // Update charts
          const timestamp = new Date().toLocaleTimeString();
          
          // Channel 0
          chart0.data.labels.push(timestamp);
          chart0.data.datasets[0].data.push(data.channel0?.rawValue || 0);
          chart0.data.datasets[1].data.push(data.channel0?.averageValue || 0);
          
          if (chart0.data.labels.length > maxDataPoints) {
            chart0.data.labels.shift();
            chart0.data.datasets[0].data.shift();
            chart0.data.datasets[1].data.shift();
          }
          chart0.update();

          // Channel 1
          chart1.data.labels.push(timestamp);
          chart1.data.datasets[0].data.push(data.channel1?.rawValue || 0);
          chart1.data.datasets[1].data.push(data.channel1?.averageValue || 0);
          
          if (chart1.data.labels.length > maxDataPoints) {
            chart1.data.labels.shift();
            chart1.data.datasets[0].data.shift();
            chart1.data.datasets[1].data.shift();
          }
          chart1.update();

          // Update log
          const logDiv = document.getElementById('dataLog');
          const entry = document.createElement('div');
          entry.className = 'log-entry';
          
          const time = new Date().toLocaleTimeString();
          const ch0 = \`CH0: R:\${data.channel0?.rawValue || 0} A:\${data.channel0?.averageValue || 0}\`;
          const ch1 = \`CH1: R:\${data.channel1?.rawValue || 0} A:\${data.channel1?.averageValue || 0}\`;
          
          entry.innerHTML = \`
            <span class="log-time">\${time}</span>
            <span class="log-channel">\${ch0}</span>
            <span class="log-value">\${ch1}</span>
          \`;
          
          logDiv.insertBefore(entry, logDiv.firstChild);
          
          while (logDiv.children.length > 100) {
            logDiv.removeChild(logDiv.lastChild);
          }
        }

        function updateStats(stats) {
          document.getElementById('messagesReceived').textContent = 
            stats.messagesReceived.toLocaleString();
        }

        function updateStatus(connected) {
          const status = document.getElementById('status');
          if (connected) {
            status.textContent = '● Online';
            status.className = 'connected';
          } else {
            status.textContent = '● Offline';
            status.className = 'disconnected';
          }
        }

        function clearLog() {
          document.getElementById('dataLog').innerHTML = '';
        }

        function resetStats() {
          if (confirm('Reset all statistics?')) {
            fetch('/api/reset', { method: 'POST' })
              .then(response => response.json())
              .then(data => {
                console.log('Stats reset:', data);
                location.reload();
              });
          }
        }

        function downloadData() {
          fetch('/api/data')
            .then(response => response.json())
            .then(result => {
              const blob = new Blob([JSON.stringify(result.data, null, 2)], 
                { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = \`emg_data_\${new Date().toISOString()}.json\`;
              a.click();
              URL.revokeObjectURL(url);
            });
        }

        function togglePause() {
          isPaused = !isPaused;
          const btn = document.getElementById('pauseBtn');
          btn.textContent = isPaused ? '▶️ Resume' : '⏸️ Pause';
        }

        function updateStoredPointsCount() {
          fetch('/api/status')
            .then(response => response.json())
            .then(data => {
              document.getElementById('storedPoints').textContent = 
                data.storedDataPoints.toLocaleString();
            });
        }

        setInterval(updateStoredPointsCount, 2000);
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('=================================');
  console.log('🚀 EMG Real-time Server');
  console.log('=================================');
  console.log(`📡 HTTP Server: http://localhost:${PORT}`);
  console.log(`📡 POST Endpoint: http://localhost:${PORT}/api/emg`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log('');
  console.log('📊 Data Endpoints:');
  console.log(`   GET  /api/data - Get all stored data`);
  console.log(`   GET  /api/data/latest - Get latest data`);
  console.log(`   GET  /api/data/range - Get data by time`);
  console.log(`   DELETE /api/data - Clear all data`);
  console.log('=================================');
});