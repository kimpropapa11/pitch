/* 피칭 바이오메카닉스 계산 엔진
 * 입력: MediaPipe Pose 3D(world) 랜드마크 프레임열
 * 좌표계: 투수 기준  X=홈플레이트 방향, Y=수직 위, Z=홈을 바라볼 때 투수의 오른쪽
 */
window.Biomech = (function () {
  const I = { NOSE: 0, LS: 11, RS: 12, LE: 13, RE: 14, LW: 15, RW: 16, LH: 23, RH: 24, LK: 25, RK: 26, LA: 27, RA: 28 };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => { const l = len(a) || 1e-9; return [a[0] / l, a[1] / l, a[2] / l]; };
  const mid = (a, b) => mul(add(a, b), 0.5);
  const deg = r => r * 180 / Math.PI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ang = (a, b) => deg(Math.acos(clamp(dot(unit(a), unit(b)), -1, 1)));
  const perp = (v, axis) => sub(v, mul(axis, dot(v, axis))); // axis는 단위벡터

  /* 2차 버터워스 저역통과, 정·역방향 2회 적용(위상 지연 0) — Winter(2009) 방식 */
  function lowpass(x, fs, fc) {
    const n = x.length;
    if (n < 6) return x.slice();
    fc = Math.min(fc / 0.802, fs * 0.45);
    const w = Math.tan(Math.PI * fc / fs), k = Math.SQRT2 * w, a0 = 1 + k + w * w;
    const b0 = w * w / a0, b1 = 2 * b0, b2 = b0, a1 = 2 * (w * w - 1) / a0, a2 = (1 - k + w * w) / a0;
    const pad = Math.min(12, n - 1);
    let ext = [];
    for (let i = pad; i >= 1; i--) ext.push(2 * x[0] - x[i]);
    ext = ext.concat(x);
    for (let i = n - 2; i >= n - 1 - pad; i--) ext.push(2 * x[n - 1] - x[i]);
    const pass = s => {
      const y = new Array(s.length); y[0] = s[0]; y[1] = s[1];
      for (let i = 2; i < s.length; i++) y[i] = b0 * s[i] + b1 * s[i - 1] + b2 * s[i - 2] - a1 * y[i - 1] - a2 * y[i - 2];
      return y;
    };
    let y = pass(ext); y.reverse(); y = pass(y); y.reverse();
    return y.slice(pad, pad + n);
  }

  function deriv(x, t) {
    const n = x.length, d = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      d[i] = (x[b] - x[a]) / ((t[b] - t[a]) || 1e-9);
    }
    return d;
  }
  function unwrap(a) { // 도 단위
    const o = a.slice();
    for (let i = 1; i < o.length; i++) {
      let d = o[i] - o[i - 1];
      while (d > 180) { o[i] -= 360; d -= 360; }
      while (d < -180) { o[i] += 360; d += 360; }
    }
    return o;
  }
  function argmax(a, lo, hi, f) {
    lo = Math.max(0, lo); hi = Math.min(a.length - 1, hi);
    let bi = lo, bv = -Infinity;
    for (let i = lo; i <= hi; i++) { const v = f ? f(a[i]) : a[i]; if (v > bv) { bv = v; bi = i; } }
    return bi;
  }
  const median = a => { const s = a.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

  /* 결측 프레임 선형 보간 */
  function fillGaps(arr) {
    const n = arr.length, out = arr.slice();
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (out[i] == null) continue;
      if (last < 0) for (let k = 0; k < i; k++) out[k] = out[i];
      else if (i - last > 1) for (let k = last + 1; k < i; k++) out[k] = out[last] + (out[i] - out[last]) * (k - last) / (i - last);
      last = i;
    }
    if (last >= 0) for (let k = last + 1; k < n; k++) out[k] = out[last];
    return out;
  }

  /* frames: [{t(실제 초), world:[[x,y,z]x33]|null, img:[[x,y,vis]x33]|null}] */
  function analyze(frames, opt) {
    opt = opt || {};
    const n = frames.length;
    const valid = frames.filter(f => f.world).length;
    if (n < 10 || valid < n * 0.5) throw new Error('사람이 인식된 프레임이 너무 적습니다 (' + valid + '/' + n + '). 투수 전신이 화면에 보이는 구간을 선택해 주세요.');
    const t = frames.map(f => f.t);
    const fs = (n - 1) / (t[n - 1] - t[0]);
    const fc = Math.min(13, fs * 0.3);
    const aspect = opt.aspect || 16 / 9;

    // 좌표 시계열 구성 → 보간 → 필터
    const W = [], P = [], V = [];
    for (let j = 0; j < 33; j++) {
      W[j] = [0, 1, 2].map(c => lowpass(fillGaps(frames.map(f => f.world ? f.world[j][c] : null)), fs, fc));
      P[j] = [0, 1].map(c => lowpass(fillGaps(frames.map(f => f.img ? f.img[j][c] * (c === 0 ? aspect : 1) : null)), fs, fc));
      V[j] = fillGaps(frames.map(f => f.img ? (f.img[j][2] == null ? 1 : f.img[j][2]) : null));
    }
    const raw = (i, j) => [W[j][0][i], W[j][1][i], W[j][2][i]]; // MediaPipe 좌표(x 우, y 아래, z 카메라 반대편)
    const speedOf = (get) => {
      const s = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        s[i] = len(sub(get(b), get(a))) / ((t[b] - t[a]) || 1e-9);
      }
      return s;
    };

    // 1) 투구 손: 손목 최고 속도가 더 큰 쪽
    const spL = speedOf(i => raw(i, I.LW)), spR = speedOf(i => raw(i, I.RW));
    let hand = opt.hand;
    if (hand !== 'R' && hand !== 'L') hand = Math.max(...spR) >= Math.max(...spL) ? 'R' : 'L';
    const s = hand === 'R' ? 1 : -1;
    const T = hand === 'R' ? { S: I.RS, E: I.RE, W: I.RW, H: I.RH, K: I.RK, A: I.RA } : { S: I.LS, E: I.LE, W: I.LW, H: I.LH, K: I.LK, A: I.LA };
    const G = hand === 'R' ? { S: I.LS, E: I.LE, W: I.LW, H: I.LH, K: I.LK, A: I.LA } : { S: I.RS, E: I.RE, W: I.RW, H: I.RH, K: I.RK, A: I.RA };
    const ov = opt.overrides || {};

    // 2) 릴리스(BR): 투구 손목 속도 최대 시점
    const wristRaw = hand === 'R' ? spR : spL;
    let br = argmax(wristRaw, 2, n - 2);
    if (ov.br != null) br = ov.br;
    else {
      // 손목 속도 정점은 릴리스 직후(팔이 내려오는 구간)에 잡히기 쉬워, 그 직전 팔꿈치가 가장 펴진 시점으로 보정
      const flex = i => 180 - ang(sub(raw(i, T.S), raw(i, T.E)), sub(raw(i, T.W), raw(i, T.E)));
      let bi = br, bv = Infinity;
      for (let i = Math.max(2, br - Math.round(0.05 * fs)); i <= br; i++) { const v = flex(i); if (v < bv) { bv = v; bi = i; } }
      br = bi;
    }

    // 3) 앞발 착지(FC): 영상 평면에서 앞발목 이동속도가 스트라이드 최고속도 이후 급감하는 첫 시점
    const torsoImg = median(frames.map((_, i) => Math.hypot(
      (P[I.LS][0][i] + P[I.RS][0][i]) / 2 - (P[I.LH][0][i] + P[I.RH][0][i]) / 2,
      (P[I.LS][1][i] + P[I.RS][1][i]) / 2 - (P[I.LH][1][i] + P[I.RH][1][i]) / 2))) || 0.2;
    const ankSp = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      ankSp[i] = Math.hypot(P[G.A][0][b] - P[G.A][0][a], P[G.A][1][b] - P[G.A][1][a]) / ((t[b] - t[a]) || 1e-9) / torsoImg;
    }
    let fcAuto;
    {
      const lo = Math.max(0, br - Math.round(1.2 * fs));
      const ip = argmax(ankSp, lo, br - 1);
      fcAuto = -1;
      for (let i = ip + 1; i < br; i++) if (ankSp[i] < 0.25 * ankSp[ip]) { fcAuto = i; break; }
      if (fcAuto < 0) fcAuto = Math.max(0, br - Math.max(2, Math.round(0.145 * fs)));
    }
    let fcI = ov.fc != null ? ov.fc : fcAuto;
    fcI = clamp(fcI, 0, Math.max(0, br - 1));

    // 4) 투수 기준 좌표계
    const up = [0, -1, 0];
    let fv = sub(raw(fcI, G.A), raw(fcI, T.A));
    fv = perp(fv, up);
    if (len(fv) < 0.05) fv = perp(sub(raw(br, G.A), raw(br, T.A)), up);
    const ex = unit(fv), ez = unit(cross(ex, up));
    const pts = [];
    for (let i = 0; i < n; i++) {
      const fr = [];
      for (let j = 0; j < 33; j++) { const p = raw(i, j); fr.push([dot(p, ex), dot(p, up), dot(p, ez)]); }
      pts.push(fr);
    }
    const pt = (i, j) => pts[i][j];

    // 5) 프레임별 각도 시계열
    const S = { pelvis: [], trunk: [], sep: [], elbow: [], abd: [], habd: [], er: [], knee: [], trunkFwd: [], trunkLat: [], kneeH: [] };
    let Hs = [];
    for (let i = 0; i < n; i++) {
      const hm = mid(pt(i, I.LH), pt(i, I.RH)), sm = mid(pt(i, I.LS), pt(i, I.RS));
      const tv = sub(sm, hm), tu = unit(tv);
      const pv = sub(pt(i, G.H), pt(i, T.H)), sv = sub(pt(i, G.S), pt(i, T.S));
      S.pelvis.push(deg(Math.atan2(-s * pv[2], pv[0])));
      S.trunk.push(deg(Math.atan2(-s * sv[2], sv[0])));
      S.trunkFwd.push(deg(Math.atan2(tv[0], tv[1])));
      S.trunkLat.push(deg(Math.atan2(-s * tv[2], tv[1])));
      const sh = pt(i, T.S), el = pt(i, T.E), wr = pt(i, T.W);
      const u = unit(sub(el, sh)), f = unit(sub(wr, el));
      S.abd.push(ang(sub(el, sh), mul(tv, -1)));
      const a = unit(cross(tu, sub(pt(i, I.RS), pt(i, I.LS))));         // 몸통 전방
      const m = unit(perp(sub(pt(i, T.S), pt(i, G.S)), tu));            // 투구측 외측
      const h = perp(u, tu);
      S.habd.push(len(h) < 0.7 ? NaN : -deg(Math.atan2(dot(h, a), dot(h, m)))); // + = 팔꿈치가 어깨선 뒤. 팔이 몸통축에 가까우면 정의 불안정 → 측정 불가
      const apv = perp(a, u);
      if (len(apv) < 0.15) S.er.push(NaN);
      else {
        const ap = unit(apv);
        const c = hand === 'R' ? cross(u, ap) : cross(ap, u);
        const fp = perp(f, u);
        let er = deg(Math.atan2(dot(fp, c), dot(fp, ap)));
        if (er < -135) er += 360; // 표현 범위 -135° ~ 225° (팔이 내려가 있을 때는 음수)
        S.er.push(er);
      }
      S.elbow.push(180 - ang(sub(sh, el), sub(wr, el)));
      S.knee.push(180 - ang(sub(pt(i, G.H), pt(i, G.K)), sub(pt(i, G.A), pt(i, G.K))));
      S.kneeH.push(pt(i, G.K)[1] - pt(i, T.A)[1]);
      const legs = (len(sub(pt(i, I.LH), pt(i, I.LK))) + len(sub(pt(i, I.LK), pt(i, I.LA))) + len(sub(pt(i, I.RH), pt(i, I.RK))) + len(sub(pt(i, I.RK), pt(i, I.RA)))) / 2;
      Hs.push((legs + len(tv)) / 0.779); // Winter(2009) 분절 길이 비율로 신장 추정
    }
    S.pelvis = unwrap(S.pelvis); S.trunk = unwrap(S.trunk);
    // 착지 시점 기준으로 -180~180 범위에 오도록 정렬
    for (const k of ['pelvis', 'trunk']) {
      const off = Math.round(S[k][fcI] / 360) * 360;
      S[k] = S[k].map(v => v - off);
    }
    S.sep = S.pelvis.map((v, i) => v - S.trunk[i]);
    S.er = fillGaps(S.er.map(v => Number.isFinite(v) ? v : null));
    // 각속도는 잡음이 증폭되므로 각도를 한 번 더 평활화한 뒤 미분
    const fv2 = Math.min(8, fs * 0.2);
    S.pelvisVel = deriv(lowpass(S.pelvis, fs, fv2), t);
    S.trunkVel = deriv(lowpass(S.trunk, fs, fv2), t);
    S.elbowVel = deriv(lowpass(S.elbow, fs, Math.min(10, fs * 0.25)), t).map(v => -v); // + = 신전 속도
    S.wristSpeed = speedOf(i => pt(i, T.W));
    S.ankleSpeed = ankSp;
    const H = median(Hs);

    // 6) 나머지 이벤트
    const pkh = argmax(S.kneeH, 0, Math.max(0, fcI - 1));
    const mer = argmax(S.er, fcI, br);
    const ev = { pkh, fc: fcI, mer, br, fcAuto };

    // 7) 지표
    const w0 = Math.max(0, fcI - Math.round(0.12 * fs)), w1 = Math.min(n - 1, br + 1);
    const iPel = argmax(S.pelvisVel, w0, w1), iTr = argmax(S.trunkVel, w0, w1), iEl = argmax(S.elbowVel, fcI, Math.min(n - 1, br + 2));
    const iSep = argmax(S.sep, Math.max(0, fcI - Math.round(0.1 * fs)), br);
    const dA = sub(pt(fcI, G.A), pt(fcI, T.A));
    const M = {
      stride_pct: Math.hypot(dA[0], dA[2]) / H * 100,
      knee_fc: S.knee[fcI], pelvis_fc: S.pelvis[fcI], trunk_fc: S.trunk[fcI], sep_fc: S.sep[fcI], sep_max: S.sep[iSep],
      abd_fc: S.abd[fcI], habd_fc: S.habd[fcI], elbow_fc: S.elbow[fcI], er_fc: S.er[fcI],
      mer: S.er[mer],
      trunk_fwd_br: S.trunkFwd[br], trunk_lat_br: S.trunkLat[br], knee_br: S.knee[br], knee_ext: S.knee[fcI] - S.knee[br],
      abd_br: S.abd[br], elbow_br: S.elbow[br],
      pelvis_vel: S.pelvisVel[iPel], trunk_vel: S.trunkVel[iTr], elbow_vel: S.elbowVel[iEl],
      t_fc_br: t[br] - t[fcI], t_pelvis_trunk: t[iTr] - t[iPel]
    };
    const peaks = { pelvis: iPel, trunk: iTr, elbow: iEl, sep: iSep };

    // 8) 데이터 품질
    const armVis = [T.S, T.E, T.W].map(j => median(V[j].slice(fcI, br + 1))).reduce((a, b) => a + b, 0) / 3;
    const legVis = [G.H, G.K, G.A, T.A].map(j => median(V[j].slice(fcI, br + 1))).reduce((a, b) => a + b, 0) / 4;
    // 촬영 방향: 투구 방향과 카메라 시선 사이 각도 (0° = 정면/후면, 90° = 측면)
    const viewAngle = deg(Math.acos(clamp(Math.abs(ex[2]), 0, 1)));
    const quality = { fs, detectRate: valid / n, armVis, legVis, framesFcBr: br - fcI, n, viewAngle };

    return { hand, t, fs, events: ev, peaks, series: S, pts, metrics: M, quality, stature: H, ids: { T, G } };
  }

  return { analyze, lowpass, I };
})();
