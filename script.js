/* ============================================
   RAFIDAIN & CO. — GOLD PRICING DASHBOARD
   ============================================ */

(function () {
    'use strict';

    var METAL_PRICES_URL = 'https://www.xau.ca/apps/api/metalprices/CAD';
    var AUTO_REFRESH_MS = 5 * 60 * 1000;
    var REFRESH_CLICK_COOLDOWN_MS = 2000;
    var STORAGE_KEY = 'rafidain_offsets';
    var latestApiUpdateMs = 0;
    var isRefreshing = false;
    var lastManualRefreshAtMs = 0;
    var lastSellSpot = NaN;

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

    // --- Gold spot (CAD/g) from xau.ca ---
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

    // =========================================
    //  UNIFIED OFFSETS (defaults + localStorage)
    // =========================================
    var DEFAULT_OFFSETS = {
        'sell|22K': 39,
        'sell|21K': 36,
        'sell|18K': 17,
        'sell|14K': -40,
        'sell|10K': -60,
        'buy|24K': -30,
        'buy|22K': -48,
        'buy|21K': -55,
        'buy|18K': -76,
        'buy|14K': -97,
        'buy|10K': -137,
        'preowned|22K': 10,
        'preowned|21K': 6,
        'preowned|18K': -15,
        'preowned|14K': -50,
        'preowned|10K': -107,
        'lira|22K': 8,
        'lira|21K': 5,
        'braided|22K|1-2': 21,
        'braided|21K|1-2': 22,
        'braided|22K|3-6': 17,
        'braided|21K|3-6': 10
    };

    // Merge defaults with any saved overrides
    var OFFSETS = {};
    (function initOffsets() {
        var key;
        for (key in DEFAULT_OFFSETS) {
            OFFSETS[key] = DEFAULT_OFFSETS[key];
        }
        try {
            var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            if (saved && typeof saved === 'object') {
                for (key in saved) {
                    if (typeof saved[key] === 'number') {
                        OFFSETS[key] = saved[key];
                    }
                }
            }
        } catch (e) { /* ignore */ }
    })();

    function saveOffsets() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(OFFSETS)); } catch (e) { /* ignore */ }
    }

    /** Build the offset key for a cell */
    function cellKey(row, col, band) {
        if (band) return row + '|' + col + '|' + band;
        return row + '|' + col;
    }

    /** Get offset for a cell (or undefined if none) */
    function getOffset(row, col, band) {
        return OFFSETS[cellKey(row, col, band)];
    }

    // =========================================
    //  APPLY PRICES
    // =========================================
    function applyCellPrice(cell, sellSpot) {
        var row = cell.dataset.row;
        var col = cell.dataset.col;
        var band = cell.dataset.band || '';
        var offset = getOffset(row, col, band);
        if (offset !== undefined && !isNaN(sellSpot)) {
            cell.textContent = formatCadPerGram(sellSpot + offset);
        }
    }

    function applyGoldSpotPrices(result) {
        var data = result && result.data;
        var source = result && result.source ? result.source : 'live';
        var gold = data && data.prices && data.prices.gold;
        if (!gold || !gold.sell || !gold.buy) {
            indicator.textContent = 'Gold prices unavailable';
            return;
        }

        lastSellSpot = parseFloat(String(gold.sell.spot_g));

        priceCells.forEach(function (cell) {
            applyCellPrice(cell, lastSellSpot);
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

    // =========================================
    //  FORMULA EDITOR POPUP
    // =========================================
    var activePopup = null;

    function closePopup() {
        if (activePopup) {
            activePopup.overlay.remove();
            activePopup = null;
        }
    }

    function buildLabel(row, col, band) {
        var rowNames = {
            sell: 'Sell', buy: 'Buy', preowned: 'Pre-owned',
            lira: 'Lira', braided: 'Braided Bangle'
        };
        var label = (rowNames[row] || row) + ' · ' + col;
        if (band) label += ' (' + band + ' pcs)';
        return label;
    }

    function openPopup(cell) {
        closePopup();

        var row = cell.dataset.row;
        var col = cell.dataset.col;
        var band = cell.dataset.band || '';
        var key = cellKey(row, col, band);
        var currentOffset = OFFSETS[key];
        if (currentOffset === undefined) return; // no formula for this cell

        // Overlay
        var overlay = document.createElement('div');
        overlay.className = 'formula-popup-overlay';

        // Popup card
        var popup = document.createElement('div');
        popup.className = 'formula-popup';

        // Title
        var title = document.createElement('div');
        title.className = 'formula-popup-title';
        title.textContent = buildLabel(row, col, band);
        popup.appendChild(title);

        // Description
        var desc = document.createElement('div');
        desc.className = 'formula-popup-desc';
        desc.textContent = 'Offset from 24K gold price (CAD/g)';
        popup.appendChild(desc);

        // Input row
        var inputRow = document.createElement('div');
        inputRow.className = 'formula-popup-input-row';

        var prefix = document.createElement('span');
        prefix.className = 'formula-popup-prefix';
        prefix.textContent = 'Gold Price';
        inputRow.appendChild(prefix);

        var sign = document.createElement('span');
        sign.className = 'formula-popup-sign';
        sign.textContent = currentOffset >= 0 ? '+' : '−';
        inputRow.appendChild(sign);

        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'formula-popup-input';
        input.value = Math.abs(currentOffset);
        input.step = '1';
        inputRow.appendChild(input);

        popup.appendChild(inputRow);

        // Toggle sign on click
        sign.addEventListener('click', function () {
            if (sign.textContent === '+') {
                sign.textContent = '−';
            } else {
                sign.textContent = '+';
            }
        });

        // Preview
        var preview = document.createElement('div');
        preview.className = 'formula-popup-preview';
        function updatePreview() {
            if (isNaN(lastSellSpot)) { preview.textContent = ''; return; }
            var val = parseFloat(input.value) || 0;
            var off = sign.textContent === '+' ? val : -val;
            preview.textContent = 'Result: ' + formatCadPerGram(lastSellSpot + off);
        }
        input.addEventListener('input', updatePreview);
        sign.addEventListener('click', updatePreview);
        updatePreview();
        popup.appendChild(preview);

        // Buttons
        var btnRow = document.createElement('div');
        btnRow.className = 'formula-popup-btns';

        var btnCancel = document.createElement('button');
        btnCancel.className = 'formula-popup-btn cancel';
        btnCancel.textContent = 'Cancel';
        btnCancel.addEventListener('click', closePopup);

        var btnSave = document.createElement('button');
        btnSave.className = 'formula-popup-btn save';
        btnSave.textContent = 'Save';
        btnSave.addEventListener('click', function () {
            var val = parseFloat(input.value) || 0;
            var newOffset = sign.textContent === '+' ? val : -val;
            OFFSETS[key] = newOffset;
            saveOffsets();
            applyCellPrice(cell, lastSellSpot);
            closePopup();
        });

        btnRow.appendChild(btnCancel);
        btnRow.appendChild(btnSave);
        popup.appendChild(btnRow);

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        // Focus input
        input.focus();
        input.select();

        // Close on overlay click
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closePopup();
        });

        // Close on Escape
        function onKey(e) {
            if (e.key === 'Escape') { closePopup(); document.removeEventListener('keydown', onKey); }
            if (e.key === 'Enter') { btnSave.click(); document.removeEventListener('keydown', onKey); }
        }
        document.addEventListener('keydown', onKey);

        activePopup = { overlay: overlay, cleanup: function () { document.removeEventListener('keydown', onKey); } };
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

    // --- Price cell click → formula editor ---
    priceCells.forEach(function (cell) {
        cell.addEventListener('click', function () {
            openPopup(cell);
        });
    });

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
