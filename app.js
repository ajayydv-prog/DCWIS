// ═══════════════════════════════════════════════════════════════
    //  CONFIGURATION
    // ═══════════════════════════════════════════════════════════════
    const API_BASE = 'https://www.ajayydv.shop';
    const DATA_ENDPOINT = '/data';
    const CLOUD_ENDPOINT = '/cloud';
    const POLL_INTERVAL_MS = 1000;

    // ── Live METAR/SPECI source via backend proxy ──
    const REGISTER_BASE = 'https://dcwis-register-proxy.ajaypahe01.workers.dev/register';
    const REGISTER_MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const REGISTER_CACHE_MS = 60000;
    const registerCache = {};

    // ── state ──
    const latestData = { '28': null, '10': null };
    const modes = { '28': 'instant', '10': 'instant' };
    const wsExtremeModes = { '28': '1min', '10': '1min' };
    const compassDirs = { '28': null, '10': null };
    const windSpeedCurrent = { '28': 0, '10': 0 }; // latest numeric wind speed (kt), feeds particle animation
    const RUNWAY_HEADING = { '28': 280, '10': 100 };
    let isDark = true;

    // ═══════════════════════════════════════════════════════════════
    //  SETTINGS — state + persistence (localStorage, per device)
    // ═══════════════════════════════════════════════════════════════
    const SETTINGS_KEY = 'dcwis_settings_v1';
    const DEFAULT_SETTINGS = { theme:'dark', wxAnim:false, windParticles:true, notif:true, sound:true, cw:15, rvr:550, ws:25 };
    const SET_LIMITS = { cw:{min:5,max:40,unit:'kt'}, rvr:{min:50,max:2000,unit:'m'}, ws:{min:10,max:60,unit:'kt'} };
    const S = Object.assign({}, DEFAULT_SETTINGS, (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch(e) { return {}; } })());
    Object.keys(SET_LIMITS).forEach(k => {
      let v = parseInt(S[k], 10); if (isNaN(v)) v = DEFAULT_SETTINGS[k];
      S[k] = Math.min(SET_LIMITS[k].max, Math.max(SET_LIMITS[k].min, v));
    });
    ['wxAnim','windParticles','notif','sound'].forEach(k => S[k] = !!S[k]);
    if (S.theme !== 'light') S.theme = 'dark';
    function saveSettings(){ try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch(e) {} }
    let autoRefreshInterval = null;
    let metarInterval = null;
    let chartInstance = null;
    let modalParam = null;

    // ═══════════════════════════════════════════════════════════════
    //  (IndexedDB local backup feature removed — backend history is
    //  the sole source of truth for charts; mixing raw instant readings
    //  with backend-averaged bins produced misleading/jagged data.)
    // ═══════════════════════════════════════════════════════════════

    let modalRwy = null;
    let gustViewActive = false;
    let isHistoryLoading = false;
    let currentHours = 6;
    let currentBin = 120;
    // The history modal chart's LINE is always built from 1-min (60s) data
    // from the backend, no matter which range/bin preset button (2m/30m/1H)
    // is selected. currentBin still drives the axis label text, stale-data
    // gap threshold, and the CSV/export meta — only the plotted resolution
    // changes, so the x-axis time range and displayed "bin" label stay same.
    const CHART_LINE_BIN = 60;
    let liveMode = true;
    let modalRefreshInterval = null;
    let lastBins = [];
    let lastChartMeta = null;
    let userHasZoomed = false;
    let qnhTrendBuffer = {};
    let metarHistoryHours = 6;

    const THRESHOLDS = {
      crosswind: { limit: 15, direction: 'above', useAbs: true, label: '15kt crosswind limit' },
      rvr:       { limit: 550, direction: 'below', useAbs: false, label: 'CAT I RVR min (550m)' }
    };

    const Y_AXIS_LIMITS = {
      rvr: { min: 0, max: 2000 },
      mor: { min: 0, max: 5320 },
      windDirection: { min: 0, max: 360 }
    };

    const TZ_OFFSET_MS = new Date().getTimezoneOffset() * 60000;
    function toUtcDisplayMs(utcSeconds) {
      return utcSeconds * 1000 + TZ_OFFSET_MS;
    }

    // ── DOM refs ──
    const modal = document.getElementById('historyModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalCanvas = document.getElementById('historyChart');
    const chartContainer = document.getElementById('chartContainer');
    const metaCurrent = document.getElementById('metaCurrent');
    const metaMin = document.getElementById('metaMin');
    const metaMax = document.getElementById('metaMax');
    const metaAvg = document.getElementById('metaAvg');
    const metarDisplay = document.getElementById('metar-display');
    const metarPopup = document.getElementById('metarPopup');
    const metarPopupBody = document.getElementById('metarPopupBody');
    const metarPopupTitle = document.getElementById('metarPopupTitle');

    // ═══════════════════════════════════════════════════════════════
    //  TIME RANGE CHANGE
    // ═══════════════════════════════════════════════════════════════
    window.changeTimeRange = function(hours, bin, btn) {
      currentHours = hours;
      currentBin = bin;
      
      document.querySelectorAll('#rangeButtons .range-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      
      if (modalParam && modalRwy) {
        liveMode = true;
        setLiveButtonUI();
        renderHistoryChart(displayParam(), modalRwy).then(startModalAutoRefresh);
      }
    };

    // ═══════════════════════════════════════════════════════════════
    //  CLOCK
    // ═══════════════════════════════════════════════════════════════
    (function(){
      const D=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      function tick(){
        const n=new Date();
        document.getElementById('clock').textContent=
          `${D[n.getUTCDay()]}, ${String(n.getUTCDate()).padStart(2,'0')} ${M[n.getUTCMonth()]} ${n.getUTCFullYear()} `+
          `${String(n.getUTCHours()).padStart(2,'0')}:${String(n.getUTCMinutes()).padStart(2,'0')}:${String(n.getUTCSeconds()).padStart(2,'0')} GMT`;
      }
      tick(); setInterval(tick,1000);
    })();

    // ═══════════════════════════════════════════════════════════════
    //  THEME
    // ═══════════════════════════════════════════════════════════════
    window.toggleTheme = function(){
      isDark = !isDark;
      document.body.classList.toggle('dark', isDark);
      S.theme = isDark ? 'dark' : 'light'; saveSettings();
      try { syncSettingsUI(); } catch(e) {}
      ['28','10'].forEach(r => {
        drawCompass(r, compassCurrentAngle[r] ?? compassDirs[r]);
        drawQnhSparkline(r);
      });
      if(modal.classList.contains('active') && modalParam){
        renderHistoryChart(modalParam, modalRwy);
      }
      if (trendViewActive) {
        destroyAllTrendCharts();
        renderAllTrendCharts();
      }
    };

    window.toggleFullscreen = function(){
      if(!document.fullscreenElement){
        document.documentElement.requestFullscreen?.();
        document.getElementById('fullscreen-btn').textContent = '⊡';
      } else {
        document.exitFullscreen?.();
        document.getElementById('fullscreen-btn').textContent = '⛶';
      }
      setTimeout(resizeLayout, 100);
    };
    document.addEventListener('fullscreenchange', () => {
      if(!document.fullscreenElement) document.getElementById('fullscreen-btn').textContent='⛶';
    });

    // ═══════════════════════════════════════════════════════════════
    //  WEATHER REGISTER — fetch + cache one calendar month's JSON
    // ═══════════════════════════════════════════════════════════════
    function registerUrlFor(year, monthIndex0){
      return `${REGISTER_BASE}/${year}/current_weather_${year}_${REGISTER_MONTH_NAMES[monthIndex0]}.json`;
    }

    async function fetchRegisterMonth(year, monthIndex0){
      const key = `${year}-${monthIndex0}`;
      const cached = registerCache[key];
      if(cached && (Date.now() - cached.time) < REGISTER_CACHE_MS){
        return cached.data;
      }
      const url = registerUrlFor(year, monthIndex0);
      try {
        const res = await fetch(url);
        if(!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const entries = Array.isArray(data) ? data : [];
        registerCache[key] = { data: entries, time: Date.now() };
        return entries;
      } catch (err) {
        console.error('Failed to fetch register:', err);
        throw err;
      }
    }

    function registerEntryEpochMs(e){
      const parts = String(e.date || '').split('/');
      if(parts.length !== 3) return null;
      const day = parseInt(parts[0], 10), month = parseInt(parts[1], 10), year = parseInt(parts[2], 10);
      const t = String(e.time || '');
      if(t.length < 3) return null;
      const hh = parseInt(t.slice(0, 2), 10), mm = parseInt(t.slice(2, 4), 10);
      if([day, month, year, hh, mm].some(isNaN)) return null;
      return Date.UTC(year, month - 1, day, hh, mm, 0);
    }

    // ─── METAR HISTORY: fetch from register for a given time window ───
    async function fetchMetarHistoryFromRegister(hoursBack) {
      const now = new Date();
      const nowMs = now.getTime();
      const cutoffMs = nowMs - hoursBack * 3600000;

      let entries = [];

      try {
        const currentMonthData = await fetchRegisterMonth(now.getUTCFullYear(), now.getUTCMonth());
        entries = entries.concat(currentMonthData);
      } catch (err) {
        console.error('Current month fetch failed:', err);
      }

      const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0);
      if (cutoffMs < monthStartMs) {
        let pY = now.getUTCFullYear(), pM = now.getUTCMonth() - 1;
        if (pM < 0) { pM = 11; pY -= 1; }
        try {
          const prevMonthData = await fetchRegisterMonth(pY, pM);
          entries = prevMonthData.concat(entries);
        } catch (err) {
          console.error('Previous month fetch failed:', err);
        }
      }

      const filtered = entries
        .map(e => {
          const ts = registerEntryEpochMs(e);
          return { entry: e, ts: ts };
        })
        .filter(x => x.ts !== null && x.ts >= cutoffMs && x.ts <= nowMs)
        .sort((a, b) => b.ts - a.ts)
        .map(x => x.entry);

      return filtered;
    }

    // ═══════════════════════════════════════════════════════════════
    //  build METAR text — two variants for different JSON formats
    // ═══════════════════════════════════════════════════════════════

    // Shared helpers
    function _metarWindCloud(e, parts) {
      if (e.windspeed) {
        let w = e.windspeed;
        if (e.maxwind) w += 'G' + e.maxwind;
        parts.push(w + 'KT');
      }
      if (e.visibility) parts.push(e.visibility);
    }
    function _metarWeatherCloudsTemp(e, parts, decimalQnh) {
      if (e.weather) parts.push(e.weather);
      let anyCloud = false;
      ['cloud1', 'cloud2', 'cloud3', 'cloud4'].forEach(c => {
        if (e[c]) { parts.push(e[c]); anyCloud = true; }
      });
      if (!anyCloud) parts.push('NSC');
      const fmtTemp = (v) => {
        if (v === undefined || v === null || v === '') return null;
        const n = parseFloat(v);
        if (isNaN(n)) return null;
        const r = Math.round(n);
        return r < 0 ? ('M' + Math.abs(r)) : String(r);
      };
      const tt = fmtTemp(e.temperature), td = fmtTemp(e.dewpoint);
      if (tt !== null && td !== null) parts.push(tt + '/' + td);
      if (e.qnh !== undefined && e.qnh !== '') {
        const qRaw = parseFloat(e.qnh);
        if (!isNaN(qRaw)) {
          const q = decimalQnh ? qRaw.toFixed(1) : Math.floor(qRaw);
          parts.push('Q' + q);
        }
      }
      if (e.trend) parts.push(e.trend);
    }

    // Register/live format: activervr1/2 = runway number ("28","10") when active, empty when not
    // decimalQnh: when true, keep QNH decimal (used for METAR HISTORY 6/12/24H popup)
    function buildMetarText(e, decimalQnh) {
      const parts = [(e.selectedOption || 'METAR'), 'VOGA', (e.time || '----') + 'Z'];
      _metarWindCloud(e, parts);
      if (e.activervr1 && e.rvr1) {
        parts.push('R' + String(e.activervr1).padStart(2, '0') + '/' + e.rvr1);
      }
      if (e.activervr2 && e.rvr2) {
        parts.push('R' + String(e.activervr2).padStart(2, '0') + '/' + e.rvr2);
      }
      _metarWeatherCloudsTemp(e, parts, decimalQnh);
      return parts.join(' ');
    }

    // Archive format: activervr1/2 = "1" means active (boolean-style), runway fixed as 28/10
    function buildArchiveMetarText(e) {
      const parts = [(e.selectedOption || 'METAR'), 'VOGA', (e.time || '----') + 'Z'];
      _metarWindCloud(e, parts);
      if (e.activervr1 === '1' && e.rvr1) {
        parts.push('R28/' + e.rvr1);
      }
      if (e.activervr2 === '1' && e.rvr2) {
        parts.push('R10/' + e.rvr2);
      }
      _metarWeatherCloudsTemp(e, parts);
      return parts.join(' ');
    }

    function escapeHtml(s){
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // ═══════════════════════════════════════════════════════════════
    //  METAR (live, current report — register-based)
    // ═══════════════════════════════════════════════════════════════
    function fetchMETAR(){
      const now = new Date();
      fetchRegisterMonth(now.getUTCFullYear(), now.getUTCMonth())
        .then(monthData => {
          if(!monthData.length) {
            throw new Error('empty register for current month');
          }
          const latest = monthData[monthData.length - 1];
          metarDisplay.textContent = buildMetarText(latest);
          metarDisplay.style.color = '';
          metarDisplay.style.opacity = '1';
          metarDisplay.classList.remove('fade');
          applyWeatherEffect(latest.weather);
        })
        .catch(err => {
          console.error('METAR fetch error:', err);
          metarDisplay.textContent = '⚠ METAR unavailable';
          metarDisplay.style.color = '#ff4444';
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  AMBIENT WEATHER EFFECT — derived from the live METAR/SPECI
    //  "weather" group (e.g. RA, +RA, TSRA, FG, BR, HZ). Purely a subtle
    //  full-screen atmosphere layer — canvas is pointer-events:none and
    //  every effect is drawn at low alpha so the actual data (RVR, MOR,
    //  cloud base, etc.) stays fully legible underneath at all times.
    //  This NEVER substitutes for or alters the real numeric readouts.
    // ═══════════════════════════════════════════════════════════════
    function classifyWeatherEffect(code){
      if(!code || typeof code !== 'string') return { type:'none' };
      const c = code.toUpperCase();
      const strength = c.includes('+') ? 'heavy' : (c.includes('-') ? 'light' : 'moderate');

      if(c.includes('TS')){
        return { type:'storm', density:150, speed:1.35, opacity:0.42, streakLen:1.35, gust:0.28 };
      }
      if(c.includes('SH') && c.includes('RA')){
        // Rain showers — bursty/gusty character (intensity waxes and wanes)
        const presets = {
          light:    { density:55,  speed:0.85, opacity:0.22, streakLen:0.90, gust:0.24 },
          moderate: { density:100, speed:1.05, opacity:0.32, streakLen:1.10, gust:0.28 },
          heavy:    { density:165, speed:1.30, opacity:0.44, streakLen:1.40, gust:0.34 }
        };
        return Object.assign({ type:'rain' }, presets[strength]);
      }
      if(c.includes('RA')){
        // Steady rain — no gustiness, constant character
        const presets = {
          light:    { density:42,  speed:0.72, opacity:0.18, streakLen:0.80, gust:0 },
          moderate: { density:80,  speed:0.95, opacity:0.26, streakLen:1.00, gust:0 },
          heavy:    { density:140, speed:1.25, opacity:0.38, streakLen:1.30, gust:0.05 }
        };
        return Object.assign({ type:'rain' }, presets[strength]);
      }
      if(c.includes('DZ')){
        // Drizzle — fine, slow, short, faint — never long streaks
        const presets = {
          light:    { density:16, speed:0.32, opacity:0.09, streakLen:0.30, gust:0 },
          moderate: { density:26, speed:0.40, opacity:0.13, streakLen:0.36, gust:0 },
          heavy:    { density:40, speed:0.48, opacity:0.18, streakLen:0.42, gust:0 }
        };
        return Object.assign({ type:'rain' }, presets[strength]);
      }
      if(c.includes('FG')) return { type:'fog', intensity:1 };
      if(c.includes('BR') || c.includes('HZ')) return { type:'fog', intensity:0.6 };
      if(c.includes('DU') || c.includes('SA') || c.includes('SS') || c.includes('DS')) return { type:'dust', intensity:0.8 };
      return { type:'none' };
    }

    let currentWeatherFx = { type:'none' };
    let rainDrops = [];
    let rainDropsDensity = 0;
    let stormFlashAlpha = 0;
    let fogPulsePhase = 0;
    let fogOffset = 0;
    let gustPhase = 0;

    function makeRainDrop(w,h){
      return {
        x: Math.random()*w,
        y: Math.random()*h,
        lenJitter: 0.75 + Math.random()*0.5,
        speedJitter: 0.80 + Math.random()*0.4
      };
    }
    function ensureRainDrops(w, density){
      if(rainDrops.length !== density){
        rainDrops = [];
        for(let i=0;i<density;i++) rainDrops.push(makeRainDrop(w, window.innerHeight));
        rainDropsDensity = density;
      }
    }

    function drawWeatherFx(){
      const canvas = document.getElementById('weatherFxCanvas');
      if(!S.wxAnim){
        if(canvas){ canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height); canvas.classList.remove('wfx-active'); }
        weatherFxLoopStarted = false;
        return;
      }
      if(canvas){
        const w = window.innerWidth, h = window.innerHeight;
        if(canvas.width !== w) canvas.width = w;
        if(canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,w,h);

        const fx = currentWeatherFx;
        const isDark = document.body.classList.contains('dark');

        if(fx.type === 'rain' || fx.type === 'storm'){
          ensureRainDrops(w, fx.density);

          // Gustiness — showers/storms visibly wax and wane; steady rain
          // (gust=0) stays flat and constant, which is itself a visual cue.
          gustPhase += 0.012;
          const gustMul = fx.gust > 0 ? (1 + fx.gust * Math.sin(gustPhase)) : 1;

          const col = isDark ? '190,210,230' : '90,120,150';
          const baseAlpha = fx.opacity * gustMul;
          const baseLen = Math.max(2.5, 14 * fx.streakLen);
          const baseSpeed = 3.2 * fx.speed * gustMul;

          rainDrops.forEach(d => {
            d.y += baseSpeed * d.speedJitter;
            d.x += 0.55 * fx.speed;
            if(d.y > h){ d.y = -20; d.x = Math.random()*w; }
            const len = baseLen * d.lenJitter;
            ctx.strokeStyle = `rgba(${col},${Math.max(0.04, baseAlpha).toFixed(3)})`;
            ctx.lineWidth = fx.type === 'storm' ? 1.3 : (fx.streakLen < 0.5 ? 0.9 : 1.1);
            ctx.beginPath();
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x - len*0.15, d.y - len);
            ctx.stroke();
          });
          if(fx.type === 'storm'){
            if(Math.random() < 0.006) stormFlashAlpha = 0.5;
            if(stormFlashAlpha > 0.01){
              ctx.fillStyle = `rgba(255,255,255,${stormFlashAlpha})`;
              ctx.fillRect(0,0,w,h);
              stormFlashAlpha *= 0.82;
            } else {
              stormFlashAlpha = 0;
            }
          }
        } else if(fx.type === 'fog' || fx.type === 'dust'){
          const base = fx.type === 'dust'
            ? (isDark ? '150,120,80' : '170,140,100')
            : (isDark ? '200,210,220' : '210,220,230');
          fogPulsePhase += 0.006;
          const pulse = 0.88 + 0.14 * Math.sin(fogPulsePhase);
          fogOffset += w * 0.0018 * fx.intensity;
          const baseAlpha = Math.min(0.22, 0.11 * fx.intensity + 0.07) * pulse;

          // Three soft mist layers drifting at different speeds/depths —
          // this is what reads as "flowing" rather than a static dim.
          const layers = [
            { yFrac:0.28, speedMul:1.00, sizeMul:0.60, alphaMul:1.00 },
            { yFrac:0.55, speedMul:0.65, sizeMul:0.78, alphaMul:0.70 },
            { yFrac:0.80, speedMul:1.35, sizeMul:0.55, alphaMul:0.85 }
          ];
          layers.forEach((L, idx) => {
            const blobW = w * L.sizeMul;
            const wrapW = w + blobW;
            const localOffset = (fogOffset * L.speedMul + idx*wrapW/3) % wrapW;
            const x = localOffset - blobW/2;
            const y = h * L.yFrac;
            const rad = blobW * 0.6;
            [x, x - wrapW].forEach(px => {
              if(px + rad < 0 || px - rad > w) return;
              const grad = ctx.createRadialGradient(px, y, 0, px, y, rad);
              grad.addColorStop(0, `rgba(${base},${(baseAlpha*L.alphaMul).toFixed(3)})`);
              grad.addColorStop(1, `rgba(${base},0)`);
              ctx.fillStyle = grad;
              ctx.fillRect(0,0,w,h);
            });
          });
        }
      }
      requestAnimationFrame(drawWeatherFx);
    }

    let weatherFxLoopStarted = false;
    function startWeatherFxLoop(){
      if(weatherFxLoopStarted) return;
      weatherFxLoopStarted = true;
      drawWeatherFx();
    }

    function applyWeatherEffect(code){
      currentWeatherFx = classifyWeatherEffect(code);
      const canvas = document.getElementById('weatherFxCanvas');
      if(canvas) canvas.classList.toggle('wfx-active', S.wxAnim && currentWeatherFx.type !== 'none');
    }

    // ═══════════════════════════════════════════════════════════════
    //  METAR/SPECI HISTORY POPUP — register-based, 6H / 12H / 24H
    // ═══════════════════════════════════════════════════════════════
    window.openMetarPopup = async function(hours, btn) {
      if (hours) metarHistoryHours = hours;

      document.querySelectorAll('.metar-range-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.hours, 10) === metarHistoryHours);
      });

      metarPopupTitle.textContent = `📜 METAR/SPECI History (Last ${metarHistoryHours} Hours)`;
      metarPopup.classList.add('active');
      metarPopupBody.innerHTML = `<div class="loading-msg"><span class="spinner"></span> Loading METAR/SPECI history...</div>`;

      try {
        const entries = await fetchMetarHistoryFromRegister(metarHistoryHours);
        if (entries.length === 0) {
          metarPopupBody.innerHTML = `<div class="no-data">No METAR/SPECI found in the last ${metarHistoryHours} hours.</div>`;
          return;
        }
        const lines = entries.map(e => buildMetarText(e, true));
        metarPopupBody.innerHTML = lines.map(line =>
          `<div class="metar-line">${escapeHtml(line)}</div>`
        ).join('');
      } catch (err) {
        console.error('METAR history fetch error:', err);
        metarPopupBody.innerHTML = `<div class="no-data">Unable to load METAR/SPECI history. Error: ${err.message}</div>`;
      }
    };

    window.closeMetarPopup = function(){
      metarPopup.classList.remove('active');
    };

    metarPopup.addEventListener('click', function(e) {
      if (e.target === this) closeMetarPopup();
    });

    // ═══════════════════════════════════════════════════════════════
    //  Archive — historical METAR lookup (2023-2025 archive)
    // ═══════════════════════════════════════════════════════════════
    const Archive_URLS = {
      2023: 'https://raw.githubusercontent.com/Ajay57484/metarjson/main/VOGA_2023.json',
      2024: 'https://raw.githubusercontent.com/Ajay57484/metarjson/main/VOGA_2024.json',
      2025: 'https://raw.githubusercontent.com/Ajay57484/metarjson/main/VOGA_2025.json'
    };
    let ArchiveCache = {};

    function ArchiveParseDate(dateStr){
      const parts = String(dateStr || '').split('/');
      if (parts.length !== 3) return null;
      const day = parseInt(parts[0], 10), month = parseInt(parts[1], 10);
      if (isNaN(day) || isNaN(month)) return null;
      return { day, month };
    }

    function ArchiveTimeToMinutes(t){
      const s = String(t || '');
      if (s.length < 3) return null;
      const hh = parseInt(s.slice(0, 2), 10);
      const mm = parseInt(s.slice(2, 4), 10);
      if (isNaN(hh) || isNaN(mm)) return null;
      return hh * 60 + mm;
    }

    async function fetchArchiveYear(year){
      if (ArchiveCache[year]) return ArchiveCache[year];
      const res = await fetch(Archive_URLS[year]);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const metarOnly = Array.isArray(data) ? data.filter(e => e.selectedOption === 'METAR') : [];
      ArchiveCache[year] = metarOnly;
      return metarOnly;
    }

    function ArchiveFindNearest(entries, todayDay, todayMonth, currentMinutes){
      const sameDay = entries.filter(e => {
        const dt = ArchiveParseDate(e.date);
        return dt && dt.day === todayDay && dt.month === todayMonth;
      });
      if (sameDay.length === 0) return [];

      const withMins = sameDay
        .map(e => ({ entry: e, mins: ArchiveTimeToMinutes(e.time) }))
        .filter(x => x.mins !== null)
        .map(x => ({ ...x, diff: x.mins - currentMinutes }));

      const before = withMins.filter(x => x.diff < 0).sort((a, b) => b.diff - a.diff).slice(0, 3);
      const after  = withMins.filter(x => x.diff >= 0).sort((a, b) => a.diff - b.diff).slice(0, 3);

      return before.concat(after).sort((a, b) => a.mins - b.mins);
    }

    window.openArchivePopup = async function(){
      const modal = document.getElementById('ArchiveModal');
      const content = document.getElementById('ArchiveContent');
      modal.classList.add('active');
      content.innerHTML = `<div class="loading-msg" style="height:auto;padding:20px;"><span class="spinner"></span> Loading historical data (2023–2025)...</div>`;

      const now = new Date();
      const todayDay = now.getUTCDate();
      const todayMonth = now.getUTCMonth() + 1;
      const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

      const years = [2023, 2024, 2025];
      const settled = await Promise.allSettled(years.map(y => fetchArchiveYear(y)));

      let allResults = [];
      let anyError = false;
      settled.forEach((res, i) => {
        const year = years[i];
        if (res.status === 'fulfilled') {
          const nearest = ArchiveFindNearest(res.value, todayDay, todayMonth, currentMinutes);
          nearest.forEach(r => allResults.push({ year, entry: r.entry, mins: r.mins, diff: r.diff }));
        } else {
          anyError = true;
          console.error('Archive fetch error for', year, res.reason);
        }
      });

      const dd = String(todayDay).padStart(2, '0'), mm = String(todayMonth).padStart(2, '0');

      if (allResults.length === 0) {
        content.innerHTML = `<div class="Archive-empty">No archived METAR found for today's date (${dd}/${mm}) in the 2023–2025 archive.${anyError ? ' (Some years also failed to load — check your connection.)' : ''}</div>`;
        return;
      }

      let closest = allResults[0];
      allResults.forEach(r => { if (Math.abs(r.diff) < Math.abs(closest.diff)) closest = r; });

      let html = '';
      years.forEach(year => {
        const yearResults = allResults.filter(r => r.year === year);
        if (yearResults.length === 0) return;
        html += `<div class="Archive-year-group"><div class="Archive-year-label">${year}</div>`;
        yearResults.forEach(r => {
          const e = r.entry;
          const isHighlight = (r === closest);
          const t = String(e.time || '----');
          const timeDisp = t.slice(0, 2) + ':' + t.slice(2, 4);
          html += `<div class="Archive-row${isHighlight ? ' highlight' : ''}">` +
                    `<span class="Archive-time">${escapeHtml(e.date)} ${timeDisp}Z</span>` +
                    `<span class="Archive-metar">${escapeHtml(buildArchiveMetarText(e))}</span>` +
                  `</div>`;
        });
        html += `</div>`;
      });

      if (anyError) {
        html += `<div class="Archive-empty">⚠ Some years could not be loaded right now — showing what's available.</div>`;
      }

      content.innerHTML = html;
    };

    window.closeArchive = function(){
      document.getElementById('ArchiveModal').classList.remove('active');
    };

    document.getElementById('ArchiveModal').addEventListener('click', function(e) {
      if (e.target === this) closeArchive();
    });

    // ═══════════════════════════════════════════════════════════════
    //  AW — Live Aerodrome Warning (ported from aerodrome_warning_monitor.py)
    //  Fetches https://olbs.amsschennai.gov.in/nsweb/FlightBriefing/showwatchwarn.php
    //  client-side. That site sends no CORS headers, so a direct fetch()
    //  from the browser is blocked — we go through a public CORS proxy,
    //  trying several in order in case one is down or rate-limited.
    // ═══════════════════════════════════════════════════════════════
    const AW_STATION = 'VOGA';
    const AW_TARGET_URL = 'https://olbs.amsschennai.gov.in/nsweb/FlightBriefing/showwatchwarn.php';
    const AW_PROXIES = [
      u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
      u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
      u => `https://thingproxy.freeboard.io/fetch/${u}`
    ];

    async function AWFetchHTML(){
      let lastErr = null;
      for (const buildUrl of AW_PROXIES){
        try {
          const res = await fetch(buildUrl(AW_TARGET_URL), { cache:'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const text = await res.text();
          if (text && text.length > 200) return text;
          throw new Error('empty/short response');
        } catch(e){
          lastErr = e;
          console.warn('AW: proxy failed, trying next —', e.message);
        }
      }
      throw lastErr || new Error('all proxies failed');
    }

    // Mirrors BeautifulSoup's get_text(separator='\n') behaviour closely
    // enough — parse_warning_text below flattens all whitespace anyway,
    // so exact line boundaries don't matter, only that text isn't glued
    // together across tags.
    function AWWalkText(node, parts){
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE){
          const t = child.textContent.replace(/\s+/g, ' ').trim();
          if (t) parts.push(t);
        } else if (child.nodeType === Node.ELEMENT_NODE){
          if (child.tagName === 'BR') parts.push('\n');
          AWWalkText(child, parts);
        }
      });
    }
    function AWDivText(div){
      const parts = [];
      AWWalkText(div, parts);
      return parts.join('\n');
    }

    function AWParseWarningText(text){
      const flat = text.replace(/\s+/g, ' ').trim();
      const header = flat.match(/WARNING\s+FOR\s+(\w+)\s*-\s*(\d{8})\s+(\d{2}:\d{2})/);
      if (!header) return null;

      let detailLine = flat.slice(header.index + header[0].length).replace(/^[\s-]+/, '');
      if (!detailLine) return null;

      const data = { station: header[1], issue_date: header[2] };

      // Pattern: VOGA 301700Z AD WRNG 3 VALID 301730/302130
      // The site inconsistently omits the trailing "Z" on issue time,
      // so it's optional here (same fix as in the Python monitor).
      const detailPattern = /(\w+)\s+(\d{6}Z?)\s+AD\s+WRNG\s+(\d+)\s+VALID\s+(\d{6})\/(\d{6})/;
      const m = detailLine.match(detailPattern);
      if (!m) return null;
      data.icao = m[1];
      data.issue_time_z = m[2];
      data.warning_number = m[3];
      data.valid_from = m[4];
      data.valid_to = m[5];

      const validMatch = detailLine.match(/VALID\s+\d{6}\/\d{6}\s+/);
      if (validMatch){
        const remaining = detailLine.slice(validMatch.index + validMatch[0].length);
        const obsMatch = remaining.match(/\s+(FCST|OBS)\s+/i);
        if (obsMatch){
          data.phenomenon = remaining.slice(0, obsMatch.index).trim();
          data.obs_type = obsMatch[1].toUpperCase();
          data.changes = remaining.slice(obsMatch.index + obsMatch[0].length).trim().replace(/=+$/, '');
        } else {
          data.phenomenon = remaining.trim();
          data.obs_type = '';
          data.changes = '';
        }
      } else {
        data.phenomenon = detailLine;
        data.obs_type = '';
        data.changes = '';
      }
      if (!data.phenomenon) data.phenomenon = 'N/A';
      return data;
    }

    function AWExtractStationWarnings(html, station){
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const divs = doc.querySelectorAll('div.adwarning');
      const results = [];
      divs.forEach(div => {
        const text = AWDivText(div);
        if (text.includes(station)){
          const data = AWParseWarningText(text);
          if (data) results.push(data);
        }
      });
      return results;
    }

    function AWFormatDate(yyyymmdd){
      if (yyyymmdd && yyyymmdd.length === 8){
        return `${yyyymmdd.slice(6,8)} / ${yyyymmdd.slice(4,6)} / ${yyyymmdd.slice(0,4)}`;
      }
      return yyyymmdd || '';
    }

    function AWChangeLabel(changes){
      const up = (changes || '').toUpperCase();
      if (up.includes('NC')) return 'NC';
      if (up.includes('INTSF') || up.includes('INT')) return 'INTSF';
      if (up.includes('WKN')) return 'WKN';
      return changes || 'NC';
    }

    // Builds the same report layout as generate_html_report() in
    // aerodrome_warning_monitor.py (title logic, field order, labels).
    function AWBuildReportHTML(data){
      const phenomenon = data.phenomenon || '';
      const hasTs = phenomenon.includes('TS') || phenomenon.includes('TSRA');
      const hasLight = /SFC\s+WSPD\s+\d+KT/.test(phenomenon);
      const titleParts = [];
      if (hasTs) titleParts.push('THUNDERSTORM');
      if (hasLight) titleParts.push('LIGHT AIRCRAFT');
      const title = titleParts.length
        ? `AERODROME WARNING FOR ${titleParts.join(' AND ')}`
        : 'AERODROME WARNING';

      const dated = AWFormatDate(data.issue_date);
      const validity = `${data.valid_from || ''} / ${data.valid_to || ''} UTC`;
      const changeLabel = AWChangeLabel(data.changes);

      return `
        <div class="aw-report">
          <div class="aw-header">${escapeHtml(title)}</div>
          <div class="aw-meta"><span>Dated: ${escapeHtml(dated)}</span><span>WRNG ${escapeHtml(data.warning_number || '')}</span></div>
          <table class="aw-table">
            <tr><td class="aw-label">Location Indicator of Aerodrome</td><td class="aw-value">${escapeHtml(data.station || '')}</td></tr>
            <tr><td class="aw-label">Date &amp; Time of Issue</td><td class="aw-value">${escapeHtml(data.issue_time_z || '')}</td></tr>
            <tr><td class="aw-label">Identification of Type of Message</td><td class="aw-value">AD WRNG ${escapeHtml(data.warning_number || '')}</td></tr>
            <tr class="aw-urgent"><td class="aw-label">Validity Period</td><td class="aw-value">${escapeHtml(validity)}</td></tr>
            <tr class="aw-phenomenon"><td class="aw-label">Phenomenon</td><td class="aw-value">${escapeHtml(phenomenon)}</td></tr>
            <tr><td class="aw-label">Observed or Forecast Phenomenon</td><td class="aw-value">${escapeHtml(data.obs_type || '')}</td></tr>
            <tr><td class="aw-label">Changes in Intensity</td><td class="aw-value">${escapeHtml(changeLabel)}</td></tr>
          </table>
          <div class="aw-sign">Signature :- DUTY OFFICER / DUTY MET</div>
          <div class="aw-footer">ISSUED BY METEOROLOGICAL WATCH OFFICE (MUMBAI)</div>
        </div>`;
    }

    let AWLastData = null;

    // Primary source: GitHub Actions scrapes OLBS server-side every ~10 min
    // and commits the parsed result here — no CORS, no proxy, no gov-site
    // IP blocking (confirmed working from Actions runners).
    const AW_JSON_URL = 'https://raw.githubusercontent.com/ajayydv-prog/DCWIS/main/data/voga_warning.json';

    async function AWFetchJSON(){
      const res = await fetch(AW_JSON_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    function AWFreshnessLine(generatedUtc){
      const d = new Date(generatedUtc);
      if (isNaN(d.getTime())) return '';
      const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
      const label = mins < 1 ? 'just now' : (mins === 1 ? '1 min ago' : `${mins} min ago`);
      return `<div class="aw-freshness">Last checked: ${label}</div>`;
    }

    window.openAWPopup = async function(){
      const modal = document.getElementById('AWModal');
      const content = document.getElementById('AWContent');
      modal.classList.add('active');
      content.innerHTML = `<div class="loading-msg" style="height:auto;padding:24px;"><span class="spinner"></span> Fetching live aerodrome warning for ${AW_STATION}...</div>`;
      AWLastData = null;

      // ── Primary: GitHub-hosted JSON ──
      try {
        const payload = await AWFetchJSON();
        if (payload.has_warning && payload.warning){
          AWLastData = payload.warning;
          content.innerHTML = AWBuildReportHTML(payload.warning) + AWFreshnessLine(payload.generated_utc);
        } else {
          content.innerHTML = `<div class="aw-empty">No active aerodrome warning for ${AW_STATION} right now.</div>` + AWFreshnessLine(payload.generated_utc);
        }
        return;
      } catch (e){
        console.warn('AW: GitHub JSON fetch failed, falling back to live proxy scrape —', e.message);
      }

      // ── Fallback: scrape OLBS directly through CORS proxies ──
      try {
        const html = await AWFetchHTML();
        const warnings = AWExtractStationWarnings(html, AW_STATION);
        if (!warnings.length){
          content.innerHTML = `<div class="aw-empty">No active aerodrome warning for ${AW_STATION} right now.</div>`;
          return;
        }
        const latest = warnings.reduce((a, b) =>
          (parseInt(b.warning_number || 0, 10) >= parseInt(a.warning_number || 0, 10) ? b : a));
        AWLastData = latest;
        content.innerHTML = AWBuildReportHTML(latest);
      } catch (e){
        console.error('AW fetch/parse failed:', e);
        content.innerHTML = `<div class="aw-error">⚠ Could not load the warning right now — GitHub data and all fallback proxies failed.<br>Try again in a moment.</div>`;
      }
    };

    window.closeAW = function(){
      document.getElementById('AWModal').classList.remove('active');
    };

    document.getElementById('AWModal').addEventListener('click', function(e){
      if (e.target === this) closeAW();
    });

    // Builds the exact same self-contained HTML document that
    // aerodrome_warning_monitor.py's generate_html_report() writes to
    // disk — same classes, same colours, same @page rule. Printing this
    // in its own tab means the dashboard's CSS (flexbox, dark theme,
    // modal overlay, etc.) never gets involved, so it can't interfere.
    function AWBuildStandaloneHTML(data){
      const phenomenon = data.phenomenon || '';
      const hasTs = phenomenon.includes('TS') || phenomenon.includes('TSRA');
      const hasLight = /SFC\s+WSPD\s+\d+KT/.test(phenomenon);
      const titleParts = [];
      if (hasTs) titleParts.push('THUNDERSTORM');
      if (hasLight) titleParts.push('LIGHT AIRCRAFT');
      const title = titleParts.length
        ? `AERODROME WARNING FOR ${titleParts.join(' AND ')}`
        : 'AERODROME WARNING';

      const dated = AWFormatDate(data.issue_date);
      const validity = `${data.valid_from || ''} / ${data.valid_to || ''} UTC`;
      const changeLabel = AWChangeLabel(data.changes);
      const station = data.station || '';

      return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Aerodrome Warning - ${escapeHtml(station)}</title>
    <style>
        /* Plain A4 — the one page size every browser/printer honours
           reliably. The .container below is sized to comfortably sit
           within the TOP HALF of that sheet (roughly 135mm tall out of
           the ~277mm usable height), instead of gambling on a custom
           @page size. Cut/fold the sheet in half afterwards if needed. */
        @page { size: A4; margin: 10mm; }
        * { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; color-adjust:exact; }
        body { font-family:'Segoe UI', Arial, sans-serif; margin:0; padding:0; background:#ffffff; }
        .container { width:100%; max-height:170mm; overflow:hidden; margin:0 auto; background:#ffffff; border:1px solid #c9ccd1; }
        .accent-bar { height:5px; width:100%; background:#7a1f1f; }
        .header { background:#23365c; color:#ffffff; font-size:20px; font-weight:bold; text-transform:uppercase; padding:13px 18px; letter-spacing:0.4px; text-align:center; border-bottom:3px solid #7a1f1f; }
        .meta-row { display:flex; justify-content:space-between; align-items:center; padding:10px 20px; background:#eceef2; border-bottom:1px solid #c9ccd1; }
        .meta-row .dated { font-size:15px; font-weight:bold; color:#23365c; text-align:left; }
        .warning-box { padding:13px 18px; }
        table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:15px; margin:0; }
        td, th { border:1px solid #c9ccd1; padding:8px 10px; text-align:center; vertical-align:middle; word-break:break-word; }
        .label { font-weight:bold; width:42%; background:#eceef2; color:#23365c; }
        .value { width:58%; background:#ffffff; font-weight:bold; color:#1a1a1a; }
        .phenomenon-row .value { font-weight:bold; color:#7a1f1f; }
        .urgent-row .label { background:#23365c; color:#ffffff; }
        .urgent-row .value { font-weight:bold; color:#23365c; background:#dde3ee; }
        .signature-row { display:flex; justify-content:flex-end; align-items:flex-end; padding:10px 18px 5px; }
        .signature { text-align:right; font-size:13px; font-weight:bold; color:#23365c; border-top:2px solid #7a1f1f; padding-top:6px; min-width:250px; }
        .footer-strip { text-align:center; font-size:10px; font-weight:bold; color:#23365c; padding:6px 12px; letter-spacing:0.3px; }
        @media print {
            body { background:#ffffff !important; }
            .container { border:1px solid #000000 !important; }
            .accent-bar { display:none !important; }
            .header { background:#ffffff !important; color:#7a1f1f !important; border:2px solid #000000 !important; border-bottom:2px solid #000000 !important; }
            .meta-row { background:#ffffff !important; border-bottom:1px solid #000000 !important; }
            .meta-row .dated { color:#000000 !important; }
            td, th { border:1px solid #000000 !important; }
            .label { background:#ffffff !important; color:#000000 !important; font-weight:bold !important; }
            .value { background:#ffffff !important; color:#000000 !important; }
            .phenomenon-row .value { color:#7a1f1f !important; font-weight:bold !important; }
            .urgent-row .label { background:#ffffff !important; color:#000000 !important; border:2px solid #000000 !important; }
            .urgent-row .value { background:#ffffff !important; color:#000000 !important; font-weight:bold !important; border:2px solid #000000 !important; }
            .signature { color:#000000 !important; border-top:1.5px solid #000000 !important; }
            .footer-strip { color:#000000 !important; }
        }
    </style>
</head>
<body>
<div class="container">
    <div class="accent-bar"></div>
    <div class="header">${escapeHtml(title)}</div>
    <div class="meta-row">
        <div class="dated">Dated: ${escapeHtml(dated)}</div>
    </div>
    <div class="warning-box">
        <table>
            <tr><td class="label">Location Indicator of Aerodrome</td><td class="value">${escapeHtml(station)}</td></tr>
            <tr><td class="label">Date &amp; Time of Issue</td><td class="value">${escapeHtml(data.issue_time_z || '')}</td></tr>
            <tr><td class="label">Identification of Type of Message</td><td class="value">AD WRNG ${escapeHtml(data.warning_number || '')}</td></tr>
            <tr class="urgent-row"><td class="label">Validity Period</td><td class="value">${escapeHtml(validity)}</td></tr>
            <tr class="phenomenon-row"><td class="label">Phenomenon</td><td class="value">${escapeHtml(phenomenon)}</td></tr>
            <tr>
                <td class="label">Observed or Forecast Phenomenon</td>
                <td class="value">${escapeHtml(data.obs_type || '')}</td>
            </tr>
            <tr>
                <td class="label">Changes in Intensity</td>
                <td class="value">${escapeHtml(changeLabel)}</td>
            </tr>
        </table>
        <div class="signature-row">
            <div class="signature">Signature :- DUTY OFFICER / DUTY MET</div>
        </div>
    </div>
    <div class="footer-strip">ISSUED BY METEOROLOGICAL WATCH OFFICE (MUMBAI)</div>
</div>
</body>
</html>`;
    }

    // Opens the standalone report in its own tab (clean print, no
    // dashboard CSS involved) and triggers print automatically. If the
    // browser blocks the popup, falls back to downloading the same HTML
    // so it can still be opened/printed manually.
    window.printAWReport = function(){
      if (!AWLastData) return;
      const html = AWBuildStandaloneHTML(AWLastData);
      const win = window.open('', '_blank');
      if (win){
        win.document.open();
        win.document.write(html);
        win.document.close();
        win.onload = () => { win.focus(); win.print(); };
        // Some browsers fire onload before write() settles — try once more shortly after.
        setTimeout(() => { try { win.focus(); win.print(); } catch(e){} }, 300);
      } else {
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `VOGA_Warning_${AWLastData.warning_number || ''}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    };

    // ═══════════════════════════════════════════════════════════════
    //  COMPASS
    // ═══════════════════════════════════════════════════════════════
    function drawCompass(rwy, windDeg){
      const canvas = document.getElementById('compass-'+rwy);
      if(!canvas) return;
      const parent = canvas.parentElement;
      canvas.width = parent.clientWidth || 200;
      canvas.height = parent.clientHeight || 90;
      const ctx = canvas.getContext('2d');
      const W=canvas.width, H=canvas.height;
      const cx=W/2, cy=H/2, r=Math.min(W,H)*0.38;
      if(r<4) return;
      const isDarkMode = document.body.classList.contains('dark');
      ctx.clearRect(0,0,W,H);
      ctx.fillStyle = isDarkMode ? '#04090f' : '#e8f0f8';
      ctx.fillRect(0,0,W,H);
      
      const grad = ctx.createLinearGradient(cx-r,cy-r,cx+r,cy+r);
      grad.addColorStop(0, isDarkMode ? '#1565c0' : '#1976d2');
      grad.addColorStop(1, isDarkMode ? '#0d3a80' : '#42a5f5');
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
      ctx.strokeStyle=grad; ctx.lineWidth=2.5; ctx.stroke();

      ctx.beginPath(); ctx.arc(cx,cy,r-1,0,Math.PI*2);
      ctx.fillStyle = isDarkMode ? 'rgba(21,101,192,0.08)' : 'rgba(21,101,192,0.06)';
      ctx.fill();

      (function drawRunwayStrip(){
        const angA = (280-90)*Math.PI/180;
        const stripLen = r*0.60, stripW = Math.max(2.5, r*0.11);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angA);
        ctx.fillStyle = isDarkMode ? 'rgba(176,190,197,0.30)' : 'rgba(69,90,100,0.28)';
        ctx.fillRect(-stripLen, -stripW/2, stripLen*2, stripW);
        ctx.strokeStyle = isDarkMode ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1; ctx.setLineDash([4,4]);
        ctx.beginPath(); ctx.moveTo(-stripLen,0); ctx.lineTo(stripLen,0); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        const lblCol = isDarkMode ? 'rgba(176,190,197,0.9)' : 'rgba(69,90,100,0.9)';
        const lblFs = Math.max(6, Math.round(r*0.14));
        ctx.font = `700 ${lblFs}px Inter,Arial`;
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillStyle = lblCol;
        ctx.fillText('10', cx+Math.cos(angA)*stripLen*0.62, cy+Math.sin(angA)*stripLen*0.62);
        ctx.fillText('28', cx-Math.cos(angA)*stripLen*0.62, cy-Math.sin(angA)*stripLen*0.62);
      })();

      for(let i=0;i<36;i++){
        const a=(i*10-90)*Math.PI/180;
        const isMaj=i%9===0;
        const inner=isMaj?r*0.72:r*0.85;
        ctx.beginPath();
        ctx.moveTo(cx+Math.cos(a)*inner, cy+Math.sin(a)*inner);
        ctx.lineTo(cx+Math.cos(a)*(r-1), cy+Math.sin(a)*(r-1));
        ctx.strokeStyle=isMaj?(isDarkMode?'#64b5f6':'#1565c0'):(isDarkMode?'#1a3a70':'#90b8d8');
        ctx.lineWidth=isMaj?2:1; ctx.stroke();
      }

      const fs=Math.max(8,Math.round(r*0.22));
      const fsInter=Math.max(7,Math.round(r*0.16));
      [['N',0,isDarkMode?'#ff4444':'#d32f2f',fs],
       ['NE',45,isDarkMode?'#90caf9':'#1976d2',fsInter],
       ['E',90,isDarkMode?'#64b5f6':'#1565c0',fs],
       ['SE',135,isDarkMode?'#90caf9':'#1976d2',fsInter],
       ['S',180,isDarkMode?'#64b5f6':'#1565c0',fs],
       ['SW',225,isDarkMode?'#90caf9':'#1976d2',fsInter],
       ['W',270,isDarkMode?'#64b5f6':'#1565c0',fs],
       ['NW',315,isDarkMode?'#90caf9':'#1976d2',fsInter]].forEach(([c,deg,col,size])=>{
        const a=(deg-90)*Math.PI/180;
        ctx.font=`900 ${size}px Orbitron,Arial`;
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillStyle=col;
        ctx.fillText(c, cx+Math.cos(a)*r*1.14, cy+Math.sin(a)*r*1.14);
      });

      ctx.beginPath(); ctx.arc(cx,cy,3.5,0,Math.PI*2);
      ctx.fillStyle=isDarkMode?'#ff7700':'#ff6600'; ctx.fill();

      if(windDeg!==null && !isNaN(windDeg)){
        const a=(windDeg-90)*Math.PI/180;
        const len=r*0.7, tail=r*0.22;
        ctx.shadowColor=isDarkMode?'rgba(255,119,0,0.5)':'rgba(255,80,0,0.3)';
        ctx.shadowBlur=10;
        ctx.beginPath();
        ctx.moveTo(cx-Math.cos(a)*tail, cy-Math.sin(a)*tail);
        ctx.lineTo(cx+Math.cos(a)*len,  cy+Math.sin(a)*len);
        ctx.strokeStyle=isDarkMode?'#ff7700':'#e65100'; ctx.lineWidth=3.5; ctx.stroke();
        ctx.shadowBlur=0; ctx.shadowColor='transparent';
        const hs=r*0.18;
        ctx.beginPath();
        ctx.moveTo(cx+Math.cos(a)*len, cy+Math.sin(a)*len);
        ctx.lineTo(cx+Math.cos(a)*len+Math.cos(a+2.7)*hs, cy+Math.sin(a)*len+Math.sin(a+2.7)*hs);
        ctx.lineTo(cx+Math.cos(a)*len+Math.cos(a-2.7)*hs, cy+Math.sin(a)*len+Math.sin(a-2.7)*hs);
        ctx.closePath(); ctx.fillStyle=isDarkMode?'#ff7700':'#e65100'; ctx.fill();
      }
    }

    // ═══════════════════════════════════════════════════════════════
    //  LIVE WIND FLOW ANIMATION (particle overlay on each compass)
    //
    //  Renders on a separate transparent canvas layered on top of the
    //  compass canvas — drawCompass() itself is untouched. Direction is
    //  read from compassCurrentAngle (the same eased angle the needle
    //  already animates to), speed scales with windSpeedCurrent (kt).
    //  Particles are stored in path-fraction coordinates (not pixels) so
    //  they stay correctly placed across any canvas resize.
    // ═══════════════════════════════════════════════════════════════
    const WIND_PARTICLE_COUNT = 11;
    const windParticles = { '28': [], '10': [] };

    function makeWindParticle(){
      return {
        t: Math.random() * 2.6 - 1.3,   // position along travel line, -1.3..1.3
        o: Math.random() * 1.4 - 0.7,   // perpendicular offset (fraction of r)
        jitter: 0.65 + Math.random() * 0.7 // per-particle speed variance
      };
    }

    function ensureWindParticles(rwy){
      if(windParticles[rwy].length === 0){
        for(let i=0;i<WIND_PARTICLE_COUNT;i++) windParticles[rwy].push(makeWindParticle());
      }
    }

    function drawWindParticles(rwy){
      const canvas = document.getElementById('particles-'+rwy);
      const compassCanvas = document.getElementById('compass-'+rwy);
      if(!canvas || !compassCanvas) return;
      const parent = canvas.parentElement;
      const w = parent.clientWidth || 200, h = parent.clientHeight || 90;
      if(canvas.width !== w) canvas.width = w;
      if(canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,w,h);

      const cx = w/2, cy = h/2, r = Math.min(w,h)*0.38;
      if(r < 4) return;

      const windDeg = compassCurrentAngle[rwy];
      const speedKt = windSpeedCurrent[rwy] || 0;
      ensureWindParticles(rwy);

      // Below ~2kt treat as calm — no particle streaks implying movement
      // that isn't there. The plane still draws (a plane on approach
      // exists regardless of whether we're rendering wind streaks).
      if(!(windDeg === null || isNaN(windDeg) || speedKt < 2)){
        // Travel direction = reciprocal of the "wind FROM" bearing the
        // needle points at, i.e. the direction the air is actually moving.
        const travelA = ((windDeg + 180) - 90) * Math.PI/180;
        const dx = Math.cos(travelA), dy = Math.sin(travelA);
        const px = -dy, py = dx;

        const speedFrac = Math.min(0.045, 0.006 + speedKt * 0.0011);
        const isDarkMode = document.body.classList.contains('dark');
        const col = isDarkMode ? '0,229,255' : '0,119,204';
        const tailLen = r * (0.10 + Math.min(speedKt,40)/40 * 0.16);

        windParticles[rwy].forEach(pt => {
          pt.t += speedFrac * pt.jitter;
          if(pt.t > 1.3){
            pt.t = -1.3;
            pt.o = Math.random() * 1.4 - 0.7;
            pt.jitter = 0.65 + Math.random() * 0.7;
          }
          const x = cx + dx*pt.t*r*1.3 + px*pt.o*r;
          const y = cy + dy*pt.t*r*1.3 + py*pt.o*r;
          const dist = Math.hypot(x-cx, y-cy);
          if(dist > r) return; // clip to the compass circle

          const fade = 1 - Math.abs(pt.o); // dimmer near the circle's edge
          const alpha = Math.max(0.12, 0.6 * fade);
          const tx = x - dx*tailLen, ty = y - dy*tailLen;
          ctx.strokeStyle = `rgba(${col},${alpha.toFixed(2)})`;
          ctx.lineWidth = 1.6;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(tx,ty);
          ctx.lineTo(x,y);
          ctx.stroke();
        });
      }

      drawPlane(ctx, cx, cy, r, rwy);
    }

    // ═══════════════════════════════════════════════════════════════
    //  RUNWAY PLANE — a static, professionally-proportioned top-down
    //  aircraft silhouette sitting on the runway strip, aligned with
    //  this panel's landing heading. Purely a visual identifier (no
    //  animation, no wind-driven movement) — clean and unobtrusive.
    // ═══════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════
    //  RUNWAY PLANE — a single large outline (stroke only, no fill) of
    //  a top-down aircraft silhouette, sized to the compass circle so
    //  the runway strip sits inside it. Static, aligned with this
    //  panel's landing heading. Purely a framing visual — never
    //  competes with the compass ticks/runway strip underneath.
    // ═══════════════════════════════════════════════════════════════
    function drawPlane(ctx, cx, cy, r, rwy){
      const angA = (280-90) * Math.PI/180; // runway bearing, matches drawCompass's strip
      const heading = (rwy === '28') ? angA : (angA + Math.PI); // static, faces this panel's landing direction

      const L = r * 0.92; // half-length scale unit — sized so the whole shape frames the compass circle

      const isDarkMode = document.body.classList.contains('dark');
      const strokeCol = isDarkMode ? 'rgba(230,240,250,0.55)' : 'rgba(20,35,50,0.55)';

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(heading);
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = Math.max(0.8, L*0.028);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // One continuous outline tracing nose → main wing → tail wing →
      // tail tip → mirrored back up the other side → closing at the nose.
      ctx.beginPath();
      ctx.moveTo(L*1.00, 0);
      ctx.lineTo(L*0.72, L*0.05);
      ctx.lineTo(L*0.30, L*0.07);
      ctx.lineTo(L*-0.10, L*0.62);
      ctx.lineTo(L*-0.28, L*0.62);
      ctx.lineTo(L*-0.42, L*0.10);
      ctx.lineTo(L*-0.65, L*0.08);
      ctx.lineTo(L*-0.85, L*0.23);
      ctx.lineTo(L*-0.95, L*0.23);
      ctx.lineTo(L*-1.00, L*0.06);
      ctx.lineTo(L*-1.08, 0);
      ctx.lineTo(L*-1.00, -L*0.06);
      ctx.lineTo(L*-0.95, -L*0.23);
      ctx.lineTo(L*-0.85, -L*0.23);
      ctx.lineTo(L*-0.65, -L*0.08);
      ctx.lineTo(L*-0.42, -L*0.10);
      ctx.lineTo(L*-0.28, -L*0.62);
      ctx.lineTo(L*-0.10, -L*0.62);
      ctx.lineTo(L*0.30, -L*0.07);
      ctx.lineTo(L*0.72, -L*0.05);
      ctx.closePath();
      ctx.stroke();

      ctx.restore();
    }

    let windParticleLoopStarted = false;
    function startWindParticleLoop(){
      if(windParticleLoopStarted) return;
      windParticleLoopStarted = true;
      (function loop(){
        if(!S.windParticles){
          ['28','10'].forEach(r => { const c = document.getElementById('particles-'+r); if(c) c.getContext('2d').clearRect(0,0,c.width,c.height); });
          windParticleLoopStarted = false;
          return;
        }
        drawWindParticles('28');
        drawWindParticles('10');
        requestAnimationFrame(loop);
      })();
    }

    // ═══════════════════════════════════════════════════════════════
    //  RESIZE
    // ═══════════════════════════════════════════════════════════════
    function resizeLayout(){
      // Row heights (wind-row / range-row / data-rows) are sized by
      // proportional flex-grow in CSS now, so they always fill the panel
      // exactly on any screen size or orientation — no JS math needed.
      // We still need to redraw the canvas-based widgets here because a
      // canvas's drawing buffer doesn't auto-scale with its CSS box; it
      // has to be re-measured and repainted whenever its container resizes
      // (e.g. after an orientation change or a mobile URL-bar show/hide).
      ['28','10'].forEach(rwy=>{
        const cell=document.getElementById('compass-'+rwy)?.parentElement;
        if(cell) drawCompass(rwy, compassCurrentAngle[rwy] ?? compassDirs[rwy]);
      });
      ['28','10'].forEach(rwy => drawQnhSparkline(rwy));
    }

    // ═══════════════════════════════════════════════════════════════
    //  VALUE HELPERS
    // ═══════════════════════════════════════════════════════════════
    function setValue(id, newVal){
      const el = document.getElementById(id);
      if(!el) return;
      const displayVal = (newVal !== undefined && newVal !== null && newVal !== '') ? String(newVal) : '—';
      if(el.textContent !== displayVal){
        el.textContent = displayVal;
      }
    }

    function parseLeadingNumber(val){
      if(val === null || val === undefined) return null;
      if(typeof val === 'number') return val;
      const str = String(val).trim();
      if(str === '--' || str === '' || str === '—') return null;
      const match = str.match(/-?\d+(\.\d+)?/);
      if(!match) return null;
      return parseFloat(match[0]);
    }

    const SEVERITY_THRESHOLDS = {
      windSpeed:  { normalMax: 15,   highMax: 25   },
      crossWind:  { normalMax: 10,   highMax: 20   },
      headWind:   { normalMax: 20,   highMax: 30   },
      temperature:{ normalMax: 35,   highMax: 40   },
      humidity:   { normalMax: 70,   highMax: 85   },
      visibility: { normalMax: 1500, highMax: 550, reverse: true }
    };

    function getSeverityClass(paramKey, rawValue){
      const cfg = SEVERITY_THRESHOLDS[paramKey];
      if(!cfg) return null;
      const num = parseLeadingNumber(rawValue);
      if(num === null || isNaN(num)) return null;
      if(cfg.reverse){
        if(num < cfg.highMax) return 'sev-red';
        if(num < cfg.normalMax) return 'sev-orange';
        return paramKey === 'visibility' ? 'sev-green' : null;
      } else {
        if(num > cfg.highMax) return 'sev-red';
        if(num > cfg.normalMax) return 'sev-orange';
        return null;
      }
    }

    function setValueWithSeverity(id, newVal, paramKey){
      setValue(id, newVal);
      const el = document.getElementById(id);
      if(!el) return;
      el.classList.remove('sev-orange', 'sev-red', 'sev-green');
      const sevClass = getSeverityClass(paramKey, newVal);
      if(sevClass) el.classList.add(sevClass);
    }

    // Highlights RVR/MOR readings that carry a "P" (>= range, e.g. P2000
    // means RVR/MOR is at least 2000m) or "M" (<= minimum reportable,
    // e.g. M200 means RVR/MOR is at or below 200m) boundary-indicator
    // prefix, so observers can see at a glance that the value is a
    // sensor-range boundary rather than an exact reading.
    function applyBoundaryBadge(id, rawVal){
      const el = document.getElementById(id);
      if(!el) return;
      el.classList.remove('boundary-ge', 'boundary-le');
      el.removeAttribute('title');
      const s = String(rawVal || '').trim().toUpperCase();
      if(s.startsWith('P')){
        el.classList.add('boundary-ge');
        el.title = 'At or beyond sensor range (≥ ' + s.slice(1) + 'm)';
      } else if(s.startsWith('M')){
        el.classList.add('boundary-le');
        el.title = 'At or below minimum reportable value (≤ ' + s.slice(1) + 'm)';
      }
    }

    function getValueByMode(data, field, mode){
      if(!data) return null;
      const suffixMap = {
        'instant': 'instant_rounded',
        '1min': 'avgOneMin_rounded',
        '2min': 'avgTwoMin_rounded',
        '10min': 'avgTenMin_rounded'
      };
      const suffix = suffixMap[mode] || 'instant_rounded';
      let key = field + '_' + suffix;
      if(data[key] !== undefined && data[key] !== '--') {
        return data[key];
      }
      key = field + '_' + suffix.replace('_rounded', '');
      if(data[key] !== undefined && data[key] !== '--') {
        return data[key];
      }
      const altMap = {
        'windDirection': ['windDirection_avgOneMin_rounded', 'windDirection_avgOneMin', 'windDirection_instant_rounded'],
        'windSpeed': ['windSpeed_avgOneMin_rounded', 'windSpeed_avgOneMin', 'windSpeed_instant_rounded'],
        'temperature': ['temperature_avgOneMin_rounded', 'temperature_avgOneMin', 'temperature_instant_rounded'],
        'humidity': ['humidity_avgOneMin_rounded', 'humidity_avgOneMin', 'humidity_instant_rounded'],
        'dewPoint': ['dewPoint_avgOneMin_rounded', 'dewPoint_avgOneMin', 'dewPoint_instant_rounded'],
        'qnh': ['qnh_avgOneMin_rounded', 'qnh_avgOneMin', 'qnh_instant_rounded'],
        'qfe': ['qfe_avgOneMin_rounded', 'qfe_avgOneMin', 'qfe_instant_rounded']
      };
      if(altMap[field]) {
        for(let altKey of altMap[field]) {
          if(data[altKey] !== undefined && data[altKey] !== '--') {
            return data[altKey];
          }
        }
      }
      return null;
    }

    function getHeadCrossWind(data, mode){
      if(!data) return { hw: '--', cw: '--' };
      const suffixMap = {
        'instant': 'instant',
        '1min': 'avgOneMin',
        '2min': 'avgTwoMin',
        '10min': 'avgTenMin'
      };
      const suffix = suffixMap[mode] || 'instant';
      let hwKey = 'headwind_' + suffix;
      let cwKey = 'crosswind_' + suffix;
      let hw = data[hwKey];
      let cw = data[cwKey];
      if(hw === undefined || hw === null || hw === '--') {
        hw = data['headwind_avgOneMin'] || '--';
        cw = data['crosswind_avgOneMin'] || '--';
      }
      return { hw: hw || '--', cw: cw || '--' };
    }

    function renderWindBadge(containerId, raw, type){
      const el = document.getElementById(containerId);
      if(!el) return;
      if(!raw || raw === '--' || raw === '—'){ el.innerHTML=''; return; }
      const s = String(raw).trim();
      if(parseLeadingNumber(s) === null){ el.innerHTML=''; return; }
      let cls, icon;
      if(type === 'head'){
        if(s.endsWith('T'))      { cls='badge-tailwind'; icon='↙ TAIL'; }
        else if(s.endsWith('H')) { cls='badge-headwind'; icon='↗ HEAD'; }
        else                     { cls='badge-zero';     icon='→'; }
      } else {
        if(s.endsWith('R'))      { cls='badge-crossR'; icon='→ R'; }
        else if(s.endsWith('L')) { cls='badge-crossL'; icon='← L'; }
        else                     { cls='badge-zero';   icon='○'; }
      }
      el.innerHTML = `<span class="wcomp-badge ${cls}">${icon}</span>`;
    }

    function parseVisibilityForFogCheck(raw){
      if(raw === undefined || raw === null) return null;
      const s = String(raw).trim();
      if(s === '--' || s === '' || s === '—') return null;
      if(s.toUpperCase().startsWith('P')) return null;
      return parseLeadingNumber(s);
    }

    function isGoodVisibilityReading(raw){
      if(raw === undefined || raw === null) return false;
      return String(raw).trim().toUpperCase().startsWith('P');
    }

    // TEMP: fog-chance prediction badge disabled for both runways.
    // To re-enable, set the relevant runway to true.
    const FOG_RISK_ENABLED = { '10': false, '28': false };

    let fogRiskActive = {};
    let visWarnActive = {};

    function renderFogRiskBadge(rwy, containerId, temp, dew, windRaw){
      const el = document.getElementById(containerId);
      if(!el) return;

      const t = parseFloat(temp), d = parseFloat(dew);
      const spread = (!isNaN(t) && !isNaN(d)) ? Math.round((t - d) * 10) / 10 : null;
      const windVal = parseLeadingNumber(windRaw);

      let isActive = !!fogRiskActive[rwy];
      if (spread === null) {
        // hold previous state
      } else if (!isActive) {
        isActive = (spread < 2 && windVal !== null && windVal < 5);
      } else {
        isActive = !(spread > 2.5 || (windVal !== null && windVal >= 6));
      }
      fogRiskActive[rwy] = isActive;

      el.innerHTML = isActive
        ? `<span class="dew-spread spread-risk">⚠ FOG RISK</span>`
        : '';
    }

    function renderVisibilityBadge(rwy, containerId, morRaw, rvrRaw){
      const el = document.getElementById(containerId);
      if(!el) return;

      const morVal = parseVisibilityForFogCheck(morRaw);
      const rvrVal = parseVisibilityForFogCheck(rvrRaw);
      const visVal = (morVal !== null) ? morVal : rvrVal;
      const sensorSaysGood = (morVal === null && rvrVal === null) &&
                             (isGoodVisibilityReading(morRaw) || isGoodVisibilityReading(rvrRaw));

      let isActive = !!visWarnActive[rwy];
      if (sensorSaysGood) {
        isActive = false;
      } else if (visVal === null) {
        // hold previous state
      } else if (!isActive) {
        isActive = visVal < 2000;
      } else {
        isActive = visVal < 2200;
      }
      visWarnActive[rwy] = isActive;

      el.innerHTML = isActive
        ? `<span class="dew-spread spread-fog">🌫 LOW VIS ${visVal}m</span>`
        : '';
    }

    function updateQnhBufferAndGetReference(rwy, currentVal) {
      const num = parseFloat(currentVal);
      if (isNaN(num)) return null;
      const now = Date.now();
      const buf = qnhTrendBuffer[rwy] || (qnhTrendBuffer[rwy] = []);
      buf.push({ t: now, v: num });
      const cutoff = now - 12 * 60 * 1000;
      while (buf.length && buf[0].t < cutoff) buf.shift();
      if (buf.length < 2 || (now - buf[0].t) < 8 * 60 * 1000) return null;
      return buf[0].v;
    }

    function renderPressureTrend(spanId, instant, tenMinAgo){
      const el = document.getElementById(spanId);
      if(!el) return;
      const i = parseFloat(instant);
      if(isNaN(i)){ el.className='qnh-trend trend-flat'; el.textContent=' →'; return; }
      if(tenMinAgo === null || tenMinAgo === undefined || isNaN(tenMinAgo)){
        el.className='qnh-trend trend-pending'; el.textContent=' ·'; return;
      }
      const diff = Math.round((i - tenMinAgo) * 10) / 10;
      if(diff > 0.3){
        el.className='qnh-trend trend-rise'; el.textContent=' ↑';
      } else if(diff < -0.3){
        el.className='qnh-trend trend-fall'; el.textContent=' ↓';
      } else {
        el.className='qnh-trend trend-flat'; el.textContent=' →';
      }
    }

    // ═══════════════════════════════════════════════════════════════
    //  RENDER PANEL
    // ═══════════════════════════════════════════════════════════════
    function renderPanel(rwy){
      const d=latestData[rwy];
      if(!d) return;
      
      const mode=modes[rwy];
      const p='r'+rwy+'-';

      const modeLabel={ instant:'INST', '1min':'1MIN', '2min':'2MIN', '10min':'10MIN' }[mode]||'INST';
      const pillClass={ instant:'pill-inst', '1min':'pill-1min', '2min':'pill-2min', '10min':'pill-10min' }[mode]||'pill-inst';
      ['wd','ws'].forEach(f=>{
        const pill=document.getElementById('pill'+rwy+'-'+f);
        if(pill){
          pill.textContent=modeLabel;
          pill.className='mode-pill '+pillClass;
        }
      });

      const wd = getValueByMode(d, 'windDirection', mode);
      setValue(p+'wd', wd);

      const ws = getValueByMode(d, 'windSpeed', mode);
      setValueWithSeverity(p+'ws', ws, 'windSpeed');
      windSpeedCurrent[rwy] = parseLeadingNumber(ws) ?? 0;

      const { hw, cw } = getHeadCrossWind(d, mode);
      const hwEl = document.getElementById(p+'hw');
      if(hwEl){
        const hwStr = String(hw||'');
        if(hwStr.endsWith('T')){
          hwEl.className = 'wval hw-red';
        } else {
          hwEl.className = 'wval hw-green';
        }
        setValue(p+'hw', hw);
        hwEl.classList.remove('sev-orange','sev-red');
      }
      setValueWithSeverity(p+'cw', cw, 'crossWind');
      const cwEl = document.getElementById(p+'cw');
      if(cwEl){ cwEl.classList.remove('sev-orange','sev-red'); }
      renderWindBadge('badge'+rwy+'-hw', hw, 'head');
      renderWindBadge('badge'+rwy+'-cw', cw, 'cross');

      if(d.windSpeed_minTwoMin_rounded !== undefined && d.windSpeed_maxTwoMin_rounded !== undefined){
        setValue(p+'ws2', d.windSpeed_minTwoMin_rounded + '-' + d.windSpeed_maxTwoMin_rounded);
      }
      if(d.windDirection_minTwoMin_rounded !== undefined && d.windDirection_maxTwoMin_rounded !== undefined){
        setValue(p+'wd2', 
          String(d.windDirection_minTwoMin_rounded).padStart(3,'0')+'-'+
          String(d.windDirection_maxTwoMin_rounded).padStart(3,'0')
        );
      }

      const rvrKey = mode === '10min' ? 'pwd_rvr_avgTenMin' : 'pwd_rvr_avgOneMin';
      setValueWithSeverity(p+'rvr', d[rvrKey] || '--', 'visibility');
      applyBoundaryBadge(p+'rvr', d[rvrKey]);

      const morKey = mode === '10min' ? 'pwd_mor_avgTenMin' : 'pwd_mor_avgOneMin';
      setValueWithSeverity(p+'mor', d[morKey] || '--', 'visibility');
      applyBoundaryBadge(p+'mor', d[morKey]);

      const qnh = getValueByMode(d, 'qnh', mode);
      setValue(p+'qnh', qnh);

      const qfe = getValueByMode(d, 'qfe', mode);
      setValue(p+'qfe', qfe);

      const temp = getValueByMode(d, 'temperature', mode);
      setValueWithSeverity(p+'temp', temp, 'temperature');

      const hum = getValueByMode(d, 'humidity', mode);
      setValue(p+'hum', hum);
      const humEl = document.getElementById(p+'hum');
      if(humEl){
        humEl.classList.remove('sev-orange', 'sev-red');
        const hNum = parseLeadingNumber(hum);
        if(hNum !== null && !isNaN(hNum)){
          if(hNum > 95) humEl.classList.add('sev-red');
          else if(hNum >= 85) humEl.classList.add('sev-orange');
        }
      }

      const dew = getValueByMode(d, 'dewPoint', mode);
      setValue(p+'dew', dew);

      renderVisibilityBadge(rwy, 'visflag'+rwy, d[morKey], d[rvrKey]);
      if (FOG_RISK_ENABLED[rwy]) {
        renderFogRiskBadge(rwy, 'fogrisk'+rwy, temp, dew, ws);
      }
      const qnhTrendRef = updateQnhBufferAndGetReference(rwy, d.qnh_instant_rounded ?? d.qnh_avgOneMin_rounded);
      renderPressureTrend('trend'+rwy+'-qnh', d.qnh_instant_rounded ?? d.qnh_avgOneMin_rounded, qnhTrendRef);

      const wsExtSuffix = { '1min':'OneMin', '2min':'TwoMin', '10min':'TenMin' }[wsExtremeModes[rwy]] || 'OneMin';
      setValue(p+'wsmax', d['windSpeed_max'+wsExtSuffix+'_rounded'] ?? '--');
      setValue(p+'wsmin', d['windSpeed_min'+wsExtSuffix+'_rounded'] ?? '--');

      compassDirs[rwy]=wd;
      setCompassTarget(rwy, wd);

      // QNH sparkline
      const qnhRaw = d.qnh_instant_rounded ?? d.qnh_avgOneMin_rounded;
      pushQnhSpark(rwy, qnhRaw);
      drawQnhSparkline(rwy);

      // RVR trend
      const rvrRawForTrend = d['pwd_rvr_avgOneMin'];
      pushRvrHistory(rwy, rvrRawForTrend);
      renderRvrTrend(rwy);

      // Alert check (after both panels get data at least once)
      checkAlerts();
    }

    window.cycleWsExtreme = function(rwy){
      const order = ['1min','2min','10min'];
      const cur = wsExtremeModes[rwy] || '1min';
      const next = order[(order.indexOf(cur) + 1) % order.length];
      wsExtremeModes[rwy] = next;

      const maxLbl = document.getElementById('wsmaxlbl'+rwy);
      const minLbl = document.getElementById('wsminlbl'+rwy);
      if(maxLbl) maxLbl.textContent = 'MAX WS ('+next+')';
      if(minLbl) minLbl.textContent = 'MIN WS ('+next+')';

      if(latestData[rwy]) renderPanel(rwy);
    };


    // ═══════════════════════════════════════════════════════════════
    //  MODE CHANGE
    // ═══════════════════════════════════════════════════════════════
    window.onModeChange = function(rwy, val){
      modes[rwy]=val;
      if(latestData[rwy]) renderPanel(rwy);
    };

    // ═══════════════════════════════════════════════════════════════
    //  HISTORY FROM BACKEND
    // ═══════════════════════════════════════════════════════════════
    async function fetchHistoryFromBackend(rwy, param, hours, bin) {
      const h = hours || currentHours;
      const b = bin || currentBin;

      if (param === 'headwind' || param === 'crosswind') {
        return fetchComputedWindComponentHistory(rwy, param, h, b);
      }

      const paramMap = {
        'windDirection': 'windDirection',
        'windSpeed': 'windSpeed',
        'headwind': 'headwind',
        'crosswind': 'crosswind',
        'temperature': 'temperature',
        'humidity': 'humidity',
        'dewPoint': 'dewPoint',
        'qnh': 'qnh',
        'qfe': 'qfe',
        'rvr': 'rvr',
        'mor': 'mor',
        'windSpeedGustMax': 'windSpeedGustMax',
        'windSpeedGustMin': 'windSpeedGustMin'
      };
      
      const backendParam = paramMap[param] || param;
      const url = `${API_BASE}/history/${rwy}/${backendParam}?hours=${h}&bin=${b}`;
      
      try {
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          return data.data || [];
        }
        // Backend reachable but returned an error — no data available.
        return [];
      } catch (err) {
        console.error('History fetch error:', err);
        // Backend unreachable entirely — no data available.
        return [];
      }
    }

    async function fetchComputedWindComponentHistory(rwy, component, hours, bin) {
      const runwayHeading = RUNWAY_HEADING[rwy];
      const [wdBins, wsBins] = await Promise.all([
        fetchHistoryFromBackend(rwy, 'windDirection', hours, bin),
        fetchHistoryFromBackend(rwy, 'windSpeed', hours, bin)
      ]);
      if (!wdBins.length || !wsBins.length || runwayHeading === undefined) return [];

      const wsByTs = new Map(wsBins.map(bn => [bn.timestamp, bn]));

      const out = [];
      wdBins.forEach(wdBin => {
        const wsBin = wsByTs.get(wdBin.timestamp);
        if (!wsBin) return;

        const wd = wdBin.value, ws = wsBin.value;
        if (wd === null || wd === undefined || ws === null || ws === undefined) return;

        const angleRad = (wd - runwayHeading) * Math.PI / 180;
        const trig = component === 'headwind' ? Math.cos(angleRad) : Math.sin(angleRad);
        const val = ws * trig;

        const entry = {
          timestamp: wdBin.timestamp,
          value: Math.round(val * 10) / 10,
          count: wsBin.count
        };

        if (wsBin.min !== undefined && wsBin.min !== null && wsBin.max !== undefined && wsBin.max !== null) {
          const a = wsBin.min * trig, c = wsBin.max * trig;
          entry.min = Math.round(Math.min(a, c) * 10) / 10;
          entry.max = Math.round(Math.max(a, c) * 10) / 10;
          entry.min_timestamp = wsBin.min_timestamp ?? wdBin.timestamp;
          entry.max_timestamp = wsBin.max_timestamp ?? wdBin.timestamp;
        }

        out.push(entry);
      });
      return out;
    }

    // ═══════════════════════════════════════════════════════════════
    //  HISTORY CHART
    // ═══════════════════════════════════════════════════════════════
    function isBreach(cfg, v) {
      if (!cfg || v === null || v === undefined || isNaN(v)) return false;
      const val = cfg.useAbs ? Math.abs(v) : v;
      return cfg.direction === 'below' ? val < cfg.limit : val >= cfg.limit;
    }

    function clampNonNegativeBins(bins, param) {
      if (param !== 'rvr' && param !== 'mor') return bins;
      return bins.map(b => {
        const fixed = { ...b };
        if (fixed.value !== undefined && fixed.value !== null) fixed.value = Math.abs(fixed.value);
        const hasMin = fixed.min !== undefined && fixed.min !== null;
        const hasMax = fixed.max !== undefined && fixed.max !== null;
        if (hasMin && hasMax) {
          const a = Math.abs(fixed.min), c = Math.abs(fixed.max);
          fixed.min = Math.min(a, c);
          fixed.max = Math.max(a, c);
        } else if (hasMin) {
          fixed.min = Math.abs(fixed.min);
        } else if (hasMax) {
          fixed.max = Math.abs(fixed.max);
        }
        return fixed;
      });
    }

    async function renderHistoryChart(param, rwy) {
      if (!param || !rwy || isHistoryLoading) return;
      isHistoryLoading = true;

      const loadingMsg = chartContainer.querySelector('.loading-msg');
      const canvas = modalCanvas;
      const gapNote = document.getElementById('dataGapNote');
      if (loadingMsg) loadingMsg.style.display = 'flex';
      canvas.style.display = 'none';

      try {
        // NOTE: We always pull 1-min (bin=60) resolution from the backend for
        // the actual plotted line, regardless of which range preset (2m/30m/1H)
        // is selected. currentBin is still used below purely for the axis
        // label text and the stale-data gap threshold, so the x-axis time
        // range and "bin" labeling shown to the user stay exactly the same —
        // only the underlying data driving the line gets finer-grained, so
        // real spikes/changes (gusts, RVR dips, etc.) that were being
        // smoothed away by the larger aggregation windows are now visible.
        const bins = clampNonNegativeBins(await fetchHistoryFromBackend(rwy, param, currentHours, CHART_LINE_BIN), param);
        lastBins = bins;
        const ctx = canvas.getContext('2d');

        if (chartInstance) {
          chartInstance.destroy();
          chartInstance = null;
        }

        if (loadingMsg) loadingMsg.style.display = 'none';
        canvas.style.display = 'block';

        const isDarkMode = document.body.classList.contains('dark');
        const textColor = isDarkMode ? '#e0e8f0' : '#1a2a3a';
        const gridColor = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

        const labelMap = {
          'windDirection': 'Wind Direction', 'windSpeed': 'Wind Speed',
          'headwind': 'Head Wind', 'crosswind': 'Cross Wind',
          'rvr': 'RVR', 'mor': 'MOR', 'qnh': 'QNH', 'qfe': 'QFE',
          'temperature': 'Temperature', 'humidity': 'Humidity', 'dewPoint': 'Dew Point',
          'windSpeedGustMax': 'Wind Speed Gust (Max)', 'windSpeedGustMin': 'Wind Speed Gust (Min)'
        };
        const displayName = labelMap[param] || param.toUpperCase();

        const unitMap = {
          'windDirection': '°', 'windSpeed': 'kt', 'headwind': 'kt', 'crosswind': 'kt',
          'rvr': 'm', 'mor': 'm', 'qnh': 'hPa', 'qfe': 'hPa',
          'temperature': '°C', 'humidity': '%', 'dewPoint': '°C',
          'windSpeedGustMax': 'kt', 'windSpeedGustMin': 'kt'
        };
        const unit = unitMap[param] || '';
        const isCircular = (param === 'windDirection');

        const d = latestData[rwy];
        let currentVal = '—';
        if (d && (param === 'headwind' || param === 'crosswind')) {
          const wdNow = parseLeadingNumber(d['windDirection_instant_rounded']);
          const wsNow = parseLeadingNumber(d['windSpeed_instant_rounded']);
          const heading = RUNWAY_HEADING[rwy];
          if (wdNow !== null && wsNow !== null && heading !== undefined) {
            const angleRad = (wdNow - heading) * Math.PI / 180;
            const trig = param === 'headwind' ? Math.cos(angleRad) : Math.sin(angleRad);
            const v = Math.round(wsNow * trig * 10) / 10;
            currentVal = (v > 0 ? '+' : '') + v + (unit ? ' ' + unit : '');
          }
        } else if (d) {
          const fieldMap = {
            'windDirection': 'windDirection_instant_rounded',
            'windSpeed': 'windSpeed_instant_rounded',
            'rvr': 'pwd_rvr_avgOneMin',
            'mor': 'pwd_mor_avgOneMin',
            'qnh': 'qnh_instant_rounded',
            'qfe': 'qfe_instant_rounded',
            'temperature': 'temperature_instant_rounded',
            'humidity': 'humidity_instant_rounded',
            'dewPoint': 'dewPoint_instant_rounded'
          };
          const key = fieldMap[param];
          if (key && d[key] !== undefined) {
            const raw = d[key];
            const num = parseLeadingNumber(raw);
            if (num !== null && !isNaN(num)) {
              currentVal = num + (unit ? ' ' + unit : '');
            } else {
              currentVal = raw;
            }
          }
        }

        if (bins.length === 0) {
          const parent = canvas.parentElement;
          let noDataMsg = parent.querySelector('.no-data-msg');
          if (!noDataMsg) {
            noDataMsg = document.createElement('div');
            noDataMsg.className = 'no-data-msg';
            parent.appendChild(noDataMsg);
          }
          noDataMsg.textContent = `📊 History Not Available for "${displayName}"`;
          noDataMsg.style.display = 'flex';

          chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
              labels: ['No data'],
              datasets: [{ label: param, data: [null], borderColor: '#666', pointRadius: 0 }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: { enabled: false } },
              scales: { x: { display: false }, y: { display: false } }
            }
          });

          metaCurrent.textContent = currentVal;
          metaMin.textContent = '—';
          metaMax.textContent = '—';
          metaAvg.textContent = '—';
          if (gapNote) gapNote.classList.remove('show');
          isHistoryLoading = false;
          return;
        }

        const parent = canvas.parentElement;
        const oldMsg = parent.querySelector('.no-data-msg');
        if (oldMsg) oldMsg.remove();

        const points = bins.map(b => ({ x: toUtcDisplayMs(b.timestamp), y: b.value }));
        const counts = bins.map(b => b.count || 1);
        const values = bins.map(b => b.value);

        let minVal = '—', maxVal = '—', avgVal = '—';
        let minTimeStr = '', maxTimeStr = '';
        let usingFallbackAvg = false;

        if (!isCircular) {
          let minValRaw = null, maxValRaw = null, minTs = null, maxTs = null;
          let anyBinHasMinMax = false;

          bins.forEach(b => {
            const hasMin = (b.min !== undefined && b.min !== null);
            const hasMax = (b.max !== undefined && b.max !== null);

            if (hasMin || hasMax) anyBinHasMinMax = true;

            const bMin = hasMin ? b.min : b.value;
            const bMax = hasMax ? b.max : b.value;

            const bMinTs = (b.min_timestamp !== undefined && b.min_timestamp !== null)
                           ? b.min_timestamp : b.timestamp;
            const bMaxTs = (b.max_timestamp !== undefined && b.max_timestamp !== null)
                           ? b.max_timestamp : b.timestamp;

            if (minValRaw === null || bMin < minValRaw) {
              minValRaw = bMin;
              minTs = bMinTs;
            }
            if (maxValRaw === null || bMax > maxValRaw) {
              maxValRaw = bMax;
              maxTs = bMaxTs;
            }
          });

          if (!anyBinHasMinMax) {
            usingFallbackAvg = true;
          }

          const totalCount = counts.reduce((a, c) => a + c, 0);
          const weightedSum = bins.reduce((s, b, i) => s + b.value * counts[i], 0);
          const trueAvg = totalCount > 0
            ? weightedSum / totalCount
            : values.reduce((a, c) => a + c, 0) / values.length;

          const fmtUtc = (ts) => {
            if (ts === null || ts === undefined) return '';
            return new Date(ts * 1000).toISOString().slice(11, 16) + 'Z';
          };

          const fallbackNote = usingFallbackAvg ? ' ᵃ' : '';

          minVal = (minValRaw !== null ? Math.round(minValRaw * 10) / 10 : '—')
                   + (unit ? ' ' + unit : '') + fallbackNote;
          maxVal = (maxValRaw !== null ? Math.round(maxValRaw * 10) / 10 : '—')
                   + (unit ? ' ' + unit : '') + fallbackNote;
          avgVal = Math.round(trueAvg * 10) / 10 + (unit ? ' ' + unit : '');

          minTimeStr = minTs !== null ? fmtUtc(minTs) : '';
          maxTimeStr = maxTs !== null ? fmtUtc(maxTs) : '';

        } else {
          avgVal = values.length
            ? Math.round(values[values.length - 1] * 10) / 10 + '°'
            : '—';
        }

        metaCurrent.textContent = currentVal;
        metaMin.innerHTML = minTimeStr
          ? `${minVal}<span class="meta-time">@${minTimeStr}</span>`
          : minVal;
        metaMax.innerHTML = maxTimeStr
          ? `${maxVal}<span class="meta-time">@${maxTimeStr}</span>`
          : maxVal;
        metaAvg.textContent = avgVal;

        const nowSec = Date.now() / 1000;
        const lastTs = bins[bins.length - 1].timestamp;
        const staleMin = Math.round((nowSec - lastTs) / 60);
        if (gapNote) {
          if (usingFallbackAvg) {
            gapNote.textContent = `ᵃ Min/Max shown are bin averages.`;
            gapNote.classList.add('show');
          } else if (staleMin > Math.max(5, currentBin / 60)) {
            gapNote.textContent = `⚠ Last sample is ${staleMin} min old — check sensor/relay connectivity.`;
            gapNote.classList.add('show');
          } else {
            gapNote.classList.remove('show');
          }
        }

        const color = isDarkMode ? '#00e5ff' : '#1565c0';
        const thresholdCfg = THRESHOLDS[param];

        const HEAD_GREEN = '#00e676';
        const TAIL_RED = '#ff1744';
        const isHeadwindChart = (param === 'headwind');

        const datasets = [];
        datasets.push({
          label: displayName,
          data: points,
          borderColor: isHeadwindChart ? HEAD_GREEN : color,
          backgroundColor: color + '33',
          fill: isCircular,
          tension: 0.3,
          pointRadius: 3,
          segment: isHeadwindChart ? {
            borderColor: (ctx) => {
              const y0 = ctx.p0?.parsed?.y, y1 = ctx.p1?.parsed?.y;
              const avg = ((y0 ?? 0) + (y1 ?? 0)) / 2;
              return avg < 0 ? TAIL_RED : HEAD_GREEN;
            }
          } : undefined,
          pointBackgroundColor: (context) => {
            const v = context.parsed ? context.parsed.y : null;
            if (isHeadwindChart) {
              return (v !== null && v < 0) ? TAIL_RED : HEAD_GREEN;
            }
            return isBreach(thresholdCfg, v) ? '#ff3b3b' : color;
          },
          pointBorderColor: isDarkMode ? '#07111c' : '#ffffff',
          pointBorderWidth: 1.2,
          borderWidth: 2.5,
          order: 1,
          spanGaps: false
        });

        const referenceLinePlugin = {
          id: 'refLines',
          afterDraw(chart) {
            const { ctx: c, chartArea, scales } = chart;
            if (!chartArea || !scales.x || !scales.y) return;
            c.save();
            if (thresholdCfg) {
              const limits = thresholdCfg.useAbs ? [thresholdCfg.limit, -thresholdCfg.limit] : [thresholdCfg.limit];
              limits.forEach((lim, i) => {
                const y = scales.y.getPixelForValue(lim);
                if (y < chartArea.top || y > chartArea.bottom) return;
                c.strokeStyle = '#ff3b3b';
                c.lineWidth = 1.3;
                c.setLineDash([6, 4]);
                c.beginPath();
                c.moveTo(chartArea.left, y);
                c.lineTo(chartArea.right, y);
                c.stroke();
                c.setLineDash([]);
                if (i === 0) {
                  c.fillStyle = '#ff3b3b';
                  c.font = "600 10px Inter, sans-serif";
                  c.textAlign = 'right';
                  c.fillText(thresholdCfg.label, chartArea.right - 4, y - 4);
                }
              });
            }
            if (isHeadwindChart) {
              const y0 = scales.y.getPixelForValue(0);
              if (y0 >= chartArea.top && y0 <= chartArea.bottom) {
                c.strokeStyle = isDarkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';
                c.lineWidth = 1.2;
                c.setLineDash([5, 4]);
                c.beginPath();
                c.moveTo(chartArea.left, y0);
                c.lineTo(chartArea.right, y0);
                c.stroke();
                c.setLineDash([]);
                c.fillStyle = isDarkMode ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)';
                c.font = "600 10px Inter, sans-serif";
                c.textAlign = 'left';
                c.fillText('0  ·  head ↑ / tail ↓', chartArea.left + 4, y0 - 4);
              }
            }
            const nowX = scales.x.getPixelForValue(toUtcDisplayMs(Date.now() / 1000));
            if (nowX >= chartArea.left && nowX <= chartArea.right) {
              c.strokeStyle = isDarkMode ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
              c.lineWidth = 1;
              c.setLineDash([3, 3]);
              c.beginPath();
              c.moveTo(nowX, chartArea.top);
              c.lineTo(nowX, chartArea.bottom);
              c.stroke();
              c.setLineDash([]);
            }
            c.restore();
          }
        };

        chartInstance = new Chart(ctx, {
          type: 'line',
          data: { datasets },
          plugins: [referenceLinePlugin],
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                labels: {
                  color: textColor,
                  font: { family: 'Inter', weight: '600', size: 13 },
                  filter: (item) => item.text === displayName
                }
              },
              tooltip: {
                backgroundColor: isDarkMode ? 'rgba(7,17,28,0.92)' : 'rgba(255,255,255,0.92)',
                titleColor: textColor,
                bodyColor: textColor,
                borderColor: gridColor,
                borderWidth: 1,
                cornerRadius: 8,
                displayColors: false,
                filter: (item) => item.dataset.label === displayName,
                callbacks: {
                  title: () => [],
                  label: function(context) {
                    const val = context.parsed.y;
                    return `${val}${unit ? ' ' + unit : ''}`;
                  }
                }
              },
              zoom: {
                pan: { enabled: true, mode: 'x', onPanComplete: () => pauseLiveOnInteraction() },
                zoom: {
                  wheel: { enabled: true },
                  pinch: { enabled: true },
                  drag: { enabled: false },
                  mode: 'x',
                  onZoomComplete: () => pauseLiveOnInteraction()
                },
                limits: { x: { min: 'original', max: 'original' } }
              }
            },
            scales: {
              x: {
                type: 'time',
                min: toUtcDisplayMs(nowSec - currentHours * 3600),
                max: toUtcDisplayMs(nowSec),
                time: {
                  tooltipFormat: 'dd MMM HH:mm',
                  displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'dd MMM' }
                },
                grid: { color: gridColor, drawBorder: false },
                ticks: { 
                  color: textColor, 
                  font: { family: 'Inter', size: 10 },
                  maxTicksLimit: 20,
                  autoSkip: true
                },
                title: { 
                  display: true, 
                  text: `Time (UTC - last ${currentHours} hours)`, 
                  color: textColor,
                  font: { family: 'Inter', size: 11 } 
                }
              },
              y: {
                min: Y_AXIS_LIMITS[param] ? Y_AXIS_LIMITS[param].min : undefined,
                max: Y_AXIS_LIMITS[param] ? Y_AXIS_LIMITS[param].max : undefined,
                grid: { color: gridColor, drawBorder: false },
                ticks: { color: textColor, font: { family: 'Inter', size: 10 } },
                title: { display: true, text: unit ? unit : '', color: textColor,
                font: { family: 'Inter', size: 11 } }
              }
            },
            interaction: {
              intersect: false,
              mode: 'index'
            }
          }
        });

        lastChartMeta = { bins, param, displayName, unit, isCircular, thresholdCfg, currentHours, currentBin, nowSec };

      } catch (err) {
        console.error('Chart rendering error:', err);
        const loadingMsg = chartContainer.querySelector('.loading-msg');
        if (loadingMsg) {
          loadingMsg.innerHTML = '❌ Error loading history: ' + err.message;
          loadingMsg.style.display = 'flex';
        }
      }

      isHistoryLoading = false;
    }

    // ═══════════════════════════════════════════════════════════════
    //  TREND DASHBOARD VIEW (1H multi-chart grid, both runways)
    // ═══════════════════════════════════════════════════════════════
    const TREND_PARAMS = ['windDirection', 'windSpeed', 'rvr', 'qnh', 'temperature'];
    const TREND_HOURS = 1;
    const TREND_BIN = 60; // 1-min bins for a 1H window
    const trendCharts = {}; // key `${rwy}-${param}` -> Chart instance
    let trendViewActive = false;
    let trendRefreshInterval = null;
    let trendRenderInFlight = false;

    const TREND_LABEL_MAP = {
      windDirection: 'Wind Direction', windSpeed: 'Wind Speed',
      rvr: 'RVR', qnh: 'QNH', temperature: 'Temperature'
    };
    const TREND_UNIT_MAP = {
      windDirection: '°', windSpeed: 'kt', rvr: 'm', qnh: 'hPa', temperature: '°C'
    };
    const TREND_COLOR_MAP = {
      light: {
        windDirection: '#1565c0',
        windSpeed:     '#00897b',
        rvr:            '#e65100',
        qnh:            '#6a1b9a',
        temperature:    '#c62828'
      },
      dark: {
        windDirection: '#42a5f5',
        windSpeed:     '#26d9c4',
        rvr:            '#ffb74d',
        qnh:            '#ba68c8',
        temperature:    '#ff7043'
      }
    };

    async function buildTrendChart(rwy, param) {
      const key = `${rwy}-${param}`;
      const canvas = document.getElementById(`trend-${rwy}-${param}`);
      if (!canvas) return;

      let bins;
      try {
        bins = clampNonNegativeBins(await fetchHistoryFromBackend(rwy, param, TREND_HOURS, TREND_BIN), param);
      } catch (err) {
        console.error('Trend fetch error:', key, err);
        bins = [];
      }

      const isDarkMode = document.body.classList.contains('dark');
      const textColor = isDarkMode ? '#e0e8f0' : '#1a2a3a';
      const gridColor = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
      const color = TREND_COLOR_MAP[isDarkMode ? 'dark' : 'light'][param] || (isDarkMode ? '#00e5ff' : '#1565c0');
      const displayName = TREND_LABEL_MAP[param];
      const unit = TREND_UNIT_MAP[param];
      const isCircular = (param === 'windDirection');
      const thresholdCfg = THRESHOLDS[param];
      const nowSec = Date.now() / 1000;

      const points = bins.map(b => ({ x: toUtcDisplayMs(b.timestamp), y: b.value }));

      const existing = trendCharts[key];
      if (existing) {
        existing.data.datasets[0].data = points;
        existing.options.scales.x.min = toUtcDisplayMs(nowSec - TREND_HOURS * 3600);
        existing.options.scales.x.max = toUtcDisplayMs(nowSec);
        existing.update('none');
        return;
      }

      const refLinePlugin = {
        id: `refLines-${key}`,
        afterDraw(chart) {
          const { ctx: c, chartArea, scales } = chart;
          if (!chartArea || !scales.x || !scales.y || !thresholdCfg) return;
          c.save();
          const limits = thresholdCfg.useAbs ? [thresholdCfg.limit, -thresholdCfg.limit] : [thresholdCfg.limit];
          limits.forEach(lim => {
            const y = scales.y.getPixelForValue(lim);
            if (y < chartArea.top || y > chartArea.bottom) return;
            c.strokeStyle = '#ff3b3b';
            c.lineWidth = 1;
            c.setLineDash([5, 3]);
            c.beginPath();
            c.moveTo(chartArea.left, y);
            c.lineTo(chartArea.right, y);
            c.stroke();
            c.setLineDash([]);
          });
          c.restore();
        }
      };

      const ctx = canvas.getContext('2d');
      trendCharts[key] = new Chart(ctx, {
        type: 'line',
        data: {
          datasets: [{
            label: displayName,
            data: points,
            borderColor: color,
            backgroundColor: color + '33',
            fill: isCircular,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 3,
            borderWidth: 1.8,
            spanGaps: false
          }]
        },
        plugins: [refLinePlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: {
              display: true,
              labels: { color: textColor, font: { family: 'Inter', weight: '700', size: 10 }, boxWidth: 8, boxHeight:8, padding:4 }
            },
            tooltip: {
              backgroundColor: isDarkMode ? 'rgba(7,17,28,0.92)' : 'rgba(255,255,255,0.92)',
              titleColor: textColor, bodyColor: textColor,
              borderColor: gridColor, borderWidth: 1, cornerRadius: 6, displayColors: false,
              callbacks: { label: (c) => `${c.parsed.y}${unit ? ' ' + unit : ''}` }
            },
            zoom: {
              pan: { enabled: true, mode: 'x' },
              zoom: { wheel: { enabled: true }, pinch: { enabled: true }, drag: { enabled: false }, mode: 'x' },
              limits: { x: { min: 'original', max: 'original' } }
            }
          },
          scales: {
            x: {
              type: 'time',
              min: toUtcDisplayMs(nowSec - TREND_HOURS * 3600),
              max: toUtcDisplayMs(nowSec),
              time: { displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } },
              grid: { color: gridColor, drawBorder: false },
              ticks: { color: textColor, font: { family: 'Inter', size: 9 }, maxTicksLimit: 6, autoSkip: true }
            },
            y: {
              min: Y_AXIS_LIMITS[param] ? Y_AXIS_LIMITS[param].min : undefined,
              max: Y_AXIS_LIMITS[param] ? Y_AXIS_LIMITS[param].max : undefined,
              grid: { color: gridColor, drawBorder: false },
              ticks: { color: textColor, font: { family: 'Inter', size: 9 }, maxTicksLimit: 4 }
            }
          },
          interaction: { intersect: false, mode: 'index' }
        }
      });
    }

    async function renderAllTrendCharts() {
      if (trendRenderInFlight) return;
      trendRenderInFlight = true;
      try {
        const jobs = [];
        ['28', '10'].forEach(rwy => {
          TREND_PARAMS.forEach(param => jobs.push(buildTrendChart(rwy, param)));
        });
        await Promise.all(jobs);
      } finally {
        trendRenderInFlight = false;
      }
    }

    function destroyAllTrendCharts() {
      Object.keys(trendCharts).forEach(key => {
        if (trendCharts[key]) trendCharts[key].destroy();
        delete trendCharts[key];
      });
    }

    function startTrendAutoRefresh() {
      stopTrendAutoRefresh();
      trendRefreshInterval = setInterval(renderAllTrendCharts, 10000);
    }

    function stopTrendAutoRefresh() {
      if (trendRefreshInterval) {
        clearInterval(trendRefreshInterval);
        trendRefreshInterval = null;
      }
    }

    window.toggleTrendView = async function() {
      trendViewActive = !trendViewActive;
      document.body.classList.toggle('trend-mode', trendViewActive);
      const btn = document.getElementById('trend-toggle-btn');
      if (btn) {
        btn.classList.toggle('active', trendViewActive);
        btn.title = trendViewActive ? 'Back to Live View' : 'Trend Dashboard (1H graphs)';
      }

      if (trendViewActive) {
        await renderAllTrendCharts();
        startTrendAutoRefresh();
      } else {
        stopTrendAutoRefresh();
        destroyAllTrendCharts();
      }
    };

    // ═══════════════════════════════════════════════════════════════
    //  MODAL CONTROLS
    // ═══════════════════════════════════════════════════════════════
    async function openHistory(param, rwy) {
      if (isHistoryLoading) return;
      modalParam = param;
      modalRwy = rwy;
      liveMode = true;
      setLiveButtonUI();
      gustViewActive = false;

      const gustBtn = document.getElementById('gustToggleBtn');
      if (gustBtn) {
        gustBtn.style.display = (param === 'windSpeed') ? 'inline-block' : 'none';
        gustBtn.classList.remove('live-on');
        gustBtn.textContent = '💨 Gust History';
      }

      const labelMap = {
        'windDirection': 'Wind Direction', 'windSpeed': 'Wind Speed',
        'headwind': 'Head Wind', 'crosswind': 'Cross Wind',
        'rvr': 'RVR', 'mor': 'MOR', 'qnh': 'QNH', 'qfe': 'QFE',
        'temperature': 'Temperature', 'humidity': 'Humidity', 'dewPoint': 'Dew Point'
      };
      const displayName = labelMap[param] || param;
      
      modalTitle.innerHTML =
        `${displayName} <small>Runway ${rwy} · ${currentHours}H trend</small>`;

      metaCurrent.textContent = '⏳';
      metaMin.textContent = '⏳';
      metaMax.textContent = '⏳';
      metaAvg.textContent = '⏳';

      modal.classList.add('active');
      await new Promise(resolve => setTimeout(resolve, 100));
      await renderHistoryChart(param, rwy);
      startModalAutoRefresh();
    }

    window.closeHistory = function() {
      modal.classList.remove('active');
      stopModalAutoRefresh();
      if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
      }
      modalParam = null;
      modalRwy = null;
      isHistoryLoading = false;
      gustViewActive = false;
    };

    function setLiveButtonUI() {
      const btn = document.getElementById('liveToggleBtn');
      if (!btn) return;
      btn.classList.toggle('live-on', liveMode);
      btn.classList.toggle('live-off', !liveMode);
      btn.textContent = liveMode ? '🔴 LIVE (30s)' : '⏸ PAUSED';
    }

    function startModalAutoRefresh() {
      stopModalAutoRefresh();
      if (!liveMode) return;
      modalRefreshInterval = setInterval(() => {
        if (modalParam && modalRwy) renderHistoryChart(displayParam(), modalRwy);
      }, 30000);
    }

    function stopModalAutoRefresh() {
      if (modalRefreshInterval) {
        clearInterval(modalRefreshInterval);
        modalRefreshInterval = null;
      }
    }

    function pauseLiveOnInteraction() {
      userHasZoomed = true;
      if (liveMode) {
        liveMode = false;
        setLiveButtonUI();
        stopModalAutoRefresh();
      }
    }

    window.toggleLiveMode = function() {
      liveMode = !liveMode;
      setLiveButtonUI();
      if (liveMode) {
        userHasZoomed = false;
        renderHistoryChart(displayParam(), modalRwy).then(startModalAutoRefresh);
      } else {
        stopModalAutoRefresh();
      }
    };

    // Tracks what's actually rendered in the chart right now. Usually this
    // is just modalParam, but toggling "Gust History" swaps in the gust
    // param temporarily without disturbing modalParam (which the modal
    // title / range buttons / live-mode refresh all key off of).
    function displayParam() {
      return gustViewActive ? 'windSpeedGustMax' : modalParam;
    }

    window.toggleGustView = function() {
      if (modalParam !== 'windSpeed') return; // button is hidden otherwise, but guard anyway
      gustViewActive = !gustViewActive;

      const gustBtn = document.getElementById('gustToggleBtn');
      if (gustBtn) {
        gustBtn.classList.toggle('live-on', gustViewActive);
        gustBtn.textContent = gustViewActive ? '💨 Gust History (ON)' : '💨 Gust History';
      }

      renderHistoryChart(displayParam(), modalRwy);
    };

    window.resetChartZoom = function() {
      if (chartInstance && chartInstance.resetZoom) chartInstance.resetZoom();
    };

    function buildExportChartConfig(meta) {
      const textColor = '#1a2a3a';
      const gridColor = 'rgba(0,0,0,0.10)';
      const lineColor = '#1565c0';

      const points = meta.bins.map(b => ({ x: toUtcDisplayMs(b.timestamp), y: b.value }));

      const whiteBgPlugin = {
        id: 'whiteBg',
        beforeDraw(chart) {
          const { ctx, width, height } = chart;
          ctx.save();
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        }
      };

      const isHeadwindChart = (meta.param === 'headwind');
      const HEAD_GREEN = '#00a854';
      const TAIL_RED = '#c62828';

      const referenceLinePlugin = {
        id: 'refLinesExport',
        afterDraw(chart) {
          const { ctx: c, chartArea, scales } = chart;
          if (!chartArea || !scales.x || !scales.y) return;
          c.save();
          if (meta.thresholdCfg) {
            const limits = meta.thresholdCfg.useAbs ? [meta.thresholdCfg.limit, -meta.thresholdCfg.limit] : [meta.thresholdCfg.limit];
            limits.forEach((lim, i) => {
              const y = scales.y.getPixelForValue(lim);
              if (y < chartArea.top || y > chartArea.bottom) return;
              c.strokeStyle = '#c62828';
              c.lineWidth = 1.3;
              c.setLineDash([6, 4]);
              c.beginPath();
              c.moveTo(chartArea.left, y);
              c.lineTo(chartArea.right, y);
              c.stroke();
              c.setLineDash([]);
              if (i === 0) {
                c.fillStyle = '#c62828';
                c.font = "600 10px Inter, sans-serif";
                c.textAlign = 'right';
                c.fillText(meta.thresholdCfg.label, chartArea.right - 4, y - 4);
              }
            });
          }
          if (isHeadwindChart) {
            const y0 = scales.y.getPixelForValue(0);
            if (y0 >= chartArea.top && y0 <= chartArea.bottom) {
              c.strokeStyle = 'rgba(0,0,0,0.45)';
              c.lineWidth = 1.2;
              c.setLineDash([5, 4]);
              c.beginPath();
              c.moveTo(chartArea.left, y0);
              c.lineTo(chartArea.right, y0);
              c.stroke();
              c.setLineDash([]);
              c.fillStyle = 'rgba(0,0,0,0.6)';
              c.font = "600 10px Inter, sans-serif";
              c.textAlign = 'left';
              c.fillText('0  ·  head ↑ / tail ↓', chartArea.left + 4, y0 - 4);
            }
          }
          c.restore();
        }
      };

      const yLimit = Y_AXIS_LIMITS[meta.param];

      return {
        type: 'line',
        data: {
          datasets: [{
            label: meta.displayName,
            data: points,
            borderColor: isHeadwindChart ? HEAD_GREEN : lineColor,
            backgroundColor: lineColor + '33',
            fill: meta.isCircular,
            tension: 0.3,
            pointRadius: 3,
            segment: isHeadwindChart ? {
              borderColor: (ctx) => {
                const y0 = ctx.p0?.parsed?.y, y1 = ctx.p1?.parsed?.y;
                const avg = ((y0 ?? 0) + (y1 ?? 0)) / 2;
                return avg < 0 ? TAIL_RED : HEAD_GREEN;
              }
            } : undefined,
            pointBackgroundColor: (context) => {
              const v = context.parsed ? context.parsed.y : null;
              if (isHeadwindChart) {
                return (v !== null && v < 0) ? TAIL_RED : HEAD_GREEN;
              }
              return isBreach(meta.thresholdCfg, v) ? '#c62828' : lineColor;
            },
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1.2,
            borderWidth: 2.5,
            spanGaps: false
          }]
        },
        plugins: [whiteBgPlugin, referenceLinePlugin],
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: { labels: { color: textColor, font: { family: 'Inter', weight: '600', size: 13 } } },
            tooltip: { enabled: false }
          },
          scales: {
            x: {
              type: 'time',
              min: toUtcDisplayMs(meta.nowSec - meta.currentHours * 3600),
              max: toUtcDisplayMs(meta.nowSec),
              time: { displayFormats: { minute: 'HH:mm', hour: 'HH:mm', day: 'dd MMM' } },
              grid: { color: gridColor, drawBorder: false },
              ticks: { color: textColor, font: { family: 'Inter', size: 10 }, maxTicksLimit: 20, autoSkip: true },
              title: { display: true, text: `Time (UTC - last ${meta.currentHours} hours)`, color: textColor, font: { family: 'Inter', size: 11 } }
            },
            y: {
              min: yLimit ? yLimit.min : undefined,
              max: yLimit ? yLimit.max : undefined,
              grid: { color: gridColor, drawBorder: false },
              ticks: { color: textColor, font: { family: 'Inter', size: 10 } },
              title: { display: true, text: meta.unit || '', color: textColor, font: { family: 'Inter', size: 11 } }
            }
          }
        }
      };
    }

    window.exportChartPNG = function() {
      if (!lastChartMeta || !lastChartMeta.bins || lastChartMeta.bins.length === 0) return;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = 1200;
      tempCanvas.height = 600;
      const ctx = tempCanvas.getContext('2d');

      const config = buildExportChartConfig(lastChartMeta);
      const tempChart = new Chart(ctx, config);

      const url = tempChart.toBase64Image('image/png', 1.0);
      const a = document.createElement('a');
      a.href = url;
      a.download = `VOGA_${modalRwy}_${modalParam}_${Date.now()}.png`;
      a.click();

      tempChart.destroy();
    };

    window.exportChartCSV = function() {
      if (!lastBins || lastBins.length === 0) return;
      const rows = [['timestamp_utc', 'value', 'min', 'max', 'sample_count']];
      lastBins.forEach(b => {
        const iso = new Date(b.timestamp * 1000).toISOString();
        rows.push([iso, b.value, (b.min ?? ''), (b.max ?? ''), (b.count ?? '')]);
      });
      const csv = rows.map(r => r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `VOGA_${modalRwy}_${modalParam}_history.csv`;
      a.click();
      URL.revokeObjectURL(url);
    };

    window.exportChartPDF = async function() {
      if (!lastBins || lastBins.length === 0) return;
      const btn = document.getElementById('chartPdfBtn');
      const btnOrigText = btn ? btn.textContent : '';
      if (btn) { btn.textContent = '⏳ Generating…'; btn.disabled = true; }

      function loadScript(src) {
        return new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }

      try {
        if (!window.jspdf) {
          await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        }
        const { jsPDF } = window.jspdf;

        const meta = lastChartMeta || {};
        const paramName = meta.displayName || modalParam || 'Parameter';
        const unit = meta.unit || '';
        const rwyLabel = modalRwy ? `Runway ${modalRwy}` : '';
        const hoursLabel = meta.currentHours ? `Last ${meta.currentHours} Hours` : '';

        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = 12;
        const usableW = pageW - margin * 2;

        // Column layout: Date | Time (UTC) | Value | Min | Max
        const colHeaders = ['Date', 'Time (UTC)', `Value${unit ? ' (' + unit + ')' : ''}`, 'Min', 'Max'];
        const colWidths = [34, 30, 42, 40, 40]; // sums to 186 = usableW at 12mm margins on A4
        const colX = [margin];
        for (let i = 0; i < colWidths.length - 1; i++) colX.push(colX[i] + colWidths[i]);

        const rowH = 7;
        const headRowH = 8.5;
        const footerH = 10;

        function drawTopBand() {
          doc.setFillColor(21, 101, 192); // blue
          doc.rect(0, 0, pageW, 24, 'F');
          doc.setFillColor(0, 105, 92); // teal accent strip
          doc.rect(0, 24, pageW, 2, 'F');

          doc.setTextColor(255, 255, 255);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(15);
          doc.text('VOGA/MOPA DCWIS', margin, 11);
          doc.setFontSize(11);
          doc.setFont('helvetica', 'normal');
          doc.text(`${paramName}${unit ? ' (' + unit + ')' : ''} — History` + (rwyLabel ? ` · ${rwyLabel}` : ''), margin, 18);

          doc.setFontSize(9);
          doc.setTextColor(230, 240, 255);
          const genStr = new Date().toUTCString().replace('GMT', 'UTC');
          doc.text(hoursLabel, pageW - margin, 11, { align: 'right' });
          doc.text(genStr, pageW - margin, 18, { align: 'right' });
        }

        function drawHeaderRow(y) {
          doc.setFillColor(21, 101, 192);
          doc.rect(margin, y, usableW, headRowH, 'F');
          doc.setTextColor(255, 255, 255);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9.5);
          colHeaders.forEach((h, i) => {
            doc.text(h, colX[i] + colWidths[i] / 2, y + headRowH / 2 + 1.2, { align: 'center' });
          });
          return y + headRowH;
        }

        function drawFooter() {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(140, 140, 140);
          doc.text('VOGA/MOPA DCWIS — Auto-generated report', margin, pageH - 6);
        }

        function fmt(v) { return (v === undefined || v === null || v === '') ? '—' : String(v); }

        drawTopBand();
        let y = drawHeaderRow(30);
        let rowIndex = 0;

        lastBins.forEach(b => {
          if (y + rowH > pageH - margin - footerH) {
            drawFooter();
            doc.addPage();
            y = drawHeaderRow(margin);
            rowIndex = 0;
          }

          const d = new Date(b.timestamp * 1000);
          const dateStr = d.toISOString().slice(0, 10);
          const timeStr = d.toISOString().slice(11, 16) + 'Z';
          const cells = [dateStr, timeStr, fmt(b.value), fmt(b.min), fmt(b.max)];

          // Alternating row background
          doc.setFillColor(rowIndex % 2 === 0 ? 255 : 232, rowIndex % 2 === 0 ? 255 : 240, rowIndex % 2 === 0 ? 255 : 254);
          doc.rect(margin, y, usableW, rowH, 'F');

          // Cell borders
          doc.setDrawColor(200, 210, 225);
          doc.setLineWidth(0.15);
          doc.rect(margin, y, usableW, rowH, 'S');
          for (let i = 1; i < colX.length; i++) {
            doc.line(colX[i], y, colX[i], y + rowH);
          }

          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          const textCellColors = [
            [40, 40, 40],   // date
            [40, 40, 40],   // time
            [21, 101, 192], // value - blue
            [1, 87, 155],   // min - dark blue
            [198, 40, 40]   // max - red
          ];
          cells.forEach((c, i) => {
            doc.setTextColor(textCellColors[i][0], textCellColors[i][1], textCellColors[i][2]);
            if (i >= 2) doc.setFont('helvetica', 'bold'); else doc.setFont('helvetica', 'normal');
            doc.text(c, colX[i] + colWidths[i] / 2, y + rowH / 2 + 1.1, { align: 'center' });
          });

          y += rowH;
          rowIndex++;
        });

        drawFooter();

        // ── Page numbers: stamp after all pages exist (safe, avoids
        // relying on any "current page" API during generation) ──────
        const totalPages = doc.internal.getNumberOfPages();
        for (let p = 1; p <= totalPages; p++) {
          doc.setPage(p);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(140, 140, 140);
          doc.text(`Page ${p} of ${totalPages}`, pageW - margin, pageH - 6, { align: 'right' });
        }

        const fname = `VOGA_${modalRwy || ''}_${modalParam || 'param'}_history_${Date.now()}.pdf`;
        doc.save(fname);

      } catch (err) {
        console.error('Chart PDF generation failed:', err);
        alert('PDF generation failed: ' + (err && err.message ? err.message : String(err)));
      } finally {
        if (btn) { btn.textContent = btnOrigText || '📕 PDF'; btn.disabled = false; }
      }
    };

    function setupClickHandlers() {
      document.querySelectorAll('.dc[data-param], .wbox[data-param]').forEach(el => {
        el.addEventListener('click', function(e) {
          const param = this.dataset.param;
          const rwy = this.dataset.rwy;
          if (param && rwy) {
            openHistory(param, rwy);
          }
        });
      });
    }

    // ═══════════════════════════════════════════════════════════════
    //  FETCH DATA
    // ═══════════════════════════════════════════════════════════════
    let consecutiveFetchFailures = 0;
    const OFFLINE_AFTER_N_FAILURES = 3;

    function setLiveStatus(){
      consecutiveFetchFailures = 0;
      const el = document.getElementById('status');
      if(!el) return;
      el.textContent = '⬤ LIVE';
      el.style.borderColor = '#00cc66';
      el.style.color = '#00ff88';
    }

    function setOfflineStatus(){
      const el = document.getElementById('status');
      if(!el) return;
      el.textContent = '⚠ OFFLINE';
      el.style.borderColor = '#ff4444';
      el.style.color = '#ff4444';
    }

    function fetchData(){
      fetch(`${API_BASE}${DATA_ENDPOINT}`)
        .then(res => {
          if(!res.ok) throw new Error('HTTP '+res.status);
          return res.json();
        })
        .then(data => {
          if(data['10']) {
            latestData['10'] = data['10'];
            renderPanel('10');
          }
          if(data['28']) {
            latestData['28'] = data['28'];
            renderPanel('28');
          }
          setLiveStatus();
          setTimeout(resizeLayout, 50);
        })
        .catch(err => {
          console.error('Fetch error:', err);
          consecutiveFetchFailures++;
          if(consecutiveFetchFailures >= OFFLINE_AFTER_N_FAILURES) setOfflineStatus();
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  START
    // ═══════════════════════════════════════════════════════════════
    function startAutoRefresh(){
      if(autoRefreshInterval) clearInterval(autoRefreshInterval);
      autoRefreshInterval = setInterval(fetchData, POLL_INTERVAL_MS);
      if(metarInterval) clearInterval(metarInterval);
      metarInterval = setInterval(fetchMETAR, 120000);
      setTimeout(fetchMETAR, 500);
    }

    window.addEventListener('load', ()=>{
      // Visual draw loops go first and are defensively isolated — a failure
      // anywhere else in this bootstrap must never be able to prevent the
      // wind-particle / weather-fx canvases from starting to render.
      try { startWindParticleLoop(); } catch(e) { console.error('startWindParticleLoop failed:', e); }
      try { startWeatherFxLoop(); } catch(e) { console.error('startWeatherFxLoop failed:', e); }

      isDark = (S.theme !== 'light');
      document.body.classList.toggle('dark', isDark);
      try { initSettings(); } catch(e) { console.error('initSettings failed:', e); }
      
      resizeLayout();
      window.addEventListener('resize', resizeLayout);
      // Rotating the phone changes width/height at slightly different
      // times across browsers, so give layout a moment to settle before
      // re-measuring; also listen on visualViewport for the case where
      // the mobile URL bar/keyboard shows or hides without a resize event.
      window.addEventListener('orientationchange', ()=> setTimeout(resizeLayout, 200));
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', resizeLayout);
      }
      setupClickHandlers();
      fetchData();
      startAutoRefresh();

      try { registerServiceWorker(); } catch(e) { console.error('registerServiceWorker failed:', e); }
      try { updateNotifBtnUI(); } catch(e) { console.error('updateNotifBtnUI failed:', e); }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeHistory(); closeArchive(); closeRadarModal(); closeFlightInfo(); closeSettings(); }
      });
      modal.addEventListener('click', function(e) {
        if (e.target === this) closeHistory();
      });

      document.getElementById('status').textContent = '⬤ LIVE';
      document.getElementById('status').style.borderColor = '#00cc66';
      document.getElementById('status').style.color = '#00ff88';
      consecutiveFetchFailures = 0;
    });


    // ═══════════════════════════════════════════════════════════════
    //  FEATURE 1 — ALERT / THRESHOLD NOTIFICATION SYSTEM
    // ═══════════════════════════════════════════════════════════════
    const alertOverlay = document.getElementById('alertOverlay');
    const alertBanner  = document.getElementById('alertBanner');

    // Audio context for beep alerts
    let audioCtx = null;
    function getAudioCtx() {
      if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
      }
      return audioCtx;
    }
    function playAlert(freq, duration, type) {
      const ctx = getAudioCtx();
      if (!ctx) return;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + duration);
      } catch(e) {}
    }
    function playAlertSequence(level) {
      if (!S.sound) return;
      if (level === 'critical') {
        // Two short high beeps
        playAlert(880, 0.22, 'square');
        setTimeout(() => playAlert(880, 0.22, 'square'), 350);
      } else {
        playAlert(660, 0.3, 'sine');
      }
    }

    // ═══════════════════════════════════════════════════════════════
    //  PWA INSTALL + NATIVE ALERT NOTIFICATIONS (no backend involved)
    //
    //  Two independent pieces:
    //  1. Service worker registration → makes the dashboard installable
    //     (Add to Home Screen / desktop install icon) and caches only
    //     the static app shell (see service-worker.js — it explicitly
    //     never touches live data requests).
    //  2. Native OS notifications fired directly from THIS page whenever
    //     checkAlerts() detects a new threshold breach, using the same
    //     data this tab already polls every second. This works while the
    //     tab/installed app is open (foreground or backgrounded) with no
    //     push server. It cannot wake up a fully-closed app — that would
    //     require a real Web Push backend, which is out of scope here.
    // ═══════════════════════════════════════════════════════════════
    let swRegistration = null;
    let notificationsEnabled = S.notif;

    function registerServiceWorker(){
      if(!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.register('service-worker.js')
        .then(reg => { swRegistration = reg; updateNotifBtnUI(); })
        .catch(err => console.error('Service worker registration failed:', err));
    }

    function updateNotifBtnUI(){ syncSettingsUI(); }

    async function sendBrowserNotification(title, body, tag){
      if(!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
      const options = {
        body,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: tag || 'dcwis-alert',
        renotify: true,
        vibrate: [200,100,200]
      };
      try {
        if(swRegistration){
          swRegistration.showNotification(title, options);
        } else {
          new Notification(title, options);
        }
      } catch(e){ console.error('Notification failed:', e); }
    }


    // Alert state tracking
    const alertStates = {};
    let alertDismissed = false;
    let alertDismissTimer = null;

    const ALERT_DEFS = [
      { id: 'cw28',  label: 'RWY 28 CROSSWIND', rwy: '28', type: 'crosswind',   limit: 15, dir: 'above', useAbs: true,  level: 'critical' },
      { id: 'cw10',  label: 'RWY 10 CROSSWIND', rwy: '10', type: 'crosswind',   limit: 15, dir: 'above', useAbs: true,  level: 'critical' },
      { id: 'rvr28', label: 'RWY 28 RVR',       rwy: '28', type: 'rvr',        limit: 550, dir: 'below', useAbs: false, level: 'critical', borderAlert: false },
      { id: 'rvr10', label: 'RWY 10 RVR',       rwy: '10', type: 'rvr',        limit: 550, dir: 'below', useAbs: false, level: 'critical', borderAlert: false },
      { id: 'ws28',  label: 'RWY 28 WIND SPEED',rwy: '28', type: 'windSpeed',  limit: 25,  dir: 'above', useAbs: false, level: 'warn' },
      { id: 'ws10',  label: 'RWY 10 WIND SPEED',rwy: '10', type: 'windSpeed',  limit: 25,  dir: 'above', useAbs: false, level: 'warn' },
    ];


    // ═══════════════════════════════════════════════════════════════
    //  SETTINGS — thresholds, popup UI, apply/reset
    // ═══════════════════════════════════════════════════════════════
    function applyThresholds(){
      THRESHOLDS.crosswind.limit = S.cw;
      THRESHOLDS.crosswind.label = S.cw + 'kt crosswind limit';
      THRESHOLDS.rvr.limit = S.rvr;
      THRESHOLDS.rvr.label = S.rvr === 550 ? 'CAT I RVR min (550m)' : 'RVR alert limit (' + S.rvr + 'm)';
      ALERT_DEFS.forEach(d => {
        if (d.type === 'crosswind') d.limit = S.cw;
        else if (d.type === 'rvr') d.limit = S.rvr;
        else if (d.type === 'windSpeed') d.limit = S.ws;
      });
    }
    applyThresholds();

    function refreshThresholdViews(){
      applyThresholds();
      if (modal.classList.contains('active') && modalParam) renderHistoryChart(modalParam, modalRwy);
      if (trendViewActive) { destroyAllTrendCharts(); renderAllTrendCharts(); }
      checkAlerts();
    }

    function applyWxAnim(){
      const c = document.getElementById('weatherFxCanvas');
      if (S.wxAnim) { startWeatherFxLoop(); if (c) c.classList.toggle('wfx-active', currentWeatherFx.type !== 'none'); }
      else if (c) c.classList.remove('wfx-active');
    }
    function applyParticles(){ if (S.windParticles) startWindParticleLoop(); }

    function notifStatus(){
      if (!('Notification' in window)) return ['Not supported in this browser', 'bad'];
      if (!S.notif) return ['OFF', 'off'];
      const p = Notification.permission;
      if (p === 'granted') return ['✔ Active: native alert on every new threshold breach', 'ok'];
      if (p === 'denied')  return ['✖ Blocked by browser: allow notifications in site settings', 'bad'];
      return ['⏳ Permission pending: tap anywhere on the page to allow', 'warn'];
    }

    function syncSettingsUI(){
      const $ = id => document.getElementById(id);
      if (!$('settingsModal')) return;
      $('set-theme').checked = (S.theme === 'dark');
      $('set-wx').checked = S.wxAnim;
      $('set-particles').checked = S.windParticles;
      $('set-notif').checked = S.notif;
      $('set-sound').checked = S.sound;
      let custom = false;
      Object.keys(SET_LIMITS).forEach(k => {
        const inp = $('set-' + k);
        if (document.activeElement !== inp) inp.value = S[k];
        const mod = S[k] !== DEFAULT_SETTINGS[k];
        inp.classList.toggle('modified', mod);
        custom = custom || mod;
      });
      $('set-custom-note').style.display = custom ? 'block' : 'none';
      const b = $('settings-btn'); if (b) b.classList.toggle('custom', custom);
      const [txt, cls] = notifStatus();
      const st = $('set-notif-status'); st.textContent = txt; st.className = 'set-status st-' + cls;
    }

    function applyAllSettings(){
      if ((S.theme !== 'light') !== isDark) window.toggleTheme();
      applyWxAnim(); applyParticles();
      notificationsEnabled = S.notif;
      refreshThresholdViews();
      syncSettingsUI();
    }

    window.setNotifPref = async function(on){
      S.notif = on; notificationsEnabled = on;
      if (on && 'Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch(e) {}
      }
      saveSettings(); syncSettingsUI();
    };

    window.testAlert = function(){
      if (S.sound) playAlertSequence('critical');
      if (('Notification' in window) && Notification.permission === 'granted' && S.notif) {
        sendBrowserNotification('VOGA-MOPA DCWIS', 'Test alert: notifications are working.', 'dcwis-test');
      } else {
        alert('Notification is OFF or not allowed. Sound test only.');
      }
    };

    window.resetSettings = function(scope){
      const limitsOnly = (scope === 'limits');
      const msg = limitsOnly ? 'Reset alert thresholds to defaults?\n(CW 15 kt · RVR 550 m · WS 25 kt)'
                             : 'Reset ALL settings to defaults?\n(Dark · animation OFF · notifications ON · default thresholds)';
      if (!confirm(msg)) return;
      if (limitsOnly) ['cw','rvr','ws'].forEach(k => S[k] = DEFAULT_SETTINGS[k]);
      else Object.assign(S, DEFAULT_SETTINGS);
      saveSettings(); applyAllSettings();
    };

    window.openSettings = function(){ syncSettingsUI(); document.getElementById('settingsModal').classList.add('active'); };
    window.closeSettings = function(){ const m = document.getElementById('settingsModal'); if (m) m.classList.remove('active'); };

    function buildSettingsModal(){
      if (document.getElementById('settingsModal')) return;
      const sw = id => `<label class="sw"><input type="checkbox" id="${id}"><span></span></label>`;
      const row = (t, sub, ctl) => `<div class="set-row"><div class="set-txt"><b>${t}</b><small>${sub}</small></div>${ctl}</div>`;
      const num = (id, unit) => `<div class="num-wrap"><input type="number" class="set-num" id="${id}" inputmode="numeric"><em>${unit}</em></div>`;
      const el = document.createElement('div');
      el.id = 'settingsModal';
      el.innerHTML = `
      <div id="settingsBox">
        <div id="settings-header">
          <div class="set-hdr-left">
            <div class="set-title">⚙ Settings</div>
            <div class="set-subtitle">VOGA / MOPA DCWIS · saved on this device</div>
          </div>
          <button class="set-close" onclick="closeSettings()">&times;</button>
        </div>
        <div id="settingsContent">
          <div class="set-grid">
            <div class="set-card">
              <div class="set-sec sec-disp">🎨 DISPLAY</div>
              ${row('Dark mode', 'Off = light theme', sw('set-theme'))}
              ${row('Weather animation', 'Rain / storm / fog overlay from METAR', sw('set-wx'))}
              ${row('Wind particles', 'Moving particles on compass', sw('set-particles'))}
            </div>
            <div class="set-card">
              <div class="set-sec sec-alert">🔔 ALERTS</div>
              ${row('Native notifications', 'OS notification on new breach', sw('set-notif'))}
              <div class="set-status" id="set-notif-status"></div>
              ${row('Alert sound', 'Beep on new breach', sw('set-sound'))}
              <div class="set-actions"><button class="set-btn b-test" onclick="testAlert()">🔊 Test alert</button></div>
            </div>
            <div class="set-card">
              <div class="set-sec sec-lim">🎯 ALERT THRESHOLDS</div>
              ${row('Crosswind', '|CW| ≥ limit · default 15 kt', num('set-cw','kt'))}
              ${row('RVR', 'RVR &lt; limit · default 550 m', num('set-rvr','m'))}
              ${row('Wind speed', 'WS ≥ limit · default 25 kt', num('set-ws','kt'))}
              <div class="set-custom" id="set-custom-note">⚠ Custom limits active: alerts and chart lines use YOUR values.</div>
              <div class="set-actions"><button class="set-btn b-reset" onclick="resetSettings('limits')">↺ Reset thresholds</button></div>
            </div>
            <div class="set-card set-card-wide">
              <div class="set-sec sec-about">ℹ️ ABOUT</div>
              <div class="set-about">
                <div class="ab-warn">⚠ REFERENCE SITE ONLY</div>
                This site is a <b>reference display of the Official DCWIS</b> and must be used <b>only as a reference</b>.
                For operational decisions and official METAR/SPECI reporting, use the authorised Official DCWIS and prescribed SOPs.
                <div class="ab-meta">Developed by: Ajay (Goa) · VOGA / MOPA · Build 20260924-settings</div>
              </div>
            </div>
          </div>
          <div class="set-footer"><button class="set-btn b-resetall" onclick="resetSettings('all')">↺ Reset all to defaults</button></div>
        </div>
      </div>`;
      document.body.appendChild(el);
      el.addEventListener('click', e => { if (e.target === el) closeSettings(); });
      const $ = id => el.querySelector('#' + id);
      $('set-theme').addEventListener('change', e => { if (e.target.checked !== isDark) window.toggleTheme(); });
      $('set-wx').addEventListener('change', e => { S.wxAnim = e.target.checked; saveSettings(); applyWxAnim(); });
      $('set-particles').addEventListener('change', e => { S.windParticles = e.target.checked; saveSettings(); applyParticles(); });
      $('set-notif').addEventListener('change', e => window.setNotifPref(e.target.checked));
      $('set-sound').addEventListener('change', e => { S.sound = e.target.checked; saveSettings(); });
      Object.keys(SET_LIMITS).forEach(k => {
        $('set-' + k).addEventListener('change', e => {
          const L = SET_LIMITS[k]; let v = parseInt(e.target.value, 10);
          if (isNaN(v)) v = S[k];
          S[k] = Math.min(L.max, Math.max(L.min, v));
          saveSettings(); refreshThresholdViews(); syncSettingsUI();
        });
      });
    }

    function ensureSettingsButton(){
      document.querySelectorAll('.top-btns [onclick="toggleTheme()"], #notif-btn').forEach(b => b.remove());
      if (document.getElementById('settings-btn')) return;
      const b = document.createElement('button');
      b.className = 'icon-btn'; b.id = 'settings-btn'; b.title = 'Settings'; b.textContent = '⚙️';
      b.onclick = () => window.openSettings();
      const tb = document.querySelector('.top-btns');
      if (tb) tb.insertBefore(b, document.querySelector('[onclick="openSnapshot()"]'));
    }

    function initSettings(){
      ensureSettingsButton();
      buildSettingsModal();
      applyWxAnim(); applyParticles();
      syncSettingsUI();
      // Browsers only allow the permission prompt after a user gesture,
      // so notifications default to ON and ask on the first tap.
      if ('Notification' in window) {
        const h = () => {
          document.removeEventListener('pointerdown', h, true);
          if (S.notif && Notification.permission === 'default') Notification.requestPermission().then(syncSettingsUI).catch(()=>{});
        };
        document.addEventListener('pointerdown', h, true);
      }
    }

    function getAlertValue(def, data) {
      if (!data) return null;
      const keyMap = {
        crosswind: 'crosswind_avgOneMin',
        rvr:       'pwd_rvr_avgOneMin',
        windSpeed: 'windSpeed_instant_rounded'
      };
      const raw = data[keyMap[def.type]];
      return parseLeadingNumber(raw);
    }

    function isAlertBreached(def, val) {
      if (val === null || isNaN(val)) return false;
      const v = def.useAbs ? Math.abs(val) : val;
      return def.dir === 'above' ? v >= def.limit : v < def.limit;
    }

    function checkAlerts() {
      if (alertDismissed) return;
      const activeAlerts = [];
      let borderAlertActive = false;
      ALERT_DEFS.forEach(def => {
        const data = latestData[def.rwy];
        const val = getAlertValue(def, data);
        const breached = isAlertBreached(def, val);
        const wasBreached = !!alertStates[def.id];
        alertStates[def.id] = breached;
        const dispVal = val !== null ? (def.useAbs ? Math.abs(val) : val) : '—';
        const unit = { crosswind:'kt', rvr:'m', windSpeed:'kt' }[def.type] || '';
        if (breached && !wasBreached) {
          playAlertSequence(def.level);
          sendBrowserNotification(`⚠ ${def.label}`, `${dispVal}${unit} — threshold breached`, def.id);
        }
        if (breached) {
          activeAlerts.push(`⚠ ${def.label}: ${dispVal}${unit}`);
          if (def.borderAlert !== false) borderAlertActive = true;
        }
      });

      if (activeAlerts.length > 0) {
        alertBanner.classList.add('banner-active');
        alertBanner.innerHTML = activeAlerts.join('&emsp;|&emsp;') +
          `&emsp;<span onclick="dismissAlert()" style="cursor:pointer;opacity:0.7;font-size:0.85em">✕ Dismiss</span>`;
      } else {
        alertBanner.classList.remove('banner-active');
        alertBanner.innerHTML = '';
        alertDismissed = false;
      }

      if (borderAlertActive) {
        alertOverlay.classList.add('alert-active');
      } else {
        alertOverlay.classList.remove('alert-active');
      }
    }

    window.dismissAlert = function() {
      alertDismissed = true;
      alertOverlay.classList.remove('alert-active');
      alertBanner.classList.remove('banner-active');
      // Auto re-enable after 5 minutes
      clearTimeout(alertDismissTimer);
      alertDismissTimer = setTimeout(() => { alertDismissed = false; }, 5 * 60 * 1000);
    };

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE 2 — QNH SPARKLINE (mini trend chart in cell)
    // ═══════════════════════════════════════════════════════════════
    const qnhSparkData = { '28': [], '10': [] };
    const QNH_SPARK_MAX = 30; // keep last 30 readings

    function pushQnhSpark(rwy, val) {
      const num = parseFloat(val);
      if (isNaN(num)) return;
      const buf = qnhSparkData[rwy];
      buf.push(num);
      if (buf.length > QNH_SPARK_MAX) buf.shift();
    }

    function drawQnhSparkline(rwy) {
      const canvas = document.getElementById('qnhspark' + rwy);
      if (!canvas) return;
      const buf = qnhSparkData[rwy];
      const isDarkMode = document.body.classList.contains('dark');

      // Size canvas to parent cell width
      const parent = canvas.parentElement;
      const w = Math.max(parent.clientWidth - 12, 40);
      const h = 22;
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);

      if (buf.length < 2) return;

      const min = Math.min(...buf);
      const max = Math.max(...buf);
      const range = max - min || 0.01;

      const lineColor = isDarkMode ? '#64b5f6' : '#1565c0';
      const fillColor = isDarkMode ? 'rgba(100,181,246,0.18)' : 'rgba(21,101,192,0.12)';

      // Draw fill
      ctx.beginPath();
      buf.forEach((v, i) => {
        const x = (i / (buf.length - 1)) * (w - 2) + 1;
        const y = h - 3 - ((v - min) / range) * (h - 6);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.lineTo((w - 1), h - 2);
      ctx.lineTo(1, h - 2);
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();

      // Draw line
      ctx.beginPath();
      buf.forEach((v, i) => {
        const x = (i / (buf.length - 1)) * (w - 2) + 1;
        const y = h - 3 - ((v - min) / range) * (h - 6);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Last dot
      const last = buf[buf.length - 1];
      const lx = w - 1;
      const ly = h - 3 - ((last - min) / range) * (h - 6);
      ctx.beginPath();
      ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
    }

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE 3 — RVR TREND INDICATOR
    // ═══════════════════════════════════════════════════════════════
    const rvrHistory = { '28': [], '10': [] };
    const RVR_HIST_MAX = 8; // last 8 readings (~8 seconds at 1Hz)
    const RVR_TREND_WINDOW = 5; // compare last vs 5 readings ago

    function pushRvrHistory(rwy, rawVal) {
      const num = parseLeadingNumber(rawVal);
      if (num === null || isNaN(num) || num < 0) return;
      const buf = rvrHistory[rwy];
      buf.push(num);
      if (buf.length > RVR_HIST_MAX) buf.shift();
    }

    function renderRvrTrend(rwy) {
      const el = document.getElementById('rvrtrd' + rwy);
      if (!el) return;
      const buf = rvrHistory[rwy];
      if (buf.length < RVR_TREND_WINDOW + 1) { el.style.display = 'none'; return; }
      const recent  = buf[buf.length - 1];
      const earlier = buf[buf.length - 1 - RVR_TREND_WINDOW];
      const diff = recent - earlier;
      if (Math.abs(diff) < 25) {
        el.textContent = '→ STABLE';
        el.className = 'rvr-trend-badge rvr-trend-stable';
      } else if (diff > 0) {
        el.textContent = '↑ IMPR +' + Math.round(diff) + 'm';
        el.className = 'rvr-trend-badge rvr-trend-impr';
      } else {
        el.textContent = '↓ DETER ' + Math.round(Math.abs(diff)) + 'm';
        el.className = 'rvr-trend-badge rvr-trend-deter';
      }
      el.style.display = 'block';
    }

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE 4 — COMPASS ANIMATED ROTATION
    // ═══════════════════════════════════════════════════════════════
    const compassCurrentAngle = { '28': null, '10': null };
    const compassTargetAngle  = { '28': null, '10': null };
    const compassAnimFrame    = { '28': null, '10': null };

    function shortestAngleDiff(from, to) {
      let diff = ((to - from) % 360 + 360) % 360;
      if (diff > 180) diff -= 360;
      return diff;
    }

    function animateCompass(rwy) {
      const cur = compassCurrentAngle[rwy];
      const tgt = compassTargetAngle[rwy];
      if (cur === null || tgt === null) return;
      const diff = shortestAngleDiff(cur, tgt);
      if (Math.abs(diff) < 0.5) {
        compassCurrentAngle[rwy] = tgt;
        drawCompass(rwy, tgt);
        return;
      }
      // Ease: move 15% of remaining each frame
      const step = diff * 0.15;
      compassCurrentAngle[rwy] = cur + step;
      drawCompass(rwy, compassCurrentAngle[rwy]);
      compassAnimFrame[rwy] = requestAnimationFrame(() => animateCompass(rwy));
    }

    function setCompassTarget(rwy, deg) {
      if (deg === null || isNaN(deg)) return;
      compassTargetAngle[rwy] = deg;
      if (compassCurrentAngle[rwy] === null) {
        compassCurrentAngle[rwy] = deg;
        drawCompass(rwy, deg);
        return;
      }
      if (compassAnimFrame[rwy]) cancelAnimationFrame(compassAnimFrame[rwy]);
      animateCompass(rwy);
    }

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE 5 — PRINT / SNAPSHOT REPORT
    // ═══════════════════════════════════════════════════════════════
    function snapColorClass(id, thresholds) {
      const el = document.getElementById(id);
      if (!el) return '';
      let txt = '';
      el.childNodes.forEach(n => { if (n.nodeType === 3) txt += n.textContent; });
      const num = parseLeadingNumber(txt.trim());
      if (num === null) return '';
      if (thresholds) {
        if (thresholds.red   && num >= thresholds.red)   return 'red';
        if (thresholds.amber && num >= thresholds.amber) return 'amber';
        if (thresholds.green && num <= thresholds.green) return 'green';
      }
      return 'cyan';
    }

    // ═══════════════════════════════════════════════════════════════
    //  VOGA WEATHER REPORT — 24h as 4 × 6-hour blocks
    //  (replaces the old "24H Summary" tables)
    //
    //  Data sources
    //   • Wind speed / direction / RVR  → backend /history  (2-min bins, falls back to 5/10/30-min if the
    //                                      backend has nothing at the finer bin)
    //   • Headwind / Crosswind          → computed here from each runway's own wind-speed + direction bins
    //   • Visibility / Cloud / Weather  → METAR/SPECI register
    // ═══════════════════════════════════════════════════════════════
    const WR_BLOCK_HOURS = 6;
    const WR_BLOCK_COUNT = 4;                       // 4 × 6h = 24h
    const WR_BIN_CHAIN   = [120, 300, 600, 1800];   // seconds; first entry is the preferred bin
    const WR_END_AT_BOUNDARY = false;               // false: window ends "now"   |   true: ends at the last 00/06/12/18Z boundary
    const WR_MIN_BIN_BY_AGE = [[48, 120], [96, 300], [Infinity, 600]];  // [hours back up to, finest bin (s)] — older range => coarser bin so the load stays quick
    const WR_SHOW_CURRENT_PANELS = false;           // true: also print the live RWY panels + latest METAR above the report

    let wrPeriod = null;      // null = last 24 h (rolling) | { y, m, d } = that UTC day, 0000–2400Z
    let wrReq = 0;            // request counter (ignore stale async results)
    let wrUiBound = false;
    let wrFileTag = '';       // used in the PDF file name

    const WR_C = { r28:'#1f6fb2', r10:'#7b4fb0', red:'#d64045', amb:'#e59a00', grn:'#2e9e5b',
                   navy:'#0b2545', grey:'#7c869a', ink:'#1d2433', grid:'#e6eaf1', axis:'#c8cfdb', teal:'#00796b' };
    const WR_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const wrP2 = n => String(n).padStart(2, '0');
    const wrHHMM = ms => { const d = new Date(ms); return wrP2(d.getUTCHours()) + wrP2(d.getUTCMinutes()); };
    const wrISTHHMM = ms => wrHHMM(ms + 19800000);
    const wrDay = ms => { const d = new Date(ms); return wrP2(d.getUTCDate()) + ' ' + WR_MON[d.getUTCMonth()]; };
    const wrDayYear = ms => wrDay(ms) + ' ' + new Date(ms).getUTCFullYear();

    // ── thresholds (taken from Settings where the app already has a limit) ──
    function wrLimits() {
      const cw = Number(S.cw) || 15, rvr = Number(S.rvr) || 550, ws = Number(S.ws) || 25;
      return {
        wsRed: ws,  wsAmb: Math.min(SEVERITY_THRESHOLDS.windSpeed.normalMax, ws * 0.6),
        cwRed: cw,  cwAmb: cw * 2 / 3,
        rvrRed: rvr, rvrAmb: Math.max(1000, rvr),
        visRed: SEVERITY_THRESHOLDS.visibility.highMax, visAmb: 3000,   // vis >= 3000 m = green, < 3000 m = orange, < visRed = red
        cbRed: 300, cbAmb: 1000
      };
    }

    // ── weather phenomena from the METAR "weather" field ──
    function wrWxCodes(raw) {
      if (!raw) return [];
      const out = [];
      String(raw).toUpperCase().split(/[\s,]+/).filter(Boolean).forEach(tok => {
        const t = tok.replace(/^[-+]/, '');
        if (!t || t === 'NSW' || t === 'NIL' || t === '--') return;
        let c;
        if (/TS/.test(t)) c = 'TS';
        else if (/(GR|GS)/.test(t)) c = 'GR';
        else if (/^(BC|PR|MI)FG$/.test(t)) c = t;
        else if (/FG/.test(t)) c = 'FG';
        else if (/DZ/.test(t)) c = 'DZ';
        else if (/RA/.test(t)) c = 'RA';
        else c = t;
        if (!out.includes(c)) out.push(c);
      });
      return out;
    }
    const WR_NORMAL_WX = ['BR', 'HZ', 'FU'];        // treated as normal (green)
    const wrWxSev   = c => (c === 'TS' || c === 'GR' || c === 'FG') ? 2 : WR_NORMAL_WX.includes(c) ? 0 : 1;
    const wrWxColor = c => (c === 'TS' || c === 'GR' || c === 'FG') ? WR_C.red : WR_NORMAL_WX.includes(c) ? WR_C.grn : (c === 'RA' || c === 'DZ') ? WR_C.r28 : WR_C.amb;

    // ── METAR visibility (metres) and lowest cloud layer ──
    function wrVisMeters(raw) {
      if (raw === undefined || raw === null) return null;
      const s = String(raw).trim().toUpperCase();
      if (!s || s === '--' || s === '—') return null;
      if (s === 'CAVOK') return 9999;
      const m = s.match(/^P?(\d+(?:\.\d+)?)\s*(KM)?$/);
      let n;
      if (m) { n = parseFloat(m[1]); if (m[2] === 'KM') n *= 1000; }
      else { n = parseLeadingNumber(s); if (n === null) return null; if (/KM/.test(s)) n *= 1000; }
      return Math.min(9999, Math.round(n));
    }
    function wrCloudOf(e) {
      const RE = /^(FEW|SCT|BKN|OVC|VV)(\d{3})/;
      let best = null;
      ['cloud1', 'cloud2', 'cloud3', 'cloud4'].forEach(k => {
        const raw = e[k]; if (!raw) return;
        const m = RE.exec(String(raw).toUpperCase()); if (!m) return;
        const ft = parseInt(m[2], 10) * 100;
        if (!best || ft < best.ft) best = { ft, type: m[1] };
      });
      return best;
    }

    // ── statistics over backend bins ──
    function wrBinStats(bins, from, to) {
      let n = 0, sum = 0, wsum = 0, mn = null, mx = null, mnTs = null, mxTs = null, hasRange = false;
      bins.forEach(b => {
        const ts = b.timestamp * 1000;
        if (ts < from || ts >= to) return;
        const v = b.value;
        if (v === null || v === undefined || isNaN(v)) return;
        const rng = b.min != null && b.max != null && !isNaN(b.min) && !isNaN(b.max);
        if (rng) hasRange = true;
        const lo = rng ? b.min : v, hi = rng ? b.max : v;
        const w = b.count > 0 ? b.count : 1;
        sum += v * w; wsum += w; n++;
        if (mn === null || lo < mn) { mn = lo; mnTs = (rng && b.min_timestamp) ? b.min_timestamp * 1000 : ts; }
        if (mx === null || hi > mx) { mx = hi; mxTs = (rng && b.max_timestamp) ? b.max_timestamp * 1000 : ts; }
      });
      return n ? { n, min: mn, max: mx, avg: sum / wsum, minTs: mnTs, maxTs: mxTs, hasRange } : null;
    }
    function wrDirStats(bins, from, to) {
      const vals = [];
      bins.forEach(b => {
        const ts = b.timestamp * 1000;
        if (ts < from || ts >= to || b.value == null || isNaN(b.value)) return;
        vals.push(((b.value % 360) + 360) % 360);
      });
      if (!vals.length) return null;
      let sx = 0, sy = 0;
      vals.forEach(v => { const r = v * Math.PI / 180; sx += Math.cos(r); sy += Math.sin(r); });
      const mean = ((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360;
      let dmin = 0, dmax = 0;
      vals.forEach(v => { const d = ((v - mean + 540) % 360) - 180; if (d < dmin) dmin = d; if (d > dmax) dmax = d; });
      return { n: vals.length, mean, lo: (mean + dmin + 360) % 360, hi: (mean + dmax + 360) % 360, span: dmax - dmin };
    }
    function wrComponentBins(rwy, wsBins, wdBins) {
      const hd = RUNWAY_HEADING[rwy];
      const wsBy = new Map(wsBins.map(b => [b.timestamp, b]));
      const hw = [], cw = [];
      wdBins.forEach(wdB => {
        const wsB = wsBy.get(wdB.timestamp);
        if (!wsB) return;
        const wd = wdB.value, ws = wsB.value;
        if (wd == null || ws == null || isNaN(wd) || isNaN(ws)) return;
        const a = (wd - hd) * Math.PI / 180;
        hw.push({ timestamp: wdB.timestamp, value: ws * Math.cos(a), count: wsB.count });
        cw.push({ timestamp: wdB.timestamp, value: Math.abs(ws * Math.sin(a)), count: wsB.count });
      });
      return { hw, cw };
    }

    // ── fetch one runway (finest bin that returns data) ──
    async function wrFetchRunway(rwy, hours) {
      const minBin = (WR_MIN_BIN_BY_AGE.find(a => hours <= a[0]) || [0, 120])[1];
      const chain = WR_BIN_CHAIN.filter(b => b >= minBin);
      for (const bin of (chain.length ? chain : [WR_BIN_CHAIN[WR_BIN_CHAIN.length - 1]])) {
        const [ws, wd, rvr, qnh, temp, dew, hum] = await Promise.all([
          fetchHistoryFromBackend(rwy, 'windSpeed', hours, bin),
          fetchHistoryFromBackend(rwy, 'windDirection', hours, bin),
          fetchHistoryFromBackend(rwy, 'rvr', hours, bin),
          fetchHistoryFromBackend(rwy, 'qnh', hours, bin),
          fetchHistoryFromBackend(rwy, 'temperature', hours, bin),
          fetchHistoryFromBackend(rwy, 'dewPoint', hours, bin),
          fetchHistoryFromBackend(rwy, 'humidity', hours, bin)
        ]);
        if (ws.length || wd.length || rvr.length || qnh.length || temp.length || dew.length || hum.length) {
          const comp = wrComponentBins(rwy, ws, wd);
          return { rwy, bin, ws, wd, rvr, qnh, temp, dew, hum, hw: comp.hw, cw: comp.cw };
        }
      }
      return { rwy, bin: null, ws: [], wd: [], rvr: [], qnh: [], temp: [], dew: [], hum: [], hw: [], cw: [] };
    }

    // ── weather phenomena → intervals (start = first report with it, end = first report without it) ──
    function wrPhenomena(reports, endMs) {
      const codesSeen = [];
      reports.forEach(r => r.codes.forEach(c => { if (!codesSeen.includes(c)) codesSeen.push(c); }));
      const out = [];
      codesSeen.forEach(c => {
        let start = null;
        for (let i = 0; i < reports.length; i++) {
          const has = reports[i].codes.includes(c);
          if (has && start === null) start = reports[i].ts;
          if (!has && start !== null) { out.push({ code: c, from: start, to: reports[i].ts }); start = null; }
        }
        if (start !== null) out.push({ code: c, from: start, to: endMs });
      });
      return out.sort((a, b) => a.from - b.from);
    }

    // ── tiny SVG graph (attributes only, so html2canvas / print render it identically) ──
    function wrGraph(o) {
      const W = 215, H = 108, L = 25, R = 6, T = 8, B = 15;
      const pw = W - L - R, ph = H - T - B;
      const X = ms => L + (ms - o.x0) / (o.x1 - o.x0) * pw;
      const Y = v => T + ph - (Math.min(Math.max(v, o.ymin), o.ymax) - o.ymin) / (o.ymax - o.ymin) * ph;
      const F = 'font-family="Inter,Arial,sans-serif"';
      let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" style="display:block">`;
      s += `<rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="#fff"/>`;
      (o.bands || []).forEach(b => {
        const y1 = Y(b.to), y2 = Y(b.from);
        s += `<rect x="${L}" y="${y1.toFixed(1)}" width="${pw}" height="${(y2 - y1).toFixed(1)}" fill="${b.color}" fill-opacity="${b.op}"/>`;
      });
      (o.yticks || []).forEach(v => {
        const y = Y(v).toFixed(1);
        s += `<line x1="${L}" y1="${y}" x2="${L + pw}" y2="${y}" stroke="${WR_C.grid}" stroke-width="0.6"/>`;
        s += `<text x="${L - 3}" y="${(+y + 2.4).toFixed(1)}" text-anchor="end" font-size="6.2" fill="${WR_C.grey}" ${F}>${v}</text>`;
      });
      // hourly ticks
      const firstHr = Math.ceil(o.x0 / 3600000) * 3600000;
      for (let t = firstHr; t <= o.x1; t += 3600000) {
        const x = X(t).toFixed(1);
        s += `<line x1="${x}" y1="${T}" x2="${x}" y2="${T + ph}" stroke="${WR_C.grid}" stroke-width="0.6"/>`;
        s += `<text x="${x}" y="${H - 5}" text-anchor="middle" font-size="6.2" fill="${WR_C.grey}" ${F}>${wrP2(new Date(t).getUTCHours())}</text>`;
      }
      s += `<line x1="${L}" y1="${T}" x2="${L}" y2="${T + ph}" stroke="${WR_C.axis}" stroke-width="0.8"/>`;
      s += `<line x1="${L}" y1="${T + ph}" x2="${L + pw}" y2="${T + ph}" stroke="${WR_C.axis}" stroke-width="0.8"/>`;

      let any = false;
      (o.series || []).forEach(se => {
        // split into segments at data gaps
        const segs = []; let cur = [];
        se.pts.forEach(p => {
          if (cur.length && p[0] - cur[cur.length - 1][0] > o.gapMs) { segs.push(cur); cur = []; }
          cur.push(p);
        });
        if (cur.length) segs.push(cur);
        segs.forEach(sg => {
          any = true;
          const pts = sg.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
          if (se.fill && sg.length > 1) {
            s += `<polygon points="${X(sg[0][0]).toFixed(1)},${Y(o.ymin).toFixed(1)} ${pts} ${X(sg[sg.length - 1][0]).toFixed(1)},${Y(o.ymin).toFixed(1)}" fill="${se.color}" fill-opacity="0.12"/>`;
          }
          if (sg.length === 1) s += `<circle cx="${X(sg[0][0]).toFixed(1)}" cy="${Y(sg[0][1]).toFixed(1)}" r="1" fill="${se.color}"/>`;
          else s += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="${se.w || 1}" stroke-linejoin="round"/>`;
        });
      });
      if (!any) s += `<text x="${L + pw / 2}" y="${T + ph / 2 + 2}" text-anchor="middle" font-size="8" fill="${WR_C.grey}" ${F}>No data</text>`;

      if (o.note && any) {
        s += `<text x="${L + pw / 2}" y="${T + ph / 2 + 2}" text-anchor="middle" font-size="7.5" fill="${WR_C.grey}" ${F}>${o.note}</text>`;
      }
      if (o.callout && any) {
        const c = o.callout, px = X(c.ms), py = Y(c.v);
        const bw = c.text.length * 3.95 + 7, bh = 10;
        const below = py < T + ph * 0.45;
        let bx = px - bw / 2; bx = Math.max(L + 1, Math.min(L + pw - bw - 1, bx));
        const by = below ? Math.min(py + 14, T + ph - bh - 2) : Math.max(py - 14 - bh, T + 1);
        const ly = below ? by : by + bh;
        s += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${(bx + bw / 2).toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${c.color}" stroke-width="0.7"/>`;
        s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="1.8" fill="${c.color}"/>`;
        s += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh}" rx="2" fill="#fff" stroke="${c.color}" stroke-width="0.8"/>`;
        s += `<text x="${(bx + bw / 2).toFixed(1)}" y="${(by + 7.2).toFixed(1)}" text-anchor="middle" font-size="6.4" font-weight="700" fill="${c.color}" ${F}>${c.text}</text>`;
      }
      return s + '</svg>';
    }

    // ── 24h overview strip (weather ribbon + condition bar + block boundaries) ──
    function wrOverviewSVG(startMs, axisEnd, phen, condRuns, blocks) {
      const W = 1000, L = 68, R = 6, pw = W - L - R;
      const X = ms => L + (ms - startMs) / (axisEnd - startMs) * pw;
      const F = 'font-family="Inter,Arial,sans-serif"';
      let s = `<svg viewBox="0 0 ${W} 74" width="100%" xmlns="http://www.w3.org/2000/svg" style="display:block">`;
      s += `<text x="0" y="14" font-size="10" font-weight="700" fill="${WR_C.grey}" ${F}>WEATHER</text>`;
      s += `<text x="0" y="40" font-size="10" font-weight="700" fill="${WR_C.grey}" ${F}>CONDITION</text>`;
      s += `<rect x="${L}" y="3" width="${pw}" height="16" fill="#eef1f5"/>`;
      phen.forEach(p => {
        const x1 = X(Math.max(p.from, startMs)), x2 = X(Math.min(p.to, axisEnd));
        if (x2 <= x1) return;
        s += `<rect x="${x1.toFixed(1)}" y="3" width="${Math.max(1, x2 - x1).toFixed(1)}" height="16" fill="${wrWxColor(p.code)}"/>`;
        if (x2 - x1 > p.code.length * 7 + 6) s += `<text x="${((x1 + x2) / 2).toFixed(1)}" y="14.5" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff" ${F}>${p.code}</text>`;
      });
      const SC = [WR_C.grn, WR_C.amb, WR_C.red];
      condRuns.forEach(r => {
        const x1 = X(r.from), x2 = X(r.to);
        s += `<rect x="${x1.toFixed(1)}" y="25" width="${Math.max(0.8, x2 - x1 + 0.4).toFixed(1)}" height="20" fill="${SC[r.sev]}"/>`;
      });
      blocks.forEach((b, i) => {
        const x = X(b.from).toFixed(1);
        s += `<line x1="${x}" y1="25" x2="${x}" y2="45" stroke="#fff" stroke-width="2"/>`;
        s += `<line x1="${x}" y1="45" x2="${x}" y2="52" stroke="${WR_C.ink}" stroke-width="1"/>`;
        s += `<text x="${((X(b.from) + X(b.to)) / 2).toFixed(1)}" y="64" text-anchor="middle" font-size="10.5" font-weight="700" fill="${WR_C.ink}" ${F}>${wrHHMM(b.from)}Z – ${wrHHMM(b.to)}Z</text>`;
      });
      s += `<line x1="${X(axisEnd).toFixed(1)}" y1="45" x2="${X(axisEnd).toFixed(1)}" y2="52" stroke="${WR_C.ink}" stroke-width="1"/>`;
      return s + '</svg>';
    }

    // ── helpers for the tables ──
    function wrCls(v, red, amb, reverse) {
      if (v === null || v === undefined) return '';
      if (reverse) return v < red ? 'wr-red' : v < amb ? 'wr-amb' : '';
      return v >= red ? 'wr-red' : v >= amb ? 'wr-amb' : '';
    }
    const wrNum   = v => (v === null || v === undefined || isNaN(v)) ? '–' : String(Math.round(v));
    const wrNum10 = v => (v === null || v === undefined || isNaN(v)) ? '–' : String(Math.round(v / 10) * 10);
    const wrOne   = v => (v === null || v === undefined || isNaN(v)) ? '–' : v.toFixed(1);
    const wrSign  = v => { if (v === null || v === undefined || isNaN(v)) return '–'; const r = Math.round(v); return r > 0 ? '+' + r : String(r === 0 ? 0 : r); };
    const wrDeg   = v => (v === null || v === undefined || isNaN(v)) ? '–' : String(Math.round(v) % 360).padStart(3, '0');
    const wrCell  = (txt, cls) => `<td class="wr-v ${cls || ''}">${txt}</td>`;

    function wrRunwayRows(L, bd) {
      // bd = { r28:{ws,dir,hw,cw,rvr}, r10:{...} }
      const rows = [];
      function trio(st, fmt, clsMin, clsMax) {
        if (!st) return wrCell('–') + wrCell('–') + wrCell('–');
        return wrCell(fmt(st.min), clsMin) + wrCell(fmt(st.avg)) + wrCell(fmt(st.max), clsMax);
      }
      function row(label, key, fmt, fnMin, fnMax) {
        let h = `<tr><td class="wr-l">${label}</td>`;
        ['r28', 'r10'].forEach(r => {
          const st = bd[r][key];
          h += trio(st, fmt, st && fnMin ? fnMin(st.min) : '', st && fnMax ? fnMax(st.max) : '');
        });
        return h + '</tr>';
      }
      rows.push(row('Wind speed  kt', 'ws', wrNum, null, v => wrCls(v, L.wsRed, L.wsAmb)));
      // direction row (circular)
      let dr = '<tr><td class="wr-l">Wind dir  deg</td>';
      ['r28', 'r10'].forEach(r => {
        const d = bd[r].dir;
        if (!d) dr += wrCell('–') + wrCell('–') + wrCell('–');
        else dr += wrCell(wrDeg(d.lo)) + wrCell(d.span > 150 ? 'VRB' : wrDeg(d.mean)) + wrCell(wrDeg(d.hi));
      });
      rows.push(dr + '</tr>');
      rows.push(row('Headwind  kt  (-ve = tail)', 'hw', wrSign, null, null));
      rows.push(row('Crosswind  kt', 'cw', wrNum, null, v => wrCls(v, L.cwRed, L.cwAmb)));
      rows.push(row('RVR  m', 'rvr', wrNum10, v => wrCls(v, L.rvrRed, L.rvrAmb, true), null));
      rows.push(row('QNH  hPa', 'qnh', wrOne, null, null));
      rows.push(row('Temperature  °C', 'temp', wrOne, null, null));
      rows.push(row('Dew point  °C', 'dew', wrOne, null, null));
      rows.push(row('Humidity  %', 'hum', wrNum, null, null));
      return rows.join('');
    }

    // ── one 6-hour block ──
    function wrBlockHTML(bk, L, runs, reports, phen, endMs) {
      if (bk.future) {
        return `<div class="wr-block wr-future"><div class="wr-bhead"><div class="wr-btime"><b>${wrHHMM(bk.from)}Z – ${wrHHMM(bk.to)}Z</b><small>IST ${wrISTHHMM(bk.from)} – ${wrISTHHMM(bk.to)}</small></div><span class="wr-sevchip">UPCOMING</span></div><div class="wr-futurebody">This block has not started yet.</div></div>`;
      }
      const to = bk.toEff;
      const bd = {};
      runs.forEach(r => {
        bd['r' + r.rwy] = {
          ws: wrBinStats(r.ws, bk.from, to), dir: wrDirStats(r.wd, bk.from, to),
          hw: wrBinStats(r.hw, bk.from, to), cw: wrBinStats(r.cw, bk.from, to),
          rvr: wrBinStats(r.rvr, bk.from, to),
          qnh: wrBinStats(r.qnh, bk.from, to), temp: wrBinStats(r.temp, bk.from, to),
          dew: wrBinStats(r.dew, bk.from, to), hum: wrBinStats(r.hum, bk.from, to)
        };
      });
      const rep = reports.filter(r => r.ts >= bk.from && r.ts < to);
      const vis = rep.map(r => r.vis).filter(v => v !== null);
      const visMin = vis.length ? Math.min(...vis) : null, visMax = vis.length ? Math.max(...vis) : null;
      const visAvg = vis.length ? vis.reduce((a, b) => a + b, 0) / vis.length : null;
      let cb = null, anyRep = rep.length > 0;
      rep.forEach(r => { if (r.cloud && (!cb || r.cloud.ft < cb.ft)) cb = { ...r.cloud, ts: r.ts }; });

      const ph = phen.filter(p => p.to > bk.from && p.from < to).map(p => ({ code: p.code, from: Math.max(p.from, bk.from), to: Math.min(p.to, bk.to) }));

      // severity
      let sev = 0;
      rep.forEach(r => { sev = Math.max(sev, r.sev); });
      ['r28', 'r10'].forEach(k => {
        const d = bd[k];
        if (d.rvr) { if (d.rvr.min < L.rvrRed) sev = 2; else if (d.rvr.min < L.rvrAmb) sev = Math.max(sev, 1); }
        if (d.ws)  { if (d.ws.max >= L.wsRed) sev = 2; else if (d.ws.max >= L.wsAmb) sev = Math.max(sev, 1); }
        if (d.cw)  { if (d.cw.max >= L.cwRed) sev = 2; else if (d.cw.max >= L.cwAmb) sev = Math.max(sev, 1); }
      });
      const sevName = ['NORMAL', 'WATCH', 'POOR'][sev];

      // graphs
      const winMs = bk.to - bk.from;
      const gapMs = Math.max(...runs.map(r => (r.bin || 120) * 1000), 120000) * 2.5;
      const sel = (arr) => arr.filter(b => { const t = b.timestamp * 1000; return t >= bk.from && t < to && b.value != null && !isNaN(b.value); }).map(b => [b.timestamp * 1000, b.value]);
      const r28 = runs.find(r => r.rwy === '28'), r10 = runs.find(r => r.rwy === '10');
      const wsP28 = sel(r28.ws), wsP10 = sel(r10.ws), rvP28 = sel(r28.rvr), rvP10 = sel(r10.rvr);
      const wsMaxAll = Math.max(0, ...wsP28.map(p => p[1]), ...wsP10.map(p => p[1]));
      const wTop = Math.max(12, Math.ceil(wsMaxAll * 1.45 / 2) * 2);
      // wind callout = highest reading of the two runways (MAX shown is the bin-average peak shown on the line)
      let wCall = null;
      ['r28', 'r10'].forEach(k => {
        const d = bd[k].ws, runCol = k === 'r28' ? WR_C.r28 : WR_C.r10;
        if (!d) return;
        const arr = k === 'r28' ? wsP28 : wsP10;
        let pk = null; arr.forEach(p => { if (!pk || p[1] > pk[1]) pk = p; });
        if (pk && (!wCall || pk[1] > wCall.v)) wCall = { ms: pk[0], v: pk[1], color: runCol, text: `MAX ${Math.round(pk[1])} kt  ${wrHHMM(pk[0])}Z` };
      });
      const rvAll = rvP28.concat(rvP10);
      const rvMax = Math.max(2150, ...rvAll.map(p => p[1]));
      let rCall = null, rNote = null;
      if (rvAll.length) {
        let lo = rvAll[0]; rvAll.forEach(p => { if (p[1] < lo[1]) lo = p; });
        if (lo[1] < 1900) rCall = { ms: lo[0], v: lo[1], color: lo[1] < L.rvrRed ? WR_C.red : WR_C.amb, text: `MIN ${Math.round(lo[1] / 10) * 10} m  ${wrHHMM(lo[0])}Z` };
        else rNote = 'RVR 2000+ (no reduction)';
      }
      const gWind = wrGraph({
        x0: bk.from, x1: bk.to, ymin: 0, ymax: wTop, gapMs,
        yticks: [0, Math.round(wTop / 2), wTop],
        bands: wTop > L.wsAmb ? [{ from: L.wsAmb, to: Math.min(L.wsRed, wTop), color: WR_C.amb, op: 0.10 }, { from: L.wsRed, to: wTop, color: WR_C.red, op: 0.10 }] : [],
        series: [{ pts: wsP28, color: WR_C.r28, w: 1.15, fill: true }, { pts: wsP10, color: WR_C.r10, w: 0.95 }],
        callout: wCall
      });
      const gRvr = wrGraph({
        x0: bk.from, x1: bk.to, ymin: 0, ymax: rvMax, gapMs,
        yticks: [0, L.rvrRed, 1000, 2000].filter((v, i, a) => a.indexOf(v) === i),
        bands: [{ from: 0, to: L.rvrRed, color: WR_C.red, op: 0.13 }, { from: L.rvrRed, to: L.rvrAmb, color: WR_C.amb, op: 0.12 }],
        series: [{ pts: rvP28, color: WR_C.r28, w: 1.15 }, { pts: rvP10, color: WR_C.r10, w: 0.95 }],
        callout: rCall, note: rNote
      });

      // header + chips
      const nM = rep.filter(r => r.kind !== 'SPECI').length, nS = rep.filter(r => r.kind === 'SPECI').length;
      const chips = ph.length
        ? ph.map(p => `<span class="wr-chip-wx" style="background:${wrWxColor(p.code)}">${p.code} ${wrHHMM(p.from)}-${wrHHMM(p.to)}</span>`).join('')
        : `<span class="wr-nil">Nil significant weather</span>`;

      // airfield
      const visRow = `<tr><td class="wr-l">Visibility (METAR)  m</td>${
        vis.length ? wrCell(wrNum10(visMin), wrCls(visMin, L.visRed, L.visAmb, true)) + wrCell(wrNum10(visAvg)) + wrCell(wrNum10(visMax))
                   : wrCell('–') + wrCell('–') + wrCell('–')}</tr>`;
      let cbCells;
      if (!anyRep) cbCells = wrCell('–') + `<td class="wr-v wr-subtxt" colspan="2">no reports</td>`;
      else if (!cb) cbCells = wrCell('NSC') + `<td class="wr-v wr-subtxt" colspan="2">no cloud reported</td>`;
      else cbCells = wrCell(String(cb.ft), wrCls(cb.ft, L.cbRed, L.cbAmb, true)) + `<td class="wr-v wr-subtxt" colspan="2">${cb.type} @ ${wrHHMM(cb.ts)}Z</td>`;
      const cbRow = `<tr><td class="wr-l">Lowest cloud base  ft</td>${cbCells}</tr>`;

      const dayTag = (wrDay(bk.from) !== wrDay(bk.to - 1)) ? `${wrDay(bk.from)} → ${wrDay(bk.to - 1)}` : wrDay(bk.from);
      return `
      <div class="wr-block wr-sev${sev}">
        <div class="wr-bhead">
          <div class="wr-btime"><b>${wrHHMM(bk.from)}Z – ${wrHHMM(bk.to)}Z</b><small>IST ${wrISTHHMM(bk.from)} – ${wrISTHHMM(bk.to)} · ${dayTag}${bk.ongoing ? ' · ongoing till ' + wrHHMM(endMs) + 'Z' : ''}</small></div>
          <span class="wr-sevchip">${sevName}</span>
        </div>
        <div class="wr-wxline"><span class="wr-wxlbl">WX</span><span class="wr-chips">${chips}</span><span class="wr-cnt">METAR ${nM} · SPECI ${nS}</span></div>
        <div class="wr-lgd"><i style="background:${WR_C.r28}"></i>RWY 28 <i style="background:${WR_C.r10}"></i>RWY 10</div>
        <div class="wr-graphs">
          <div class="wr-g"><div class="wr-gt">WIND SPEED (kt)</div>${gWind}</div>
          <div class="wr-g"><div class="wr-gt">RVR (m)</div>${gRvr}</div>
        </div>
        <table class="wr-t">
          <thead>
            <tr><th class="wr-th0">RUNWAY DATA</th><th colspan="3" class="wr-th28">RWY 28</th><th colspan="3" class="wr-th10">RWY 10</th></tr>
            <tr class="wr-sh"><th></th><th>MIN</th><th>AVG</th><th>MAX</th><th>MIN</th><th>AVG</th><th>MAX</th></tr>
          </thead>
          <tbody>${wrRunwayRows(L, bd)}</tbody>
        </table>
        <table class="wr-t wr-t2">
          <thead><tr><th class="wr-thA">AIRFIELD DATA</th><th>MIN</th><th>AVG</th><th>MAX</th></tr></thead>
          <tbody>${visRow}${cbRow}</tbody>
        </table>
      </div>`;
    }

    // ── the whole report ──
    async function buildAndInject24hSummary() {
      const container = document.getElementById('snap24hContainer');
      if (!container) return;
      const myReq = ++wrReq;
      try {
        const nowMs = Date.now();
        const BLK = WR_BLOCK_HOURS * 3600000;
        const DAY = WR_BLOCK_COUNT * BLK;
        let mode, startMs, endMs, axisEnd;
        if (wrPeriod) {                       // custom UTC day: 0000–2400Z (today = up to "now")
          mode = 'day';
          startMs = Date.UTC(wrPeriod.y, wrPeriod.m - 1, wrPeriod.d);
          axisEnd = startMs + DAY;
          endMs = Math.min(axisEnd, nowMs);
        } else {                              // default: last 24 h
          mode = 'rolling';
          endMs = WR_END_AT_BOUNDARY ? Math.floor(nowMs / BLK) * BLK : nowMs;
          startMs = endMs - DAY;
          axisEnd = endMs;
        }
        const hoursBack = Math.max(WR_BLOCK_COUNT * WR_BLOCK_HOURS, Math.ceil((nowMs - startMs) / 3600000));
        wrFileTag = mode === 'day' ? (new Date(startMs).toISOString().slice(0, 10) + '_UTCday') : '';

        const [run28, run10, regRaw] = await Promise.all([
          wrFetchRunway('28', hoursBack),
          wrFetchRunway('10', hoursBack),
          fetchMetarHistoryFromRegister(hoursBack).catch(() => [])
        ]);
        if (myReq !== wrReq) return;          // a newer request was started meanwhile
        const runs = [run28, run10];
        const L = wrLimits();

        // register → ascending list of reports inside the window
        const reports = (regRaw || []).map(e => {
          const ts = registerEntryEpochMs(e);
          const vis = wrVisMeters(e.visibility);
          const codes = wrWxCodes(e.weather);
          let sev = 0;
          if (vis !== null) { if (vis < L.visRed) sev = 2; else if (vis < L.visAmb) sev = 1; }
          codes.forEach(c => { sev = Math.max(sev, wrWxSev(c)); });
          return { ts, e, vis, codes, sev, kind: String(e.selectedOption || 'METAR').toUpperCase(), cloud: wrCloudOf(e) };
        }).filter(r => r.ts !== null && r.ts >= startMs && r.ts < (endMs >= axisEnd ? axisEnd : endMs + 1)).sort((a, b) => a.ts - b.ts);

        const phen = wrPhenomena(reports, endMs);

        // blocks
        const blocks = [];
        for (let i = 0; i < WR_BLOCK_COUNT; i++) {
          const from = startMs + i * BLK, to = from + BLK;
          let toEff;
          if (mode === 'rolling') toEff = (i === WR_BLOCK_COUNT - 1) ? endMs + 1 : to;
          else toEff = (endMs >= axisEnd) ? to : Math.min(to, endMs + 1);
          blocks.push({ from, to, toEff, future: mode === 'day' && from > endMs,
                        ongoing: mode === 'day' && from <= endMs && to > endMs });
        }

        // condition strip (10-min steps): latest METAR/SPECI state + RVR below limit
        const rvrMin = new Map();
        [run28, run10].forEach(r => r.rvr.forEach(b => {
          if (b.value == null || isNaN(b.value)) return;
          const k = Math.floor(b.timestamp * 1000 / 600000);
          if (!rvrMin.has(k) || b.value < rvrMin.get(k)) rvrMin.set(k, b.value);
        }));
        const condRuns = []; let ri = -1;
        for (let t = startMs; t < endMs; t += 600000) {
          while (ri + 1 < reports.length && reports[ri + 1].ts <= t) ri++;
          let sev = ri >= 0 ? reports[ri].sev : 0;
          const rv = rvrMin.get(Math.floor(t / 600000));
          if (rv !== undefined) { if (rv < L.rvrRed) sev = 2; else if (rv < L.rvrAmb) sev = Math.max(sev, 1); }
          const last = condRuns[condRuns.length - 1];
          const t2 = Math.min(t + 600000, endMs);
          if (last && last.sev === sev) last.to = t2; else condRuns.push({ from: t, to: t2, sev });
        }

        // footnote text (bin size + whether MIN/MAX are in-bin extremes)
        const binUsed = Math.max(...runs.map(r => r.bin || 0));
        const binTxt = binUsed ? (binUsed >= 60 ? (binUsed / 60) + '-min' : binUsed + '-sec') : '—';
        const hasRange = runs.some(r => [r.ws, r.rvr, r.qnh, r.temp, r.dew, r.hum].some(a => a.some(b => b.min != null && b.max != null)));
        const noBackend = runs.every(r => !r.bin);

        const windNotes = noBackend ? '' : `
              <li><b>Wind, headwind, crosswind, RVR, QNH, temperature, dew point, humidity:</b> backend readings grouped in <b>${binTxt} bins</b>${binUsed > WR_BIN_CHAIN[0] ? ' (a coarser bin is used when the period is older or finer data is not available)' : ''}, from each runway's own sensors.
                  AVG = mean of all bins in the block. MIN / MAX = ${hasRange ? 'lowest / highest reading recorded inside the bins' : 'lowest / highest <b>' + binTxt + ' average</b> (very short peaks inside a bin are smoothed out)'}.
                  The graph line and its MAX / MIN label use the ${binTxt} values.</li>
              <li><b>Headwind / crosswind</b> are calculated from each runway's own ${binTxt} wind speed and direction.
                  Headwind: + head, − tail. Crosswind: magnitude only. Wind dir: circular mean, “VRB” when it varies by more than 150°.</li>
        `;

        const gen = nowMs;
        const html = `
        <div class="wr-paper">
          <div class="wr-head">
            <div>
              <div class="wr-title">VOGA WEATHER REPORT</div>
              <div class="wr-sub">${mode === 'day' ? 'UTC day ' + wrDayYear(startMs) + ' (0000Z – 2400Z)' : '24-hour summary · last 24 h'} · ${WR_BLOCK_COUNT} blocks of ${WR_BLOCK_HOURS} hours</div>
            </div>
            <div class="wr-headr">
              <div class="wr-gen">Generated: ${wrDayYear(gen)}  ${wrHHMM(gen)}Z  <span>(IST ${wrISTHHMM(gen)})</span></div>
              <div class="wr-per">Period: ${wrDay(startMs)} ${wrHHMM(startMs)}Z  →  ${wrDay(axisEnd)} ${mode === 'day' ? '0000' : wrHHMM(axisEnd)}Z${mode === 'day' && endMs < axisEnd ? '  (today: data up to ' + wrHHMM(endMs) + 'Z)' : ''}</div>
            </div>
          </div>
          <div class="wr-overview">
            ${wrOverviewSVG(startMs, axisEnd, phen, condRuns, blocks)}
            <div class="wr-legend">
              <span><i style="background:${WR_C.grn}"></i>Normal: vis ≥ ${L.visAmb} m · BR / HZ / FU</span>
              <span><i style="background:${WR_C.amb}"></i>Watch: vis &lt; ${L.visAmb} m / RA, DZ etc. / wind ≥ ${Math.round(L.wsAmb)} kt / RVR &lt; ${L.rvrAmb} m / X-wind ≥ ${Math.round(L.cwAmb)} kt</span>
              <span><i style="background:${WR_C.red}"></i>Poor: TS / FG / vis &lt; ${L.visRed} m / RVR &lt; ${L.rvrRed} m / wind ≥ ${L.wsRed} kt / X-wind ≥ ${L.cwRed} kt</span>
            </div>
          </div>
          <div class="wr-grid">
            ${blocks.map(b => wrBlockHTML(b, L, runs, reports, phen, endMs)).join('')}
          </div>
          <div class="wr-foot">
            <div class="wr-foot-h">HOW THESE VALUES ARE OBTAINED</div>
            ${noBackend ? '<div class="wr-foot-warn">⚠ Backend history not reachable — wind / RVR values could not be loaded.</div>' : ''}
            <ul>
              ${windNotes}
              <li><b>Visibility, cloud base and weather (TS, FG, RA, BR…):</b> from METAR / SPECI reports (about every 30 min + SPECI), not continuous.
                  Weather start / end times are the report times, so can be off by up to 30 min. Cloud base = lowest layer reported (FEW/SCT/BKN/OVC/VV).</li>
              <li>Limits used for colours come from Settings: wind ${L.wsRed} kt · crosswind ${L.cwRed} kt · RVR ${L.rvrRed} m.</li>
            </ul>
          </div>
        </div>`;
        container.innerHTML = html;
      } catch (err) {
        console.error('Weather report build failed:', err);
        container.innerHTML = `<div class="snap-24h-note">⚠ Could not build the weather report (${escapeHtml(err.message || err)}). Check network/backend and try again.</div>`;
      }
    }

    // ── report period picker (Last 24 h  |  a chosen UTC day 0000–2400Z) ──
    function wrReload() {
      const c = document.getElementById('snap24hContainer');
      if (c) c.innerHTML = '<div class="snap-24h-loading">Loading weather report…</div>';
      buildAndInject24hSummary();
    }
    function wrInitPeriodUI() {
      const inp = document.getElementById('wrDate'), lastBtn = document.getElementById('wrBtnLast'), hint = document.getElementById('wrPeriodHint');
      if (!inp || !lastBtn) return;
      const DAYMS = 86400000, n = new Date();
      const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
      const fmt = ms => { const d = new Date(ms); return d.getUTCFullYear() + '-' + wrP2(d.getUTCMonth() + 1) + '-' + wrP2(d.getUTCDate()); };
      inp.max = fmt(today);
      inp.min = fmt(today - 6 * DAYMS);          // backend keeps 7 days; 6 days back is always a full day
      inp.value = '';
      wrPeriod = null;
      lastBtn.classList.add('active');
      hint.textContent = 'Date = UTC day (0000Z–2400Z). Backend keeps 7 days.';
      hint.classList.remove('wr-hint-warn');
      if (wrUiBound) return;
      wrUiBound = true;
      inp.addEventListener('change', () => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inp.value);
        if (!m) return;
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
        const t0 = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
        if (ms > t0 || ms < t0 - 6 * DAYMS) {
          hint.textContent = '⚠ Pick a date within the last 7 days (UTC).';
          hint.classList.add('wr-hint-warn');
          return;
        }
        hint.textContent = 'Date = UTC day (0000Z–2400Z). Backend keeps 7 days.';
        hint.classList.remove('wr-hint-warn');
        wrPeriod = { y: +m[1], m: +m[2], d: +m[3] };
        lastBtn.classList.remove('active');
        wrReload();
      });
      lastBtn.addEventListener('click', () => {
        wrPeriod = null; inp.value = '';
        lastBtn.classList.add('active');
        hint.textContent = 'Date = UTC day (0000Z–2400Z). Backend keeps 7 days.';
        hint.classList.remove('wr-hint-warn');
        wrReload();
      });
    }

    function buildSnapshotHTML() {
      const now = new Date();
      const utcStr = now.toUTCString().replace('GMT', 'UTC');
      document.getElementById('snap-time-hdr').textContent = `Weather Report ☔️· ${utcStr}`;

      function sv(id) {
        const el = document.getElementById(id);
        if (!el) return '—';
        let txt = '';
        el.childNodes.forEach(n => { if (n.nodeType === 3) txt += n.textContent; });
        return txt.trim() || '—';
      }

      function drow(lbl, val, colorCls) {
        return `<div class="snap-drow"><span class="snap-dlbl">${lbl}</span><span class="snap-dval ${colorCls||''}">${val}</span></div>`;
      }

      function rwyPanel(rwy, headerCls, tealLabel) {
        const d = latestData[rwy];

        // Print/PDF snapshot always uses 2-min average wind, regardless of
        // whatever instant/1min/10min mode is currently toggled on the live dashboard.
        const wd = d ? (getValueByMode(d, 'windDirection', '2min') ?? '—') : sv('r'+rwy+'-wd');
        const ws = d ? (getValueByMode(d, 'windSpeed', '2min') ?? '—') : sv('r'+rwy+'-ws');
        const wsNum = parseLeadingNumber(ws);
        const wsColor = wsNum !== null ? (wsNum >= 25 ? 'red' : wsNum >= 15 ? 'amber' : 'green') : '';

        const windComp2min = d ? getHeadCrossWind(d, '2min') : { hw: sv('r'+rwy+'-hw'), cw: sv('r'+rwy+'-cw') };
        const cw = windComp2min.cw;
        const cwNum = parseLeadingNumber(cw);
        const cwColor = cwNum !== null ? (Math.abs(cwNum) >= 15 ? 'red' : Math.abs(cwNum) >= 10 ? 'amber' : 'green') : '';

        const hw = windComp2min.hw;
        const hwStr = String(hw);
        const hwColor = hwStr.endsWith('T') ? 'red' : hwStr.endsWith('H') ? 'green' : '';

        const rvr = sv('r'+rwy+'-rvr');
        const rvrNum = parseLeadingNumber(rvr);
        const rvrColor = rvrNum !== null ? (rvrNum < 550 ? 'red' : rvrNum < 1000 ? 'amber' : 'green') : '';

        const mor = sv('r'+rwy+'-mor');
        const qnh = sv('r'+rwy+'-qnh');
        const qfe = sv('r'+rwy+'-qfe');
        const temp = sv('r'+rwy+'-temp');
        const hum = sv('r'+rwy+'-hum');
        const humNum = parseLeadingNumber(hum);
        const humColor = humNum !== null ? (humNum >= 95 ? 'red' : humNum >= 85 ? 'amber' : 'teal') : '';
        const dew = sv('r'+rwy+'-dew');
        const wsmax = d ? (d.windSpeed_maxTenMin_rounded ?? '—') : sv('r'+rwy+'-wsmax');
        const wsmin = d ? (d.windSpeed_minTenMin_rounded ?? '—') : sv('r'+rwy+'-wsmin');

        return `<div class="snap-panel">
          <div class="snap-panel-header ${headerCls}">RWY ${rwy} — ${tealLabel}</div>
          <div class="snap-panel-body">
            ${drow('Wind Direction (2min Avg)', wd + '°', 'cyan')}
            ${drow('Wind Speed (2min Avg)', ws + ' kt', wsColor)}
            ${drow('Headwind', hw, hwColor)}
            ${drow('Crosswind', cw, cwColor)}
            ${drow('Wind Speed Max (10min)', wsmax + ' kt', '')}
            ${drow('Wind Speed Min (10min)', wsmin + ' kt', '')}
            <div class="snap-drow" style="border-top:1px solid rgba(255,255,255,0.1);margin-top:4px;padding-top:4px;"></div>
            ${drow('RVR', rvr + ' m', rvrColor)}
            ${drow('MOR', mor + ' m', '')}
            ${drow('QNH', qnh + ' hPa', 'amber')}
            ${drow('QFE', qfe + ' hPa', '')}
            ${drow('Temp', temp + ' °C', '')}
            ${drow('Humidity', hum + ' %', humColor)}
            ${drow('Dew Point', dew + ' °C', 'teal')}
          </div>
        </div>`;
      }

      const metar = document.getElementById('metar-display')?.textContent?.trim() || '—';
      const status = document.getElementById('status')?.textContent || '—';

      const currentPanels = !WR_SHOW_CURRENT_PANELS ? '' : `
        <div class="snap-station-bar">
          <div class="snap-station-item"><span class="snap-station-lbl">Station</span><span class="snap-station-val">VOGA / MOPA — Goa</span></div>
          <div class="snap-station-item"><span class="snap-station-lbl">Time (UTC)</span><span class="snap-station-val">${utcStr}</span></div>
          <div class="snap-station-item"><span class="snap-station-lbl">Link Status</span><span class="snap-station-val">${status}</span></div>
        </div>
        <div class="snap-rwy-grid">
          ${rwyPanel('28','rwy28','Goa Intl')}
          ${rwyPanel('10','rwy10','Goa Intl')}
        </div>
        <div class="snap-metar-box">
          <div class="snap-metar-hdr">📡 LATEST METAR / SPECI</div>
          <div class="snap-metar-body">${escapeHtml(metar)}</div>
        </div>`;

      return `${currentPanels}
        <div class="snap-24h-section" id="snap24hContainer">
          <div class="snap-24h-loading">Loading weather report…</div>
        </div>`;
    }

    window.openSnapshot = function() {
      wrInitPeriodUI();   // resets to "Last 24 h"
      document.getElementById('snapshotContent').innerHTML = buildSnapshotHTML();
      document.getElementById('snapshotModal').classList.add('active');
      buildAndInject24hSummary(); // async, fills in #snap24hContainer when ready
    };

    window.closeSnapshot = function() {
      document.getElementById('snapshotModal').classList.remove('active');
    };

    window.downloadSnapshotPDF = async function() {
      const btn = document.querySelector('.snap-btn.btn-pdf');
      if (btn) { btn.textContent = '⏳ Generating…'; btn.disabled = true; }

      // Helper: load a script once
      function loadScript(src) {
        return new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }

      try {
        if (!window.jspdf) {
          await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        }
        if (!window.html2canvas) {
          await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
        }
        const { jsPDF } = window.jspdf;

        const sourceEl = document.getElementById('snapshotContent');
        if (!sourceEl) throw new Error('snapshotContent not found');

        // ── Clone the snapshot content off-screen and apply the same
        // print CSS rules (@media print) so html2canvas captures the
        // exact same visual layout as window.print() does. ──
        const clone = sourceEl.cloneNode(true);
        const wrapper = document.createElement('div');
        wrapper.id = 'pdf-export-wrapper';
        // A4 usable width at 96dpi-equivalent px for good canvas resolution
        const A4_W_MM = 210, MARGIN_MM = 5;   // thin page margin (report fills the page)
        const usableWidthMM = A4_W_MM - MARGIN_MM * 2;
        const PX_PER_MM = 3.78; // ~96dpi
        // Weather report is laid out at 1000px wide, then scaled onto the A4 width (wide enough that the page is width-limited => thin side margins)
        const targetWidthPx = 1000;

        wrapper.style.position = 'fixed';
        wrapper.style.left = '-99999px';
        wrapper.style.top = '0';
        wrapper.style.width = targetWidthPx + 'px';
        wrapper.style.background = '#fff';
        wrapper.style.color = '#000';
        wrapper.style.padding = '0';
        wrapper.className = 'pdf-export-print-styles';
        wrapper.appendChild(clone);
        document.body.appendChild(wrapper);

        // Re-apply the print-only classes/colors inline by toggling a
        // print-style stylesheet scoped to this wrapper.
        const styleTag = document.createElement('style');
        styleTag.textContent = `
          #pdf-export-wrapper, #pdf-export-wrapper *:not(.wr-paper):not(.wr-paper *) { color:#000; }
          #pdf-export-wrapper .snap-24h-section { margin:0 !important; }
          #pdf-export-wrapper #snapshotContent { padding:0 !important; overflow:visible !important; max-height:none !important; }
          #pdf-export-wrapper #snap-actions, #pdf-export-wrapper .snap-close { display:none !important; }
          #pdf-export-wrapper .snap-panel-header.rwy28 { background:#1565c0 !important; color:#fff !important; }
          #pdf-export-wrapper .snap-panel-header.rwy10 { background:#00695c !important; color:#fff !important; }
          #pdf-export-wrapper .snap-metar-hdr { background:#2e7d32 !important; color:#fff !important; }
          #pdf-export-wrapper .snap-panel-body { background:#f0f4f8 !important; padding:4px 8px !important; }
          #pdf-export-wrapper .snap-station-bar { background:#e3f2fd !important; padding:6px 10px !important; margin-bottom:8px !important; }
          #pdf-export-wrapper .snap-station-lbl { color:#555 !important; font-size:11px !important; }
          #pdf-export-wrapper .snap-station-val { color:#000 !important; font-size:12px !important; }
          #pdf-export-wrapper .snap-metar-body { color:#1b5e20 !important; background:#f1f8e9 !important; font-size:12px !important; padding:6px 10px !important; }
          #pdf-export-wrapper .snap-dlbl { font-size:12px !important; color:#444 !important; }
          #pdf-export-wrapper .snap-dval { font-size:13px !important; color:#000 !important; }
          #pdf-export-wrapper .snap-dval.red { color:#c62828 !important; }
          #pdf-export-wrapper .snap-24h-table { font-size:9px !important; border:1px solid #bbb !important; }
          #pdf-export-wrapper .snap-24h-table caption { font-size:10px !important; padding:3px 6px !important; color:#fff !important; }
          #pdf-export-wrapper .snap-24h-table.rwy28 caption { background:#1565c0 !important; }
          #pdf-export-wrapper .snap-24h-table.rwy10 caption { background:#00695c !important; }
          #pdf-export-wrapper .snap-24h-table.common caption { background:#5e35b1 !important; }
          #pdf-export-wrapper .snap-24h-table td.s24-val.red   { color:#c62828 !important; }
          #pdf-export-wrapper .snap-24h-table td.s24-val.amber { color:#a05a00 !important; }
          #pdf-export-wrapper .snap-24h-table td.s24-val.green { color:#1b5e20 !important; }
          #pdf-export-wrapper .snap-24h-table td.s24-val.cyan  { color:#01579b !important; }
          #pdf-export-wrapper .snap-24h-loading { display:none !important; }
        `;
        document.head.appendChild(styleTag);

        // Allow the browser a tick to layout the cloned, styled content
        await new Promise(r => setTimeout(r, 50));

        const canvas = await window.html2canvas(wrapper, {
          scale: 2,
          backgroundColor: '#ffffff',
          useCORS: true,
          windowWidth: targetWidthPx
        });

        // Cleanup the off-screen clone
        document.body.removeChild(wrapper);
        document.head.removeChild(styleTag);

        // ── Slice the tall canvas into A4-height pages ──────────────
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const A4_H_MM = 297;
        const usableHeightMM = A4_H_MM - MARGIN_MM * 2;

        const pageHeightPx = Math.floor(usableHeightMM * (canvas.width / usableWidthMM));
        const totalPages = Math.ceil(canvas.height / pageHeightPx);

        if (canvas.height <= pageHeightPx * 1.3) {
          // Weather report: keep everything on ONE A4 page (scale down a little if needed)
          let drawW = usableWidthMM;
          let drawH = canvas.height * (usableWidthMM / canvas.width);
          if (drawH > usableHeightMM) { const k = usableHeightMM / drawH; drawW *= k; drawH = usableHeightMM; }
          doc.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG',
            MARGIN_MM + (usableWidthMM - drawW) / 2, MARGIN_MM, drawW, drawH);
        } else {
          for (let page = 0; page < totalPages; page++) {
            if (page > 0) doc.addPage();

            const sliceCanvas = document.createElement('canvas');
            sliceCanvas.width = canvas.width;
            const sliceHeightPx = Math.min(pageHeightPx, canvas.height - page * pageHeightPx);
            sliceCanvas.height = sliceHeightPx;

            const ctx = sliceCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
            ctx.drawImage(
              canvas,
              0, page * pageHeightPx, canvas.width, sliceHeightPx,
              0, 0, canvas.width, sliceHeightPx
            );

            const imgData = sliceCanvas.toDataURL('image/jpeg', 0.92);
            const sliceHeightMM = sliceHeightPx * (usableWidthMM / canvas.width);
            doc.addImage(imgData, 'JPEG', MARGIN_MM, MARGIN_MM, usableWidthMM, sliceHeightMM);
          }
        }

        // ── Footer on last page ──────────────────────────────────────
        const now = new Date();
        const utcStr = now.toUTCString().replace('GMT', 'UTC');
        doc.setFontSize(7);
        doc.setTextColor(150, 150, 150);
        doc.text(
          'VOGA WEATHER REPORT · Generated ' + utcStr,
          MARGIN_MM, A4_H_MM - 2
        );

        const fname = `VOGA_Weather_Report_${wrFileTag || now.toISOString().slice(0,16).replace('T','_').replace(':','')}.pdf`;
        doc.save(fname);

      } catch (err) {
        console.error('PDF generation failed:', err);
        window.print();
      } finally {
        if (btn) { btn.textContent = '⬇ Download PDF'; btn.disabled = false; }
      }
    };

    window.copySnapshotText = function() {
      function sv(id) {
        const el = document.getElementById(id);
        if (!el) return '—';
        let txt = '';
        el.childNodes.forEach(n => { if (n.nodeType === 3) txt += n.textContent; });
        return txt.trim() || '—';
      }
      const r = (rwy) =>
        `--- Runway ${rwy} ---\nWD: ${sv('r'+rwy+'-wd')}° | WS: ${sv('r'+rwy+'-ws')} kt | HW: ${sv('r'+rwy+'-hw')} | CW: ${sv('r'+rwy+'-cw')}\nRVR: ${sv('r'+rwy+'-rvr')} m | MOR: ${sv('r'+rwy+'-mor')} m\nQNH: ${sv('r'+rwy+'-qnh')} hPa | QFE: ${sv('r'+rwy+'-qfe')} hPa\nTEMP: ${sv('r'+rwy+'-temp')} °C | HUM: ${sv('r'+rwy+'-hum')} % | DEW: ${sv('r'+rwy+'-dew')} °C`;
      const metar = document.getElementById('metar-display')?.textContent?.trim() || '—';
      const txt = `VOGA/MOPA DCWIS Snapshot — ${new Date().toUTCString()}\n\n${r('28')}\n\n${r('10')}\n\nMETAR: ${metar}`;
      navigator.clipboard?.writeText(txt).then(() => {
        const btn = document.getElementById('snapCopyBtn');
        if (btn) { btn.textContent = '✔ Copied!'; setTimeout(() => btn.textContent = '📋 Copy Text', 1800); }
      });
    };

    document.getElementById('snapshotModal').addEventListener('click', function(e) {
      if (e.target === this) closeSnapshot();
    });

    // ═══════════════════════════════════════════════════════════════
    //  RADAR PRECIPITATION OUTLOOK MODAL (replaces the retired satellite
    //  cloud-analysis feature — same /cloud endpoint, but the backend
    //  file it reads is now written by radar.py's cell-tracking output
    //  instead of the old satellite pipeline. server.py is untouched.)
    // ═══════════════════════════════════════════════════════════════
    function radarCategoryDisplay(cat){
      if(!cat || cat === 'no_significant_echo') return { label:'None', cls:'none', lightning:false };
      const lightning = cat.includes('lightning_likely');
      const base = cat.replace('_lightning_likely','');
      let cls = 'light';
      if(base.startsWith('heavy')) cls = 'heavy';
      else if(base.startsWith('moderate')) cls = 'moderate';
      const kindWord = base.includes('shower') ? 'Shower' : (base.includes('rain') ? 'Rain' : '');
      const intensityWord = cls.charAt(0).toUpperCase()+cls.slice(1);
      const label = kindWord ? `${intensityWord} ${kindWord}` : intensityWord;
      return { label, cls, lightning };
    }

    function formatRadarTime(isoStr){
      if(!isoStr) return '—';
      try {
        const d = new Date(isoStr);
        if(isNaN(d.getTime())) return isoStr;
        return d.toUTCString().replace(':00 GMT','Z').replace(' GMT','Z');
      } catch(e){ return isoStr; }
    }

    function mergeCellsForDisplay(tracks, vicinity){
      // Tracks carry heading (direction of motion); vicinity entries don't.
      // A track's cell very often also appears in the vicinity list (same
      // physical cell, within 20km) — dedupe those by proximity so each
      // real cell shows once, keeping the richer (heading-bearing) version.
      const merged = tracks.map(t => ({
        range_km: t.range_km, bearing: t.bearing, category: t.category,
        heading: t.heading || null, dbz: t.dbz
      }));
      (vicinity || []).forEach(v => {
        const isDup = merged.some(m => m.bearing === v.bearing && Math.abs(m.range_km - v.range_km) < 1.5);
        if(!isDup){
          merged.push({ range_km: v.range_km, bearing: v.bearing, category: v.category, heading: null, dbz: v.dbz });
        }
      });
      merged.sort((a,b) => (a.range_km ?? 1e9) - (b.range_km ?? 1e9));
      return merged;
    }

    function buildCellCard(c){
      const cat = radarCategoryDisplay(c.category);
      return `
        <div class="ro-cell-card">
          <div class="ro-cell-top">
            <div class="ro-cell-loc">${c.bearing || '—'} · ${c.range_km ?? '—'} km</div>
            <span class="ro-badge ${cat.cls}">${cat.label}${cat.lightning ? ' ⚡' : ''}</span>
          </div>
          <div class="ro-cell-detail-row"><span>Heading</span><b>${c.heading || '—'}</b></div>
          <div class="ro-cell-detail-row"><span>Reflectivity</span><b>${c.dbz ?? '—'} dBZ</b></div>
        </div>
      `;
    }

    function buildRadarOutlookHTML(data){
      const headline = data.headline || 'No outlook available.';
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      const vicinity = Array.isArray(data.vicinity) ? data.vicinity : [];
      const merged = mergeCellsForDisplay(tracks, vicinity);

      const gridHTML = merged.length
        ? `<div class="ro-cell-grid">${merged.map(buildCellCard).join('')}</div>`
        : `<div class="ro-empty">Nothing detected nearby right now.</div>`;

      const framesUsed = data.frames_used ?? '—';
      const latestFrame = formatRadarTime(data.latest_frame_time);
      const generatedAt = formatRadarTime(data.generated_at);

      return `
        <div class="ro-headline">
          <span class="ro-headline-icon">🌧️</span>
          <span class="ro-headline-text">${headline}</span>
        </div>
        <div class="ro-grid-wrap">
          <div class="ro-section-hdr">Nearby Cells — nearest first</div>
          ${gridHTML}
        </div>
        <div class="ro-footer">Radar frame: ${latestFrame} · ${framesUsed} frame(s) analyzed · Generated ${generatedAt}</div>
      `;
    }

    let lastCloudData = null;

    async function fetchAndRenderCloudInfo() {
      const content = document.getElementById('cloudContent');
      const timeHdr = document.getElementById('cloud-time-hdr');
      try {
        const res = await fetch(`${API_BASE}${CLOUD_ENDPOINT}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        lastCloudData = data;
        timeHdr.textContent = `MOPA radar — ${formatRadarTime(data.latest_frame_time)}`;
        content.innerHTML = buildRadarOutlookHTML(data);
      } catch (err) {
        console.error('Radar outlook fetch failed:', err);
        timeHdr.textContent = 'Unavailable';
        content.innerHTML = `<div class="ro-empty" style="color:#ff5252;">⚠ Could not load radar outlook.<br>Backend / radar pipeline may be unreachable.</div>`;
      }
    }

    window.openCloudInfo = function() {
      document.getElementById('cloudModal').classList.add('active');
      document.getElementById('cloudContent').innerHTML = `<div class="ro-empty">Loading…</div>`;
      fetchAndRenderCloudInfo();
    };

    window.closeCloudInfo = function() {
      document.getElementById('cloudModal').classList.remove('active');
    };

    document.getElementById('cloudModal').addEventListener('click', function(e) {
      if (e.target === this) closeCloudInfo();
    });

    // ═══════════════════════════════════════════════════════════════
    //  LIVE RAIN RADAR MODAL
    //  Opens a popup covering 80% of the viewport showing the radar
    //  image. A fresh cache-busting query param is appended on every
    //  open so the browser always fetches the latest image instead of
    //  ever showing a stale cached copy.
    // ═══════════════════════════════════════════════════════════════
    const RADAR_IMAGE_BASE = 'https://lh3.googleusercontent.com/d/101Ahh08Ykc2uIpCAS6hR1RXpgbGMfYiC=w1078-h2156?authuser=0';

    window.openRadarModal = function(){
      const modal = document.getElementById('radarModal');
      const img = document.getElementById('radarImg');
      const loadingMsg = document.getElementById('radarLoadingMsg');
      const errorMsg = document.getElementById('radarErrorMsg');
      const timeHdr = document.getElementById('radar-time-hdr');

      modal.classList.add('active');
      img.style.display = 'none';
      errorMsg.style.display = 'none';
      loadingMsg.style.display = 'block';
      loadingMsg.textContent = 'Loading radar image…';
      timeHdr.textContent = 'Fetching latest…';

      const freshUrl = `${RADAR_IMAGE_BASE}&cb=${Date.now()}`;

      img.onload = function(){
        loadingMsg.style.display = 'none';
        errorMsg.style.display = 'none';
        img.style.display = 'block';
        timeHdr.textContent = 'Updated ' + new Date().toUTCString();
      };
      img.onerror = function(){
        loadingMsg.style.display = 'none';
        img.style.display = 'none';
        errorMsg.style.display = 'block';
        timeHdr.textContent = 'Unavailable';
      };
      img.src = freshUrl;
    };

    window.closeRadarModal = function(){
      document.getElementById('radarModal').classList.remove('active');
    };

    document.getElementById('radarModal').addEventListener('click', function(e) {
      if (e.target === this) closeRadarModal();
    });

    // ═══════════════════════════════════════════════════════════════
    //  FLIGHT ARRIVALS/DEPARTURES MODAL
    // ═══════════════════════════════════════════════════════════════
    const FLIGHT_ENDPOINT = 'https://www.ajayydv.shop/data/flight';
    let flightRefreshTimer = null;

    function flMinutesLabel(mins){
      if(mins === null || mins === undefined || isNaN(mins)) return '—';
      const m = Math.round(mins);
      if(m < 0) return Math.abs(m) + 'm ago';
      if(m < 60) return 'in ' + m + 'm';
      const h = Math.floor(m/60), rem = m % 60;
      return 'in ' + h + 'h' + (rem ? ' ' + rem + 'm' : '');
    }

    function flStatusBadge(status){
      const s = (status || '').trim().toUpperCase();
      if(!s) return '<span class="fl-badge fl-badge-none">SCHEDULED</span>';
      if(s === 'BOARDING') return '<span class="fl-badge fl-badge-board">BOARDING</span>';
      if(s === 'FCL') return '<span class="fl-badge fl-badge-fcl">FINAL CALL</span>';
      if(s.includes('DELAY')) return '<span class="fl-badge fl-badge-delay">'+escapeHtml(s)+'</span>';
      if(s.includes('CANCEL')) return '<span class="fl-badge fl-badge-cancel">'+escapeHtml(s)+'</span>';
      if(s.includes('LAND') || s.includes('DEPART')) return '<span class="fl-badge fl-badge-done">'+escapeHtml(s)+'</span>';
      return '<span class="fl-badge fl-badge-none">'+escapeHtml(s)+'</span>';
    }

    // Flight time/date display: keep the local/IST value exactly as supplied
    // by the backend, and ALWAYS show the corresponding UTC value in brackets.
    // Supports HH:MM, HHMM and ISO datetime strings. If a date is supplied,
    // the UTC date is shown as well.
    function flUtcFromTime(value, dateValue){
      if(value === null || value === undefined) return null;
      const raw = String(value).trim();
      if(!raw || raw === '--:--' || raw === '----' || raw === '—') return null;

      // Full ISO / date-time with timezone or Z.
      if(/[T ]/.test(raw) && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(raw)){
        const d = new Date(raw);
        if(!isNaN(d.getTime())) return d;
      }

      // HH:MM / HHMM. Interpret it on the supplied date (or today) in IST,
      // then convert to UTC. This is correct for Goa/India flight timings.
      const m = raw.match(/^(\d{1,2}):?(\d{2})$/);
      if(m){
        const hh = Number(m[1]), mm = Number(m[2]);
        if(hh > 23 || mm > 59) return null;
        let y, mo, da;
        const ds = String(dateValue || '').trim();
        let dm = ds.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if(dm){ y=+dm[1]; mo=+dm[2]; da=+dm[3]; }
        else {
          const now = new Date();
          y=now.getFullYear(); mo=now.getMonth()+1; da=now.getDate();
        }
        // Date.UTC for 18:30 IST => 13:00 UTC.
        return new Date(Date.UTC(y, mo-1, da, hh-5, mm-30, 0));
      }
      return null;
    }

    function flUtcLabel(value, dateValue, includeDate=false){
      const d = flUtcFromTime(value, dateValue);
      if(!d) return '';
      const dd = String(d.getUTCDate()).padStart(2,'0');
      const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
      const yyyy = d.getUTCFullYear();
      const hh = String(d.getUTCHours()).padStart(2,'0');
      const mm = String(d.getUTCMinutes()).padStart(2,'0');
      return includeDate ? `${dd} ${mo} ${yyyy} ${hh}:${mm} UTC` : `${hh}:${mm} UTC`;
    }

    function flDisplayTime(value, dateValue, includeDate=false){
      const raw = String(value ?? '').trim();
      if(!raw || raw === '--:--' || raw === '----' || raw === '—') return '—';
      const utc = flUtcLabel(raw, dateValue, includeDate);
      return utc ? `${raw} <span class="fl-utc-time">(${escapeHtml(utc)})</span>` : escapeHtml(raw);
    }

    function flTimeBlock(f){
      const est = f.estimated_time && f.estimated_time !== '--:--';
      const act = f.actual_time && f.actual_time !== '--:--';
      const primary = act ? f.actual_time : (est ? f.estimated_time : f.scheduled_time);
      const showSched = (act || est) && primary !== f.scheduled_time;
      const dateValue = f.date || f.flight_date || f.scheduled_date || f.arrival_date || f.departure_date || '';
      return `<span class="fl-time-primary">${flDisplayTime(primary, dateValue)}</span>` +
             (showSched ? `<span class="fl-time-sched">sch ${flDisplayTime(f.scheduled_time, dateValue)}</span>` : '');
    }

    function flHeroCard(f, label, cls){
      if(!f){
        return `<div class="fl-hero-card ${cls}"><div class="fl-hero-lbl">${label}</div><div class="fl-hero-empty">No flight in window</div></div>`;
      }
      return `<div class="fl-hero-card ${cls}">
        <div class="fl-hero-lbl">${label}</div>
        <div class="fl-hero-flight">${escapeHtml(f.flight_no || '—')}</div>
        <div class="fl-hero-loc">${escapeHtml(f.location || '—')}</div>
        <div class="fl-hero-time">${flTimeBlock(f)} <span class="fl-hero-countdown">${flMinutesLabel(f.minutes_from_now)}</span></div>
        <div class="fl-hero-meta">${flStatusBadge(f.status)} <span class="fl-hero-gate">Gate/Belt ${escapeHtml(f.gate_belt || '—')}</span></div>
      </div>`;
    }

    function flRow(f){
      return `<div class="fl-row">
        <div class="fl-row-time">${flTimeBlock(f)}</div>
        <div class="fl-row-main">
          <div class="fl-row-flight">${escapeHtml(f.flight_no || '—')}</div>
          <div class="fl-row-loc">${escapeHtml(f.location || '—')}</div>
        </div>
        <div class="fl-row-gate">${escapeHtml(f.gate_belt || '—')}</div>
        <div class="fl-row-badge">${flStatusBadge(f.status)}</div>
        <div class="fl-row-countdown">${flMinutesLabel(f.minutes_from_now)}</div>
      </div>`;
    }

    function flAgeLabel(sec){
      if(sec === null || sec === undefined || isNaN(sec)) return '—';
      const s = Math.round(sec);
      if(s < 60) return s + 's ago';
      return Math.round(s/60) + 'm ago';
    }

    function buildFlightHTML(data){
      const arrivals = Array.isArray(data.arrivals) ? data.arrivals : [];
      const departures = Array.isArray(data.departures) ? data.departures : [];
      const nextArr = arrivals[0] || null;
      const nextDep = departures[0] || null;
      const windowHours = data.window_hours ?? '—';

      const arrList = arrivals.length
        ? arrivals.map(flRow).join('')
        : `<div class="fl-empty">No arrivals in the next ${escapeHtml(String(windowHours))}h.</div>`;
      const depList = departures.length
        ? departures.map(flRow).join('')
        : `<div class="fl-empty">No departures in the next ${escapeHtml(String(windowHours))}h.</div>`;

      const staleNote = data.stale
        ? `<div class="fl-stale-note">⚠ Data may be stale — last updated ${flAgeLabel(data.data_age_seconds)}.</div>`
        : '';

      return `
        <div class="fl-hero-grid">
          ${flHeroCard(nextArr, '🛬 NEXT ARRIVAL', 'arr')}
          ${flHeroCard(nextDep, '🛫 NEXT DEPARTURE', 'dep')}
        </div>
        ${staleNote}
        <div class="fl-lists-grid">
          <div class="fl-list-col">
            <div class="fl-list-hdr arr">Arrivals (${data.counts ? data.counts.arrivals : arrivals.length})</div>
            ${arrList}
          </div>
          <div class="fl-list-col">
            <div class="fl-list-hdr dep">Departures (${data.counts ? data.counts.departures : departures.length})</div>
            ${depList}
          </div>
        </div>
        <div class="fl-footer">Source: ${escapeHtml(data.source || '—')} · Updated ${flAgeLabel(data.data_age_seconds)} · ${escapeHtml(data.generated_at_ist || '')}${data.generated_at_ist ? ` <span class="fl-footer-utc">(${escapeHtml((() => { const d=new Date(data.generated_at_ist); return !isNaN(d.getTime()) ? d.toISOString().replace('T',' ').slice(0,16)+' UTC' : ''; })())})</span>` : ''}</div>
      `;
    }

    async function fetchAndRenderFlightInfo(){
      const content = document.getElementById('flightContent');
      const timeHdr = document.getElementById('flight-time-hdr');
      if(!content || !timeHdr) return;
      try {
        const res = await fetch(FLIGHT_ENDPOINT + '?t=' + Date.now(), { cache: 'no-store' });
        if(!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        const nextArr = (data.arrivals && data.arrivals[0]) || null;
        const nextDep = (data.departures && data.departures[0]) || null;
        const arrTime = nextArr ? flDisplayTime(nextArr.scheduled_time, nextArr.date || nextArr.flight_date || nextArr.arrival_date || '') : '';
        const depTime = nextDep ? flDisplayTime(nextDep.scheduled_time, nextDep.date || nextDep.flight_date || nextDep.departure_date || '') : '';
        const arrLbl = nextArr ? `🛬 ${nextArr.flight_no || '—'} · ${arrTime} (${flMinutesLabel(nextArr.minutes_from_now)})` : '🛬 No upcoming arrival';
        const depLbl = nextDep ? `🛫 ${nextDep.flight_no || '—'} · ${depTime} (${flMinutesLabel(nextDep.minutes_from_now)})` : '🛫 No upcoming departure';
        timeHdr.innerHTML = `${arrLbl}   |   ${depLbl}`;

        content.innerHTML = buildFlightHTML(data);
      } catch (err) {
        console.error('Flight info fetch failed:', err);
        timeHdr.textContent = 'Unavailable';
        content.innerHTML = `<div class="fl-empty" style="color:#ff5252;">⚠ Could not load flight data.<br>Backend may be unreachable.</div>`;
      }
    }

    window.openFlightInfo = function(){
      const modal = document.getElementById('flightModal');
      if(!modal) return;
      modal.classList.add('active');
      document.getElementById('flightContent').innerHTML = `<div class="fl-empty">Loading…</div>`;
      fetchAndRenderFlightInfo();
      if(flightRefreshTimer) clearInterval(flightRefreshTimer);
      flightRefreshTimer = setInterval(() => {
        if(modal.classList.contains('active')) fetchAndRenderFlightInfo();
      }, 60000);
    };

    window.closeFlightInfo = function(){
      const modal = document.getElementById('flightModal');
      if(modal) modal.classList.remove('active');
      if(flightRefreshTimer) {
        clearInterval(flightRefreshTimer);
        flightRefreshTimer = null;
      }
    };

    document.getElementById('flightModal')?.addEventListener('click', function(e){
      if (e.target === this) closeFlightInfo();
    });

    // ═══════════════════════════════════════════════════════════════
    //  FEATURE 6 — METAR COPY BUTTON
    // ═══════════════════════════════════════════════════════════════
    window.copyMetar = function() {
      const txt = document.getElementById('metar-display')?.textContent?.trim();
      if (!txt || txt === 'Loading METAR...') return;
      navigator.clipboard?.writeText(txt).then(() => {
        const btn = document.getElementById('metar-copy-btn');
        if (btn) {
          btn.textContent = '✔';
          btn.style.color = '#ffffff';
          setTimeout(() => {
            btn.textContent = '📋';
            btn.style.color = '';
          }, 1800);
        }
      });
    };

    window.addEventListener('beforeunload', () => {
      if(autoRefreshInterval) clearInterval(autoRefreshInterval);
      if(metarInterval) clearInterval(metarInterval);
      if(modalRefreshInterval) clearInterval(modalRefreshInterval);
      if(chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
      }
    });
