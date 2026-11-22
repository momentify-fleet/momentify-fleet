// ============================================================
//  Momentify Fleet — Enterprise Server v4
//  Public Tracking + Multi-level Users + Hardware GPS
// ============================================================
const express  = require('express');
const http     = require('http');
const net      = require('net');  // untuk hardware GPS TCP
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket','polling'],
  pingTimeout: 60000, pingInterval: 10000
});

// ══════════════════════════════════════════════════════════
//  DATA STORE
// ══════════════════════════════════════════════════════════
const drivers    = {};   // socketId → driver data
const gpsHistory = {};   // driverId → [{lat,lng,speed,timestamp}]
const alerts     = [];
const geozones   = [
  { id:'z1', name:'Bandung Kota',  lat:-6.9175,  lng:107.6191, radius:10000, active:true },
  { id:'z2', name:'Jakarta Pusat', lat:-6.1751,  lng:106.8650, radius:15000, active:true }
];

// ── MULTI-LEVEL USERS ─────────────────────────────────────
const USERS = [
  { id:'u1', username:'admin',    password:'momentify2024', role:'superadmin', name:'Administrator',    company:'Momentify' },
  { id:'u2', username:'operator', password:'fleet123',      role:'operator',   name:'Operator Fleet',   company:'Momentify' },
  { id:'u3', username:'busmania', password:'bus2024',       role:'client',     name:'PO Sinar Jaya',    company:'Sinar Jaya Travel' },
  { id:'u4', username:'travel01', password:'travel2024',    role:'client',     name:'Travel Primajasa', company:'Primajasa' }
];

const sessions = {};  // token → user
const trips    = {};  // tripCode → trip data (PUBLIC TRACKING)
const publicViewers = {}; // trackingCode → [socketId]

// ══════════════════════════════════════════════════════════
//  AUTH HELPERS
// ══════════════════════════════════════════════════════════
function generateToken(len=32) {
  return crypto.randomBytes(len).toString('hex');
}
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token && sessions[token]) { req.user = sessions[token]; return next(); }
  res.status(401).json({ error: 'Unauthorized' });
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.user?.role)) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}

