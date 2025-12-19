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
  framesReceived: 0,
  samplesReceived: 0,
  lastFrameSequence: -1,
  droppedFrames: 0,
  lastReceiveTime: null,
  devices: {}
};

// ========== NEW: Store recent frames ==========
const MAX_STORED_FRAMES = 1000; // Lưu tối đa 1000 frames gần nhất
let recentFrames = []; // Mảng lưu frames theo thứ tự thời gian

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('📱 Client connected via WebSocket');
  clients.push(ws);

  // Send current stats to new client
  ws.send(JSON.stringify({ type: 'stats', data: stats }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received data:', data);
      broadcast({ type: 'data', data });
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('📴 Client disconnected');
    clients = clients.filter(client => client !== ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// HTTP POST endpoint to receive frame data from ESP32
app.post('/api/emg', (req, res) => {
  try {
    const frameData = req.body;
    const deviceId = frameData.deviceId || 'unknown';
    const frameSeq = frameData.frameSequence;
    const samplesCount = frameData.samplesInFrame || 0;
    
    // Update stats
    stats.framesReceived++;
    stats.samplesReceived += samplesCount;
    stats.lastReceiveTime = new Date().toISOString();
    
    // Track per-device stats
    if (!stats.devices[deviceId]) {
      stats.devices[deviceId] = {
        framesReceived: 0,
        samplesReceived: 0,
        lastFrameSequence: -1,
        droppedFrames: 0
      };
    }
    
    const deviceStats = stats.devices[deviceId];
    deviceStats.framesReceived++;
    deviceStats.samplesReceived += samplesCount;
    
    // Detect dropped frames
    if (deviceStats.lastFrameSequence !== -1) {
      const expectedSeq = deviceStats.lastFrameSequence + 1;
      if (frameSeq > expectedSeq) {
        const dropped = frameSeq - expectedSeq;
        deviceStats.droppedFrames += dropped;
        stats.droppedFrames += dropped;
        console.log(`⚠️  Dropped ${dropped} frame(s) from ${deviceId}`);
      }
    }
    deviceStats.lastFrameSequence = frameSeq;
    
    // ========== NEW: Store frame data ==========
    const frameWithTimestamp = {
      ...frameData,
      receivedAt: new Date().toISOString(),
      serverTimestamp: Date.now()
    };
    
    recentFrames.push(frameWithTimestamp);
    
    // Keep only recent frames
    if (recentFrames.length > MAX_STORED_FRAMES) {
      recentFrames.shift(); // Remove oldest frame
    }
    
    // Log received frame
    console.log(`✓ Frame #${frameSeq} from ${deviceId}: ${samplesCount} samples @ ${frameData.samplingRate}Hz`);
    
    // Broadcast to all WebSocket clients
    broadcast({
      type: 'frame',
      data: frameData,
      stats: {
        totalFrames: stats.framesReceived,
        totalSamples: stats.samplesReceived,
        droppedFrames: stats.droppedFrames
      }
    });
    
    // Quick response to ESP32
    res.json({ 
      success: true,
      frameSequence: frameSeq,
      samplesReceived: samplesCount
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

// ========== NEW: Get all recent frames ==========
app.get('/api/frames', (req, res) => {
  const limit = parseInt(req.query.limit) || recentFrames.length;
  const deviceId = req.query.deviceId;
  
  let frames = recentFrames;
  
  // Filter by device if specified
  if (deviceId) {
    frames = frames.filter(f => f.deviceId === deviceId);
  }
  
  // Limit results
  const result = frames.slice(-limit);
  
  res.json({
    success: true,
    count: result.length,
    totalStored: recentFrames.length,
    frames: result
  });
});

// ========== NEW: Get latest frame ==========
app.get('/api/frames/latest', (req, res) => {
  const deviceId = req.query.deviceId;
  
  let frame = null;
  
  if (deviceId) {
    // Get latest frame from specific device
    for (let i = recentFrames.length - 1; i >= 0; i--) {
      if (recentFrames[i].deviceId === deviceId) {
        frame = recentFrames[i];
        break;
      }
    }
  } else {
    // Get latest frame from any device
    frame = recentFrames[recentFrames.length - 1] || null;
  }
  
  if (frame) {
    res.json({
      success: true,
      frame: frame
    });
  } else {
    res.status(404).json({
      success: false,
      message: 'No frames available'
    });
  }
});

// ========== NEW: Get frames by time range ==========
app.get('/api/frames/range', (req, res) => {
  const startTime = req.query.start ? new Date(req.query.start).getTime() : 0;
  const endTime = req.query.end ? new Date(req.query.end).getTime() : Date.now();
  const deviceId = req.query.deviceId;
  
  let frames = recentFrames.filter(f => {
    const frameTime = f.serverTimestamp;
    return frameTime >= startTime && frameTime <= endTime;
  });
  
  // Filter by device if specified
  if (deviceId) {
    frames = frames.filter(f => f.deviceId === deviceId);
  }
  
  res.json({
    success: true,
    count: frames.length,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    frames: frames
  });
});

// ========== NEW: Get frame by sequence number ==========
app.get('/api/frames/:sequence', (req, res) => {
  const sequence = parseInt(req.params.sequence);
  const deviceId = req.query.deviceId;
  
  let frame = null;
  
  if (deviceId) {
    frame = recentFrames.find(f => 
      f.frameSequence === sequence && f.deviceId === deviceId
    );
  } else {
    frame = recentFrames.find(f => f.frameSequence === sequence);
  }
  
  if (frame) {
    res.json({
      success: true,
      frame: frame
    });
  } else {
    res.status(404).json({
      success: false,
      message: `Frame #${sequence} not found`
    });
  }
});

// ========== NEW: Delete all stored frames ==========
app.delete('/api/frames', (req, res) => {
  const previousCount = recentFrames.length;
  recentFrames = [];
  
  res.json({
    success: true,
    message: 'All frames deleted',
    deletedCount: previousCount
  });
});

// HTTP GET endpoint to check server status
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    connectedClients: clients.length,
    stats: stats,
    storedFrames: recentFrames.length,
    maxStoredFrames: MAX_STORED_FRAMES,
    timestamp: new Date().toISOString()
  });
});

// Reset stats endpoint
app.post('/api/reset', (req, res) => {
  stats = {
    framesReceived: 0,
    samplesReceived: 0,
    lastFrameSequence: -1,
    droppedFrames: 0,
    lastReceiveTime: null,
    devices: {}
  };
  
  // Optionally clear stored frames too
  if (req.query.clearFrames === 'true') {
    recentFrames = [];
  }
  
  broadcast({ type: 'reset' });
  res.json({ 
    success: true, 
    message: 'Stats reset',
    framesCleared: req.query.clearFrames === 'true'
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

// Serve enhanced HTML dashboard
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>EMG Frame Stream Dashboard</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: 'Segoe UI', Arial, sans-serif; 
          background: #1a1a1a; 
          color: #fff;
          padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { 
          font-size: 24px; 
          margin-bottom: 20px;
          color: #00ff88;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 15px;
          margin-bottom: 20px;
        }
        .stat-card {
          background: #2a2a2a;
          padding: 15px;
          border-radius: 8px;
          border-left: 4px solid #00ff88;
        }
        .stat-label {
          font-size: 12px;
          color: #888;
          text-transform: uppercase;
          margin-bottom: 5px;
        }
        .stat-value {
          font-size: 28px;
          font-weight: bold;
          color: #00ff88;
        }
        .stat-value.warning { color: #ff9500; }
        .stat-value.error { color: #ff3b30; }
        .controls {
          display: flex;
          gap: 10px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        button {
          padding: 10px 20px;
          background: #00ff88;
          color: #1a1a1a;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: bold;
          transition: all 0.2s;
        }
        button:hover { background: #00cc6a; }
        button.secondary {
          background: #444;
          color: #fff;
        }
        button.secondary:hover { background: #555; }
        #status {
          display: inline-block;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: bold;
        }
        #status.connected {
          background: #00ff88;
          color: #1a1a1a;
        }
        #status.disconnected {
          background: #ff3b30;
          color: #fff;
        }
        .chart-container {
          background: #2a2a2a;
          padding: 20px;
          border-radius: 8px;
          margin-bottom: 20px;
        }
        #dataLog {
          background: #2a2a2a;
          padding: 15px;
          height: 400px;
          overflow-y: auto;
          border-radius: 8px;
          font-family: 'Courier New', monospace;
          font-size: 13px;
        }
        .log-entry {
          padding: 8px;
          border-bottom: 1px solid #333;
          display: flex;
          justify-content: space-between;
        }
        .log-entry:hover { background: #333; }
        .log-time {
          color: #888;
          margin-right: 15px;
        }
        .log-frame {
          color: #00ff88;
          font-weight: bold;
        }
        .log-samples {
          color: #0af;
        }
        .api-section {
          background: #2a2a2a;
          padding: 20px;
          border-radius: 8px;
          margin-top: 20px;
        }
        .api-section h3 {
          color: #00ff88;
          margin-bottom: 15px;
        }
        .api-endpoint {
          background: #1a1a1a;
          padding: 10px;
          border-radius: 4px;
          margin-bottom: 10px;
          font-family: 'Courier New', monospace;
          font-size: 12px;
        }
        .api-endpoint .method {
          color: #0af;
          font-weight: bold;
          margin-right: 10px;
        }
        .api-endpoint .path {
          color: #00ff88;
        }
        .api-endpoint .desc {
          color: #888;
          margin-top: 5px;
        }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #1a1a1a; }
        ::-webkit-scrollbar-thumb { 
          background: #00ff88; 
          border-radius: 4px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔬 EMG Frame Stream Dashboard</h1>
        
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Connection</div>
            <div class="stat-value">
              <span id="status" class="disconnected">Disconnected</span>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Frames Received</div>
            <div class="stat-value" id="framesReceived">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Stored Frames</div>
            <div class="stat-value" id="storedFrames">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Samples</div>
            <div class="stat-value" id="samplesReceived">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Dropped Frames</div>
            <div class="stat-value error" id="droppedFrames">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Frame Rate</div>
            <div class="stat-value" id="frameRate">0 Hz</div>
          </div>
        </div>

        <div class="controls">
          <button onclick="clearLog()">Clear Log</button>
          <button class="secondary" onclick="resetStats()">Reset Stats</button>
          <button class="secondary" onclick="downloadFrames()">Download Frames</button>
          <button class="secondary" onclick="clearFrames()">Clear Stored Frames</button>
          <button class="secondary" onclick="togglePause()">
            <span id="pauseBtn">Pause</span>
          </button>
        </div>

        <div class="chart-container">
          <h3 style="margin-bottom: 10px;">📊 Real-time Data Stream</h3>
          <div id="dataLog"></div>
        </div>

        <div class="api-section">
          <h3>📡 API Endpoints</h3>
          <div class="api-endpoint">
            <span class="method">GET</span>
            <span class="path">/api/frames</span>
            <div class="desc">Get all stored frames (query: ?limit=100&deviceId=ESP32_001)</div>
          </div>
          <div class="api-endpoint">
            <span class="method">GET</span>
            <span class="path">/api/frames/latest</span>
            <div class="desc">Get the latest frame (query: ?deviceId=ESP32_001)</div>
          </div>
          <div class="api-endpoint">
            <span class="method">GET</span>
            <span class="path">/api/frames/range</span>
            <div class="desc">Get frames by time range (query: ?start=2024-01-01T00:00:00Z&end=2024-01-01T23:59:59Z)</div>
          </div>
          <div class="api-endpoint">
            <span class="method">GET</span>
            <span class="path">/api/frames/:sequence</span>
            <div class="desc">Get specific frame by sequence number</div>
          </div>
          <div class="api-endpoint">
            <span class="method">DELETE</span>
            <span class="path">/api/frames</span>
            <div class="desc">Delete all stored frames</div>
          </div>
        </div>
      </div>

      <script>
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let ws = new WebSocket(wsProtocol + '//' + window.location.host);
        let isPaused = false;
        let lastFrameTime = Date.now();
        let frameCount = 0;
        let sampleCount = 0;

        ws.onopen = function() {
          console.log('✓ Connected to server');
          updateStatus(true);
        };

        ws.onmessage = function(event) {
          const message = JSON.parse(event.data);
          
          if (message.type === 'frame') {
            handleFrame(message.data, message.stats);
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

        function handleFrame(frameData, stats) {
          if (isPaused) return;

          frameCount++;
          sampleCount += frameData.samplesInFrame;
          const now = Date.now();
          const elapsed = (now - lastFrameTime) / 1000;
          
          if (elapsed >= 1) {
            document.getElementById('frameRate').textContent = 
              Math.round(frameCount / elapsed) + ' Hz';
            frameCount = 0;
            sampleCount = 0;
            lastFrameTime = now;
          }

          if (stats) {
            document.getElementById('framesReceived').textContent = 
              stats.totalFrames.toLocaleString();
            document.getElementById('samplesReceived').textContent = 
              stats.totalSamples.toLocaleString();
            document.getElementById('droppedFrames').textContent = 
              stats.droppedFrames.toLocaleString();
          }

          const logDiv = document.getElementById('dataLog');
          const entry = document.createElement('div');
          entry.className = 'log-entry';
          
          const time = new Date().toLocaleTimeString();
          const frameInfo = \`Frame #\${frameData.frameSequence}\`;
          const sampleInfo = \`\${frameData.samplesInFrame} samples\`;
          
          const firstSample = frameData.samples && frameData.samples[0];
          const ch0 = firstSample ? \`CH0: \${firstSample.ch0.raw}\` : '';
          const ch1 = firstSample ? \`CH1: \${firstSample.ch1.raw}\` : '';
          
          entry.innerHTML = \`
            <span class="log-time">\${time}</span>
            <span class="log-frame">\${frameInfo}</span>
            <span class="log-samples">\${sampleInfo}</span>
            <span>\${ch0}</span>
            <span>\${ch1}</span>
          \`;
          
          logDiv.insertBefore(entry, logDiv.firstChild);
          
          while (logDiv.children.length > 100) {
            logDiv.removeChild(logDiv.lastChild);
          }
        }

        function updateStats(stats) {
          document.getElementById('framesReceived').textContent = 
            stats.framesReceived.toLocaleString();
          document.getElementById('samplesReceived').textContent = 
            stats.samplesReceived.toLocaleString();
          document.getElementById('droppedFrames').textContent = 
            stats.droppedFrames.toLocaleString();
        }

        function updateStatus(connected) {
          const status = document.getElementById('status');
          if (connected) {
            status.textContent = 'Connected';
            status.className = 'connected';
          } else {
            status.textContent = 'Disconnected';
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

        function downloadFrames() {
          fetch('/api/frames')
            .then(response => response.json())
            .then(data => {
              const blob = new Blob([JSON.stringify(data.frames, null, 2)], 
                { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = \`emg_frames_\${new Date().toISOString()}.json\`;
              a.click();
              URL.revokeObjectURL(url);
            });
        }

        function clearFrames() {
          if (confirm('Clear all stored frames?')) {
            fetch('/api/frames', { method: 'DELETE' })
              .then(response => response.json())
              .then(data => {
                console.log('Frames cleared:', data);
                alert(\`Cleared \${data.deletedCount} frames\`);
                updateStoredFramesCount();
              });
          }
        }

        function togglePause() {
          isPaused = !isPaused;
          document.getElementById('pauseBtn').textContent = 
            isPaused ? 'Resume' : 'Pause';
        }

        function updateStoredFramesCount() {
          fetch('/api/status')
            .then(response => response.json())
            .then(data => {
              document.getElementById('storedFrames').textContent = 
                data.storedFrames.toLocaleString();
            });
        }

        setInterval(updateStoredFramesCount, 2000);
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('=================================');
  console.log('🚀 EMG Frame Stream Server');
  console.log('=================================');
  console.log(`📡 HTTP Server: http://localhost:${PORT}`);
  console.log(`📡 POST Endpoint: http://localhost:${PORT}/api/emg`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log('');
  console.log('📊 NEW Data Endpoints:');
  console.log(`   GET  /api/frames - Get all stored frames`);
  console.log(`   GET  /api/frames/latest - Get latest frame`);
  console.log(`   GET  /api/frames/range - Get frames by time`);
  console.log(`   GET  /api/frames/:seq - Get frame by sequence`);
  console.log(`   DELETE /api/frames - Clear all frames`);
  console.log('=================================');
});