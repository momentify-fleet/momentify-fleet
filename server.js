// ============================================================
//  Momentify Fleet — Production Server v3
//  Fase 2: Login Admin
//  Fase 3: Multi Driver
//  Fase 4: Geofencing
//  Fase 5: Export Laporan
// ============================================================
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');
const os       = require('os');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// NO CACHE
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
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

// ── DATA STORE (in-memory) ────────────────────────────────
const drivers    = {};   // socketId → driver data
const gpsHistory = {};   // driverId → array koordinat (max 500)
const alerts     = [];   // semua alert
const geozones   = [     // default geofence zones
  { id: 'z1', name: 'Bandung Kota', lat: -6.9175, lng: 107.6191, radius: 10000, active: true },
  { id: 'z2', name: 'Jakarta Pusat', lat: -6.1751, lng: 106.8650, radius: 15000, active: true }
];

// ── ADMIN CREDENTIALS (ganti sesuai kebutuhan) ───────────
const ADMIN_USERS = [
  { username: 'admin', password: 'momentify2024', role: 'superadmin', name: 'Administrator' },
  { username: 'operator', password: 'fleet123', role: 'operator', name: 'Operator Fleet' }
];

// ── SESSIONS (simple token) ───────────────────────────────
const sessions = {};

function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token && sessions[token]) {
    req.user = sessions[token];
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/hp',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'gps.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gps.html')));

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = ADMIN_USERS.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Username atau password salah' });
  const token = generateToken();
  sessions[token] = { username: user.username, name: user.name, role: user.role, loginAt: Date.now() };
  console.log(`🔐 LOGIN: ${user.name} (${user.role})`);
  res.json({ token, name: user.name, role: user.role });
});

// LOGOUT
app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.headers['x-auth-token'];
  delete sessions[token];
  res.json({ ok: true });
});

// GET semua driver
app.get('/api/drivers', requireAuth, (req, res) => {
  res.json(Object.values(drivers));
});

// GET history GPS per driver
app.get('/api/history/:driverId', requireAuth, (req, res) => {
  const h = gpsHistory[req.params.driverId] || [];
  res.json(h);
});

// GET semua alert
app.get('/api/alerts', requireAuth, (req, res) => {
  res.json(alerts.slice(-100)); // 100 alert terakhir
});

// ACK alert
app.post('/api/alerts/:id/ack', requireAuth, (req, res) => {
  const alert = alerts.find(a => a.id === req.params.id);
  if (alert) { alert.acked = true; alert.ackedBy = req.user.name; alert.ackedAt = Date.now(); }
  res.json({ ok: true });
});

// GET geofence zones
app.get('/api/geozones', requireAuth, (req, res) => res.json(geozones));

// ADD geofence zone
app.post('/api/geozones', requireAuth, (req, res) => {
  const zone = { ...req.body, id: 'z' + Date.now(), active: true };
  geozones.push(zone);
  io.emit('geozone-update', geozones);
  res.json(zone);
});

// DELETE geofence zone
app.delete('/api/geozones/:id', requireAuth, (req, res) => {
  const idx = geozones.findIndex(z => z.id === req.params.id);
  if (idx > -1) geozones.splice(idx, 1);
  io.emit('geozone-update', geozones);
  res.json({ ok: true });
});

