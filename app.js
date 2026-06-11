// 세이프크로싱 프로토타입 — 미스매치 점수 산출·순위화·지도 시각화

// ── 점수 엔진 ──────────────────────────────────────────────
// 미스매치 점수 = 고령자 통행 발생원 밀집도 × f(도보거리)
// f: 거리구간별 가중치 테이블(임계 100m, 하한 10m)로 정규화

function distanceWeight(dist) {
  const d = Math.max(10, dist); // 분모 발산 방지용 하한 10m
  for (const row of DISTANCE_WEIGHT_TABLE) {
    if (d > row.min && d <= row.max) return { w: row.w, label: row.label };
  }
  return { w: 1.0, label: '500m 초과' };
}

function sourceDensity(sources) {
  return sources.reduce((acc, s) => acc + (SOURCE_TYPE_WEIGHTS[s.type] || 0), 0);
}

function computeScore(seg) {
  const density = sourceDensity(seg.sources);
  const { w, label } = distanceWeight(seg.crosswalkDist);
  const raw = density * w;
  // 0~100 스케일 정규화 (표본 내 최대 밀집도 3.0 기준)
  const score = Math.min(100, Math.round(raw / 3.0 * 100));
  return { density: +density.toFixed(2), distWeight: w, distLabel: label, raw: +raw.toFixed(2), score };
}

function gradeOf(score) {
  if (score >= 70) return { key: 'A', label: 'A등급 · 최우선', color: '#dc2626' };
  if (score >= 45) return { key: 'B', label: 'B등급 · 우선', color: '#ea580c' };
  if (score >= 20) return { key: 'C', label: 'C등급 · 관찰', color: '#d97706' };
  return { key: 'D', label: 'D등급 · 양호', color: '#16a34a' };
}

function recommend(seg, score) {
  const items = [];
  if (score >= 70) items.push({ tag: '1단계', text: '횡단보도 신설·보행섬 우선설치 심의 상정 (도로교통법 §10①·시행규칙 §11)' });
  else if (score >= 45) items.push({ tag: '1단계', text: '보행섬·집중조명 보강 심의 상정' });
  if (score >= 45) items.push({ tag: '2단계', text: 'LED 노면표시 사전경보 설치 (지자체 자체 시설)' });
  if (score >= 20) items.push({ tag: '3단계', text: '민간 내비 푸시 경보 협약 옵션 (티맵·카카오 등)' });
  if (seg.hasSignalNearby) items.push({ tag: '병행', text: '인근 작동신호기 보행녹색시간 자동연장 (교통약자 0.7m/s 정합)' });
  if (items.length === 0) items.push({ tag: '유지', text: '정기 모니터링 (연 1회 재진단)' });
  return items;
}

// ── 데이터 가공 ────────────────────────────────────────────
const ranked = SEGMENTS.map(seg => {
  const sc = computeScore(seg);
  return { ...seg, ...sc, grade: gradeOf(sc.score), actions: recommend(seg, sc.score) };
}).sort((a, b) => b.score - a.score);

ranked.forEach((s, i) => { s.rank = i + 1; });

// ── KPI 스트립 ─────────────────────────────────────────────
function renderKpis() {
  const aCount = ranked.filter(s => s.grade.key === 'A').length;
  const bCount = ranked.filter(s => s.grade.key === 'B').length;
  const avgDist = Math.round(ranked.reduce((a, s) => a + s.crosswalkDist, 0) / ranked.length);
  const taasHits = ranked.filter(s => s.score >= 45);
  const precision = taasHits.length
    ? Math.round(taasHits.filter(s => s.taasMatch).length / taasHits.length * 100) : 0;
  document.getElementById('kpi-total').textContent = ranked.length;
  document.getElementById('kpi-a').textContent = aCount;
  document.getElementById('kpi-b').textContent = bCount;
  document.getElementById('kpi-dist').textContent = avgDist + 'm';
  document.getElementById('kpi-precision').textContent = precision + '%';
}

