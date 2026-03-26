/* ============================================
   RAFIDAIN & CO. — GOLD PRICING DASHBOARD
   ============================================ */

(function () {
    'use strict';

    // =========================================
    //  FIREBASE INIT
    // =========================================
    var firebaseConfig = {
        apiKey: 'AIzaSyBC69pCVJ_dXnuj3P9OdX29e1avszQ18CY',
        authDomain: 'rafidain-co.firebaseapp.com',
        databaseURL: 'https://rafidain-co-default-rtdb.firebaseio.com',
        projectId: 'rafidain-co',
        storageBucket: 'rafidain-co.firebasestorage.app',
        messagingSenderId: '991543794539',
        appId: '1:991543794539:web:3c52bba694f42d1e998a2e',
        measurementId: 'G-XB1FCF6L8X'
    };
    firebase.initializeApp(firebaseConfig);
    var db = firebase.database();

    var METAL_PRICES_URL = 'https://www.xau.ca/apps/api/metalprices/CAD';
    var AUTO_REFRESH_MS = 5 * 60 * 1000;
    var REFRESH_CLICK_COOLDOWN_MS = 2000;
    var STORAGE_KEY = 'rafidain_offsets';
    var BAR_STORAGE_KEY = 'rafidain_bar_formulas';
    var SESSION_KEY = 'rafidain_logged_in';
    var ROLE_KEY = 'rafidain_role';
    var DEFAULT_USERS = [
        { user: 'Admin', pass: '1729', role: 'admin' },
        { user: 'r', pass: 'r', role: 'viewer' }
    ];
    var USERS = [];

    // Sync users from Firebase (and initialize if empty)
    db.ref('users').on('value', function (snapshot) {
        var data = snapshot.val();
        if (data && Array.isArray(data)) {
            // Auto-upgrade old Hassan account to Admin
            if (data[0] && data[0].user === 'Hassan') {
                data[0] = { user: 'Admin', pass: '1729', role: 'admin' };
                db.ref('users').set(data); // Save the fix to Firebase
            }
            USERS = data;
        } else {
            USERS = DEFAULT_USERS;
            db.ref('users').set(DEFAULT_USERS);
        }
    });
    var currentRole = '';
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
    //  UNIFIED OFFSETS (defaults + Firebase)
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

    // Start with defaults
    var OFFSETS = {};
    (function initOffsets() {
        var key;
        for (key in DEFAULT_OFFSETS) {
            OFFSETS[key] = DEFAULT_OFFSETS[key];
        }
    })();

    function saveOffsets() {
        // Save to Firebase (admin only)
        db.ref('offsets').set(OFFSETS);
    }

    // Listen for real-time offset changes from Firebase
    db.ref('offsets').on('value', function (snapshot) {
        var data = snapshot.val();
        if (data && typeof data === 'object') {
            var key;
            // Reset to defaults first
            for (key in DEFAULT_OFFSETS) {
                OFFSETS[key] = DEFAULT_OFFSETS[key];
            }
            // Apply Firebase overrides
            for (key in data) {
                if (typeof data[key] === 'number') {
                    OFFSETS[key] = data[key];
                }
            }
            // Recalculate all prices if we have a spot price
            if (!isNaN(lastSellSpot)) {
                priceCells.forEach(function (cell) {
                    applyCellPrice(cell, lastSellSpot);
                });
            }
        }
    });

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

    // =========================================
    //  GOLD BARS — 24K FORMULAS
    // =========================================
    var DEFAULT_BAR_FORMULAS = {
        '100g': { mult: 100, markup: 360 },
        '50g': { mult: 50, markup: 375 },
        '1oz': { mult: 31.1, markup: 145 },
        '20g': { mult: 20, markup: 125 },
        'half-oz': { mult: 15.5, markup: 115 },
        '10g': { mult: 10, markup: 115 },
        '5g': { mult: 5, markup: 100 },
        '2.5g': { mult: 2.5, markup: 70 },
        '1g': { mult: 1, markup: 55 }
    };

    // Merge defaults with Firebase
    var BAR_FORMULAS = {};
    (function initBarFormulas() {
        var key;
        for (key in DEFAULT_BAR_FORMULAS) {
            BAR_FORMULAS[key] = { mult: DEFAULT_BAR_FORMULAS[key].mult, markup: DEFAULT_BAR_FORMULAS[key].markup };
        }
    })();

    function saveBarFormulas() {
        // Save to Firebase (admin only)
        db.ref('barFormulas').set(BAR_FORMULAS);
    }

    // Listen for real-time bar formula changes from Firebase
    db.ref('barFormulas').on('value', function (snapshot) {
        var data = snapshot.val();
        if (data && typeof data === 'object') {
            var key;
            // Reset to defaults first
            for (key in DEFAULT_BAR_FORMULAS) {
                BAR_FORMULAS[key] = { mult: DEFAULT_BAR_FORMULAS[key].mult, markup: DEFAULT_BAR_FORMULAS[key].markup };
            }
            // Apply Firebase overrides
            for (key in data) {
                if (data[key] && typeof data[key].mult === 'number' && typeof data[key].markup === 'number') {
                    BAR_FORMULAS[key] = { mult: data[key].mult, markup: data[key].markup };
                }
            }
            // Recalculate all bar prices if we have a spot price
            if (!isNaN(lastSellSpot)) {
                applyBarPrices(lastSellSpot);
            }
        }
    });

    var barCells = document.querySelectorAll('.bar-price');

    function formatBarPrice(val) {
        var n = parseFloat(String(val));
        if (isNaN(n)) return '';
        var dec = (n % 1 !== 0) ? 2 : 0;
        return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: dec, maximumFractionDigits: 2 });
    }

    function applyBarCellPrice(cell, sellSpot) {
        var barKey = cell.dataset.bar;
        var formula = BAR_FORMULAS[barKey];
        if (formula && !isNaN(sellSpot)) {
            var price = (sellSpot * formula.mult) + formula.markup;
            cell.textContent = formatBarPrice(price);
        }
    }

    function applyBarPrices(sellSpot) {
        if (isNaN(sellSpot)) return;
        barCells.forEach(function (cell) {
            applyBarCellPrice(cell, sellSpot);
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

        lastSellSpot = parseFloat(String(gold.sell.spot_g));

        priceCells.forEach(function (cell) {
            applyCellPrice(cell, lastSellSpot);
        });

        // Gold bars
        applyBarPrices(lastSellSpot);

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

    // =========================================
    //  BAR FORMULA EDITOR POPUP
    // =========================================
    var BAR_LABELS = {
        '100g': '100g', '50g': '50g', '1oz': '1 oz', '20g': '20g',
        'half-oz': '1/2 oz', '10g': '10g', '5g': '5g', '2.5g': '2.5g', '1g': '1g'
    };

    function openBarPopup(cell) {
        closePopup();

        var barKey = cell.dataset.bar;
        var formula = BAR_FORMULAS[barKey];
        if (!formula) return;

        var currentMult = formula.mult;
        var currentMarkup = formula.markup;

        // Overlay
        var overlay = document.createElement('div');
        overlay.className = 'formula-popup-overlay';

        // Popup card
        var popup = document.createElement('div');
        popup.className = 'formula-popup';

        // Title
        var title = document.createElement('div');
        title.className = 'formula-popup-title';
        title.textContent = 'Gold Bar · ' + (BAR_LABELS[barKey] || barKey);
        popup.appendChild(title);

        // Description
        var desc = document.createElement('div');
        desc.className = 'formula-popup-desc';
        desc.textContent = 'Formula: (Gold Price × Multiplier) + Fee';
        popup.appendChild(desc);

        // Multiplier row
        var multRow = document.createElement('div');
        multRow.className = 'formula-popup-input-row';

        var multLabel = document.createElement('span');
        multLabel.className = 'formula-popup-prefix';
        multLabel.textContent = 'Gold Price  ×';
        multRow.appendChild(multLabel);

        var multInput = document.createElement('input');
        multInput.type = 'number';
        multInput.className = 'formula-popup-input';
        multInput.value = currentMult;
        multInput.step = '0.1';
        multRow.appendChild(multInput);

        popup.appendChild(multRow);

        // Markup row
        var markupRow = document.createElement('div');
        markupRow.className = 'formula-popup-input-row';

        var markupSign = document.createElement('span');
        markupSign.className = 'formula-popup-sign';
        markupSign.textContent = currentMarkup >= 0 ? '+' : '−';
        markupRow.appendChild(markupSign);

        var markupLabel = document.createElement('span');
        markupLabel.className = 'formula-popup-prefix';
        markupLabel.textContent = 'Fee';
        markupRow.appendChild(markupLabel);

        var markupInput = document.createElement('input');
        markupInput.type = 'number';
        markupInput.className = 'formula-popup-input';
        markupInput.value = Math.abs(currentMarkup);
        markupInput.step = '1';
        markupRow.appendChild(markupInput);

        popup.appendChild(markupRow);

        // Toggle markup sign
        markupSign.addEventListener('click', function () {
            markupSign.textContent = markupSign.textContent === '+' ? '−' : '+';
            updateBarPreview();
        });

        // Preview
        var preview = document.createElement('div');
        preview.className = 'formula-popup-preview';
        function updateBarPreview() {
            if (isNaN(lastSellSpot)) { preview.textContent = ''; return; }
            var m = parseFloat(multInput.value) || 0;
            var mk = parseFloat(markupInput.value) || 0;
            if (markupSign.textContent === '−') mk = -mk;
            var result = (lastSellSpot * m) + mk;
            preview.textContent = 'Result: ' + formatBarPrice(result);
        }
        multInput.addEventListener('input', updateBarPreview);
        markupInput.addEventListener('input', updateBarPreview);
        updateBarPreview();
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
            var m = parseFloat(multInput.value) || 0;
            var mk = parseFloat(markupInput.value) || 0;
            if (markupSign.textContent === '−') mk = -mk;
            BAR_FORMULAS[barKey] = { mult: m, markup: mk };
            saveBarFormulas();
            applyBarCellPrice(cell, lastSellSpot);
            closePopup();
        });

        btnRow.appendChild(btnCancel);
        btnRow.appendChild(btnSave);
        popup.appendChild(btnRow);

        overlay.appendChild(popup);
        document.body.appendChild(overlay);

        multInput.focus();
        multInput.select();

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closePopup();
        });

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

    // --- Price cell click → formula editor (admin only) ---
    priceCells.forEach(function (cell) {
        cell.addEventListener('click', function () {
            if (currentRole === 'admin') openPopup(cell);
        });
    });

    // --- Bar cell click → bar formula editor (admin only) ---
    barCells.forEach(function (cell) {
        cell.addEventListener('click', function () {
            if (currentRole === 'admin') openBarPopup(cell);
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

    // =========================================
    //  LOGIN / SESSION
    // =========================================
    var loginScreen = document.getElementById('login-screen');
    var loginForm = document.getElementById('login-form');
    var loginError = document.getElementById('login-error');
    var loginUsername = document.getElementById('login-username');
    var loginPassword = document.getElementById('login-password');
    var mainHeader = document.getElementById('main-header');
    var mainContent = document.getElementById('main-content');
    var btnLogout = document.getElementById('btn-logout');

    function showDashboard() {
        loginScreen.classList.add('hidden');
        mainHeader.classList.remove('hidden');
        mainContent.classList.remove('hidden');
        document.body.classList.add('role-' + currentRole);
        loadMetalPrices();
        setInterval(maybeAutoRefreshMetalPrices, AUTO_REFRESH_MS);
    }

    function showLogin() {
        loginScreen.classList.remove('hidden');
        mainHeader.classList.add('hidden');
        mainContent.classList.add('hidden');
    }

    // Check session on load
    var savedRole = localStorage.getItem(ROLE_KEY);
    if (localStorage.getItem(SESSION_KEY) === 'true' && savedRole) {
        currentRole = savedRole;
        showDashboard();
    } else {
        showLogin();
    }

    loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var user = loginUsername.value.trim();
        var pass = loginPassword.value;

        var matched = null;
        for (var i = 0; i < USERS.length; i++) {
            if (USERS[i].user === user && USERS[i].pass === pass) {
                matched = USERS[i];
                break;
            }
        }

        if (matched) {
            loginError.textContent = '';
            currentRole = matched.role;
            localStorage.setItem(SESSION_KEY, 'true');
            localStorage.setItem(ROLE_KEY, matched.role);
            showDashboard();
        } else {
            loginError.textContent = 'Invalid username or password';
            loginPassword.value = '';
            loginPassword.focus();
        }
    });

    btnLogout.addEventListener('click', function () {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(ROLE_KEY);
        location.reload();
    });

})();
