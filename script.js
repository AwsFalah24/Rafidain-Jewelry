/* ============================================
   RAFIDAIN & CO. — GOLD PRICING DASHBOARD
   ============================================ */

(function () {
    'use strict';

    var METAL_PRICES_URL = 'https://www.xau.ca/apps/api/metalprices/CAD';
    var AUTO_REFRESH_MS = 5 * 60 * 1000;
    var FETCH_TIMEOUT_MS = 4500;
    var latestApiUpdateMs = 0;

    /** Mon–Sat, 10:00–17:59 (local time on this device). */
    function isBusinessHoursActive(date) {
        var d = date || new Date();
        var day = d.getDay();
        if (day < 1 || day > 6) return false;
        var h = d.getHours();
        return h >= 10 && h < 18;
    }

    var dateEl = document.getElementById('current-date');
    var timeEl = document.getElementById('current-time');
    var indicator = document.getElementById('cell-indicator');
    var btnRefresh = document.getElementById('btn-refresh');
    var btnPrint = document.getElementById('btn-print');
    var cells = document.querySelectorAll('.cell');

    // --- Gold spot (CAD/g) from xau.ca — same value per karat column until you add karat formulas ---
    function formatCadPerGram(spotStr) {
        var n = parseFloat(String(spotStr));
        if (isNaN(n)) return '';
        return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    }

    function withNoCache(url) {
        var sep = url.indexOf('?') === -1 ? '?' : '&';
        return url + sep + '_ts=' + Date.now();
    }

    function fetchJsonWithTimeout(url, timeoutMs) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
        return fetch(url, {
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .finally(function () {
                clearTimeout(timer);
            });
    }

    function fetchMetalPricesJson() {
        var directUrl = withNoCache(METAL_PRICES_URL);
        var proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(withNoCache(METAL_PRICES_URL));

        return fetchJsonWithTimeout(directUrl, FETCH_TIMEOUT_MS)
            .then(function (data) { return { data: data, source: 'live' }; })
            .catch(function () {
                return fetchJsonWithTimeout(proxyUrl, FETCH_TIMEOUT_MS)
                    .then(function (data) { return { data: data, source: 'proxy' }; });
            });
    }

    function applyGoldSpotPrices(result) {
        var data = result && result.data;
        var source = result && result.source ? result.source : 'live';
        var gold = data && data.prices && data.prices.gold;
        if (!gold || !gold.sell || !gold.buy) {
            indicator.textContent = 'Gold prices unavailable';
            return;
        }

        var sellG = formatCadPerGram(gold.sell.spot_g);
        var buyG = formatCadPerGram(gold.buy.spot_g);
        var baseG = sellG;

        cells.forEach(function (cell) {
            var row = cell.dataset.row;
            var text = baseG;
            if (row === 'sell') text = sellG;
            else if (row === 'buy') text = buyG;
            cell.textContent = text;
        });

        var updated = data.rates && data.rates.lastUpdate;
        var updatedMs = updated ? Date.parse(updated) : NaN;
        if (!isNaN(updatedMs)) {
            if (updatedMs < latestApiUpdateMs) {
                indicator.textContent = 'Ignored older price update';
                return;
            }
            latestApiUpdateMs = updatedMs;
        }

        var when = '';
        if (updated) {
            try {
                when = new Date(updated).toLocaleString('en-CA', { dateStyle: 'short', timeStyle: 'short' });
            } catch { when = updated; }
        }
        indicator.textContent = 'Gold spot CAD/g · xau.ca' + (when ? ' · ' + when : '') + (source === 'proxy' ? ' · via proxy' : '');
    }

    function loadMetalPrices() {
        indicator.textContent = 'Loading gold…';
        fetchMetalPricesJson()
            .then(applyGoldSpotPrices)
            .catch(function () {
                indicator.textContent = 'Could not load gold prices';
            });
    }

    function maybeAutoRefreshMetalPrices() {
        if (!isBusinessHoursActive()) return;
        loadMetalPrices();
    }

    // --- Clock ---
    function tick() {
        var now = new Date();
        timeEl.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }
    tick();
    setInterval(tick, 1000);

    // --- Buttons ---
    btnRefresh.addEventListener('click', function () {
        var svg = btnRefresh.querySelector('svg');
        svg.style.transition = 'transform 0.5s ease';
        svg.style.transform = 'rotate(360deg)';
        setTimeout(function () { svg.style.transition = 'none'; svg.style.transform = ''; }, 500);
        loadMetalPrices();
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

    loadMetalPrices();
    setInterval(maybeAutoRefreshMetalPrices, AUTO_REFRESH_MS);

})();
