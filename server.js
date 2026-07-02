const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const path    = require('path');
const os      = require('os');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── NO CACHE semua request ────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket','polling'],
  pingTimeout:  60000,
  pingInterval: 10000
});

const drivers = {};

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ── Routes ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// /driver dan /gps dan /v3 semuanya serve file yang sama (driver baru)
// Pakai res.send langsung agar 100% bypass cache apapun
app.get('/driver', serveDriver);
app.get('/gps',    serveDriver);
app.get('/v3',     serveDriver);
app.get('/hp',     serveDriver);  // ← URL pendek untuk HP

function serveDriver(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'gps.html')); // file polos baru
}

app.get('/api/drivers', (req, res) => res.json(Object.values(drivers)));
app.get('/api/ping',    (req, res) => res.json({ ok: true, time: Date.now(), drivers: Object.keys(drivers).length }));

// ── Socket.IO ─────────────────────────────────────────────
io.on('connection', (socket) => {
  const t = new Date().toLocaleTimeString('id-ID');
  const ip = socket.handshake.address;
  console.log(`\n🔌 [${t}] KONEK   → ${socket.id.slice(0,8)} (${ip})`);

  const existing = Object.values(drivers);
  if (existing.length > 0) socket.emit('drivers-state', existing);

  socket.on('driver-location', (raw) => {
    const d = {
      socketId:  socket.id,
      id:        raw.driverId   || raw.id   || ('D-' + socket.id.slice(0,4).toUpperCase()),
      name:      raw.driverName || raw.name || 'Driver',
      lat:       parseFloat(raw.lat      || 0),
      lng:       parseFloat(raw.lng      || 0),
      speed:     parseFloat(raw.speed    || 0),
      accuracy:  parseFloat(raw.accuracy || 0),
      heading:   parseFloat(raw.heading  || 0),
      altitude:  parseFloat(raw.altitude || 0),
      timestamp: Date.now()
    };

    if (d.lat === 0 && d.lng === 0) {
      console.log(`   ⚠  Koordinat 0,0 dari ${d.name} — diabaikan`);
      return;
    }

    drivers[socket.id] = d;
    io.emit('gps-update', d);

    console.log(
      `   📍 [${new Date().toLocaleTimeString('id-ID')}] ` +
      `${d.name.padEnd(14)} ` +
      `lat:${d.lat.toFixed(5)}  lng:${d.lng.toFixed(5)}  ` +
      `spd:${d.speed} km/h  acc:±${d.accuracy}m`
    );
  });

  socket.on('ping-driver', () => {});

  socket.on('disconnect', (reason) => {
    const t2 = new Date().toLocaleTimeString('id-ID');
    if (drivers[socket.id]) {
      const name = drivers[socket.id].name;
      io.emit('driver-offline', { socketId: socket.id, name });
      console.log(`❌ [${t2}] OFFLINE → ${name} · ${reason}`);
      delete drivers[socket.id];
    } else {
      console.log(`❌ [${t2}] DISCON  → ${socket.id.slice(0,8)} · ${reason}`);
    }
  });
});

// ── Start ─────────────────────────────────────────────────
const PORT = 3000;
const IP   = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   🗺  MOMENTIFY FLEET — SERVER AKTIF               ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log(`║  Dashboard  →  http://localhost:${PORT}              ║`);
  console.log(`║  HP Driver  →  http://${IP}:${PORT}/hp       ║`);
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log('║  Semua route NO-CACHE — HP selalu fresh           ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');
});
