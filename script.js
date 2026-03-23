/* ============================================
   RAFIDAIN & CO. — GOLD PRICING DASHBOARD
   ============================================ */

(function () {
    'use strict';

    var METAL_PRICES_URL = 'https://www.xau.ca/apps/api/metalprices/CAD';
    var AUTO_REFRESH_MS = 5 * 60 * 1000;
    var REFRESH_CLICK_COOLDOWN_MS = 2000;
    var latestApiUpdateMs = 0;
    var isRefreshing = false;
    var lastManualRefreshAtMs = 0;

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

    function fetchJson(url) {
        return fetch(url, {
            credentials: 'omit',
            cache: 'no-store'
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            });
    }

    function fetchMetalPricesJson() {
        var directUrl = withNoCache(METAL_PRICES_URL);
        var codetabsUrl = 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(withNoCache(METAL_PRICES_URL));
        var allOriginsUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(withNoCache(METAL_PRICES_URL));

        return fetchJson(directUrl)
            .then(function (data) { return { data: data, source: 'live' }; })
            .catch(function () {
                return fetchJson(codetabsUrl)
                    .then(function (data) { return { data: data, source: 'proxy-codetabs' }; });
            })
            .catch(function () {
                return fetchJson(allOriginsUrl)
                    .then(function (data) { return { data: data, source: 'proxy-allorigins' }; });
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
            } catch (e) { when = updated; }
        }
        var via = '';
        if (source === 'proxy-codetabs') via = ' · via codetabs';
        else if (source === 'proxy-allorigins') via = ' · via allorigins';
        else if (source === 'proxy') via = ' · via proxy';
        indicator.textContent = 'Gold spot CAD/g · xau.ca' + (when ? ' · ' + when : '') + via;
    }

    function loadMetalPrices(options) {
        var opts = options || {};
        var isManual = opts.manual === true;
        if (isRefreshing) return;
        isRefreshing = true;

        indicator.textContent = isManual ? 'Refreshing gold…' : 'Loading gold…';
        fetchMetalPricesJson()
            .then(applyGoldSpotPrices)
            .then(function () {
                if (!isManual) return;
                var checkedAt = new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                indicator.textContent = indicator.textContent + ' · checked ' + checkedAt;
            })
            .then(function () {
                isRefreshing = false;
            })
            .catch(function (err) {
                indicator.textContent = 'Could not load gold prices';
                if (err && err.message) indicator.textContent += ' (' + err.message + ')';
                isRefreshing = false;
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
        var nowMs = Date.now();
        if (nowMs - lastManualRefreshAtMs < REFRESH_CLICK_COOLDOWN_MS) return;
        lastManualRefreshAtMs = nowMs;

        var svg = btnRefresh.querySelector('svg');
        if (svg) {
            svg.style.transition = 'transform 0.5s ease';
            svg.style.transform = 'rotate(360deg)';
            setTimeout(function () { svg.style.transition = 'none'; svg.style.transform = ''; }, 500);
        }
        loadMetalPrices({ manual: true });
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
