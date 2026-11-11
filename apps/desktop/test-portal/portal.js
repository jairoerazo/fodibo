// Portal de prueba: script clásico (sin módulos), compatible con CSP default-src 'self'.
// Navegación de envío: usa window.__fodiboNavigate(url) si existe (las pruebas la sustituyen);
// por defecto, location.assign(url). La URL se calcula relativa a la página actual.
(function () {
  if (typeof window.__fodiboNavigate !== 'function') {
    window.__fodiboNavigate = function (url) {
      location.assign(url);
    };
  }

  var sections = Array.prototype.slice.call(document.querySelectorAll('section[data-step]'));

  function sec(n) {
    return sections[n - 1];
  }
  function fieldsOf(s) {
    return Array.prototype.slice.call(s.querySelectorAll('[name]'));
  }
  function labelOf(f) {
    var l = document.querySelector('label[for="' + f.id + '"]');
    return l ? l.textContent.trim() : f.name;
  }
  function show(n) {
    sections.forEach(function (s, i) {
      s.hidden = i + 1 !== n;
    });
    if (n === 5) renderSummary();
  }
  function fill(ul, msgs) {
    ul.textContent = '';
    msgs.forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = m;
      ul.appendChild(li);
    });
  }
  function validDate(v) {
    var m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
    if (!m) return false;
    var d = +m[1], mo = +m[2], y = +m[3];
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }
  function validAmount(v) {
    return /^-?\d+(\.\d{1,2})?$/.test(v) || /^-?\d{1,3}('\d{3})+(\.\d{1,2})?$/.test(v);
  }
  function value(f) {
    return f.type === 'checkbox' ? (f.checked ? 'ja' : '') : f.value.trim();
  }
  function renderSummary() {
    var table = sec(5).querySelector('.summary');
    table.textContent = '';
    collect().forEach(function (r) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      var td = document.createElement('td');
      th.textContent = r[0];
      td.textContent = r[1] || '—';
      tr.appendChild(th);
      tr.appendChild(td);
      table.appendChild(tr);
    });
  }
  function collect() {
    var rows = [];
    for (var n = 1; n <= 4; n++) {
      fieldsOf(sec(n)).forEach(function (f) {
        rows.push([labelOf(f), value(f)]);
      });
    }
    return rows;
  }
  function b64url(s) {
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function onNext(n) {
    var s = sec(n);
    var errors = [];
    var warnings = [];
    fieldsOf(s).forEach(function (f) {
      f.removeAttribute('aria-invalid');
      var v = value(f);
      if (f.dataset.type === 'date' && v && !validDate(v)) {
        errors.push(labelOf(f) + ': ungültiges Datum (TT.MM.JJJJ)');
        f.setAttribute('aria-invalid', 'true');
      } else if (f.required && !v) {
        warnings.push(labelOf(f) + ': Pflichtfeld nicht ausgefüllt');
        f.setAttribute('aria-invalid', 'true');
      }
    });
    fill(s.querySelector('.errors'), errors);
    fill(s.querySelector('.warnings'), warnings);
    if (errors.length === 0) show(n + 1);
  }

  function onSubmit() {
    var s = sec(5);
    var errors = [];
    for (var n = 1; n <= 4; n++) {
      fieldsOf(sec(n)).forEach(function (f) {
        var v = value(f);
        if (f.required && !v) errors.push(labelOf(f) + ': Pflichtfeld nicht ausgefüllt');
        else if (v && f.dataset.type === 'date' && !validDate(v)) errors.push(labelOf(f) + ': ungültiges Datum');
        else if (v && f.dataset.type === 'amount' && !validAmount(v)) errors.push(labelOf(f) + ': ungültiger Betrag');
      });
    }
    if (!s.querySelector('input[name="p5_bestaetigung"]').checked) {
      errors.push('Bestätigung fehlt: bitte Richtigkeit der Angaben bestätigen');
    }
    fill(s.querySelector('.errors'), errors);
    if (errors.length) return;
    var url = new URL('enviado.html?d=' + b64url(JSON.stringify(collect())), location.href);
    window.__fodiboNavigate(url.href);
  }

  var form = document.querySelector('form');
  form.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!b) return;
    var n = sections.indexOf(b.closest('section[data-step]')) + 1;
    if (b.dataset.action === 'next') onNext(n);
    else if (b.dataset.action === 'back') show(n - 1);
    else if (b.dataset.action === 'submit') onSubmit();
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
  });
})();
