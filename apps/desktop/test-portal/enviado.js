// Página de confirmación: muestra la tabla de valores recibidos en ?d= (base64url de JSON [[etiqueta, valor], ...]).
(function () {
  var table = document.querySelector('table.summary');
  var d = new URLSearchParams(location.search).get('d') || '';
  var rows = [];
  try {
    var b64 = d.replace(/-/g, '+').replace(/_/g, '/');
    rows = JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch (e) {
    rows = [];
  }
  rows.forEach(function (r) {
    var tr = document.createElement('tr');
    var th = document.createElement('th');
    var td = document.createElement('td');
    th.textContent = r[0];
    td.textContent = r[1];
    tr.appendChild(th);
    tr.appendChild(td);
    table.appendChild(tr);
  });
})();
