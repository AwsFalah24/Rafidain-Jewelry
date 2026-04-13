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
    var USERS = [];

    // Sync users securely from Firebase
    db.ref('users').on('value', function (snapshot) {
        var data = snapshot.val();
        if (data && Array.isArray(data)) {
            USERS = data;
        }
    });
    var currentRole = '';
    var latestApiUpdateMs = 0;
    var isRefreshing = false;
    var lastManualRefreshAtMs = 0;
    var lastBidSpot = NaN;
    var lastAskSpot = NaN;

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
    var spotPureSellEl = document.getElementById('spot-pure-sell');
    var spotPureBuyEl = document.getElementById('spot-pure-buy');
    var spotPureTitleSellEl = document.getElementById('spot-pure-title-sell');
    var spotPureTitleBuyEl = document.getElementById('spot-pure-title-buy');
    var priceCells = document.querySelectorAll('.cell.price');

    function resetSpotPureCardTitles() {
        if (spotPureTitleSellEl) spotPureTitleSellEl.textContent = 'Sell';
        if (spotPureTitleBuyEl) spotPureTitleBuyEl.textContent = 'Buy';
    }

    var KG_TO_PER_GRAM = 1000;
    /** Chart + headline: show gold like equities apps (price per troy oz). Spot CAD/g × oz/g. */
    var GRAMS_PER_TROY_OZ = 31.1034768;

    /** API fields gold.*.kg are CAD per kg — divide for CAD per gram (grid + gold bars). */
    function apiKgToPerGram(kgStr) {
        var n = parseFloat(String(kgStr));
        if (isNaN(n)) return NaN;
        return n / KG_TO_PER_GRAM;
    }

    // --- Gold spot (CAD/g) from xau.ca — API kg ÷ 1000 for per-gram base ---
    function formatCadPerGram(spotStr) {
        var n = parseFloat(String(spotStr));
        if (isNaN(n)) return '';
        return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatCadPerOz(ozVal) {
        var n = parseFloat(String(ozVal));
        if (isNaN(n)) return '';
        return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function cadPerGramToOz(cadPerGram) {
        var g = parseFloat(String(cadPerGram));
        if (isNaN(g)) return NaN;
        return g * GRAMS_PER_TROY_OZ;
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
            // Recalculate all prices if we have spot prices
            if (!isNaN(lastAskSpot) && !isNaN(lastBidSpot)) {
                priceCells.forEach(function (cell) {
                    applyCellPrice(cell);
                });
            }
        } else {
            // Initialize missing node in Firebase
            db.ref('offsets').set(OFFSETS);
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
    function applyCellPrice(cell) {
        var row = cell.dataset.row;
        var col = cell.dataset.col;
        var band = cell.dataset.band || '';
        var offset = getOffset(row, col, band);

        // Use BID for 'buy' row, ASK for everything else
        var spot = (row === 'buy') ? lastBidSpot : lastAskSpot;

        if (offset !== undefined && !isNaN(spot)) {
            cell.textContent = formatCadPerGram(spot + offset);
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
        '2-5g': { mult: 2.5, markup: 70 },
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
            if (!isNaN(lastAskSpot)) {
                applyBarPrices(lastAskSpot);
            }
        } else {
            // Initialize missing node in Firebase
            db.ref('barFormulas').set(BAR_FORMULAS);
        }
    });

    var barCells = document.querySelectorAll('.bar-price');

    function formatBarPrice(val) {
        var n = parseFloat(String(val));
        if (isNaN(n)) return '';
        return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function applyBarCellPrice(cell, sellSpot) {
        var barKey = cell.dataset.bar;
        var formula = BAR_FORMULAS[barKey];
        // sellSpot = ask CAD/g (API gold.buy.kg ÷ KG_TO_PER_GRAM), same base as grid
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
        resetSpotPureCardTitles();
        var data = result && result.data;
        var source = result && result.source ? result.source : 'live';
        var gold = data && data.prices && data.prices.gold;
        if (!gold || !gold.sell || !gold.buy) {
            indicator.textContent = 'Gold prices unavailable';
            if (spotPureSellEl) spotPureSellEl.textContent = '—';
            if (spotPureBuyEl) spotPureBuyEl.textContent = '—';
            return;
        }

        // BID price is gold.sell.kg, ASK price is gold.buy.kg (CAD/kg → per gram for grid + bars)
        lastBidSpot = apiKgToPerGram(gold.sell.kg);
        lastAskSpot = apiKgToPerGram(gold.buy.kg);

        // Top banners: pure 24K spot only (no formula). Sell = API "you buy" (gold.sell.kg), Buy = API "you sell" (gold.buy.kg).
        if (spotPureSellEl) spotPureSellEl.textContent = formatCadPerGram(lastBidSpot);
        if (spotPureBuyEl) spotPureBuyEl.textContent = formatCadPerGram(lastAskSpot);

        priceCells.forEach(function (cell) {
            applyCellPrice(cell);
        });

        // Gold bars: same per-gram ask as grid (kg ÷ 1000)
        applyBarPrices(lastAskSpot);

        // Save price snapshot to Firebase for chart history
        var snapNow = Date.now();
        db.ref('priceHistory').push({ t: snapNow, bid: lastBidSpot, ask: lastAskSpot });
        // Trim entries older than 30 days
        var cutoff30d = snapNow - (30 * 24 * 60 * 60 * 1000);
        db.ref('priceHistory').orderByChild('t').endAt(cutoff30d).once('value', function (snap) {
            var updates = {};
            snap.forEach(function (child) { updates[child.key] = null; });
            if (Object.keys(updates).length) db.ref('priceHistory').update(updates);
        });

        // Chart headline: CAD per troy oz (same order of magnitude as major gold tickers)
        if (chartPriceEl) {
            var oz = cadPerGramToOz(lastBidSpot);
            chartPriceEl.textContent = isNaN(oz) ? '—' : formatCadPerOz(oz);
        }

        // Re-convert Twelve Data closes with updated spot anchor (no re-fetch needed)
        updateTwelveLineDataIfPossible();

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
                if (spotPureSellEl) spotPureSellEl.textContent = '—';
                if (spotPureBuyEl) spotPureBuyEl.textContent = '—';
                isRefreshing = false;
            });
    }

    function maybeAutoRefreshMetalPrices() {
        if (!isBusinessHoursActive()) return;
        loadMetalPrices();
    }

    // =========================================
    //  GOLD PRICE CHART (TradingView Lightweight Charts — time scale + line)
    // =========================================
    var lwChart = null;
    var lwSeries = null;
    var lwSeriesKind = ''; // 'line' when a series is active
    var lwResizeObserver = null;
    var lwChartWrap = null;
    var chartTimeframe = '1D';
    var CHART_HISTORY_PATH = 'priceHistory';
    var chartPriceEl = document.getElementById('chart-current-price');
    /** OHLC from Twelve Data (USD/oz); line uses close only, re-anchored to live CAD/g spot. */
    var lastTwelveBarsUSD = null;
    var chartFetchSeq = 0;
    /** When Twelve Data succeeds for this fetch id, skip Firebase line (avoids stale overwrite). */
    var chartFirebaseSuppressFetchId = -1;

    /** Rejects after ms milliseconds */
    function withTimeout(promise, ms) {
        var timeout = new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('timeout')); }, ms);
        });
        return Promise.race([promise, timeout]);
    }

    function getChartCutoffMs(tf) {
        var now = Date.now();
        var day = 24 * 60 * 60 * 1000;
        if (tf === '1D') return now - day;
        if (tf === '1W') return now - 7 * day;
        if (tf === '1M') return now - 30 * day;
        if (tf === '3M') return now - 90 * day;
        if (tf === '6M') return now - 183 * day;
        if (tf === '1Y') return now - 365 * day;
        if (tf === '5Y') return now - 5 * 365 * day;
        if (tf === 'ALL') return now - 20 * 365 * day;
        return now - 30 * day;
    }

    function getLw() {
        return typeof LightweightCharts !== 'undefined' ? LightweightCharts : null;
    }

    function destroyLwChart() {
        if (lwResizeObserver && lwChartWrap) {
            try { lwResizeObserver.unobserve(lwChartWrap); } catch (e1) { /* ignore */ }
            try { lwResizeObserver.disconnect(); } catch (e2) { /* ignore */ }
        }
        lwResizeObserver = null;
        lwChartWrap = null;
        lwSeries = null;
        lwSeriesKind = '';
        if (lwChart) {
            try { lwChart.remove(); } catch (e) { /* ignore */ }
            lwChart = null;
        }
    }

    function mergeLineByTime(rows) {
        rows.sort(function (a, b) { return a.time - b.time; });
        var out = [];
        rows.forEach(function (r) {
            var prev = out[out.length - 1];
            if (prev && prev.time === r.time) {
                prev.value = r.value;
            } else {
                out.push({ time: r.time, value: r.value });
            }
        });
        return out;
    }

    function updateChangeBadgeFromSeries(firstVal, lastVal) {
        var changeEl = document.getElementById('chart-change');
        if (!changeEl) return;
        if (firstVal == null || lastVal == null || isNaN(firstVal) || isNaN(lastVal)) {
            changeEl.textContent = '';
            changeEl.className = 'chart-change';
            return;
        }
        var diff = lastVal - firstVal;
        var pct = firstVal !== 0 ? (diff / firstVal) * 100 : 0;
        var sign = diff >= 0 ? '+' : '';
        changeEl.textContent = sign + diff.toLocaleString('en-CA', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
            + ' (' + sign + pct.toFixed(2) + '%)';
        changeEl.className = 'chart-change ' + (diff >= 0 ? 'up' : 'down');
    }

    function attachLwResize(container) {
        lwChartWrap = container.parentElement;
        if (!lwChartWrap || typeof ResizeObserver === 'undefined') return;
        lwResizeObserver = new ResizeObserver(function (entries) {
            if (!lwChart || !entries.length) return;
            var cr = entries[0].contentRect;
            var w = Math.max(0, Math.floor(cr.width));
            var h = Math.max(0, Math.floor(cr.height));
            lwChart.applyOptions({ width: w, height: h });
        });
        lwResizeObserver.observe(lwChartWrap);
    }

    /** Lightweight Charts `Time` → `Date` (UTC for business-day objects). */
    function lwTimeToDate(time) {
        if (time == null) return null;
        if (typeof time === 'object' && typeof time.year === 'number') {
            var h = typeof time.hours === 'number' ? time.hours : 0;
            var m = typeof time.minutes === 'number' ? time.minutes : 0;
            var s = typeof time.seconds === 'number' ? time.seconds : 0;
            return new Date(Date.UTC(time.year, time.month - 1, time.day, h, m, s));
        }
        if (typeof time === 'number') {
            return new Date(time * 1000);
        }
        return null;
    }

    /** Shorter $ labels so the right scale does not clip (axis + crosshair). */
    function lwPriceFormatter(price) {
        var n = Number(price);
        if (isNaN(n)) return '';
        var rounded = Math.round(n);
        if (Math.abs(n - rounded) < 0.005 || Math.abs(n) >= 500) {
            return '$' + rounded.toLocaleString('en-CA');
        }
        return '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    /** Crosshair / tooltip time line */
    function lwTimeFormatter(time) {
        var d = lwTimeToDate(time);
        if (!d || isNaN(d.getTime())) return '';
        if (chartTimeframe === '1D') {
            return d.toLocaleString('en-CA', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        }
        if (chartTimeframe === '1W') {
            return d.toLocaleString('en-CA', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        }
        return d.toLocaleDateString('en-CA', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
    }

    /** X-axis tick labels by range */
    function lwTickMarkFormatter(time, tickMarkType) {
        try {
            var d = lwTimeToDate(time);
            if (!d || isNaN(d.getTime())) return null;
            var LW = getLw();
            var TM = LW && LW.TickMarkType;
            var tf = chartTimeframe;

            if (tf === '1D') {
                return d.toLocaleString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true });
            }
            if (tf === '1W') {
                return d.toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
            }
            if (tf === '1M' || tf === '3M' || tf === '6M') {
                if (TM != null && tickMarkType === TM.Year) {
                    return d.toLocaleDateString('en-CA', { year: 'numeric' });
                }
                return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
            }
            if (tf === '1Y' || tf === '5Y' || tf === 'ALL') {
                return d.toLocaleDateString('en-CA', { month: 'short', year: 'numeric' });
            }
            return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
        } catch (err) {
            return null;
        }
    }

    function createLwBaseChart(container) {
        var LW = getLw();
        if (!LW) return null;
        var timeVisible = chartTimeframe === '1D' || chartTimeframe === '1W';
        try {
            return LW.createChart(container, {
            width: Math.max(1, container.clientWidth),
            height: Math.max(1, container.clientHeight),
            layout: {
                background: {
                    type: LW.ColorType != null ? LW.ColorType.Solid : 'solid',
                    color: '#FFFFFF'
                },
                textColor: '#5C534E',
                fontSize: 11
            },
            grid: {
                vertLines: { color: 'rgba(0,0,0,0.06)' },
                horzLines: { color: 'rgba(0,0,0,0.06)' }
            },
            rightPriceScale: {
                borderVisible: false,
                scaleMargins: { top: 0.16, bottom: 0.16 },
                entireTextOnly: true,
                alignLabels: true,
                minimumWidth: 76
            },
            timeScale: {
                borderVisible: false,
                timeVisible: timeVisible,
                secondsVisible: false,
                rightOffset: 12,
                tickMarkFormatter: lwTickMarkFormatter
            },
            crosshair: { mode: LW.CrosshairMode != null ? LW.CrosshairMode.Normal : 0 },
            localization: {
                locale: 'en-CA',
                priceFormatter: lwPriceFormatter,
                timeFormatter: lwTimeFormatter
            }
            });
        } catch (e) {
            return null;
        }
    }

    /** Fallback: Firebase snapshots (CAD/g) as a line when Twelve Data is unavailable */
    function loadChartFromFirebase(fetchId) {
        var cutoff = getChartCutoffMs(chartTimeframe);
        db.ref(CHART_HISTORY_PATH).orderByChild('t').startAt(cutoff).once('value', function (snapshot) {
            if (fetchId !== chartFetchSeq) return;
            if (fetchId === chartFirebaseSuppressFetchId) return;

            var points = [];
            snapshot.forEach(function (child) {
                var v = child.val();
                if (v && typeof v.t === 'number' && typeof v.bid === 'number') points.push(v);
            });
            points.sort(function (a, b) { return a.t - b.t; });
            renderFirebaseLineChart(points, fetchId);
        });
    }

    /** Draw / rebuild a gold line from `{ time: unixSec, value: CAD/oz }[]` (Firebase or Twelve close). */
    function renderLwLineFromPoints(lineData) {
        var root = document.getElementById('gold-chart-root');
        var noData = document.getElementById('chart-no-data');
        if (!root) return;

        if (lineData.length === 0) {
            if (noData) noData.style.display = 'flex';
            root.style.display = 'none';
            return;
        }
        if (noData) noData.style.display = 'none';
        root.style.display = 'block';

        var firstV = lineData[0].value;
        var lastV = lineData[lineData.length - 1].value;
        updateChangeBadgeFromSeries(firstV, lastV);

        if (chartPriceEl) {
            var ozLive = cadPerGramToOz(lastBidSpot);
            chartPriceEl.textContent = !isNaN(ozLive) && ozLive > 0 ? formatCadPerOz(ozLive) : formatCadPerOz(lastV);
        }

        var LW = getLw();
        if (!LW) {
            if (noData) {
                noData.style.display = 'flex';
                var sp = noData.querySelector('span');
                if (sp) sp.textContent = 'Chart library failed to load. Check your network.';
            }
            root.style.display = 'none';
            return;
        }

        destroyLwChart();
        lwChart = createLwBaseChart(root);
        if (!lwChart) return;
        lwSeries = lwChart.addLineSeries({
            color: '#DAA520',
            lineWidth: 2,
            priceLineVisible: true,
            lastValueVisible: true
        });
        lwSeriesKind = 'line';
        lwSeries.setData(lineData);
        lwChart.timeScale().fitContent();
        attachLwResize(root);
    }

    function renderFirebaseLineChart(points, fetchId) {
        if (fetchId !== chartFetchSeq) return;
        var lineData = mergeLineByTime(points.map(function (p) {
            return {
                time: Math.floor(p.t / 1000),
                value: cadPerGramToOz(p.bid)
            };
        }).filter(function (r) { return !isNaN(r.value) && !isNaN(r.time); }));
        renderLwLineFromPoints(lineData);
    }

    var TWELVE_DATA_KEY = '3d0670e65f4b4e4891276c92fc6bb783';

    function loadAndRenderChart() {
        var fetchId = ++chartFetchSeq;
        chartFirebaseSuppressFetchId = -1;
        lastTwelveBarsUSD = null;

        var tfMap = {
            '1D':  { interval: '5min',  outputsize: 288 },
            '1W':  { interval: '1h',    outputsize: 168 },
            '1M':  { interval: '1day',  outputsize: 32 },
            '3M':  { interval: '1day',  outputsize: 94 },
            '6M':  { interval: '1day',  outputsize: 186 },
            '1Y':  { interval: '1day',  outputsize: 366 },
            '5Y':  { interval: '1week', outputsize: 270 },
            'ALL': { interval: '1month', outputsize: 120 }
        };
        var params = tfMap[chartTimeframe] || tfMap['1D'];
        var twelveUrl = 'https://api.twelvedata.com/time_series' +
            '?symbol=XAU/USD' +
            '&interval=' + params.interval +
            '&outputsize=' + params.outputsize +
            '&apikey=' + TWELVE_DATA_KEY;

        var noData = document.getElementById('chart-no-data');
        var root = document.getElementById('gold-chart-root');
        var noDataSpan = noData && noData.querySelector('span');
        if (noDataSpan) noDataSpan.textContent = 'Loading chart data\u2026';
        if (noData) noData.style.display = 'flex';
        if (root) root.style.display = 'none';
        destroyLwChart();

        loadChartFromFirebase(fetchId);

        withTimeout(fetchJson(twelveUrl), 12000)
            .then(function (data) {
                if (fetchId !== chartFetchSeq) return;
                if (!data || data.status === 'error' || !Array.isArray(data.values) || data.values.length === 0) return;

                var values = data.values.slice().reverse();
                lastTwelveBarsUSD = [];
                values.forEach(function (v) {
                    var t = new Date(v.datetime).getTime();
                    var o = parseFloat(v.open);
                    var h = parseFloat(v.high);
                    var l = parseFloat(v.low);
                    var c = parseFloat(v.close);
                    if (isNaN(t) || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) return;
                    lastTwelveBarsUSD.push({ t: t, o: o, h: h, l: l, c: c });
                });

                if (!lastTwelveBarsUSD.length) return;
                chartFirebaseSuppressFetchId = fetchId;
                renderTwelveData();
            })
            .catch(function () { /* keep Firebase line if present */ });
    }

    /** Twelve close (USD/oz) → CAD/oz line points using live bid anchor */
    function buildCadOzLinePointsFromLastTwelve() {
        if (!lastTwelveBarsUSD || lastTwelveBarsUSD.length === 0) return [];
        var latestUSD = lastTwelveBarsUSD[lastTwelveBarsUSD.length - 1].c;
        var convFactor;
        if (!isNaN(lastBidSpot) && lastBidSpot > 0 && latestUSD > 0) {
            convFactor = lastBidSpot / latestUSD;
        } else {
            convFactor = 1.38 / 31.1035;
        }
        return lastTwelveBarsUSD.map(function (b) {
            return {
                time: Math.floor(b.t / 1000),
                value: cadPerGramToOz(b.c * convFactor)
            };
        });
    }

    /** Live spot refresh: update Twelve line without tearing down the chart */
    function updateTwelveLineDataIfPossible() {
        if (!lwChart || !lwSeries || lwSeriesKind !== 'line' || !lastTwelveBarsUSD || !lastTwelveBarsUSD.length) {
            return false;
        }
        var lineData = mergeLineByTime(buildCadOzLinePointsFromLastTwelve());
        if (!lineData.length) return false;
        lwSeries.setData(lineData);
        updateChangeBadgeFromSeries(lineData[0].value, lineData[lineData.length - 1].value);
        if (chartPriceEl) {
            var ozLive = cadPerGramToOz(lastBidSpot);
            chartPriceEl.textContent = !isNaN(ozLive) && ozLive > 0
                ? formatCadPerOz(ozLive)
                : formatCadPerOz(lineData[lineData.length - 1].value);
        }
        return true;
    }

    function renderTwelveData() {
        var lineData = mergeLineByTime(buildCadOzLinePointsFromLastTwelve());
        renderLwLineFromPoints(lineData);
    }

    function initChart() {
        loadAndRenderChart();
        var tfBtns = document.querySelectorAll('.chart-tf');
        tfBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                chartTimeframe = btn.dataset.tf;
                tfBtns.forEach(function (b) {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                destroyLwChart();
                loadAndRenderChart();
            });
        });
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
            var spot = (row === 'buy') ? lastBidSpot : lastAskSpot;
            if (isNaN(spot)) { preview.textContent = ''; return; }
            var val = parseFloat(input.value) || 0;
            var off = sign.textContent === '+' ? val : -val;
            preview.textContent = 'Result: ' + formatCadPerGram(spot + off);
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
            applyCellPrice(cell);
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
        'half-oz': '1/2 oz', '10g': '10g', '5g': '5g', '2-5g': '2.5g', '1g': '1g'
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
        desc.textContent = 'Gold price is ask per gram (CAD/g), API kg ÷ 1000. Formula: (Gold Price × Multiplier) + Fee';
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
            if (isNaN(lastAskSpot)) { preview.textContent = ''; return; }
            var m = parseFloat(multInput.value) || 0;
            var mk = parseFloat(markupInput.value) || 0;
            if (markupSign.textContent === '−') mk = -mk;
            var result = (lastAskSpot * m) + mk;
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
            applyBarCellPrice(cell, lastAskSpot);
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

    resetSpotPureCardTitles();

    function showDashboard() {
        loginScreen.classList.add('hidden');
        mainHeader.classList.remove('hidden');
        mainContent.classList.remove('hidden');
        document.body.classList.add('role-' + currentRole);
        loadMetalPrices();
        setInterval(maybeAutoRefreshMetalPrices, AUTO_REFRESH_MS);
        initChart();
        resetSpotPureCardTitles();
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
