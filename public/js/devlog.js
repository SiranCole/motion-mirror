// Dev aid for testing on phones against the local server (server.js): relays
// uncaught errors and console.error/warn to the PC's terminal. Classic
// (non-module) script so it still runs — and can report — if a module fails
// to load or parse. Inert anywhere but the local server's LAN HTTPS port.
(function () {
  if (location.port !== '8443') return;

  function send(level, parts) {
    var message = Array.prototype.map.call(parts, function (p) {
      if (p instanceof Error) return (p.name + ': ' + p.message + '\n' + (p.stack || '')).trim();
      if (typeof p === 'object') {
        try { return JSON.stringify(p); } catch (_) { return String(p); }
      }
      return String(p);
    }).join(' ');
    try {
      fetch('/__devlog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: level, message: message, ua: navigator.userAgent }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) { /* nothing useful left to do */ }
  }

  ['error', 'warn', 'info'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      send(level, arguments);
      return original.apply(console, arguments);
    };
  });

  window.addEventListener('error', function (e) {
    var where = e.filename ? ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno : '';
    send('uncaught', [e.error || (e.message + where)]);
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    send('unhandledrejection', [e.reason]);
  });

  send('info', ['page loaded: ' + location.href + ' secure=' + window.isSecureContext
    + ' mediaDevices=' + !!navigator.mediaDevices]);
})();