// ── 지도 ──────────────────────────────────────────────────
const map = L.map('map', { scrollWheelZoom: true }).setView([37.02, 127.04], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const markers = {};
function markerIcon(seg) {
  return L.divIcon({
    className: '',
    html: `<div class="pin" style="background:${seg.grade.color}">${seg.rank}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

ranked.forEach(seg => {
  const m = L.marker([seg.lat, seg.lng], { icon: markerIcon(seg) }).addTo(map);
  m.bindTooltip(`#${seg.rank} ${seg.name} (${seg.score}점)`);
  m.on('click', () => selectSegment(seg.id, true));
  markers[seg.id] = m;
});

// ── 순위 리스트 ────────────────────────────────────────────
function renderList(filter) {
  const wrap = document.getElementById('rank-list');
  wrap.innerHTML = '';
  ranked
    .filter(s => filter === 'ALL' || s.grade.key === filter)
    .forEach(seg => {
      const el = document.createElement('button');
      el.className = 'rank-item';
      el.id = 'item-' + seg.id;
      el.innerHTML = `
        <span class="rank-no" style="background:${seg.grade.color}">${seg.rank}</span>
        <span class="rank-body">
          <span class="rank-name">${seg.name}</span>
          <span class="rank-meta">${seg.district} · 횡단보도 ${seg.crosswalkDist}m · 발생원 ${seg.sources.length}곳</span>
        </span>
        <span class="rank-score">
          <b>${seg.score}</b>
          ${seg.taasMatch ? '<i class="taas">TAAS 적중</i>' : '<i class="taas none">-</i>'}
        </span>`;
      el.addEventListener('click', () => selectSegment(seg.id, false));
      wrap.appendChild(el);
    });
}

// ── 상세 패널 ─────────────────────────────────────────────
function selectSegment(id, fromMap) {
  const seg = ranked.find(s => s.id === id);
  if (!seg) return;
  document.querySelectorAll('.rank-item').forEach(e => e.classList.remove('active'));
  const item = document.getElementById('item-' + id);
  if (item) { item.classList.add('active'); if (fromMap) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  map.flyTo([seg.lat, seg.lng], 15, { duration: 0.6 });

  const srcRows = seg.sources.map(s =>
    `<tr><td>${s.type}</td><td>${s.name}</td><td class="num">${(SOURCE_TYPE_WEIGHTS[s.type] || 0).toFixed(1)}</td></tr>`
  ).join('');
  const actRows = seg.actions.map(a =>
    `<li><span class="act-tag">${a.tag}</span>${a.text}</li>`
  ).join('');

  document.getElementById('detail').innerHTML = `
    <div class="detail-head">
      <div>
        <span class="grade-chip" style="background:${seg.grade.color}">${seg.grade.label}</span>
        <h3>#${seg.rank} ${seg.name}</h3>
        <p class="detail-sub">${seg.district} · 고령자 통행 피크 ${seg.peak} · 최근 3년 보행사고 ${seg.accidents3yr}건(표본) · 보행 사망·중상 중 고령자 ${seg.elderlyShare}%</p>
      </div>
      <div class="score-ring" style="border-color:${seg.grade.color}"><b>${seg.score}</b><span>미스매치</span></div>
    </div>
    <div class="detail-grid">
      <section>
        <h4>점수 분해</h4>
        <div class="formula">
          <span class="f-item"><b>${seg.density}</b><i>발생원 밀집도 Σw</i></span>
          <span class="f-op">×</span>
          <span class="f-item"><b>${seg.distWeight.toFixed(1)}</b><i>f(${seg.crosswalkDist}m → ${seg.distLabel})</i></span>
          <span class="f-op">=</span>
          <span class="f-item total"><b>${seg.raw}</b><i>정규화 → ${seg.score}점</i></span>
        </div>
        <p class="cross-check ${seg.taasMatch ? 'hit' : 'miss'}">
          ${seg.taasMatch
            ? '✓ TAAS 보행사고 다발지점과 교차검증 일치 — 사후검증 루프 적중'
            : '○ TAAS 다발지점 미일치 — 대리지표 한계 구간으로 분류, 적중률(precision) 분모 관리'}
        </p>
      </section>
      <section>
        <h4>고령자 통행 발생원 (횡단수요 대리지표)</h4>
        <table class="src-table">
          <thead><tr><th>유형</th><th>시설명</th><th class="num">가중치</th></tr></thead>
          <tbody>${srcRows}</tbody>
        </table>
      </section>
      <section class="span2">
        <h4>권고 조치 (비용·권한 순 단계 도입)</h4>
        <ul class="actions">${actRows}</ul>
      </section>
    </div>`;
  document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── 필터 ──────────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    renderList(btn.dataset.grade);
  });
});

// ── 초기화 ────────────────────────────────────────────────
renderKpis();
renderList('ALL');
selectSegment(ranked[0].id, false);
