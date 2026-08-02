'use strict';

/**
 * Static HTTPS server for MotionMirror.
 *
 * HTTPS (not just HTTP) is required because getUserMedia() only works in a
 * "secure context". That includes https:// origins, but ALSO plain
 * http://localhost on the same machine. It does NOT include http://<lan-ip>,
 * which is exactly what a phone needs to reach this PC over Wi-Fi. So a
 * self-signed cert covering localhost + the machine's current LAN IPs is
 * generated on first run (and regenerated automatically if the LAN IP
 * changes, e.g. after switching networks).
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CERT_DIR = path.join(ROOT, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const META_PATH = path.join(CERT_DIR, 'meta.json');

const HTTPS_PORT = Number(process.env.PORT) || 8443;
const HTTP_PORT = HTTPS_PORT === 8080 ? 8081 : 8080;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Interfaces whose names suggest they're not the Wi-Fi/Ethernet link a phone
// would actually share (VPNs, Hyper-V/WSL/Docker virtual switches, etc).
const VIRTUAL_ADAPTER_HINTS = /vpn|virtual|vethernet|hyper-v|wsl|docker|hamachi|loopback|tailscale|zerotier/i;

function getLocalIPv4s() {
  const nets = os.networkInterfaces();
  const all = [];
  const likelyLan = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        all.push(net.address);
        if (!VIRTUAL_ADAPTER_HINTS.test(name)) likelyLan.push(net.address);
      }
    }
  }
  // Cert SAN always includes every IP (cheap, avoids surprises if the
  // heuristic is wrong); only the *printed* list is filtered for clarity.
  return { all, likelyLan: likelyLan.length ? likelyLan : all };
}

function ensureCert(ips) {
  fs.mkdirSync(CERT_DIR, { recursive: true });

  let previousIps = null;
  if (fs.existsSync(META_PATH)) {
    try {
      previousIps = JSON.parse(fs.readFileSync(META_PATH, 'utf8')).ips;
    } catch (_) {
      previousIps = null;
    }
  }

  const haveCert = fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);
  const sameIps =
    previousIps &&
    previousIps.length === ips.length &&
    previousIps.every((ip) => ips.includes(ip));

  if (haveCert && sameIps) {
    return;
  }

  console.log('[cert] Generando certificado autofirmado para:', ['localhost', '127.0.0.1', ...ips].join(', '));

  const sanEntries = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)];
  const san = `subjectAltName=${sanEntries.join(',')}`;

  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY_PATH,
    '-out', CERT_PATH,
    '-days', '825',
    '-subj', '/CN=MotionMirror',
    '-addext', san,
  ];

  const result = spawnSync('openssl', args, { stdio: 'inherit' });

  if (result.error || result.status !== 0) {
    console.error('[cert] No se pudo generar el certificado con openssl.');
    console.error('       Verifica que "openssl" este disponible en el PATH (viene con Git for Windows).');
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }

  fs.writeFileSync(META_PATH, JSON.stringify({ ips, generatedAt: new Date().toISOString() }, null, 2));
  console.log('[cert] Certificado generado en', CERT_DIR);
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const resolved = path.normalize(path.join(base, decoded));
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function serveStatic(req, res) {
  let filePath = safeJoin(PUBLIC_DIR, req.url === '/' ? '/index.html' : req.url);

  if (!filePath) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || (!stats.isFile() && !stats.isDirectory())) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 - No encontrado');
      return;
    }

    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 - No encontrado');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        // Never cache during active development / testing.
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
}

function main() {
  const { all: allIps, likelyLan } = getLocalIPv4s();
  ensureCert(allIps);

  const httpsOptions = {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  };

  https.createServer(httpsOptions, serveStatic).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('\nMotionMirror corriendo. Abre uno de estos enlaces:\n');
    console.log(`  Este PC (sin advertencia de certificado): http://localhost:${HTTP_PORT}`);
    for (const ip of likelyLan) {
      console.log(`  Celular / otro dispositivo (misma red Wi-Fi): https://${ip}:${HTTPS_PORT}`);
    }
    console.log('\nEl enlace del celular usa un certificado autofirmado: el navegador');
    console.log('mostrara una advertencia la primera vez. Elige "Avanzado" -> "Continuar".');
    console.log('\nCtrl+C para detener.\n');
  });

  // Plain HTTP, but only on the loopback interface: Chrome/Edge/Firefox treat
  // http://localhost as a secure context (so getUserMedia works) without
  // needing a certificate at all. Not bound to 0.0.0.0 so the camera feed is
  // never reachable over the LAN unencrypted; other devices must use HTTPS.
  http.createServer(serveStatic).listen(HTTP_PORT, '127.0.0.1');
}

main();
