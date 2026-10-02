(function () {
  if (window.__capHook) return;
  window.__capHook = 1;
  var CAP = window.CAP;
  if (!CAP) return;
  function mask(s) {
    return String(s == null ? '' : s).replace(/((?:pass|psk|key|pwd)[^=&:"]*[=:"]+)([^&"]*)/ig, '$1***');
  }
  function abs(u) {
    try { var a = new URL(u, location.href); return a.pathname + a.search; } catch (e) { return String(u); }
  }
  function send(o) { try { CAP.log(JSON.stringify(o)); } catch (e) {} }

  var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send, xh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__c = { m: m, u: u, h: {} }; return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__c) this.__c.h[k] = v; return xh.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    var c = this.__c, x = this;
    if (c) {
      c.b = b == null ? '' : String(b);
      this.addEventListener('loadend', function () {
        var r = '';
        try { r = mask(x.responseText).slice(0, 700); } catch (e) {}
        send({ t: 'xhr', m: String(c.m).toUpperCase(), u: abs(c.u), b: mask(c.b), s: x.status, r: r });
      });
    }
    return xs.apply(this, arguments);
  };

  if (window.fetch) {
    var of = window.fetch;
    window.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      var m = (init && init.method) || (input && input.method) || 'GET';
      var b = init && init.body != null ? String(init.body) : '';
      return of.apply(this, arguments).then(function (res) {
        send({ t: 'fetch', m: String(m).toUpperCase(), u: abs(u), b: mask(b), s: res.status, r: '' });
        return res;
      });
    };
  }

  function logForm(f) {
    var body = '';
    try { body = new URLSearchParams(new FormData(f)).toString(); } catch (e) {}
    send({ t: 'form', m: String(f.method || 'GET').toUpperCase(), u: abs(f.action || location.href), b: mask(body), s: 0, r: '' });
  }
  document.addEventListener('submit', function (e) { logForm(e.target); }, true);
  var fs = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () { logForm(this); return fs.apply(this, arguments); };
})();
