/* 피칭 분석기 — 영상 처리, 3D 뷰어, 그래프, 보고서 */
(function () {
  const $ = id => document.getElementById(id);
  const MP_VER = '0.10.14';
  const MODELS = {
    heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
    full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
    lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task'
  };
  const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30], [29, 31], [30, 32]];
  const COL = { body: '#3b4252', arm: '#d6336c', lead: '#1c7ed6', grid: '#d9dee7', ev: { pkh: '#868e96', fc: '#1c7ed6', mer: '#e8590c', br: '#d6336c' } };
  const S = { file: null, start: 0, end: 0, frames: null, res: null, cur: 0, yaw: -0.7, pitch: 0.2, ts: 0, overrides: {}, snaps: {}, lm: null, lmKey: '', timer: null, cancel: false, meta: {} };
  const video = $('video'), overlay = $('overlay');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d) => Number.isFinite(v) ? v.toFixed(d || 0) : '–';

  /* ---------- 영상 불러오기 ---------- */
  function loadFile(f) {
    if (!f) return;
    S.file = f; S.frames = null; S.res = null; S.overrides = {}; S.converted = false; S.noVideo = false;
    video.src = URL.createObjectURL(f);
    $('fileName').textContent = f.name;
    $('work').hidden = false; $('results').hidden = true;
  }
  $('file').addEventListener('change', e => loadFile(e.target.files[0]));
  const drop = $('drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); });
  video.addEventListener('loadedmetadata', () => {
    S.start = 0; S.end = video.duration; updateRange();
    S.noVideo = !video.videoWidth;
    if (S.noVideo) convert();
    else setStatus((S.converted ? '변환 완료. ' : '') + '영상을 재생해 투구 1개만 남도록 시작·끝을 지정한 뒤 분석을 시작하세요.');
  });
  video.addEventListener('error', () => { if (S.file) { S.noVideo = true; convert(); } });

  /* 브라우저가 읽지 못하는 영상(스마트폰 HEVC 등)은 로컬 서버의 ffmpeg로 자동 변환 */
  async function convert() {
    if (S.converted || S.converting) { if (S.converted) setStatus('변환한 영상도 읽을 수 없습니다. 다른 영상으로 시도해 주세요.', null, true); return; }
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { // 핸드폰·웹 주소에서는 PC의 변환 도구를 쓸 수 없음
      setStatus('이 기기의 브라우저가 이 영상을 읽지 못합니다. 이 기기로 직접 찍은 영상을 넣거나, 다른 브라우저(아이폰은 Safari, 안드로이드는 Chrome)로 열어 보세요.', null, true);
      return;
    }
    S.converting = true; $('run').disabled = true;
    const mb = (S.file.size / 1048576).toFixed(0);
    setStatus(`스마트폰 영상(HEVC 등)을 분석용으로 자동 변환하는 중… (${mb}MB, 보통 1~3분. 창을 닫지 마세요)`);
    try {
      const r = await fetch('/convert', { method: 'POST', body: S.file });
      if (r.status === 503) throw new Error('변환 도구(ffmpeg)가 아직 설치되지 않았습니다. tools\\ffmpeg 폴더에 ffmpeg.exe가 있어야 합니다.');
      if (!r.ok) throw new Error('영상 변환에 실패했습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.');
      const blob = await r.blob();
      S.converted = true;
      video.src = URL.createObjectURL(blob);
    } catch (e) {
      setStatus(e instanceof TypeError ? '자동 변환을 하려면 start.bat으로 프로그램을 실행해야 합니다.' : e.message, null, true);
    } finally { S.converting = false; $('run').disabled = false; }
  }
  $('setStart').onclick = () => { S.start = Math.min(video.currentTime, S.end - 0.1); updateRange(); };
  $('setEnd').onclick = () => { S.end = Math.max(video.currentTime, S.start + 0.1); updateRange(); };
  $('fps').onchange = $('slow').onchange = updateRange;
  function updateRange() {
    const p = plan();
    $('rangeInfo').textContent = `분석 구간 ${S.start.toFixed(2)}초 ~ ${S.end.toFixed(2)}초 · ${p.n}프레임 분석` + (p.step > 1 ? ` (${p.step}프레임마다 1장)` : '') + ` · 실제 동작 기준 ${p.eff.toFixed(0)}fps`;
  }
  /* 구간이 길면 프레임을 건너뛰어 약 450장 이내로 분석 */
  function plan() {
    const fps = +$('fps').value, slow = +$('slow').value || 1;
    const total = Math.floor((S.end - S.start) * fps);
    const step = Math.max(1, Math.ceil(total / 450));
    return { fps, slow, step, n: Math.floor(total / step), eff: fps * slow / step };
  }

  function seek(t) {
    return new Promise(res => {
      if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return res();
      let done = false;
      const fin = () => { if (done) return; done = true; video.removeEventListener('seeked', fin); res(); };
      video.addEventListener('seeked', fin);
      setTimeout(fin, 3000);
      video.currentTime = t;
    });
  }

  /* ---------- 포즈 추정 ---------- */
  async function ensureModel(key) {
    if (S.lm && S.lmKey === key) return;
    setStatus('3D 포즈 모델을 내려받는 중… (처음 한 번은 1~2분 걸릴 수 있습니다)');
    const vision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`);
    if (S.lm) S.lm.close();
    S.lm = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS[key], delegate: 'CPU' },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4
    });
    S.lmKey = key;
  }
  function setStatus(msg, frac, isErr) {
    $('status').textContent = msg;
    $('status').className = isErr ? 'errmsg' : 'muted';
    $('bar').style.width = (frac == null ? 0 : Math.round(frac * 100)) + '%';
  }

  async function run() {
    if (!S.file) return;
    const { fps, slow, step, n, eff } = plan();
    if (!video.videoWidth) { setStatus('영상 화면을 읽을 수 없어 분석할 수 없습니다.', null, true); return; }
    if (n < 10) { setStatus('분석 구간이 너무 짧습니다. 시작·끝을 다시 지정해 주세요.', null, true); return; }
    if (eff < 20) { setStatus(`분석 구간이 너무 깁니다 (${(S.end - S.start).toFixed(1)}초). 투구 1개만 남도록 영상에서 "현재 위치를 시작으로" / "현재 위치를 끝으로"를 눌러 주세요. 슬로모션 영상이면 슬로모션 배율도 맞춰 주세요.`, null, true); return; }
    $('run').disabled = true; $('cancel').hidden = false; S.cancel = false; stopPlay();
    video.pause();
    try {
      await ensureModel($('model').value);
      const frames = [], t0 = performance.now();
      for (let i = 0; i < n; i++) {
        if (S.cancel) throw new Error('취소되었습니다.');
        const tv = S.start + (i * step + 0.5) / fps;
        await seek(tv);
        S.ts += Math.max(1, Math.round(1000 * step / fps));
        const r = S.lm.detectForVideo(video, S.ts);
        const ok = r.worldLandmarks && r.worldLandmarks[0];
        const fr = { tv, t: i * step / fps / slow, world: ok ? r.worldLandmarks[0].map(p => [p.x, p.y, p.z]) : null, img: ok ? r.landmarks[0].map(p => [p.x, p.y, p.visibility]) : null };
        frames.push(fr);
        drawOverlay(fr);
        const el = (performance.now() - t0) / 1000, rem = el / (i + 1) * (n - i - 1);
        setStatus(`3D 포즈 추정 중… ${i + 1}/${n} 프레임 (남은 시간 약 ${Math.ceil(rem)}초)`, (i + 1) / n);
        await new Promise(r => setTimeout(r, 0));
      }
      S.frames = frames; S.overrides = {};
      S.meta = { name: $('pname').value.trim(), memo: $('memo').value.trim(), fps, slow, file: S.file.name, date: new Date().toISOString(), model: $('model').value, w: video.videoWidth, h: video.videoHeight };
      await compute();
      setStatus('분석 완료', 1);
    } catch (e) {
      console.error(e);
      setStatus('오류: ' + e.message, null, true);
    } finally {
      $('run').disabled = false; $('cancel').hidden = true;
    }
  }
  $('run').onclick = run;
  $('cancel').onclick = () => { S.cancel = true; };

  async function compute() {
    S.res = Biomech.analyze(S.frames, { hand: $('hand').value, aspect: S.meta.w / S.meta.h, overrides: S.overrides });
    $('results').hidden = false;
    $('scrub').max = S.frames.length - 1;
    await makeSnapshots();
    buildReport();
    setFrame(S.res.events.fc);
  }

  /* ---------- 2D 오버레이 ---------- */
  function drawSkel2D(ctx, img, w, h, lw) {
    if (!img) return;
    const hand = S.res ? S.res.hand : null;
    ctx.lineWidth = lw; ctx.lineCap = 'round';
    for (const [a, b] of BONES) {
      ctx.strokeStyle = boneColor(a, b, hand, true);
      ctx.beginPath(); ctx.moveTo(img[a][0] * w, img[a][1] * h); ctx.lineTo(img[b][0] * w, img[b][1] * h); ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    for (const j of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { ctx.beginPath(); ctx.arc(img[j][0] * w, img[j][1] * h, lw * 0.9, 0, 7); ctx.fill(); }
  }
  function boneColor(a, b, hand, onVideo) {
    if (!hand) return onVideo ? '#ffe066' : COL.body;
    const arm = hand === 'R' ? [12, 14, 16] : [11, 13, 15], lead = hand === 'R' ? [23, 25, 27, 29, 31] : [24, 26, 28, 30, 32];
    if (arm.includes(a) && arm.includes(b)) return COL.arm;
    if (lead.includes(a) && lead.includes(b)) return onVideo ? '#4dabf7' : COL.lead;
    return onVideo ? '#ffe066' : COL.body;
  }
  function drawOverlay(fr) {
    const w = video.videoWidth || 640, h = video.videoHeight || 360;
    if (overlay.width !== w) { overlay.width = w; overlay.height = h; }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (fr && $('showSkel').checked) drawSkel2D(ctx, fr.img, w, h, Math.max(2, w / 240));
  }
  $('showSkel').onchange = () => drawOverlay(S.frames && S.frames[S.cur]);

  /* ---------- 프레임 이동 ---------- */
  function setFrame(i) {
    if (!S.res) return;
    S.cur = Math.max(0, Math.min(S.frames.length - 1, i | 0));
    $('scrub').value = S.cur;
    video.currentTime = S.frames[S.cur].tv;
    drawOverlay(S.frames[S.cur]);
    draw3D(); drawCharts();
    const e = S.res.events, t = S.res.t;
    const tag = Object.keys(Refs.EV).filter(k => e[k] === S.cur).map(k => Refs.EV[k]).join(' · ');
    $('frameInfo').textContent = `프레임 ${S.cur + 1}/${S.frames.length} · 릴리스 기준 ${(t[S.cur] - t[e.br]).toFixed(3)}초` + (tag ? ' · ' + tag : '');
    const s = S.res.series;
    $('live').innerHTML = [['골반 회전', s.pelvis], ['상체 회전', s.trunk], ['분리각', s.sep], ['팔꿈치 굴곡', s.elbow], ['어깨 외전', s.abd], ['어깨 외회전', s.er], ['앞무릎 굴곡', s.knee], ['몸통 전방 기울기', s.trunkFwd]]
      .map(([k, a]) => `<div><span>${k}</span><b>${fmt(a[S.cur])}°</b></div>`).join('');
  }
  $('scrub').oninput = e => { stopPlay(); setFrame(+e.target.value); };
  $('prev').onclick = () => { stopPlay(); setFrame(S.cur - 1); };
  $('next').onclick = () => { stopPlay(); setFrame(S.cur + 1); };
  function stopPlay() { if (S.timer) { clearInterval(S.timer); S.timer = null; $('play').textContent = '▶ 재생'; } }
  $('play').onclick = () => {
    if (S.timer) return stopPlay();
    if (!S.res) return;
    $('play').textContent = '■ 정지';
    S.timer = setInterval(() => setFrame(S.cur >= S.frames.length - 1 ? 0 : S.cur + 1), 120);
  };
  for (const k of ['pkh', 'fc', 'mer', 'br']) $('go_' + k).onclick = () => { stopPlay(); setFrame(S.res.events[k]); };
  $('setFC').onclick = () => { S.overrides.fc = S.cur; compute(); };
  $('setBR').onclick = () => { S.overrides.br = S.cur; compute(); };
  $('resetEv').onclick = () => { S.overrides = {}; compute(); };
  $('hand').onchange = () => { if (S.frames) { S.overrides = {}; compute(); } };

  /* ---------- 3D 뷰어 ---------- */
  const c3 = $('view3d');
  function proj(p, cx, cy, sc) {
    const cy_ = Math.cos(S.yaw), sy = Math.sin(S.yaw), cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    const x = p[0] * cy_ + p[2] * sy, z = -p[0] * sy + p[2] * cy_;
    const y = p[1] * cp - z * sp;
    return [cx + x * sc, cy - y * sc];
  }
  function draw3D() {
    if (!S.res) return;
    const ctx = c3.getContext('2d'), w = c3.width, h = c3.height;
    ctx.clearRect(0, 0, w, h);
    const P = S.res.pts[S.cur], sc = h * 0.42, cx = w / 2, cy = h * 0.5;
    const gy = Math.min(P[27][1], P[28][1], P[29][1], P[30][1], P[31][1], P[32][1]);
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    for (let k = -4; k <= 4; k++) {
      let a = proj([k * 0.25, gy, -1], cx, cy, sc), b = proj([k * 0.25, gy, 1], cx, cy, sc);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      a = proj([-1, gy, k * 0.25], cx, cy, sc); b = proj([1, gy, k * 0.25], cx, cy, sc);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    // 홈플레이트 방향 화살표
    const a0 = proj([0.6, gy, 0], cx, cy, sc), a1 = proj([1.05, gy, 0], cx, cy, sc);
    ctx.strokeStyle = '#2f9e44'; ctx.fillStyle = '#2f9e44'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(a0[0], a0[1]); ctx.lineTo(a1[0], a1[1]); ctx.stroke();
    ctx.font = '13px sans-serif'; ctx.fillText('홈 방향 →', a1[0] - 30, a1[1] + 18);
    // 투구 손 궤적
    const e = S.res.events, wj = S.res.ids.T.W;
    ctx.strokeStyle = 'rgba(214,51,108,.35)'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = e.pkh; i <= Math.min(S.frames.length - 1, e.br + 4); i++) {
      const q = proj(S.res.pts[i][wj], cx, cy, sc);
      i === e.pkh ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    // 골격
    ctx.lineCap = 'round'; ctx.lineWidth = 5;
    for (const [a, b] of BONES) {
      const p = proj(P[a], cx, cy, sc), q = proj(P[b], cx, cy, sc);
      ctx.strokeStyle = boneColor(a, b, S.res.hand, false);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
    }
    const sm = [(P[11][0] + P[12][0]) / 2, (P[11][1] + P[12][1]) / 2, (P[11][2] + P[12][2]) / 2];
    const hp = proj([sm[0] + (P[0][0] - sm[0]) * 0.9, sm[1] + (P[0][1] - sm[1]) * 0.9, sm[2] + (P[0][2] - sm[2]) * 0.9], cx, cy, sc);
    ctx.fillStyle = COL.body; ctx.beginPath(); ctx.arc(hp[0], hp[1], sc * 0.1, 0, 7); ctx.fill();
  }
  let drag = null;
  c3.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY]; c3.setPointerCapture(e.pointerId); });
  c3.addEventListener('pointermove', e => {
    if (!drag) return;
    S.yaw += (e.clientX - drag[0]) * 0.01; S.pitch = Math.max(-1.5, Math.min(1.5, S.pitch + (e.clientY - drag[1]) * 0.01));
    drag = [e.clientX, e.clientY]; draw3D();
  });
  c3.addEventListener('pointerup', () => { drag = null; });
  const views = { vSide: [0, 0.05], vFront: [-Math.PI / 2, 0.05], vBack: [Math.PI / 2, 0.05], vTop: [0, 1.5] };
  for (const k in views) $(k).onclick = () => { S.yaw = views[k][0]; S.pitch = views[k][1]; draw3D(); };

  /* ---------- 그래프 ---------- */
  const CHARTS = [
    { id: 'ch1', title: '골반·상체 회전각과 분리각 (°)', s: [['골반', 'pelvis', '#1c7ed6'], ['상체', 'trunk', '#e8590c'], ['분리각', 'sep', '#2f9e44']] },
    { id: 'ch2', title: '회전 각속도 (°/s)', s: [['골반', 'pelvisVel', '#1c7ed6'], ['상체', 'trunkVel', '#e8590c']] },
    { id: 'ch3', title: '투구 팔 각도 (°)', s: [['팔꿈치 굴곡', 'elbow', '#7048e8'], ['어깨 외회전', 'er', '#d6336c'], ['어깨 외전', 'abd', '#0c8599']] },
    { id: 'ch4', title: '앞무릎 굴곡 (°) · 몸통 전방 기울기 (°)', s: [['앞무릎 굴곡', 'knee', '#1c7ed6'], ['몸통 전방 기울기', 'trunkFwd', '#e8590c']] }
  ];
  function drawChart(cv, def, cursor) {
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, R = S.res, t = R.t, e = R.events;
    const L = 52, Rm = 12, Tm = 44, B = 26;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    // 표시 구간: 최대 무릎 높이 조금 전 ~ 릴리스 조금 후
    const i0 = Math.max(0, e.pkh - 3), i1 = Math.min(t.length - 1, e.br + Math.max(4, Math.round(0.1 * R.fs)));
    let lo = Infinity, hi = -Infinity;
    for (const [, key] of def.s) for (let i = i0; i <= i1; i++) { const v = R.series[key][i]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    if (!(hi > lo)) { lo = 0; hi = 1; }
    const padv = (hi - lo) * 0.08; lo -= padv; hi += padv;
    const X = i => L + (t[i] - t[i0]) / ((t[i1] - t[i0]) || 1) * (w - L - Rm), Y = v => Tm + (hi - v) / (hi - lo) * (h - Tm - B);
    ctx.font = 'bold 13px sans-serif'; ctx.fillStyle = '#212529'; ctx.textAlign = 'left'; ctx.fillText(def.title, 8, 16);
    ctx.font = '11px sans-serif';
    let lx = 8;
    for (const [name, , col] of def.s) { ctx.fillStyle = col; ctx.fillRect(lx, 25, 14, 3); ctx.fillStyle = '#495057'; ctx.fillText(name, lx + 18, 31); lx += ctx.measureText(name).width + 34; }
    const step = niceStep((hi - lo) / 4);
    ctx.textAlign = 'right';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ctx.strokeStyle = Math.abs(v) < 1e-9 ? '#adb5bd' : '#eef0f3'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - Rm, Y(v)); ctx.stroke();
      ctx.fillStyle = '#868e96'; ctx.fillText(String(Math.round(v)), L - 6, Y(v) + 4);
    }
    ctx.textAlign = 'center';
    for (const k of ['pkh', 'fc', 'mer', 'br']) {
      if (e[k] < i0 || e[k] > i1) continue;
      ctx.strokeStyle = COL.ev[k]; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(X(e[k]), Tm); ctx.lineTo(X(e[k]), h - B); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COL.ev[k]; ctx.fillText({ pkh: '무릎↑', fc: '착지', mer: 'MER', br: '릴리스' }[k], X(e[k]), h - 8);
    }
    for (const [, key, col] of def.s) {
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
      let started = false;
      for (let i = i0; i <= i1; i++) { const v = R.series[key][i]; if (!Number.isFinite(v)) continue; started ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); started = true; }
      ctx.stroke();
    }
    if (cursor != null && cursor >= i0 && cursor <= i1) { ctx.strokeStyle = '#212529'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(cursor), Tm); ctx.lineTo(X(cursor), h - B); ctx.stroke(); }
  }
  function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x || 1))); const m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
  function drawCharts() { if (S.res) for (const d of CHARTS) drawChart($(d.id), d, S.cur); }

  /* ---------- 스냅샷 ---------- */
  async function makeSnapshots() {
    S.snaps = {};
    const cv = document.createElement('canvas');
    const w = Math.min(480, S.meta.w), h = Math.round(w * S.meta.h / S.meta.w);
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    for (const k of ['pkh', 'fc', 'mer', 'br']) {
      const fr = S.frames[S.res.events[k]];
      await seek(fr.tv);
      try { ctx.drawImage(video, 0, 0, w, h); drawSkel2D(ctx, fr.img, w, h, 3); S.snaps[k] = cv.toDataURL('image/jpeg', 0.8); } catch (e) { S.snaps[k] = ''; }
    }
  }

  /* ---------- 평가 ---------- */
  function evaluate() {
    const R = S.res, lowFps = R.fs < 60, out = [];
    let sum = 0, wsum = 0;
    for (const d of Refs.METRICS) {
      const v = R.metrics[d.id], [lo, hi] = d.ref, m = (hi - lo) * 0.25;
      let st = 'na', dir = '';
      if (Number.isFinite(v)) {
        if (v >= lo && v <= hi) st = 'ok';
        else { dir = v < lo ? 'low' : 'high'; st = (v >= lo - m && v <= hi + m) ? 'near' : 'off'; }
      }
      const scored = st !== 'na' && !(d.vel && lowFps);
      if (scored) { sum += d.w * (st === 'ok' ? 1 : st === 'near' ? 0.6 : 0.2); wsum += d.w; }
      out.push({ d, v, st, dir, scored });
    }
    return { items: out, score: wsum ? Math.round(sum / wsum * 100) : null, lowFps };
  }
  const ST = { ok: ['적정', 'ok'], near: ['경계', 'near'], off: ['벗어남', 'off'], na: ['측정 불가', 'na'] };

  function riskFlags(M) {
    const f = [];
    if (M.trunk_fc > 15 || M.sep_fc < 25) f.push(['조기 몸통 회전', `착지 시 어깨선 ${fmt(M.trunk_fc)}°, 분리각 ${fmt(M.sep_fc)}°. 착지 전에 상체가 열리면 하체 에너지를 쓰지 못하고 어깨 내회전 토크·팔꿈치 외반 부하가 커지는 것으로 보고되었습니다.`, [6, 7, 8]]);
    if (M.abd_br < 80 || M.abd_br > 105) f.push(['릴리스 시 팔꿈치 높이', `어깨 외전 ${fmt(M.abd_br)}°. 약 90~100°에서 벗어날수록 팔꿈치 내반 토크가 커지는 것으로 보고되었습니다.`, [11]]);
    if (M.trunk_lat_br > 35) f.push(['과도한 반대측 몸통 기울기', `릴리스 시 글러브 쪽 기울기 ${fmt(M.trunk_lat_br)}°. 구속 이득에 비해 어깨·팔꿈치 관절 모멘트 증가가 큰 패턴입니다.`, [9, 10]]);
    if (M.er_fc < 30) f.push(['늦은 팔(착지 시 전완이 누움)', `착지 시 어깨 외회전 ${fmt(M.er_fc)}°. 착지 때 팔이 던질 자세에 오지 못하면 이후 짧은 시간에 급격히 젖혀져 부하가 커질 수 있습니다.`, [8]]);
    if (M.knee_ext < -5) f.push(['앞다리 무너짐', `착지 후 무릎이 ${fmt(-M.knee_ext)}° 더 굽혀졌습니다. 직접적인 부상 지표는 아니지만 하체 에너지 전달이 끊겨 팔 의존도가 높아집니다.`, [4, 14]]);
    if (M.t_pelvis_trunk <= 0 && S.res.fs >= 60) f.push(['키네틱 체인 순서 역전', '상체 회전 최고속도가 골반보다 먼저(또는 동시에) 나타났습니다.', [5, 13]]);
    return f;
  }

  /* ---------- 보고서 ---------- */
  function history() { try { return JSON.parse(localStorage.getItem('pitchHistory') || '[]'); } catch (e) { return []; } }
  function buildReport() {
    const R = S.res, M = R.metrics, q = R.quality, E = evaluate(), meta = S.meta, ev = R.events;
    const cite = a => a.map(n => `<sup>[${n}]</sup>`).join('');
    const used = new Set([16, 17]);
    const row = it => {
      it.d.cite.forEach(n => used.add(n));
      const [lab, cls] = ST[it.st];
      const note = it.d.vel && E.lowFps ? ' <span class="muted">(저fps·참고용)</span>' : '';
      return `<tr><td>${it.d.name}${cite(it.d.cite)}${note}</td><td class="num"><b>${fmt(it.v, it.d.dec || 0)}</b> ${it.d.unit}</td><td class="num">${it.d.ref[0]} ~ ${it.d.ref[1]}</td><td><span class="tag ${cls}">${lab}${it.dir === 'low' ? ' ↓' : it.dir === 'high' ? ' ↑' : ''}</span></td><td>${it.d.rel}</td></tr>`;
    };
    const table = k => `<h3>${Refs.EV[k]} 시점</h3><table><thead><tr><th>지표</th><th>측정값</th><th>참고범위</th><th>판정</th><th>신뢰도</th></tr></thead><tbody>${E.items.filter(it => it.d.ev === k).map(row).join('')}</tbody></table>`;

    const good = E.items.filter(it => it.st === 'ok' && it.scored && it.d.rel !== '하').sort((a, b) => b.d.w - a.d.w).slice(0, 3);
    const bad = E.items.filter(it => (it.st === 'off' || it.st === 'near') && it.scored).sort((a, b) => (b.st === 'off') - (a.st === 'off') || b.d.w - a.d.w).slice(0, 3);
    const detail = E.items.filter(it => it.st !== 'na').map(it => {
      const [lab, cls] = ST[it.st];
      const msg = it.st === 'ok' ? '참고범위 안에 있습니다.' : it.d[it.dir];
      return `<div class="item"><h4>${it.d.name} <span class="tag ${cls}">${fmt(it.v, it.d.dec || 0)} ${it.d.unit} · ${lab}</span></h4><p>${it.d.what}${cite(it.d.cite)}</p><p><b>해석:</b> ${msg}</p></div>`;
    }).join('');
    const flags = riskFlags(M);
    flags.forEach(f => f[2].forEach(n => used.add(n)));

    const warn = [];
    if (q.fs < 60) warn.push(`유효 촬영 속도가 ${fmt(q.fs)}fps입니다. 착지→릴리스가 약 0.15초(${q.framesFcBr}프레임)뿐이라 이벤트 시점 오차가 ±${fmt(1000 / q.fs)}ms 수준이며, 각속도와 최대 외회전은 실제보다 작게 측정됩니다. 스마트폰 슬로모션(120~240fps) 촬영을 권합니다.`);
    if (q.viewAngle < 35) warn.push('정면(또는 후면)에서 촬영된 영상입니다. 투구 방향이 카메라의 깊이 방향이라 <b>스트라이드 길이·몸통 전방 기울기·앞무릎 각도</b>는 실제보다 작게 측정되기 쉽습니다. 반대로 몸통 측면 기울기·팔꿈치 높이는 잘 측정됩니다. 측면 영상을 함께 분석하면 서로 보완됩니다.');
    else if (q.viewAngle > 65) warn.push('측면에서 촬영된 영상입니다. 스트라이드·무릎·몸통 전방 기울기는 잘 측정되지만, <b>골반·상체 회전각과 분리각, 몸통 측면 기울기</b>는 깊이 방향 추정에 의존해 오차가 큽니다.');
    if (q.detectRate < 0.9) warn.push(`전체 프레임 중 ${fmt(q.detectRate * 100)}%에서만 사람이 인식되었습니다.`);
    if (q.armVis < 0.6) warn.push('투구 팔이 몸에 가려지는 구간이 많아 팔 관련 지표의 신뢰도가 낮습니다.');
    if (q.legVis < 0.6) warn.push('하체가 가려지는 구간이 많아 스트라이드·무릎 지표의 신뢰도가 낮습니다.');
    if (S.overrides.fc != null || S.overrides.br != null) warn.push('착지 또는 릴리스 프레임을 수동으로 지정한 결과입니다.');

    const hist = history(), prev = hist.length ? hist[hist.length - 1] : null;
    let cmp = '';
    if (prev) {
      cmp = `<h2>이전 기록과 비교</h2><p class="muted">비교 대상: ${esc(prev.label)} (${prev.date.slice(0, 10)}) · 종합 점수 ${prev.score} → ${E.score}</p><table><thead><tr><th>지표</th><th>이전</th><th>이번</th><th>변화</th></tr></thead><tbody>` +
        E.items.filter(it => Number.isFinite(it.v) && Number.isFinite(prev.metrics[it.d.id])).map(it => {
          const p = prev.metrics[it.d.id], dlt = it.v - p, dec = it.d.dec || 0;
          return `<tr><td>${it.d.name}</td><td class="num">${fmt(p, dec)}</td><td class="num">${fmt(it.v, dec)}</td><td class="num">${dlt >= 0 ? '+' : ''}${fmt(dlt, dec)} ${it.d.unit}</td></tr>`;
        }).join('') + '</tbody></table>';
    }

    const seqOk = M.t_pelvis_trunk > 0;
    const charts = CHARTS.map(d => { const cv = document.createElement('canvas'); cv.width = 560; cv.height = 250; drawChart(cv, d, null); return `<img src="${cv.toDataURL()}" alt="${d.title}">`; }).join('');

    $('report').innerHTML = `
<header class="rhead"><h1>투구 바이오메카닉스 분석 보고서</h1>
<p>${meta.name ? '<b>' + esc(meta.name) + '</b> · ' : ''}${R.hand === 'R' ? '우투' : '좌투'} · 분석일 ${meta.date.slice(0, 10)} · ${esc(meta.file)}${meta.memo ? ' · ' + esc(meta.memo) : ''}</p>
<p class="muted">영상 ${meta.w}×${meta.h}, 유효 ${fmt(q.fs)}fps, ${q.n}프레임 · 단일 카메라 3D 포즈 추정(MediaPipe BlazePose)${cite([17])}</p></header>

<h2>1. 종합 요약</h2>
<div class="summary"><div class="score"><b>${E.score == null ? '–' : E.score}</b><span>/ 100<br>메커닉 일치도</span></div>
<div><p>참고범위(성인 대학·프로 투수 연구값)와의 일치 정도를 가중 평균한 값입니다. 구속이나 제구를 직접 뜻하지 않으며, 같은 조건으로 촬영한 영상끼리 변화를 추적하는 용도로 쓰는 것이 가장 정확합니다.</p>
<p><b>잘 되고 있는 점</b></p><ul>${good.length ? good.map(it => `<li>${it.d.name}: ${fmt(it.v, it.d.dec || 0)} ${it.d.unit} (참고 ${it.d.ref[0]}~${it.d.ref[1]})</li>`).join('') : '<li>참고범위 안에 든 고신뢰 지표가 없습니다.</li>'}</ul>
<p><b>우선 개선 과제</b></p><ol>${bad.length ? bad.map(it => `<li><b>${it.d.name}</b> ${fmt(it.v, it.d.dec || 0)} ${it.d.unit} — ${it.d[it.dir]}</li>`).join('') : '<li>참고범위를 벗어난 지표가 없습니다.</li>'}</ol></div></div>
${warn.length ? `<div class="warn"><b>측정 품질 안내</b><ul>${warn.map(w => `<li>${w}</li>`).join('')}</ul></div>` : ''}

<h2>2. 투구 구간별 자세</h2>
<div class="snaps">${['pkh', 'fc', 'mer', 'br'].map(k => `<figure>${S.snaps[k] ? `<img src="${S.snaps[k]}" alt="${Refs.EV[k]}">` : ''}<figcaption><b>${Refs.EV[k]}</b><br>릴리스 ${(R.t[ev[k]] - R.t[ev.br]).toFixed(3)}초</figcaption></figure>`).join('')}</div>
<p class="muted">투구는 와인드업 → 스트라이드 → 팔 코킹 → 팔 가속 → 감속 → 팔로스루의 6단계로 나뉘며, 앞발 착지·최대 외회전·릴리스가 단계의 경계가 됩니다.${cite([2, 3])}</p>

<h2>3. 지표 요약표</h2>
${table('fc')}${table('mer')}${table('br')}
<p class="muted">판정: 적정 = 참고범위 안 / 경계 = 범위 폭의 25% 이내로 벗어남 / 벗어남 = 그 이상. ↓ 낮음, ↑ 높음. 신뢰도는 단일 카메라 추정에서 해당 지표가 얼마나 안정적으로 측정되는지(상·중·하)입니다.</p>

<h2>4. 키네틱 체인(에너지 전달 순서)</h2>
<p>효율적인 투구는 골반 → 상체 → 팔꿈치 → 손 순서로 각 분절의 최고속도가 차례로 나타납니다. 앞 분절이 감속하며 다음 분절로 에너지를 넘겨주는 근위-원위 순서입니다.${cite([5, 13])}</p>
<table><thead><tr><th>분절</th><th>최고속도</th><th>릴리스 기준 시점</th></tr></thead><tbody>
<tr><td>골반 회전</td><td class="num">${fmt(M.pelvis_vel)} °/s</td><td class="num">${(R.t[R.peaks.pelvis] - R.t[ev.br]).toFixed(3)}초</td></tr>
<tr><td>상체 회전</td><td class="num">${fmt(M.trunk_vel)} °/s</td><td class="num">${(R.t[R.peaks.trunk] - R.t[ev.br]).toFixed(3)}초</td></tr>
<tr><td>팔꿈치 신전</td><td class="num">${fmt(M.elbow_vel)} °/s</td><td class="num">${(R.t[R.peaks.elbow] - R.t[ev.br]).toFixed(3)}초</td></tr></tbody></table>
<p><b>${seqOk ? '골반 → 상체 순서가 지켜졌습니다.' : '골반과 상체의 최고속도 순서가 뚜렷하지 않습니다.'}</b> ${E.lowFps ? '다만 현재 영상의 fps로는 순서 판정의 신뢰도가 낮습니다.' : ''}</p>
<div class="charts">${charts}</div>

<h2>5. 항목별 상세 해석</h2>${detail}

<h2>6. 부상 위험 관련 체크</h2>
${flags.length ? flags.map(f => `<div class="item"><h4>⚠ ${f[0]}</h4><p>${f[1]}${cite(f[2])}</p></div>`).join('') : '<p>논문에서 관절 부하 증가와 연관된다고 보고된 주요 패턴이 이번 영상에서는 뚜렷하게 나타나지 않았습니다.</p>'}
<p class="muted">이 항목은 운동학(자세·각도) 패턴만으로 본 것입니다. 관절 토크 같은 운동역학 값은 단일 영상으로 계산할 수 없으며, 통증이 있다면 의료 전문가의 진료가 우선입니다.</p>
${cmp}
<h2>분석 방법과 한계</h2>
<ul><li>단일 카메라 영상에서 딥러닝 모델로 33개 관절의 3D 좌표를 추정하고, 착지 순간 양 발의 방향을 기준으로 투수 좌표계(홈 방향·수직·좌우)로 변환해 각도를 계산했습니다. 그래서 촬영 각도가 달라도 같은 정의의 값이 나옵니다.</li>
<li>좌표는 2차 버터워스 저역통과 필터(차단 ${fmt(Math.min(13, q.fs * 0.3), 1)}Hz, 위상 지연 없음)로 평활화했습니다.${cite([16])}</li>
<li>연구실 모션캡처(오차 1~2°)와 달리 단일 카메라 추정은 관절각에서 대략 5~15° 수준의 오차가 있을 수 있고, 카메라에서 먼 쪽·가려진 관절, 회전(외회전·몸통 회전) 지표일수록 오차가 큽니다. 카메라는 수평으로 고정했다고 가정합니다.</li>
<li>참고범위는 성인 대학·프로 투수 연구의 평균±표준편차를 요약한 근사값입니다. 유소년·사이드암 투수는 다른 값이 정상일 수 있고, 정확한 수치는 아래 원문에서 확인하세요.</li></ul>
<h2>참고문헌</h2><ol class="refs">${Object.keys(Refs.REFS).filter(n => used.has(+n)).map(n => `<li value="${n}">${Refs.REFS[n]}</li>`).join('')}</ol>`;
    S.lastEval = E;
  }

  $('print').onclick = () => window.print();
  $('saveHist').onclick = () => {
    if (!S.res) return;
    const h = history();
    h.push({ date: S.meta.date, label: (S.meta.name || '기록') + (S.meta.memo ? ' / ' + S.meta.memo : ''), score: S.lastEval.score, metrics: S.res.metrics });
    localStorage.setItem('pitchHistory', JSON.stringify(h.slice(-50)));
    $('saveHist').textContent = '기록 저장됨 (' + h.length + '개)';
  };
  $('exportJson').onclick = () => {
    if (!S.res) return;
    const R = S.res, data = { meta: S.meta, hand: R.hand, events: R.events, metrics: R.metrics, quality: R.quality, t: R.t, series: R.series, points3d: R.pts };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = (S.meta.name || 'pitch') + '_' + S.meta.date.slice(0, 10) + '.json';
    a.click();
  };

  window.__app = { S, compute, setFrame, evaluate }; // 점검용
})();
