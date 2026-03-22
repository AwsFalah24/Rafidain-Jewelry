/* ============================================
   RAFIDAIN & CO. — GOLD PRICING DASHBOARD
   ============================================ */

(function () {
    'use strict';

    var dateEl = document.getElementById('current-date');
    var timeEl = document.getElementById('current-time');
    var indicator = document.getElementById('cell-indicator');
    var btnRefresh = document.getElementById('btn-refresh');
    var btnPrint = document.getElementById('btn-print');
    var cells = document.querySelectorAll('.cell');

    // --- Clock ---
    function tick() {
        var now = new Date();
        timeEl.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }
    tick();
    setInterval(tick, 1000);

    // --- Selection ---
    var active = null;
    var rowNames = { sell: 'Sell', buy: 'Buy', preowned: 'Pre-owned', lira: 'Lira', braided: 'Braided Bangle' };

    function select(cell) {
        if (active) active.classList.remove('selected');
        active = cell;
        cell.classList.add('selected');
        indicator.textContent = (rowNames[cell.dataset.row] || cell.dataset.row) + ' \u00B7 ' + cell.dataset.col;
    }

    function deselect() {
        if (active) { active.classList.remove('selected'); active = null; }
        indicator.textContent = 'Ready';
    }

    cells.forEach(function (c) {
        c.addEventListener('focus', function () { select(c); });

        c.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); move(c, 'down'); }
            if (e.key === 'Escape') { e.preventDefault(); c.blur(); deselect(); }
            if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(c, 'down'); }
            if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(c, 'up'); }
            if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); move(c, 'right'); }
            if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); move(c, 'left'); }
        });
    });

    function move(cell, dir) {
        var row = cell.closest('tr');
        var idx = Array.from(row.children).indexOf(cell);
        var target = null;

        if (dir === 'right') { var n = cell.nextElementSibling; if (n && n.classList.contains('cell')) target = n; }
        if (dir === 'left') { var p = cell.previousElementSibling; if (p && p.classList.contains('cell')) target = p; }
        if (dir === 'down') { var nr = row.nextElementSibling; while (nr && nr.classList.contains('divider-row')) nr = nr.nextElementSibling; if (nr) { var nc = nr.querySelectorAll('.cell'); if (nc[idx - 1]) target = nc[idx - 1]; } }
        if (dir === 'up') { var pr = row.previousElementSibling; while (pr && pr.classList.contains('divider-row')) pr = pr.previousElementSibling; if (pr) { var pc = pr.querySelectorAll('.cell'); if (pc[idx - 1]) target = pc[idx - 1]; } }

        if (target) target.focus();
    }

    document.addEventListener('click', function (e) {
        if (!e.target.closest('#pricing-table')) deselect();
    });

    // --- Buttons ---
    btnRefresh.addEventListener('click', function () {
        var svg = btnRefresh.querySelector('svg');
        svg.style.transition = 'transform 0.5s ease';
        svg.style.transform = 'rotate(360deg)';
        setTimeout(function () { svg.style.transition = 'none'; svg.style.transform = ''; }, 500);
    });

    btnPrint.addEventListener('click', function () { window.print(); });

    // --- Row entrance ---
    var rows = document.querySelectorAll('tbody tr:not(.divider-row)');
    rows.forEach(function (r, i) {
        r.style.opacity = '0';
        r.style.transform = 'translateY(8px)';
        r.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
        setTimeout(function () { r.style.opacity = '1'; r.style.transform = 'translateY(0)'; }, 120 + i * 60);
    });

})();