// ══════════════════════════════════════════════════════════
//  ROUTES — AUTH
// ══════════════════════════════════════════════════════════
app.get('/',          (req,res) => res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/hp',        (req,res) => res.sendFile(path.join(__dirname,'public','gps.html')));
app.get('/driver',    (req,res) => res.sendFile(path.join(__dirname,'public','gps.html')));

// Public tracking page — NO AUTH REQUIRED
app.get('/track/:code', (req,res) => res.sendFile(path.join(__dirname,'public','track.html')));
app.get('/pool/:code',  (req,res) => res.sendFile(path.join(__dirname,'public','pool.html')));

app.post('/api/login', (req,res) => {
  const { username, password } = req.body;
  const user = USERS.find(u => u.username===username && u.password===password);
  if (!user) return res.status(401).json({ error:'Username atau password salah' });
  const token = generateToken();
  sessions[token] = { ...user, loginAt: Date.now() };
  console.log(`🔐 LOGIN: ${user.name} (${user.role})`);
  res.json({ token, name:user.name, role:user.role, company:user.company });
});

app.post('/api/logout', requireAuth, (req,res) => {
  delete sessions[req.headers['x-auth-token']];
  res.json({ ok:true });
});

// ══════════════════════════════════════════════════════════
//  ROUTES — DRIVERS & GPS
// ══════════════════════════════════════════════════════════
app.get('/api/drivers',        requireAuth, (req,res) => res.json(Object.values(drivers)));
app.get('/api/history/:id',    requireAuth, (req,res) => res.json(gpsHistory[req.params.id]||[]));
app.get('/api/alerts',         requireAuth, (req,res) => res.json(alerts.slice(-100)));
app.post('/api/alerts/:id/ack',requireAuth, (req,res) => {
  const a = alerts.find(x=>x.id===req.params.id);
  if (a) { a.acked=true; a.ackedBy=req.user.name; a.ackedAt=Date.now(); }
  res.json({ok:true});
});
app.get('/api/geozones',       requireAuth, (req,res) => res.json(geozones));
app.post('/api/geozones',      requireAuth, (req,res) => {
  const z = {...req.body, id:'z'+Date.now(), active:true};
  geozones.push(z);
  io.emit('geozone-update', geozones);
  res.json(z);
});
app.delete('/api/geozones/:id',requireAuth, (req,res) => {
  const i = geozones.findIndex(z=>z.id===req.params.id);
  if (i>-1) geozones.splice(i,1);
  io.emit('geozone-update', geozones);
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════
//  ROUTES — NEAREST DRIVER & DISPATCH
// ══════════════════════════════════════════════════════════
app.get('/api/nearest', requireAuth, (req,res) => {
  const { lat, lng, limit=3 } = req.query;
  if (!lat||!lng) return res.status(400).json({error:'lat & lng required'});
  const pLat=parseFloat(lat), pLng=parseFloat(lng);
  const ranked = Object.values(drivers)
    .map(d => ({...d, distance:getDistance(d.lat,d.lng,pLat,pLng),
      distanceKm:(getDistance(d.lat,d.lng,pLat,pLng)/1000).toFixed(2),
      eta:Math.ceil(getDistance(d.lat,d.lng,pLat,pLng)/1000/30*60)}))
    .sort((a,b)=>a.distance-b.distance).slice(0,parseInt(limit));
  res.json({ pickup:{lat:pLat,lng:pLng}, total:Object.keys(drivers).length, nearest:ranked });
});

app.post('/api/dispatch', requireAuth, (req,res) => {
  const { pickup_lat, pickup_lng, pickup_name, order_id } = req.body;
  if (!pickup_lat||!pickup_lng) return res.status(400).json({error:'pickup required'});
  const ranked = Object.values(drivers)
    .map(d=>({...d,distance:getDistance(d.lat,d.lng,pickup_lat,pickup_lng)}))
    .sort((a,b)=>a.distance-b.distance);
  if (!ranked.length) return res.status(404).json({error:'Tidak ada driver'});
  const assigned = ranked[0];
  const order = {
    orderId: order_id||'ORD'+Date.now(),
    driverId:assigned.id, driverName:assigned.name, socketId:assigned.socketId,
    pickupLat:pickup_lat, pickupLng:pickup_lng, pickupName:pickup_name||'Pickup',
    distance:(assigned.distance/1000).toFixed(2),
    eta:Math.ceil(assigned.distance/1000/30*60), assignedAt:Date.now()
  };
  io.to(assigned.socketId).emit('order-assigned', order);
  io.emit('driver-dispatched', order);
  console.log(`🚀 DISPATCH: ${assigned.name} → ${pickup_name}`);
  res.json(order);
});

// ══════════════════════════════════════════════════════════
//  ROUTES — PUBLIC TRIP TRACKING
// ══════════════════════════════════════════════════════════

// Buat trip baru → generate tracking code
app.post('/api/trips', requireAuth, (req,res) => {
  const { driverId, routeName, origin, destination, depTime, destLat, destLng } = req.body;
  const code = generateToken(4).toUpperCase(); // 8 char code
  const trip = {
    code, driverId, routeName,
    origin: origin||'Terminal Asal',
    destination: destination||'Terminal Tujuan',
    destLat: parseFloat(destLat||0),
    destLng: parseFloat(destLng||0),
    depTime: depTime||new Date().toISOString(),
    status: 'active', // active | arrived | expired
    createdAt: Date.now(),
    arrivedAt: null,
    trackUrl: `/track/${code}`,
    poolUrl:  `/pool/${code}`,
    shareUrl: `https://atop-crimp-jargon.ngrok-free.dev/track/${code}`,
    viewers: 0
  };
  trips[code] = trip;
  console.log(`🎫 TRIP CREATED: ${code} → ${routeName}`);
  res.json(trip);
});

// List semua trips
app.get('/api/trips', requireAuth, (req,res) => {
  res.json(Object.values(trips).sort((a,b)=>b.createdAt-a.createdAt));
});

// Get single trip
app.get('/api/trips/:code', (req,res) => {
  const trip = trips[req.params.code.toUpperCase()];
  if (!trip) return res.status(404).json({error:'Trip tidak ditemukan'});
  res.json(trip);
});

// Tandai trip arrived → auto-expire tracking link
app.post('/api/trips/:code/arrived', requireAuth, (req,res) => {
  const trip = trips[req.params.code.toUpperCase()];
  if (!trip) return res.status(404).json({error:'Trip tidak ditemukan'});
  trip.status   = 'arrived';
  trip.arrivedAt = Date.now();
  // Broadcast ke semua viewer trip ini
  io.to(`trip_${trip.code}`).emit('trip-arrived', {
    code: trip.code,
    message: `Armada ${trip.routeName} telah tiba di ${trip.destination}`,
    arrivedAt: trip.arrivedAt
  });
  console.log(`✅ TRIP ARRIVED: ${trip.code} → ${trip.destination}`);
  res.json(trip);
});

// PUBLIC: Get posisi driver untuk trip tertentu (NO AUTH)
app.get('/api/public/trip/:code', (req,res) => {
  const code = req.params.code.toUpperCase();
  const trip = trips[code];
  if (!trip) return res.status(404).json({error:'Trip tidak ditemukan atau sudah expired'});

  // Cari driver yang match
  const driver = Object.values(drivers).find(d => d.id===trip.driverId || d.name===trip.driverId);

  res.json({
    trip,
    driver: driver ? {
      lat: driver.lat, lng: driver.lng,
      speed: driver.speed, accuracy: driver.accuracy,
      heading: driver.heading, timestamp: driver.timestamp
    } : null,
    eta: driver && trip.destLat ? Math.ceil(getDistance(driver.lat,driver.lng,trip.destLat,trip.destLng)/1000/60*60) : null
  });
});

// Export
app.get('/api/export/csv',  requireAuth, (req,res) => {
  const { date } = req.query;
  let rows = [['Waktu','Driver','Lat','Lng','Speed','Akurasi']];
  Object.values(gpsHistory).forEach(h => h.forEach(p => {
    const d = new Date(p.timestamp).toISOString();
    if (!date||d.startsWith(date)) rows.push([d,p.name,p.lat,p.lng,p.speed,p.accuracy]);
  }));
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="laporan-${date||'all'}.csv"`);
  res.send(rows.map(r=>r.join(',')).join('\n'));
});
app.get('/api/export/json', requireAuth, (req,res) => {
  res.json({ exportAt:new Date().toISOString(), drivers:Object.values(drivers),
    alerts:alerts.filter(a=>!a.acked).length, trips:Object.values(trips), history:gpsHistory });
});
app.get('/api/ping', (req,res) => res.json({ok:true,drivers:Object.keys(drivers).length,trips:Object.keys(trips).length}));

// ══════════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  const t  = new Date().toLocaleTimeString('id-ID');
  const ip = socket.handshake.address;
  console.log(`🔌 [${t}] KONEK → ${socket.id.slice(0,8)} (${ip})`);

  socket.emit('init-state', {
    drivers:  Object.values(drivers),
    alerts:   alerts.filter(a=>!a.acked).slice(-20),
    geozones, trips: Object.values(trips)
  });

  // ── Driver kirim GPS ──────────────────────────────────
  socket.on('driver-location', (raw) => {
    const d = {
      socketId:  socket.id,
      id:        raw.driverId   || ('D'+socket.id.slice(0,4).toUpperCase()),
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
    if (d.lat===0 && d.lng===0) return;

    // History
    if (!gpsHistory[d.id]) gpsHistory[d.id] = [];
    gpsHistory[d.id].push({...d});
    if (gpsHistory[d.id].length > 500) gpsHistory[d.id].shift();

    // Overspeed alert
    if (d.speed > 80) createAlert('OVERSPEED',`🚨 Kecepatan berlebih ${d.name}: ${d.speed} km/h`,d,'critical');

    // Geofence check
    checkGeofence(d);

    // Auto-arrive check untuk semua trip aktif driver ini
    Object.values(trips).forEach(trip => {
      if (trip.status!=='active') return;
      if (trip.driverId!==d.id && trip.driverId!==d.name) return;
      if (!trip.destLat || !trip.destLng) return;
      const distToDest = getDistance(d.lat, d.lng, trip.destLat, trip.destLng);
      if (distToDest < 200) { // 200 meter dari tujuan = ARRIVED
        trip.status = 'arrived';
        trip.arrivedAt = Date.now();
        io.to(`trip_${trip.code}`).emit('trip-arrived', {
          code: trip.code,
          message: `Armada ${trip.routeName} telah tiba di ${trip.destination}!`,
          arrivedAt: trip.arrivedAt
        });
        io.emit('new-alert', createAlert('TRIP_ARRIVED',`✅ ${trip.routeName} TIBA di ${trip.destination}`,d,'info'));
        console.log(`✅ AUTO-ARRIVE: ${trip.code}`);
      }
    });

    drivers[socket.id] = d;
    io.emit('gps-update', d);

    // Broadcast ke public viewers trip ini
    Object.values(trips).filter(t=>t.status==='active'&&(t.driverId===d.id||t.driverId===d.name)).forEach(trip => {
      io.to(`trip_${trip.code}`).emit('public-gps', {
        lat:d.lat, lng:d.lng, speed:d.speed, heading:d.heading,
        accuracy:d.accuracy, timestamp:d.timestamp,
        tripCode:trip.code, routeName:trip.routeName,
        destination:trip.destination, destLat:trip.destLat, destLng:trip.destLng,
        eta: trip.destLat ? Math.ceil(getDistance(d.lat,d.lng,trip.destLat,trip.destLng)/1000/60*60) : null
      });
    });

    console.log(`   📍 [${new Date().toLocaleTimeString('id-ID')}] ${d.name.padEnd(14)} lat:${d.lat.toFixed(5)} lng:${d.lng.toFixed(5)} spd:${d.speed}km/h`);
  });

  // ── Public viewer join trip room ──────────────────────
  socket.on('join-trip', (code) => {
    const trip = trips[code?.toUpperCase()];
    if (!trip || trip.status==='expired') return;
    socket.join(`trip_${trip.code}`);
    if (!publicViewers[trip.code]) publicViewers[trip.code] = new Set();
    publicViewers[trip.code].add(socket.id);
    trip.viewers = publicViewers[trip.code].size;
    io.emit('trip-viewers-update', {code:trip.code, viewers:trip.viewers});
    console.log(`👁 PUBLIC VIEWER: trip ${trip.code} — total ${trip.viewers} viewers`);
    // Kirim posisi driver saat ini langsung
    const driver = Object.values(drivers).find(d=>d.id===trip.driverId||d.name===trip.driverId);
    if (driver) socket.emit('public-gps', {lat:driver.lat,lng:driver.lng,speed:driver.speed,heading:driver.heading,accuracy:driver.accuracy,timestamp:driver.timestamp,tripCode:trip.code,routeName:trip.routeName,destination:trip.destination,destLat:trip.destLat,destLng:trip.destLng});
  });

  socket.on('ping-driver', () => {});

  socket.on('disconnect', (reason) => {
    if (drivers[socket.id]) {
      const d = drivers[socket.id];
      io.emit('driver-offline', {socketId:socket.id, name:d.name, id:d.id});
      console.log(`❌ OFFLINE → ${d.name}`);
      delete drivers[socket.id];
    }
    // Hapus dari public viewers
    Object.keys(publicViewers).forEach(code => {
      if (publicViewers[code]) {
        publicViewers[code].delete(socket.id);
        const trip = trips[code];
        if (trip) trip.viewers = publicViewers[code].size;
      }
    });
  });
});

// ══════════════════════════════════════════════════════════
//  TCP SERVER — HARDWARE GPS TRACKER
//  Support: Teltonika, Sinotrack GT06, Concox
// ══════════════════════════════════════════════════════════
const TCP_PORT = process.env.TCP_PORT || 5000;

const tcpServer = net.createServer((socket) => {
  const clientIp = socket.remoteAddress;
  console.log(`📡 [HW GPS] Konek: ${clientIp}`);
  let deviceId = null;

  socket.on('data', (data) => {
    try {
      const hex = data.toString('hex');
      console.log(`📡 [HW GPS] Data hex: ${hex.slice(0,40)}...`);

      // ── GT06/Concox Protocol Parser ──────────────────
      if (hex.startsWith('7878')) {
        const parsed = parseGT06(data);
        if (parsed) {
          if (parsed.type === 'login') {
            deviceId = parsed.deviceId;
            // ACK login
            const ack = Buffer.from('787805010001d9dc0d0a','hex');
            socket.write(ack);
            console.log(`📡 [HW GPS] Login: ${deviceId}`);
          } else if (parsed.type === 'gps' && parsed.lat && parsed.lng) {
            const gpsData = {
              socketId:  'hw_'+deviceId,
              id:        deviceId || ('HW'+clientIp.replace(/\./g,'')),
              name:      'HW-'+( deviceId||'GPS'),
              lat:       parsed.lat,
              lng:       parsed.lng,
              speed:     parsed.speed||0,
              accuracy:  10, // hardware GPS biasanya ±5-10m
              heading:   parsed.heading||0,
              altitude:  0,
              timestamp: Date.now(),
              source:    'hardware',
              _lastZones: drivers['hw_'+deviceId]?._lastZones||{}
            };
            drivers['hw_'+deviceId] = gpsData;
            if (!gpsHistory[gpsData.id]) gpsHistory[gpsData.id]=[];
            gpsHistory[gpsData.id].push({...gpsData});
            if (gpsHistory[gpsData.id].length>500) gpsHistory[gpsData.id].shift();
            io.emit('gps-update', gpsData);
            checkGeofence(gpsData);
            console.log(`📡 [HW GPS] ${gpsData.id}: ${parsed.lat.toFixed(5)},${parsed.lng.toFixed(5)} ${parsed.speed}km/h`);
          }
        }
      }

      // ── Teltonika Protocol Parser ────────────────────
      else if (data.length > 10) {
        const parsed = parseTeltonika(data);
        if (parsed && parsed.records) {
          parsed.records.forEach(rec => {
            if (!rec.lat || !rec.lng) return;
            const gpsData = {
              socketId:  'hw_'+clientIp.replace(/[.:]/g,''),
              id:        'TLT-'+clientIp.split('.').pop(),
              name:      'Teltonika-'+clientIp.split('.').pop(),
              lat:       rec.lat, lng:rec.lng,
              speed:     rec.speed||0, accuracy:5,
              heading:   rec.angle||0, altitude:rec.altitude||0,
              timestamp: rec.timestamp||Date.now(),
              source:    'hardware_teltonika',
              _lastZones: {}
            };
            drivers[gpsData.socketId] = gpsData;
            io.emit('gps-update', gpsData);
            console.log(`📡 [Teltonika] ${gpsData.id}: ${rec.lat.toFixed(5)},${rec.lng.toFixed(5)}`);
          });
          // ACK Teltonika
          const count = parsed.records.length;
          const ack = Buffer.alloc(4);
          ack.writeUInt32BE(count, 0);
          socket.write(ack);
        }
      }
    } catch(e) {
      console.error('TCP parse error:', e.message);
    }
  });

  socket.on('error', (e) => console.error(`TCP error ${clientIp}:`, e.message));
  socket.on('close', () => {
    console.log(`📡 [HW GPS] Disconnect: ${clientIp}`);
    if (deviceId && drivers['hw_'+deviceId]) {
      io.emit('driver-offline', {socketId:'hw_'+deviceId, name:'HW-'+deviceId});
      delete drivers['hw_'+deviceId];
    }
  });
});

// ── GT06 Protocol Parser ──────────────────────────────────
function parseGT06(buf) {
  try {
    if (buf[0]!==0x78||buf[1]!==0x78) return null;
    const len    = buf[2];
    const type   = buf[3];
    if (type===0x01) { // Login packet
      const imei = buf.slice(4,12).toString('hex');
      return { type:'login', deviceId:imei };
    }
    if (type===0x10||type===0x12) { // GPS packet
      const year  = buf[4]+2000;
      const month = buf[5];
      const day   = buf[6];
      const hour  = buf[7];
      const min   = buf[8];
      const sec   = buf[9];
      const sats  = buf[10]>>4;
      const latRaw = buf.readUInt32BE(11);
      const lngRaw = buf.readUInt32BE(15);
      const speed  = buf[19];
      const course = buf.readUInt16BE(20);
      const N = (course>>10)&1, E = (course>>9)&1;
      const lat = (N?1:-1) * latRaw/30000/60;
      const lng = (E?1:-1) * lngRaw/30000/60;
      return { type:'gps', lat, lng, speed, heading:course&0x3FF, sats,
        timestamp: new Date(year,month-1,day,hour,min,sec).getTime() };
    }
    return null;
  } catch(e) { return null; }
}

// ── Teltonika Codec8 Parser ───────────────────────────────
function parseTeltonika(buf) {
  try {
    if (buf.length < 10) return null;
    const preamble = buf.readUInt32BE(0);
    if (preamble!==0) return null; // Teltonika starts with 0x00000000
    const dataLen = buf.readUInt32BE(4);
    const codecId = buf[8];
    if (codecId!==0x08&&codecId!==0x8E) return null; // Only codec8/8E
    const recCount1 = buf[9];
    const records = [];
    let pos = 10;
    for (let i=0;i<recCount1&&pos<buf.length-5;i++) {
      const ts  = Number(buf.readBigInt64BE(pos)); pos+=8;
      const pri = buf[pos++];
      const lng = buf.readInt32BE(pos)/10000000; pos+=4;
      const lat = buf.readInt32BE(pos)/10000000; pos+=4;
      const alt = buf.readInt16BE(pos); pos+=2;
      const ang = buf.readUInt16BE(pos); pos+=2;
      const sat = buf[pos++];
      const spd = buf.readUInt16BE(pos); pos+=2;
      const evId= buf[pos++];
      const ioCount=buf[pos++];
      // Skip IO data
      for(let j=0;j<4;j++){const c=buf[pos++];pos+=c*(j===0?1:j===1?2:j===2?4:8);}
      records.push({ timestamp:ts, lat, lng, altitude:alt, angle:ang, satellites:sat, speed:spd });
    }
    return { codecId, records };
  } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════════
//  GEOFENCE & ALERTS
// ══════════════════════════════════════════════════════════
function checkGeofence(d) {
  geozones.forEach(zone => {
    if (!zone.active) return;
    const dist = getDistance(d.lat,d.lng,zone.lat,zone.lng);
    const was  = d._lastZones?.[zone.id];
    const is   = dist<=zone.radius;
    if (was&&!is) createAlert('GEOFENCE_EXIT', `🚨 ${d.name} KELUAR zona ${zone.name}`,d,'critical');
    else if (!was&&is) createAlert('GEOFENCE_ENTER',`📍 ${d.name} masuk zona ${zone.name}`,d,'info');
    if (!d._lastZones) d._lastZones={};
    d._lastZones[zone.id]=is;
  });
}

function createAlert(type, message, d, level='warning') {
  const alert = {
    id:'al'+Date.now()+Math.random().toString(36).slice(2,5),
    type,message,level,
    driverId:d.id, driverName:d.name,
    lat:d.lat, lng:d.lng,
    timestamp:Date.now(), acked:false
  };
  alerts.push(alert);
  if (alerts.length>500) alerts.shift();
  io.emit('new-alert', alert);
  console.log(`⚡ ALERT [${level}]: ${message}`);
  return alert;
}

function getDistance(lat1,lng1,lat2,lng2) {
  const R=6371000;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function getLocalIP() {
  const ifaces=os.networkInterfaces();
  for(const n of Object.keys(ifaces)) for(const i of ifaces[n]) if(i.family==='IPv4'&&!i.internal) return i.address;
  return 'localhost';
}

// ══════════════════════════════════════════════════════════
//  START SERVERS
// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const IP   = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   🗺  MOMENTIFY FLEET v4 — ENTERPRISE SERVER              ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Login      →  http://localhost:${PORT}                    ║`);
  console.log(`║  Dashboard  →  http://localhost:${PORT}/dashboard          ║`);
  console.log(`║  HP Driver  →  http://${IP}:${PORT}/hp           ║`);
  console.log(`║  Public     →  http://localhost:${PORT}/track/[CODE]       ║`);
  console.log(`║  Pool Track →  http://localhost:${PORT}/pool/[CODE]        ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  ✓ Login & Multi-User  ✓ Public Trip Tracking            ║');
  console.log('║  ✓ Auto-Expire Link    ✓ Share ke Keluarga               ║');
  console.log('║  ✓ Nearest Driver      ✓ Hardware GPS TCP                ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});

tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  console.log(`📡 Hardware GPS TCP Server: port ${TCP_PORT}`);
  console.log(`   Support: GT06/Concox, Teltonika Codec8\n`);
});

tcpServer.on('error', (e) => console.error('TCP Server error:', e.message));