// EXPORT LAPORAN CSV
app.get('/api/export/csv', requireAuth, (req, res) => {
  const { date, driverId } = req.query;
  let rows = [['Waktu','Driver','Latitude','Longitude','Speed (km/h)','Akurasi (m)']];

  const sources = driverId ? [gpsHistory[driverId] || []] : Object.values(gpsHistory);
  sources.forEach(history => {
    history.forEach(p => {
      const d = new Date(p.timestamp).toISOString();
      if (!date || d.startsWith(date)) {
        rows.push([d, p.name, p.lat, p.lng, p.speed, p.accuracy]);
      }
    });
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="laporan-fleet-${date||'all'}.csv"`);
  res.send(csv);
});

// EXPORT LAPORAN JSON
app.get('/api/export/json', requireAuth, (req, res) => {
  res.json({
    exportAt: new Date().toISOString(),
    drivers: Object.values(drivers),
    totalPoints: Object.values(gpsHistory).reduce((a,b) => a + b.length, 0),
    alerts: alerts.filter(a => !a.acked).length,
    history: gpsHistory
  });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, drivers: Object.keys(drivers).length, time: Date.now() }));

// ── GEOFENCE CHECK ────────────────────────────────────────
function checkGeofence(driverData) {
  geozones.forEach(zone => {
    if (!zone.active) return;
    const dist = getDistance(driverData.lat, driverData.lng, zone.lat, zone.lng);
    const wasInside = driverData._lastZones && driverData._lastZones[zone.id];
    const isInside  = dist <= zone.radius;

    if (wasInside && !isInside) {
      // Keluar zona
      createAlert('GEOFENCE_EXIT', `🚨 ${driverData.name} KELUAR zona ${zone.name}`, driverData, 'critical');
    } else if (!wasInside && isInside) {
      // Masuk zona
      createAlert('GEOFENCE_ENTER', `📍 ${driverData.name} masuk zona ${zone.name}`, driverData, 'info');
    }

    if (!driverData._lastZones) driverData._lastZones = {};
    driverData._lastZones[zone.id] = isInside;
  });
}

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function createAlert(type, message, driverData, level = 'warning') {
  const alert = {
    id: 'al' + Date.now() + Math.random().toString(36).slice(2,5),
    type, message, level,
    driverId: driverData.id,
    driverName: driverData.name,
    lat: driverData.lat,
    lng: driverData.lng,
    timestamp: Date.now(),
    acked: false
  };
  alerts.push(alert);
  if (alerts.length > 500) alerts.shift();
  io.emit('new-alert', alert);
  console.log(`⚡ ALERT [${level.toUpperCase()}]: ${message}`);
  return alert;
}

// ── SOCKET.IO ─────────────────────────────────────────────
io.on('connection', (socket) => {
  const t  = new Date().toLocaleTimeString('id-ID');
  const ip = socket.handshake.address;
  console.log(`\n🔌 [${t}] KONEK → ${socket.id.slice(0,8)} (${ip})`);

  // Kirim state awal ke dashboard baru
  socket.emit('init-state', {
    drivers: Object.values(drivers),
    alerts:  alerts.filter(a => !a.acked).slice(-20),
    geozones
  });

  // ── Terima GPS dari HP Driver ──────────────────────────
  socket.on('driver-location', (raw) => {
    const d = {
      socketId:  socket.id,
      id:        raw.driverId   || ('D' + socket.id.slice(0,4).toUpperCase()),
      name:      raw.driverName || raw.name || 'Driver',
      lat:       parseFloat(raw.lat      || 0),
      lng:       parseFloat(raw.lng      || 0),
      speed:     parseFloat(raw.speed    || 0),
      accuracy:  parseFloat(raw.accuracy || 0),
      heading:   parseFloat(raw.heading  || 0),
      altitude:  parseFloat(raw.altitude || 0),
      timestamp: Date.now(),
      _lastZones: drivers[socket.id]?._lastZones || {}
    };

    if (d.lat === 0 && d.lng === 0) return;

    // Simpan history GPS
    if (!gpsHistory[d.id]) gpsHistory[d.id] = [];
    gpsHistory[d.id].push({ ...d });
    if (gpsHistory[d.id].length > 500) gpsHistory[d.id].shift();

    // Cek overspeed
    if (d.speed > 80) {
      createAlert('OVERSPEED', `🚨 Kecepatan berlebih ${d.name}: ${d.speed} km/h`, d, 'critical');
    }

    // Cek geofence
    checkGeofence(d);

    drivers[socket.id] = d;
    io.emit('gps-update', d);

    console.log(`   📍 [${new Date().toLocaleTimeString('id-ID')}] ${d.name.padEnd(14)} lat:${d.lat.toFixed(5)} lng:${d.lng.toFixed(5)} spd:${d.speed}km/h`);
  });

  socket.on('ping-driver', () => {});

  socket.on('disconnect', (reason) => {
    if (drivers[socket.id]) {
      const d = drivers[socket.id];
      io.emit('driver-offline', { socketId: socket.id, name: d.name, id: d.id });
      console.log(`❌ [${new Date().toLocaleTimeString('id-ID')}] OFFLINE → ${d.name}`);
      delete drivers[socket.id];
    }
  });
});

// ── START ─────────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const n of Object.keys(ifaces))
    for (const i of ifaces[n])
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   🗺  MOMENTIFY FLEET v3 — PRODUCTION SERVER          ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Login     →  http://localhost:${PORT}                 ║`);
  console.log(`║  Dashboard →  http://localhost:${PORT}/dashboard       ║`);
  console.log(`║  HP Driver →  http://${getLocalIP()}:${PORT}/hp ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Fase 2: Login ✓  Fase 3: Multi Driver ✓             ║');
  console.log('║  Fase 4: Geofencing ✓  Fase 5: Export CSV ✓          ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
});
