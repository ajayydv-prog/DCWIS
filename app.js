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
    const RUNWAY_HEADING = { '28': 280, '10': 100 };
    let isDark = true;
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
    let currentBin = 60;
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
      document.querySelector('[onclick="toggleTheme()"]').textContent = isDark ? '☀' : '🌙';
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
    function _metarWeatherCloudsTemp(e, parts) {
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
        const q = Math.floor(parseFloat(e.qnh));
        if (!isNaN(q)) parts.push('Q' + q);
      }
      if (e.trend) parts.push(e.trend);
    }

    // Register/live format: activervr1/2 = runway number ("28","10") when active, empty when not
    function buildMetarText(e) {
      const parts = [(e.selectedOption || 'METAR'), 'VOGA', (e.time || '----') + 'Z'];
      _metarWindCloud(e, parts);
      if (e.activervr1 && e.rvr1) {
        parts.push('R' + String(e.activervr1).padStart(2, '0') + '/' + e.rvr1);
      }
      if (e.activervr2 && e.rvr2) {
        parts.push('R' + String(e.activervr2).padStart(2, '0') + '/' + e.rvr2);
      }
      _metarWeatherCloudsTemp(e, parts);
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
        })
        .catch(err => {
          console.error('METAR fetch error:', err);
          metarDisplay.textContent = '⚠ METAR unavailable';
          metarDisplay.style.color = '#ff4444';
        });
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
        const lines = entries.map(e => buildMetarText(e));
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
      // translucent wash instead of opaque fill, so the compass-cell's
      // frosted-glass background shows through behind the dial
      ctx.fillStyle = isDarkMode ? 'rgba(4,9,15,0.38)' : 'rgba(232,240,248,0.38)';
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
    //  RESIZE
    // ═══════════════════════════════════════════════════════════════
    function resizeLayout(){
      document.querySelectorAll('.panel').forEach(panel=>{
        const pb=panel.querySelector('.pb');
        if(!pb) return;
        const totalH=pb.getBoundingClientRect().height;
        if(totalH<10) return;
        const windRow=pb.querySelector('.wind-row');
        const rangeRow=pb.querySelector('.range-row');
        const dataRows=pb.querySelectorAll('.data-row');
        const windH=Math.round(totalH*0.32);
        const rangeH = rangeRow ? Math.max(rangeRow.getBoundingClientRect().height, 30) : 30;
        const remaining=totalH-windH-rangeH;
        const perData=Math.floor(remaining/dataRows.length);
        if(windRow) windRow.style.height=Math.max(windH, 70)+'px';
        dataRows.forEach(r=>r.style.height=Math.max(perData, 55)+'px');
      });
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
        return null;
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
      el.classList.remove('sev-orange', 'sev-red');
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
      if (rwy === '10') {
        renderFogRiskBadge(rwy, 'fogrisk10', temp, dew, ws);
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
        const bins = clampNonNegativeBins(await fetchHistoryFromBackend(rwy, param, currentHours, currentBin), param);
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

        const binText = currentBin === 60 ? '1-min' :
                        currentBin === 120 ? '2-min' :
                        currentBin === 600 ? '10-min' :
                        currentBin === 1800 ? '30-min' :
                        currentBin === 3600 ? '1-hour' : '3-hour';

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
                  text: `Time (UTC - last ${currentHours} hours, ${binText} bins)`, 
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
        btn.textContent = trendViewActive ? '📡' : '📈';
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
      
      const binText = currentBin === 60 ? '1-min' :
                      currentBin === 120 ? '2-min' :
                      currentBin === 600 ? '10-min' :
                      currentBin === 1800 ? '30-min' :
                      currentBin === 3600 ? '1-hour' : '3-hour';
      
      modalTitle.innerHTML =
        `${displayName} <small>Runway ${rwy} · ${currentHours}H trend (${binText} bins)</small>`;

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
      document.body.classList.add('dark');
      document.querySelector('[onclick="toggleTheme()"]').textContent = '☀';
      
      resizeLayout();
      window.addEventListener('resize', resizeLayout);
      setupClickHandlers();
      fetchData();
      startAutoRefresh();

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeHistory(); closeArchive(); }
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
      if (level === 'critical') {
        // Two short high beeps
        playAlert(880, 0.22, 'square');
        setTimeout(() => playAlert(880, 0.22, 'square'), 350);
      } else {
        playAlert(660, 0.3, 'sine');
      }
    }

    // Alert state tracking
    const alertStates = {};
    let alertDismissed = false;
    let alertDismissTimer = null;

    const ALERT_DEFS = [
      { id: 'cw28',  label: 'RWY 28 CROSSWIND', rwy: '28', type: 'crosswind',   limit: 15, dir: 'above', useAbs: true,  level: 'critical' },
      { id: 'cw10',  label: 'RWY 10 CROSSWIND', rwy: '10', type: 'crosswind',   limit: 15, dir: 'above', useAbs: true,  level: 'critical' },
      { id: 'rvr28', label: 'RWY 28 RVR',       rwy: '28', type: 'rvr',        limit: 550, dir: 'below', useAbs: false, level: 'critical' },
      { id: 'rvr10', label: 'RWY 10 RVR',       rwy: '10', type: 'rvr',        limit: 550, dir: 'below', useAbs: false, level: 'critical' },
      { id: 'ws28',  label: 'RWY 28 WIND SPEED',rwy: '28', type: 'windSpeed',  limit: 25,  dir: 'above', useAbs: false, level: 'warn' },
      { id: 'ws10',  label: 'RWY 10 WIND SPEED',rwy: '10', type: 'windSpeed',  limit: 25,  dir: 'above', useAbs: false, level: 'warn' },
    ];

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
      ALERT_DEFS.forEach(def => {
        const data = latestData[def.rwy];
        const val = getAlertValue(def, data);
        const breached = isAlertBreached(def, val);
        const wasBreached = !!alertStates[def.id];
        alertStates[def.id] = breached;
        if (breached && !wasBreached) {
          playAlertSequence(def.level);
        }
        if (breached) {
          const dispVal = val !== null ? (def.useAbs ? Math.abs(val) : val) : '—';
          const unit = { crosswind:'kt', rvr:'m', windSpeed:'kt' }[def.type] || '';
          activeAlerts.push(`⚠ ${def.label}: ${dispVal}${unit}`);
        }
      });

      if (activeAlerts.length > 0) {
        alertOverlay.classList.add('alert-active');
        alertBanner.classList.add('banner-active');
        alertBanner.innerHTML = activeAlerts.join('&emsp;|&emsp;') +
          `&emsp;<span onclick="dismissAlert()" style="cursor:pointer;opacity:0.7;font-size:0.85em">✕ Dismiss</span>`;
      } else {
        alertOverlay.classList.remove('alert-active');
        alertBanner.classList.remove('banner-active');
        alertBanner.innerHTML = '';
        alertDismissed = false;
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
    //  24H SUMMARY — data gathering (register-based + backend history)
    // ═══════════════════════════════════════════════════════════════

    // Harsh-weather priority ranking (high → low severity). Each entry is
    // checked against e.weather via simple substring/regex match, most
    // specific (longest / most qualified) patterns first within each tier.
    const WEATHER_PRIORITY = [
      { rank: 1,  test: /\+TS(RA|GR)?/,            label: 'Severe Thunderstorm' },
      { rank: 2,  test: /(?<!\+)TS(RA)?/,          label: 'Thunderstorm' },
      { rank: 3,  test: /(\+SHRA|\+RA|GR)/,        label: 'Heavy Rain/Showers/Hail' },
      { rank: 4,  test: /(FZRA|FZFG)/,             label: 'Freezing Rain/Fog' },
      { rank: 5,  test: /(?<!\w)FG(?!\w)/,         label: 'Fog' },
      { rank: 6,  test: /(SHRA|(?<!-)RA(?!\w)|DZ)/,label: 'Showers/Rain/Drizzle' },
      { rank: 7,  test: /(BCFG|PRFG|MIFG)/,        label: 'Patchy/Shallow Fog' },
      { rank: 8,  test: /(?<!\w)BR(?!\w)/,         label: 'Mist' },
      { rank: 9,  test: /(?<!\w)HZ(?!\w)/,         label: 'Haze' },
      { rank: 10, test: /(-RA|-DZ|-SHRA)/,         label: 'Light Rain/Drizzle' }
    ];

    function classifyWeatherCode(raw) {
      if (!raw) return null;
      const s = String(raw).trim().toUpperCase();
      if (!s) return null;
      for (const tier of WEATHER_PRIORITY) {
        if (tier.test.test(s)) return tier;
      }
      return null;
    }

    function registerEntryTimeLabel(e) {
      const t = String(e.time || '').padStart(4, '0');
      return t.length >= 4 ? `${t.slice(0,2)}:${t.slice(2,4)}Z` : '—';
    }

    // Fetch + flatten the register entries needed to cover the last 24h.
    async function fetch24hRegisterEntries() {
      return fetchMetarHistoryFromRegister(24); // newest-first array of raw entries
    }

    // ─── Max reported wind gust (24h), restricted to entries where the
    //     given runway's RVR was the active one (register OR archive format) ───
    function getMaxWindGust24h(rwy, entries) {
      let best = null;
      entries.forEach(e => {
        const isActiveForRwy =
          String(e.activervr1) === rwy || String(e.activervr2) === rwy ||   // live register format
          (rwy === '28' && e.activervr1 === '1') ||                         // archive format
          (rwy === '10' && e.activervr2 === '1');
        if (!isActiveForRwy) return;
        const g = parseLeadingNumber(e.maxwind);
        if (g === null) return;
        if (!best || g > best.value) {
          best = { value: g, time: registerEntryTimeLabel(e) };
        }
      });
      return best; // { value, time } | null
    }

    // ─── Common airfield block: lowest visibility, lowest cloud base, harshest weather ───
    function getCommonAirfield24h(entries) {
      let lowestVis = null;     // { value, time, isGood }
      let lowestCloud = null;   // { value, time, raw }
      let harshest = null;      // { rank, label, raw, time }

      const CLOUD_RE = /^(FEW|SCT|BKN|OVC)(\d{3})/;

      entries.forEach(e => {
        // Visibility
        if (e.visibility !== undefined && e.visibility !== null && e.visibility !== '') {
          const good = isGoodVisibilityReading(e.visibility);
          const v = parseVisibilityForFogCheck(e.visibility);
          if (!good && v !== null) {
            if (!lowestVis || v < lowestVis.value) {
              lowestVis = { value: v, time: registerEntryTimeLabel(e), isGood: false };
            }
          }
        }
        // Cloud base — lowest among FEW/SCT/BKN/OVC layers reported in this entry
        ['cloud1','cloud2','cloud3','cloud4'].forEach(c => {
          const raw = e[c];
          if (!raw) return;
          const m = CLOUD_RE.exec(String(raw).toUpperCase());
          if (!m) return;
          const baseFt = parseInt(m[2], 10) * 100;
          if (!lowestCloud || baseFt < lowestCloud.value) {
            lowestCloud = { value: baseFt, time: registerEntryTimeLabel(e), raw: raw };
          }
        });
        // Harshest weather phenomenon
        const tier = classifyWeatherCode(e.weather);
        if (tier && (!harshest || tier.rank < harshest.rank)) {
          harshest = { rank: tier.rank, label: tier.label, raw: e.weather, time: registerEntryTimeLabel(e) };
        }
      });

      return { lowestVis, lowestCloud, harshest };
    }

    // ─── Per-runway 24h table rows: wind/headwind from backend history (MIN/MAX
    //     aggregation), gust from register, and avg-based placeholders for
    //     RVR/MOR/Temp/Humidity/Spread until the backend MIN/MAX upgrade lands ───
    async function build24hRunwayData(rwy, registerEntries) {
      const [wsBins, hwBins, rvrBins, morBins, tempBins, humBins] = await Promise.all([
        fetchHistoryFromBackend(rwy, 'windSpeed', 24, 3600),
        fetchComputedWindComponentHistory(rwy, 'headwind', 24, 3600),
        fetchHistoryFromBackend(rwy, 'rvr', 24, 3600),
        fetchHistoryFromBackend(rwy, 'mor', 24, 3600),
        fetchHistoryFromBackend(rwy, 'temperature', 24, 3600),
        fetchHistoryFromBackend(rwy, 'humidity', 24, 3600)
      ]);

      function minMaxOf(bins, key) {
        let mn = null, mx = null, mnT = null, mxT = null;
        bins.forEach(b => {
          const hasRange = b.min !== undefined && b.min !== null && b.max !== undefined && b.max !== null;
          const lo = hasRange ? b.min : b.value;
          const hi = hasRange ? b.max : b.value;
          if (lo === undefined || lo === null || isNaN(lo)) return;
          if (mn === null || lo < mn) { mn = lo; mnT = b.min_timestamp ?? b.timestamp; }
          if (mx === null || hi > mx) { mx = hi; mxT = b.max_timestamp ?? b.timestamp; }
        });
        return { min: mn, max: mx, minTs: mnT, maxTs: mxT };
      }

      // Backend bin timestamps are epoch seconds (UTC); format directly.
      function fmtEpochSec(ts) {
        if (ts === undefined || ts === null) return '—';
        const d = new Date(ts * 1000);
        if (isNaN(d.getTime())) return '—';
        return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + 'Z';
      }

      const ws = minMaxOf(wsBins);
      const hw = minMaxOf(hwBins);
      const rvr = minMaxOf(rvrBins);
      const mor = minMaxOf(morBins);
      const temp = minMaxOf(tempBins);
      const hum = minMaxOf(humBins);
      const gust = getMaxWindGust24h(rwy, registerEntries);

      // Fog-risk spread: derive from temp/hum bins isn't possible without dew
      // point history; reuse min temp & corresponding humidity as an approx
      // unless dew point history is available.
      const dewBins = await fetchHistoryFromBackend(rwy, 'dewPoint', 24, 3600);
      const dew = minMaxOf(dewBins);
      let minSpread = null;
      if (temp.min !== null && dew.max !== null) {
        // Worst-case (smallest) spread isn't simply min(temp)-max(dew) across
        // *different* timestamps, but it's the best available approximation
        // without per-bin paired temp/dew samples.
        minSpread = Math.round((temp.min - dew.max) * 10) / 10;
      }

      return {
        rwy,
        wsMax: ws.max, wsMaxT: fmtEpochSec(ws.maxTs),
        wsMin: ws.min, wsMinT: fmtEpochSec(ws.minTs),
        hwMax: hw.max, hwMaxT: fmtEpochSec(hw.maxTs),
        gust,
        rvrMin: rvr.min, rvrMinT: fmtEpochSec(rvr.minTs),
        morMin: mor.min, morMinT: fmtEpochSec(mor.minTs),
        tempMax: temp.max, tempMaxT: fmtEpochSec(temp.maxTs),
        tempMin: temp.min, tempMinT: fmtEpochSec(temp.minTs),
        humMax: hum.max, humMaxT: fmtEpochSec(hum.maxTs),
        humMin: hum.min, humMinT: fmtEpochSec(hum.minTs),
        minSpread
      };
    }

    function s24row(lbl, val, unit, colorCls, timeStr, approx) {
      const valDisp = (val === null || val === undefined || val === '—') ? '—' : `${val}${unit||''}`;
      return `<tr>
        <td class="s24-lbl">${lbl}${approx ? ' <span class="s24-approx">(approx)</span>' : ''}</td>
        <td class="s24-val ${colorCls||''}">${valDisp}</td>
        <td class="s24-time">${timeStr || '—'}</td>
      </tr>`;
    }

    function buildRunway24hTable(d, headerCls, label) {
      const wsMaxColor = d.wsMax !== null ? (d.wsMax >= 25 ? 'red' : d.wsMax >= 15 ? 'amber' : 'green') : '';
      const hwMaxColor = d.hwMax !== null ? (Math.abs(d.hwMax) >= 30 ? 'red' : Math.abs(d.hwMax) >= 20 ? 'amber' : 'green') : '';
      const gustColor = d.gust ? (d.gust.value >= 25 ? 'red' : d.gust.value >= 15 ? 'amber' : 'green') : '';
      const rvrColor = d.rvrMin !== null ? (d.rvrMin < 550 ? 'red' : d.rvrMin < 1000 ? 'amber' : 'green') : '';
      const spreadColor = d.minSpread !== null ? (d.minSpread < 2 ? 'red' : d.minSpread < 3 ? 'amber' : 'green') : '';

      return `<table class="snap-24h-table ${headerCls}">
        <caption>RWY ${d.rwy} — 24H Summary${label ? ' · ' + label : ''}</caption>
        <tbody>
          ${s24row('Max Wind Speed', d.wsMax, ' kt', wsMaxColor, d.wsMaxT)}
          ${s24row('Min Wind Speed', d.wsMin, ' kt', '', d.wsMinT)}
          ${s24row('Max Headwind', d.hwMax, ' kt', hwMaxColor, d.hwMaxT)}
          ${s24row('Max Wind Gust (reported)', d.gust ? d.gust.value : null, ' kt', gustColor, d.gust ? d.gust.time : null)}
          ${s24row('Min RVR', d.rvrMin, ' m', rvrColor, d.rvrMinT, true)}
          ${s24row('Min MOR', d.morMin, ' m', '', d.morMinT, true)}
          ${s24row('Max Temp', d.tempMax, ' °C', '', d.tempMaxT, true)}
          ${s24row('Min Temp', d.tempMin, ' °C', '', d.tempMinT, true)}
          ${s24row('Max Humidity', d.humMax, ' %', '', d.humMaxT, true)}
          ${s24row('Min Humidity', d.humMin, ' %', '', d.humMinT, true)}
          ${s24row('Min T–Td Spread (Fog Risk)', d.minSpread, '°C', spreadColor, '', true)}
        </tbody>
      </table>`;
    }

    function buildCommonAirfield24hTable(common) {
      const visStr = common.lowestVis ? `${common.lowestVis.value} m` : '—';
      const visColor = common.lowestVis ? (common.lowestVis.value < 550 ? 'red' : common.lowestVis.value < 1500 ? 'amber' : 'green') : '';
      const cloudStr = common.lowestCloud ? `${common.lowestCloud.raw} (${common.lowestCloud.value} ft)` : '—';
      const weatherStr = common.harshest ? `${common.harshest.label} (${common.harshest.raw})` : 'NSW';

      return `<table class="snap-24h-table common">
        <caption>Airfield Common — 24H</caption>
        <tbody>
          <tr><td class="s24-lbl">Lowest Visibility</td><td class="s24-val ${visColor}">${visStr}</td><td class="s24-time">${common.lowestVis ? common.lowestVis.time : '—'}</td></tr>
          <tr><td class="s24-lbl">Lowest Cloud Base</td><td class="s24-val">${cloudStr}</td><td class="s24-time">${common.lowestCloud ? common.lowestCloud.time : '—'}</td></tr>
          <tr><td class="s24-lbl">Harshest Weather</td><td class="s24-val ${common.harshest ? 'amber' : ''}">${weatherStr}</td><td class="s24-time">${common.harshest ? common.harshest.time : '—'}</td></tr>
        </tbody>
      </table>`;
    }

    async function buildAndInject24hSummary() {
      const container = document.getElementById('snap24hContainer');
      if (!container) return;
      try {
        const entries = await fetch24hRegisterEntries();
        const common = getCommonAirfield24h(entries);
        const [d28, d10] = await Promise.all([
          build24hRunwayData('28', entries),
          build24hRunwayData('10', entries)
        ]);

        container.innerHTML = `
          <div class="snap-24h-heading">24H Summary (RWY 28 / RWY 10)</div>
          <div class="snap-24h-grid">
            ${buildRunway24hTable(d28, 'rwy28')}
            ${buildRunway24hTable(d10, 'rwy10')}
          </div>
          <div class="snap-24h-heading">Airfield Common — 24H</div>
          <div class="snap-24h-grid">
            ${buildCommonAirfield24hTable(common)}
          </div>
          <div class="snap-24h-note">RVR / MOR / Temp / Humidity rows are avg-based (approx).</div>`;
      } catch (err) {
        console.error('24h summary build failed:', err);
        container.innerHTML = `<div class="snap-24h-note">⚠ Could not load 24H summary (backend/register unreachable).</div>`;
      }
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

      return `
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
        </div>
        <div class="snap-24h-section" id="snap24hContainer">
          <div class="snap-24h-loading">Loading 24H summary…</div>
        </div>`;
    }

    window.openSnapshot = function() {
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
        const A4_W_MM = 210, MARGIN_MM = 12;
        const usableWidthMM = A4_W_MM - MARGIN_MM * 2;
        const PX_PER_MM = 3.78; // ~96dpi
        const targetWidthPx = Math.round(usableWidthMM * PX_PER_MM);

        wrapper.style.position = 'fixed';
        wrapper.style.left = '-99999px';
        wrapper.style.top = '0';
        wrapper.style.width = targetWidthPx + 'px';
        wrapper.style.background = '#fff';
        wrapper.style.color = '#000';
        wrapper.style.padding = '6px 12px';
        wrapper.className = 'pdf-export-print-styles';
        wrapper.appendChild(clone);
        document.body.appendChild(wrapper);

        // Re-apply the print-only classes/colors inline by toggling a
        // print-style stylesheet scoped to this wrapper.
        const styleTag = document.createElement('style');
        styleTag.textContent = `
          #pdf-export-wrapper, #pdf-export-wrapper * { color:#000; }
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

        // ── Footer on last page ──────────────────────────────────────
        const now = new Date();
        const utcStr = now.toUTCString().replace('GMT', 'UTC');
        doc.setFontSize(7);
        doc.setTextColor(150, 150, 150);
        doc.text(
          'VOGA/MOPA DCWIS · Generated ' + utcStr,
          MARGIN_MM, A4_H_MM - 6
        );

        const fname = `VOGA_Snapshot_${now.toISOString().slice(0,16).replace('T','_').replace(':','')}.pdf`;
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
    //  CLOUD INFO MODAL (satellite-derived cloud analysis)
    // ═══════════════════════════════════════════════════════════════
    const CLOUD_AMOUNT_ICON = {
      'SKC': '☀️', 'CLR': '☀️', 'FEW': '🌤️', 'SCT': '⛅', 'BKN': '🌥️', 'OVC': '☁️'
    };
    const CLOUD_TYPE_NAME = {
      'CU': 'Cumulus', 'SC': 'Stratocumulus', 'AC': 'Altocumulus', 'AS': 'Altostratus',
      'CI': 'Cirrus', 'CS': 'Cirrostratus', 'CC': 'Cirrocumulus', 'NS': 'Nimbostratus',
      'ST': 'Stratus', 'CB': 'Cumulonimbus', 'TCU': 'Towering Cumulus',
      'SC/AC': 'Stratocumulus / Altocumulus', 'NSC': 'No Significant Cloud',
      'NSC': 'No Significant Cloud', 'CLR': 'Clear'
    };

    function cloudRow(lbl, val, cls) {
      return `<div class="cloud-row"><span class="cloud-lbl">${lbl}</span><span class="cloud-val ${cls||''}">${val}</span></div>`;
    }

    function buildCloudHTML(c) {
      const amount = c.cloud_amount || '—';
      const icon = CLOUD_AMOUNT_ICON[amount] || '☁️';
      const typeName = CLOUD_TYPE_NAME[c.cloud_type] || c.cloud_type || '—';
      const ctbtRaw  = c.raw_analysis?.ctbt;
      const ctbtTypeName = CLOUD_TYPE_NAME[ctbtRaw?.dominant_cloud_type] || ctbtRaw?.dominant_cloud_type || '—';

      const obsDate = c.unix_ts ? new Date(c.unix_ts * 1000) : null;
      const ageMin = obsDate ? Math.round((Date.now() - obsDate.getTime()) / 60000) : null;
      const staleWarning = (ageMin !== null && ageMin > 20)
        ? `<div class="cloud-stale-note">⚠ Last satellite pass ${ageMin} min ago — may not reflect current sky.</div>` : '';

      const remarksHTML = (c.remarks && c.remarks.length)
        ? `<div class="cloud-remark-box">📌 ${c.remarks.map(escapeHtml).join(' · ')}</div>` : '';

      const fs = c.fetch_status || {};
      const channelPill = (name, key) => {
        const ok = fs[key] === 'ok';
        return `<div class="cloud-channel-pill">
          <span class="cloud-channel-name">${name}</span>
          <span class="cloud-channel-status ${ok ? 'ok' : 'bad'}">${ok ? '✔ OK' : '✘ FAIL'}</span>
        </div>`;
      };

      const conf = typeof c.confidence_pct === 'number' ? c.confidence_pct : null;

      // CTBT detection details — tcu_tops support added
      const det = ctbtRaw?.detections || {};
      const cbFrac   = det.deep_convection?.fraction ?? 0;
      const tcuFrac  = det.tcu_tops?.fraction ?? 0;
      const ciFrac   = det.high_cloud?.fraction ?? 0;
      const totalCol = ctbtRaw?.total_colored_fraction ?? 0;

      const ctbtDetailHTML = ctbtRaw ? `
        <div class="cloud-section-hdr">CTBT Channel Detail</div>
        <div class="cloud-grid" style="grid-template-columns:1fr 1fr 1fr;">
          ${cloudRow('CB tops', (cbFrac*100).toFixed(1)+'%', cbFrac>0.05?'flag-yes':'flag-no')}
          ${cloudRow('TCU tops', (tcuFrac*100).toFixed(1)+'%', tcuFrac>0.05?'flag-yes':'flag-no')}
          ${cloudRow('CI tops', (ciFrac*100).toFixed(1)+'%', '')}
        </div>` : '';

      return `
        <div class="cloud-hero">
          <div class="cloud-hero-icon">${icon}</div>
          <div class="cloud-hero-main">
            <div class="cloud-hero-amount">${amount} &nbsp;·&nbsp; ${c.oktas ?? '—'}/8 oktas</div>
            <div class="cloud-hero-sub">${typeName}${c.est_cloud_base_ft ? ' · Base ' + c.est_cloud_base_ft : ''}</div>
          </div>
        </div>

        ${remarksHTML}

        <div class="cloud-grid">
          ${cloudRow('Moisture Level', c.moisture_level || '—')}
          ${cloudRow('Amount Source', (c.amount_source || '—') + ' channel')}
          ${cloudRow('Cumulonimbus (CB)', c.cb_flag ? 'DETECTED' : 'Not detected', c.cb_flag ? 'flag-yes' : 'flag-no')}
          ${cloudRow('Towering Cu (TCU)', c.tcu_flag ? 'POSSIBLE' : 'Not detected', c.tcu_flag ? 'flag-yes' : 'flag-no')}
          ${cloudRow('METAR Group', c.metar_cloud_group || '—')}
          ${cloudRow('Dominant Type (CTBT)', ctbtTypeName)}
        </div>

        <div class="cloud-remark-box" style="color:#f0a500">
          ⚠ Satellite analysis detects dominant cloud layer only. 
          Multiple layers require observer confirmation.
        </div>

        ${ctbtDetailHTML}

        <div class="cloud-section-hdr">Estimate Confidence</div>
        <div class="cloud-confidence-bar-wrap">
          <div class="cloud-confidence-track"><div class="cloud-confidence-fill" style="width:${conf ?? 0}%"></div></div>
          <div class="cloud-confidence-pct">${conf !== null ? conf + '%' : '—'}</div>
        </div>

        <div class="cloud-section-hdr">Satellite Channels</div>
        <div class="cloud-channels">
          ${channelPill('IR', 'ir1')}
          ${channelPill('VIS', 'vis')}
          ${channelPill('WV', 'wv')}
          ${channelPill('CTBT', 'ctbt')}
        </div>

        ${staleWarning}
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
        const obsStr = data.obs_time_utc || '—';
        timeHdr.textContent = `${data.icao || 'VOGA'} / ${data.location || 'Mopa, Goa'} — ${obsStr}`;
        content.innerHTML = buildCloudHTML(data);
      } catch (err) {
        console.error('Cloud info fetch failed:', err);
        timeHdr.textContent = 'Unavailable';
        content.innerHTML = `<div class="cloud-error-note">⚠ Could not load cloud analysis.<br>Backend / pipeline may be unreachable.</div>`;
      }
    }

    window.openCloudInfo = function() {
      document.getElementById('cloudModal').classList.add('active');
      document.getElementById('cloudContent').innerHTML = `<div class="cloud-error-note" style="color:#8fa8bd;">Loading…</div>`;
      fetchAndRenderCloudInfo();
    };

    window.closeCloudInfo = function() {
      document.getElementById('cloudModal').classList.remove('active');
    };

    document.getElementById('cloudModal').addEventListener('click', function(e) {
      if (e.target === this) closeCloudInfo();
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
