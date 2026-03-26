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
    var priceCells = document.querySelectorAll('.cell.price');

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

    // --- Sell-row karat offsets from 24K spot price ---
    var SELL_OFFSETS = {
        '22K': 39,
        '21K': 36,
        '18K': 17,
        '14K': -40,
        '10K': -60
    };

    // --- Buy-row karat offsets from 24K spot price ---
    var BUY_OFFSETS = {
        '24K': -30,
        '22K': -48,
        '21K': -55,
        '18K': -76,
        '14K': -97,
        '10K': -137
    };

    // --- Pre-owned row karat offsets from 24K spot price ---
    var PREOWNED_OFFSETS = {
        '22K': 10,
        '21K': 6,
        '18K': -15,
        '14K': -50,
        '10K': -107
    };

    // --- Lira row karat offsets from 24K spot price ---
    var LIRA_OFFSETS = {
        '22K': 8,
        '21K': 5
    };

    // --- Braided Bangle 1-2 pcs offsets from 24K spot price ---
    var BRAIDED_1_2_OFFSETS = {
        '22K': 21,
        '21K': 22
    };

    // --- Braided Bangle 3-6 pcs offsets from 24K spot price ---
    var BRAIDED_3_6_OFFSETS = {
        '22K': 17,
        '21K': 10
    };

    function applyGoldSpotPrices(result) {
        var data = result && result.data;
        var source = result && result.source ? result.source : 'live';
        var gold = data && data.prices && data.prices.gold;
        if (!gold || !gold.sell || !gold.buy) {
            indicator.textContent = 'Gold prices unavailable';
            return;
        }

        var sellSpot = parseFloat(String(gold.sell.spot_g));
        var buySpot = parseFloat(String(gold.buy.spot_g));

        priceCells.forEach(function (cell) {
            var row = cell.dataset.row;
            var col = cell.dataset.col;

            if (row === 'sell') {
                // Apply sell formula: spot + offset per karat
                var offset = SELL_OFFSETS[col];
                if (offset !== undefined && !isNaN(sellSpot)) {
                    cell.textContent = formatCadPerGram(sellSpot + offset);
                }
            } else if (row === 'buy') {
                // Apply buy formula: spot + offset per karat
                var buyOffset = BUY_OFFSETS[col];
                if (buyOffset !== undefined && !isNaN(sellSpot)) {
                    cell.textContent = formatCadPerGram(sellSpot + buyOffset);
                }
            } else if (row === 'preowned') {
                // Apply pre-owned formula: spot + offset per karat
                var preownedOffset = PREOWNED_OFFSETS[col];
                if (preownedOffset !== undefined && !isNaN(sellSpot)) {
                    cell.textContent = formatCadPerGram(sellSpot + preownedOffset);
                }
            } else if (row === 'lira') {
                // Apply lira formula: spot + offset per karat
                var liraOffset = LIRA_OFFSETS[col];
                if (liraOffset !== undefined && !isNaN(sellSpot)) {
                    cell.textContent = formatCadPerGram(sellSpot + liraOffset);
                }
            } else if (row === 'braided') {
                var band = cell.dataset.band;
                if (band === '1-2') {
                    // Apply braided 1-2 pcs formula
                    var b12Offset = BRAIDED_1_2_OFFSETS[col];
                    if (b12Offset !== undefined && !isNaN(sellSpot)) {
                        cell.textContent = formatCadPerGram(sellSpot + b12Offset);
                    }
                } else if (band === '3-6') {
                    // Apply braided 3-6 pcs formula
                    var b36Offset = BRAIDED_3_6_OFFSETS[col];
                    if (b36Offset !== undefined && !isNaN(sellSpot)) {
                        cell.textContent = formatCadPerGram(sellSpot + b36Offset);
                    }
                }
            } else {
                // Other rows: show sell spot as base for now
                if (!isNaN(sellSpot)) {
                    cell.textContent = formatCadPerGram(sellSpot);
                }
            }
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
