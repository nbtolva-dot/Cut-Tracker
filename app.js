// Cut tracker v3. Built from app.jsx.
import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceLine, ResponsiveContainer, } from "recharts";
/* ---------- constants ---------- */
const KEY = "cut-tracker:v1"; // storage key stays the same; the data carries its own version
const VERSION = 2;
const KCAL_PER_LB = 3500;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Fixed model constants. Changing these changes the math, so they live here rather than in Settings.
const MODEL = {
    washoutDays: 14, // first two weeks of a cut: the scale is mostly water, so it is ignored for maintenance
    windowDays: 21, // scale measurement window
    minSpan: 10, // need at least this many days in the window before measuring
    minWeighIns: 8,
    coverage: 0.8, // fraction of days in the window that need calories logged
    weeklyGain: 0.35, // how far one week of measurements moves the estimate
    clamp: 600, // largest gap between measurement and estimate that counts
    weeklyCap: 200, // weekly target never moves more than this
    dailyCap: 100, // daily target never moves more than this
    tef: 0.10, // energy spent digesting food, which the watch does not see
    autocorr: 1.36, // error-bar inflation because scale noise lingers across days
    calibDays: 28, // watch calibration window
    calibMinWatch: 24, // watch days needed inside that window
    watchCap: 150, // most the watch can move maintenance
    watchFlag: 0.10, // activity change that gets called out
};
const DAILY_GAIN = 1 - Math.pow(1 - MODEL.weeklyGain, 1 / 7);
const DEFAULTS = {
    heightIn: 71, age: 25, sex: "male", activity: 1.675,
    goalRate: 1.25, minRate: 1.0, maxRate: 1.5,
    goalLow: 180, goalHigh: 185, cutStart: "2026-10-12",
    sleepHours: 7.5, calorieFloor: 2000, proteinLow: 180, proteinHigh: 200,
    targetMode: "daily", bottleOz: 24,
};
// Local storage on this device.
const storage = {
    async get(k) { const v = localStorage.getItem(k); if (v == null)
        throw new Error("missing"); return { key: k, value: v }; },
    async set(k, v) { localStorage.setItem(k, v); return { key: k, value: v }; },
};
const PAL_LIGHT = { ink: "#14221E", muted: "#5A6A65", line: "#C9D3CF", accent: "#1D5944", amber: "#9C640A", surface: "#F6F8F7" };
const PAL_DARK = { ink: "#E2EBE7", muted: "#8FA19A", line: "#2A3933", accent: "#74C4A3", amber: "#E3A946", surface: "#16221E" };
/* ---------- date helpers (UTC day numbers avoid DST bugs) ---------- */
const pad = (n) => String(n).padStart(2, "0");
const dayNum = (k) => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const keyOf = (n) => { const d = new Date(Math.round(n) * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const addDays = (k, n) => keyOf(dayNum(k) + n);
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dow = (k) => new Date(dayNum(k) * 86400000).getUTCDay();
const fmtDay = (k) => { const d = new Date(dayNum(k) * 86400000); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const fmtDayLong = (k) => `${DOW[dow(k)]} ${fmtDay(k)}`;
const fmtDayYear = (k) => `${fmtDay(k)}, ${k.slice(0, 4)}`;
const fmtDayN = (n) => fmtDay(keyOf(n));
const weekStart = (k) => addDays(k, -((dow(k) + 1) % 7)); // weeks run Saturday to Friday
const maxKey = (a, b) => (a > b ? a : b);
const isKey = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
/* ---------- number helpers ---------- */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round50 = (x) => Math.round(x / 50) * 50;
const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const fmtSigned = (x) => `${x < 0 ? "−" : "+"}${fmtInt(Math.abs(x))}`;
const parseNum = (s) => {
    const t = String(s ?? "").replace(/[^0-9.\-]/g, "").trim();
    if (!t)
        return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : NaN;
};
/* ---------- data versions ---------- */
function emptyData() {
    return { version: VERSION, entries: {}, given: {}, settings: { ...DEFAULTS } };
}
// Accepts v1 backups (Claude version or first GitHub version) and v2.
function migrate(d, today) {
    if (!d || typeof d !== "object" || !d.entries || typeof d.entries !== "object")
        return null;
    const out = { version: VERSION, entries: {}, given: { ...(d.given || {}) }, settings: { ...DEFAULTS, ...(d.settings || {}) } };
    for (const [k, e] of Object.entries(d.entries)) {
        if (!isKey(k) || !e || typeof e !== "object")
            continue;
        const n = {};
        for (const f of ["weight", "intake", "protein", "active", "resting", "water"])
            if (isNum(e[f]))
                n[f] = e[f];
        // v1 had one "watch" field. Every value logged so far was active energy only.
        if (isNum(e.watch) && !isNum(n.active))
            n.active = e.watch;
        if (Object.keys(n).length)
            out.entries[k] = n;
    }
    delete out.settings.shortcutName;
    if ((d.version || 1) < 2) {
        out.settings.targetMode = DEFAULTS.targetMode;
        // keep a record of what v1 actually told you to eat, for the history table
        for (const [ws, w] of Object.entries(d.weeks || {})) {
            if (!w || !isNum(w.target) || !isKey(ws))
                continue;
            for (let i = 0; i < 7; i++) {
                const day = addDays(ws, i);
                if (day < today && !(day in out.given))
                    out.given[day] = w.target;
            }
        }
    }
    return out;
}
/* ---------- model ---------- */
function mifflin(lb, s) {
    const base = 10 * lb * 0.453592 + 6.25 * s.heightIn * 2.54 - 5 * s.age;
    return s.sex === "female" ? base - 161 : base + 5;
}
const perLb = (s) => 10 * 0.453592 * s.activity; // how much the formula's maintenance drops per pound lost
function weightPts(entries, upTo) {
    return Object.keys(entries)
        .filter((k) => isNum(entries[k].weight) && (!upTo || k <= upTo))
        .sort()
        .map((k) => ({ k, x: dayNum(k), w: entries[k].weight }));
}
function avg7(entries, k) {
    const v = [];
    for (let i = 0; i < 7; i++) {
        const e = entries[addDays(k, -i)];
        if (e && isNum(e.weight))
            v.push(e.weight);
    }
    return v.length ? mean(v) : null;
}
function linreg(pts) {
    const n = pts.length;
    const mx = mean(pts.map((p) => p[0]));
    const my = mean(pts.map((p) => p[1]));
    let sxy = 0, sxx = 0;
    pts.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; });
    const slope = sxx ? sxy / sxx : 0;
    const at = (x) => my + slope * (x - mx);
    let ss = 0;
    pts.forEach(([x, y]) => { ss += (y - at(x)) ** 2; });
    const sd = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
    return { slope, at, sxx, sd, n };
}
// Scale measurement of maintenance: weights lo..hi, calories lo..hi-1 (food shows up on the next morning's scale).
function measure(E, lo, hi, minSpan = MODEL.minSpan) {
    const n0 = dayNum(lo), n1 = dayNum(hi);
    const span = n1 - n0;
    const pts = [], ins = [];
    for (let n = n0; n <= n1; n++) {
        const e = E[keyOf(n)];
        if (!e)
            continue;
        if (isNum(e.weight))
            pts.push([n - n1, e.weight]);
        if (n < n1 && isNum(e.intake))
            ins.push(e.intake);
    }
    if (span < minSpan || pts.length < MODEL.minWeighIns || ins.length < MODEL.coverage * span)
        return null;
    const reg = linreg(pts);
    const avgIntake = mean(ins);
    const obs = avgIntake - reg.slope * KCAL_PER_LB;
    const sigma = reg.sxx > 0 ? (reg.sd / Math.sqrt(reg.sxx)) * MODEL.autocorr * KCAL_PER_LB : null;
    return { lo, hi, span, nW: pts.length, nI: ins.length, avgIntake, slope: reg.slope, rateWk: -reg.slope * 7, obs, sigma };
}
// Simple 14-day trend for display (rate and forecast), separate from the maintenance model.
function trend14(E, endK) {
    const pts = [];
    for (let i = 13; i >= 0; i--) {
        const k = addDays(endK, -i);
        const e = E[k];
        if (e && isNum(e.weight))
            pts.push([-i, e.weight]);
    }
    if (pts.length < 5)
        return null;
    const reg = linreg(pts);
    return { rateWk: -reg.slope * 7, now: reg.at(0) };
}
// One day's burn according to the watch, on the same footing as the scale's number.
function watchBurn(E, k, s, fallbackIntake) {
    const e = E[k];
    if (!e || !isNum(e.active))
        return null;
    const bw = avg7(E, k) ?? (isNum(e.weight) ? e.weight : null);
    if (bw == null)
        return null;
    const bmr = mifflin(bw, s);
    const rest = isNum(e.resting) ? e.resting + (bmr / 24) * s.sleepHours : bmr;
    const food = isNum(e.intake) ? e.intake : (fallbackIntake ?? 0);
    return { burn: e.active + rest + MODEL.tef * food, usedFormulaRest: !isNum(e.resting) };
}
function watchModel(E, k, s, scaleMeas) {
    const washEnd = addDays(s.cutStart, MODEL.washoutDays);
    const lo = maxKey(washEnd, addDays(k, -MODEL.calibDays));
    const res = { nCal: 0, calibrated: false, active: false };
    if (lo >= k)
        return res;
    const ints = [];
    for (let d = lo; d < k; d = addDays(d, 1)) {
        const e = E[d];
        if (e && isNum(e.intake))
            ints.push(e.intake);
    }
    const fallback = ints.length ? mean(ints) : null;
    const burns = [];
    let formulaRest = 0;
    for (let d = lo; d < k; d = addDays(d, 1)) {
        const b = watchBurn(E, d, s, fallback);
        if (b) {
            burns.push({ d, b: b.burn });
            if (b.usedFormulaRest)
                formulaRest++;
        }
    }
    res.nCal = burns.length;
    res.formulaRestDays = formulaRest;
    if (!burns.length)
        return res;
    res.from = burns[0].d;
    res.meanBurn = mean(burns.map((x) => x.b));
    const m = measure(E, burns[0].d, k, 7);
    res.meas = m;
    if (m) {
        res.ratio = res.meanBurn / m.obs;
        res.ratioSigma = m.sigma ? (res.meanBurn * m.sigma) / (m.obs * m.obs) : null;
    }
    const span = dayNum(k) - dayNum(lo);
    res.calibrated = !!m && burns.length >= MODEL.calibMinWatch && span >= MODEL.calibDays - 1;
    if (res.calibrated && scaleMeas) {
        res.c = m.obs / res.meanBurn;
        const recent = burns.filter((x) => x.d >= addDays(k, -7)).map((x) => x.b);
        const inWindow = burns.filter((x) => x.d >= scaleMeas.lo).map((x) => x.b);
        if (recent.length >= 5 && inWindow.length >= MODEL.coverage * scaleMeas.span) {
            const base = mean(inWindow), now = mean(recent);
            res.change = now / base - 1;
            res.shift = clamp(res.c * (now - base), -MODEL.watchCap, MODEL.watchCap);
            res.flag = Math.abs(res.change) > MODEL.watchFlag;
            res.active = true;
        }
    }
    return res;
}
// Plain summary of what the watch says, independent of the accuracy check.
function watchSummary(E, s, today) {
    const pick = (from, to) => {
        const xs = [];
        for (let k = from; k <= to; k = addDays(k, 1)) {
            const e = E[k];
            if (e && isNum(e.active))
                xs.push(k);
        }
        return xs;
    };
    const ints = [];
    for (let k = addDays(today, -28); k < today; k = addDays(k, 1)) {
        const e = E[k];
        if (e && isNum(e.intake))
            ints.push(e.intake);
    }
    const fb = ints.length ? mean(ints) : null;
    const last = pick(addDays(today, -7), addDays(today, -1));
    const prev = pick(addDays(today, -14), addDays(today, -8));
    const all = pick(addDays(today, -28), addDays(today, -1));
    if (!all.length)
        return null;
    const act = (ks) => (ks.length ? mean(ks.map((k) => E[k].active)) : null);
    const burns = last.map((k) => watchBurn(E, k, s, fb)).filter(Boolean).map((b) => b.burn);
    let top = null;
    all.forEach((k) => { if (!top || E[k].active > E[top].active)
        top = k; });
    const lastActive = act(last), prevActive = act(prev);
    return {
        n7: last.length, lastActive, prevActive,
        change: lastActive != null && prevActive ? lastActive / prevActive - 1 : null,
        lastBurn: burns.length ? mean(burns) : null,
        top, topActive: top ? E[top].active : null,
        bars: all.map((k) => { const b = watchBurn(E, k, s, fb); return b ? { k, label: fmtDay(k), burn: b.burn } : null; }).filter(Boolean),
    };
}
// Earliest day the watch can start adjusting the target, assuming you log every day from here.
function calibrationDate(w, s, today) {
    const washEnd = addDays(s.cutStart, MODEL.washoutDays);
    const a = addDays(washEnd, MODEL.calibDays - 1);
    const b = addDays(today, Math.max(0, MODEL.calibMinWatch - ((w && w.nCal) || 0)));
    return maxKey(maxKey(a, b), today);
}
// Replays every day from the cut start. Same inputs always give the same numbers.
function runModel(data, today) {
    const s = data.settings, E = data.entries;
    const days = [];
    if (!isKey(s.cutStart) || s.cutStart > today)
        return days;
    const washEnd = addDays(s.cutStart, MODEL.washoutDays);
    let est = null, wPrev = null, target = null, weekTarget = null, weekKey = null;
    for (let k = s.cutStart; k <= today; k = addDays(k, 1)) {
        const a = avg7(E, k);
        const row = { k, avg7: a };
        if (est == null) {
            if (a == null) {
                days.push(row);
                continue;
            }
            est = mifflin(a, s) * s.activity;
            wPrev = a;
            row.init = true;
        }
        row.prev = est;
        if (a != null) {
            row.weightAdj = perLb(s) * (a - wPrev);
            est += row.weightAdj;
            wPrev = a;
        }
        row.formula = mifflin(wPrev, s) * s.activity;
        if (k >= addDays(washEnd, MODEL.minSpan)) {
            const lo = maxKey(washEnd, addDays(k, -(MODEL.windowDays - 1)));
            const m = measure(E, lo, k);
            if (m) {
                row.meas = m;
                row.gap = clamp(m.obs - est, -MODEL.clamp, MODEL.clamp);
                row.nudge = DAILY_GAIN * row.gap;
                est += row.nudge;
            }
        }
        row.est = est;
        row.watch = watchModel(E, k, s, row.meas);
        row.shift = row.watch.active ? row.watch.shift : 0;
        row.maint = est + row.shift;
        row.raw = Math.max(s.calorieFloor, round50(row.maint - (s.goalRate * KCAL_PER_LB) / 7));
        if (s.targetMode === "weekly") {
            const ws = weekStart(k);
            if (ws !== weekKey) {
                weekTarget = weekTarget == null ? row.raw : clamp(row.raw, weekTarget - MODEL.weeklyCap, weekTarget + MODEL.weeklyCap);
                weekKey = ws;
                row.setsWeek = true;
            }
            row.target = weekTarget;
        }
        else {
            target = target == null ? row.raw : clamp(row.raw, target - MODEL.dailyCap, target + MODEL.dailyCap);
            row.target = target;
        }
        row.capped = s.targetMode === "weekly" ? !!row.setsWeek && row.target !== row.raw : row.target !== row.raw;
        days.push(row);
    }
    return days;
}
function derive(data, today) {
    const s = data.settings, E = data.entries;
    const rows = runModel(data, today);
    const byKey = {};
    rows.forEach((r) => { byKey[r.k] = r; });
    const pts = weightPts(E, today);
    const last = pts[pts.length - 1] || null;
    const prev = pts[pts.length - 2] || null;
    const row = byKey[today] && isNum(byKey[today].est) ? byKey[today] : null;
    const checkedIn = !!(E[today] && isNum(E[today].weight));
    const avgNow = last ? avg7(E, last.k) : null;
    const avgWeekAgo = last ? avg7(E, addDays(last.k, -7)) : null;
    const t14 = last ? trend14(E, last.k) : null;
    const daysIn = dayNum(today) - dayNum(s.cutStart);
    const last7 = [], prot7 = [];
    for (let i = 1; i <= 7; i++) {
        const e = E[addDays(today, -i)];
        if (e && isNum(e.intake))
            last7.push(e.intake);
        if (e && isNum(e.protein))
            prot7.push(e.protein);
    }
    return { s, rows, byKey, row, pts, last, prev, checkedIn, avgNow, avgWeekAgo, t14, daysIn, last7, prot7 };
}
function rateStatus(der) {
    const { t14, s, daysIn } = der;
    if (!t14)
        return null;
    const r = t14.rateWk;
    if (r > s.maxRate) {
        return daysIn < 21
            ? { tone: "muted", text: `Faster than your ${s.maxRate} lb/week cap, but the first weeks of a cut are mostly water.` }
            : { tone: "warn", text: `Faster than your ${s.maxRate} lb/week cap. The target comes up on its own as the estimate catches it.` };
    }
    if (r >= s.minRate)
        return { tone: "good", text: `Inside your ${s.minRate}–${s.maxRate} lb/week range.` };
    if (r > 0)
        return { tone: "muted", text: `Slower than ${s.minRate} lb/week over two weeks. Short stretches like this are often water.` };
    return { tone: "warn", text: "The two-week trend isn't heading down. Check that logging has been complete." };
}
function buildRead(der, today) {
    const { last, prev, avgNow, avgWeekAgo, t14, row } = der;
    if (!last)
        return "Log your first weigh-in to get a read.";
    const parts = [];
    if (last.k !== today)
        parts.push(`No weigh-in for today yet, so this is as of ${fmtDay(last.k)}.`);
    if (prev && dayNum(last.k) - dayNum(prev.k) === 1) {
        const dd = last.w - prev.w;
        if (Math.abs(dd) < 0.05)
            parts.push("Flat from the day before.");
        else if (dd < 0)
            parts.push(`Down ${fmt1(-dd)} from the day before.`);
        else
            parts.push(`Up ${fmt1(dd)} from the day before${dd >= 0.6 ? ", which is almost certainly water" : ""}.`);
    }
    if (avgNow != null) {
        if (avgWeekAgo != null) {
            const c = avgNow - avgWeekAgo;
            parts.push(`Your 7-day average is ${fmt1(avgNow)}, ${Math.abs(c) < 0.05 ? "unchanged" : `${c < 0 ? "down" : "up"} ${fmt1(Math.abs(c))}`} from a week ago.`);
        }
        else
            parts.push(`Your 7-day average is ${fmt1(avgNow)}.`);
    }
    if (t14)
        parts.push(t14.rateWk >= 0 ? `The two-week trend has you losing ${fmt1(t14.rateWk)} lb/week.` : `The two-week trend has you gaining ${fmt1(-t14.rateWk)} lb/week.`);
    if (row && row.watch && row.watch.flag) {
        const ch = row.watch.change;
        parts.push(`Your watch shows this week's activity ${Math.round(Math.abs(ch) * 100)}% ${ch > 0 ? "above" : "below"} your recent normal, so maintenance is shifted ${fmtSigned(row.shift)}.`);
    }
    return parts.join(" ");
}
function weekRows(data, der, today) {
    const E = data.entries, out = [];
    const first = weekStart(data.settings.cutStart);
    for (let ws = weekStart(today); ws >= first; ws = addDays(ws, -7)) {
        const we = addDays(ws, 6);
        const ints = [], gv = [];
        for (let k = ws; k <= we && k <= today; k = addDays(k, 1)) {
            const e = E[k];
            if (k < today && e && isNum(e.intake))
                ints.push(e.intake);
            const g = data.given[k] ?? (k === today && der.byKey[k] ? der.byKey[k].target : null);
            if (isNum(g))
                gv.push(g);
        }
        const endK = we < today ? we : today;
        const a1 = avg7(E, endK), a0 = avg7(E, addDays(ws, -1));
        out.push({ ws, target: gv.length ? mean(gv) : null, avg: ints.length ? mean(ints) : null, n: ints.length, change: a1 != null && a0 != null ? a1 - a0 : null });
    }
    return out;
}
function forecastLine(x0, w0, rateWk, stopAt, maxWeeks = 60) {
    if (!(rateWk > 0.05) || w0 <= stopAt)
        return [];
    const perDay = rateWk / 7;
    const total = Math.min((w0 - stopAt) / perDay, maxWeeks * 7);
    const out = [{ x: x0, y: w0 }];
    for (let d = 7; d < total; d += 7)
        out.push({ x: x0 + d, y: w0 - perDay * d });
    out.push({ x: x0 + total, y: w0 - perDay * total });
    return out;
}
/* ---------- export ---------- */
function toCSV(data, der) {
    const E = data.entries;
    const keys = Object.keys(E).sort();
    const head = ["date", "weight_lb", "weight_7day_avg", "calories", "protein_g", "watch_active", "watch_resting", "water_bottles", "maintenance_estimate", "target_given", "target_model"];
    const lines = [head.join(",")];
    for (const k of keys) {
        const e = E[k], r = der.byKey[k];
        const a = avg7(E, k);
        const g = data.given[k];
        const v = [k, e.weight, a != null ? fmt1(a) : "", e.intake, e.protein, e.active, e.resting, e.water, r && isNum(r.maint) ? Math.round(r.maint) : "", isNum(g) ? g : "", r && isNum(r.target) ? r.target : ""];
        lines.push(v.map((x) => (x == null ? "" : String(x))).join(","));
    }
    return lines.join("\n") + "\n";
}
async function shareFile(filename, text, mime) {
    try {
        const file = new File([text], filename, { type: mime });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: filename });
            return "shared";
        }
    }
    catch (e) {
        if (e && e.name === "AbortError")
            return "cancelled";
    }
    try {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return "downloaded";
    }
    catch (e) {
        return "failed";
    }
}
/* ---------- hooks ---------- */
function usePrefersDark() {
    const q = "(prefers-color-scheme: dark)";
    const [dark, setDark] = useState(() => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(q).matches);
    useEffect(() => {
        if (!window.matchMedia)
            return;
        const m = window.matchMedia(q);
        const f = (e) => setDark(e.matches);
        if (m.addEventListener)
            m.addEventListener("change", f);
        else
            m.addListener(f);
        return () => { if (m.removeEventListener)
            m.removeEventListener("change", f);
        else
            m.removeListener(f); };
    }, []);
    return dark;
}
/* ---------- styles ---------- */
const CSS = `
:root{
  --bg:#E8EDEB; --surface:#F6F8F7; --ink:#14221E; --muted:#5A6A65; --line:#C9D3CF;
  --accent:#1D5944; --on-accent:#F3F8F6; --amber:#9C640A; --warn:#A3304A; --good:#1D5944;
  --display:"Avenir Next Condensed","Roboto Condensed","Arial Narrow",system-ui,sans-serif;
  --body:"Avenir Next","Segoe UI","Helvetica Neue",system-ui,sans-serif;
  color-scheme:light;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0F1815; --surface:#17241F; --ink:#E2EBE7; --muted:#8FA19A; --line:#2A3933;
    --accent:#74C4A3; --on-accent:#0F1815; --amber:#E3A946; --warn:#EC8BA0; --good:#74C4A3;
    color-scheme:dark;
  }
}
.ct{background:var(--bg);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.45;min-height:100vh;-webkit-font-smoothing:antialiased}
.ct *{box-sizing:border-box}
.wrap{max-width:560px;margin:0 auto;padding:calc(14px + env(safe-area-inset-top)) 18px calc(56px + env(safe-area-inset-bottom))}
.sbar{position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top);background:var(--bg);z-index:20}
.brand{font-family:var(--display);font-weight:600;font-size:16px;color:var(--muted);margin:2px 0 10px}
.readout{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.stat-v{font-family:var(--display);font-weight:600;font-size:27px;line-height:1;font-variant-numeric:tabular-nums}
.stat-l{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.2}
.tabs{position:sticky;top:env(safe-area-inset-top);z-index:5;background:var(--bg);display:flex;margin:16px -18px 0;padding:0 18px;border-bottom:1px solid var(--line)}
.tab{flex:1;appearance:none;background:none;border:0;color:var(--muted);font:inherit;font-size:15px;padding:12px 0 9px;border-bottom:3px solid transparent;margin-bottom:-1px;cursor:pointer}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
.hero{padding:22px 0 4px}
.ct .hero-label{font-size:15px;color:var(--muted);margin:0}
.hero-num{font-family:var(--display);font-weight:700;font-size:104px;line-height:.9;letter-spacing:-.015em;font-variant-numeric:tabular-nums;color:var(--accent);margin:6px 0 10px}
.hero-unit{font-size:22px;font-weight:600;color:var(--muted);margin-left:8px;letter-spacing:0}
.ct p{margin:4px 0}
.sec{margin-top:28px}
.ct h2{font-family:var(--display);font-weight:600;font-size:23px;line-height:1.15;margin:0 0 8px}
.ct h3{font-weight:600;font-size:16px;margin:18px 0 6px}
.panel{background:var(--surface);border-radius:16px;padding:16px}
.field{display:block;margin-bottom:14px}
.field>span{display:block;font-size:14px;color:var(--muted);margin-bottom:5px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.input{width:100%;font:inherit;font-size:20px;font-variant-numeric:tabular-nums;color:var(--ink);background:var(--bg);border:1.5px solid var(--line);border-radius:10px;padding:10px 12px;min-height:46px}
.input.sm{font-size:16px;padding:8px 10px;min-height:40px}
.input:focus{outline:none;border-color:var(--accent)}
.ct :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn{appearance:none;border:0;border-radius:10px;font:inherit;font-weight:600;font-size:17px;padding:13px 16px;width:100%;background:var(--accent);color:var(--on-accent);cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent);border:1.5px solid var(--accent)}
.btn.sm{width:auto;font-size:14px;padding:8px 12px}
.btn.danger{background:transparent;color:var(--warn);border:1.5px solid var(--warn)}
.btn:disabled{opacity:.45}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
a.btn{display:inline-block;text-decoration:none;text-align:center}
.link{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:14px;color:var(--accent);text-decoration:underline;text-underline-offset:3px;cursor:pointer;margin-top:8px}
.note{font-size:14px;color:var(--muted)}
.ct .ok{font-size:14px;color:var(--good);margin-top:10px}
.ct .err{font-size:14px;color:var(--warn);margin-top:10px}
.ct .status{font-size:15px;margin-top:8px}
.status.warn{color:var(--warn)} .status.good{color:var(--good)} .status.muted{color:var(--muted)}
.basis{font-size:14px;color:var(--muted);margin-top:10px;padding-left:12px;border-left:3px solid var(--line)}
.basis ol{margin:6px 0 0;padding-left:20px}
.basis li{margin:6px 0}
.basis b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.seg{display:inline-flex;background:var(--surface);border-radius:10px;padding:3px;margin-bottom:10px}
.seg button{appearance:none;border:0;background:none;font:inherit;font-size:14px;color:var(--muted);padding:7px 14px;border-radius:8px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent);font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:var(--muted);margin-top:6px}
.sw{display:inline-block;width:16px;height:0;border-top:2.5px solid;vertical-align:middle;margin-right:6px}
.sw.dot{width:7px;height:7px;border:0;border-radius:50%;margin-right:6px}
.sw.band{height:9px;border:0;border-radius:2px;margin-right:6px}
.eta{display:grid;grid-template-columns:1fr 1fr;gap:14px 12px;margin-top:6px}
.eta-v{font-family:var(--display);font-weight:600;font-size:24px;line-height:1.05;font-variant-numeric:tabular-nums}
.eta-l{font-size:13px;color:var(--muted)}
.tbl{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:15px}
.tbl th{text-align:left;font-weight:500;font-size:13px;color:var(--muted);padding:6px 4px;border-bottom:1px solid var(--line)}
.tbl td{padding:9px 4px;border-bottom:1px solid var(--line)}
.tbl .r{text-align:right}
.hist-row{display:grid;grid-template-columns:1.35fr 1fr 1fr 1fr auto;align-items:center;gap:6px;padding:10px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;font-size:15px}
.hist-head{font-size:13px;color:var(--muted);padding:6px 0}
.hist-edit{padding:12px 0;border-bottom:1px solid var(--line)}
.dim{color:var(--muted)}
.tip{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:13px;color:var(--ink);font-variant-numeric:tabular-nums}
.tip-d{font-weight:600;margin-bottom:2px}
.filebtn{display:inline-block;position:relative;overflow:hidden;text-align:center}
.filebtn input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
textarea.input{font-size:12px;min-height:120px;font-family:ui-monospace,Menlo,monospace}
.stepper{display:flex;align-items:center;gap:10px}
.stepper button{appearance:none;width:46px;height:46px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-size:22px;cursor:pointer}
.stepper .count{font-family:var(--display);font-weight:600;font-size:26px;min-width:28px;text-align:center;font-variant-numeric:tabular-nums}
.row2>*{min-width:0}
.ct input[type="date"]{-webkit-appearance:none;appearance:none;display:block;min-width:0;max-width:100%;text-align:left}
.ct input[type="date"]::-webkit-date-and-time-value{text-align:left}
.top{display:flex;justify-content:space-between;align-items:center;margin:2px 0 10px}
.top .brand{margin:0}
.gear{appearance:none;background:none;border:0;color:var(--muted);padding:8px;margin:-8px;cursor:pointer;border-radius:10px;line-height:0}
.sheet{position:fixed;inset:0;z-index:50;background:var(--bg);overflow-y:auto;-webkit-overflow-scrolling:touch}
.sheet-bar{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line)}
.sheet-bar-in{max-width:560px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;padding:calc(12px + env(safe-area-inset-top)) 18px 12px}
.ct .sheet-bar h2{margin:0}
.sheet-body{max-width:560px;margin:0 auto;padding:4px 18px calc(56px + env(safe-area-inset-bottom))}
.ct .panel h3:first-child{margin-top:0}
details.grp{border-bottom:1px solid var(--line)}
details.grp>summary{list-style:none;display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:14px 0;cursor:pointer}
details.grp>summary::-webkit-details-marker{display:none}
details.grp>summary .ttl{font-weight:600;white-space:nowrap}
details.grp>summary .ttl::before{content:"";display:inline-block;width:7px;height:7px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);margin-right:12px;vertical-align:2px;transition:transform .15s}
details.grp[open]>summary .ttl::before{transform:rotate(45deg)}
details.year>summary .ttl{font-family:var(--display);font-size:21px}
details.month{border-bottom:0;border-top:1px solid var(--line);margin-left:4px}
details.month>summary{padding:12px 0}
details.month .sum{font-size:13px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion: reduce){ details.grp>summary .ttl::before{transition:none} }
@media (max-width:380px){ .hero-num{font-size:88px} .stat-v{font-size:23px} }
`;
/* ---------- small components ---------- */
function Stat({ v, l }) {
    return (React.createElement("div", null,
        React.createElement("div", { className: "stat-v" }, v),
        React.createElement("div", { className: "stat-l" }, l)));
}
function Breakdown({ r, s, prevTarget }) {
    if (!r || !isNum(r.est))
        return null;
    const w = r.watch || {};
    const deficit = (s.goalRate * KCAL_PER_LB) / 7;
    return (React.createElement("div", { className: "basis" },
        React.createElement("ol", null,
            React.createElement("li", null, r.init
                ? React.createElement(React.Fragment, null,
                    "Starting point from the formula: Mifflin\u2013St Jeor \u00D7 ",
                    s.activity,
                    " at your 7-day average of ",
                    fmt1(r.avg7),
                    " lb = ",
                    React.createElement("b", null, fmtInt(r.prev)),
                    ".")
                : React.createElement(React.Fragment, null,
                    "Yesterday's maintenance calories: ",
                    React.createElement("b", null, fmtInt(r.prev)),
                    ".")),
            isNum(r.weightAdj) && Math.abs(r.weightAdj) >= 0.5 && (React.createElement("li", null,
                "Weight change: your 7-day average moved, and the formula drops ",
                fmt1(perLb(s)),
                " kcal per lb, so ",
                React.createElement("b", null, fmtSigned(r.weightAdj)),
                ".")),
            React.createElement("li", null, r.meas
                ? React.createElement(React.Fragment, null,
                    "Scale measurement, ",
                    fmtDay(r.meas.lo),
                    " to ",
                    fmtDay(r.meas.hi),
                    " (",
                    r.meas.span,
                    " days): you averaged ",
                    fmtInt(r.meas.avgIntake),
                    " kcal while trending ",
                    r.meas.rateWk >= 0 ? "down" : "up",
                    " ",
                    Math.abs(r.meas.rateWk).toFixed(2),
                    " lb/week, so maintenance measured ",
                    React.createElement("b", null,
                        fmtInt(r.meas.obs),
                        " \u00B1 ",
                        fmtInt(r.meas.sigma)),
                    ". The estimate moves ",
                    Math.round(DAILY_GAIN * 100),
                    "% of the way toward it each morning",
                    Math.abs(r.meas.obs - r.prev) > MODEL.clamp ? `, with the gap capped at ${MODEL.clamp}` : "",
                    ": ",
                    React.createElement("b", null, fmtSigned(r.nudge)),
                    ".")
                : r.k < addDays(addDays(s.cutStart, MODEL.washoutDays), MODEL.minSpan)
                    ? React.createElement(React.Fragment, null,
                        "No scale measurement yet. The first two weeks of a cut are mostly water, so measuring starts ",
                        fmtDay(addDays(addDays(s.cutStart, MODEL.washoutDays), MODEL.minSpan)),
                        ".")
                    : React.createElement(React.Fragment, null,
                        "Scale measurement skipped today: it needs ",
                        MODEL.minWeighIns,
                        "+ weigh-ins and calories on ",
                        Math.round(MODEL.coverage * 100),
                        "% of days in the window.")),
            React.createElement("li", null, w.active
                ? React.createElement(React.Fragment, null,
                    "Watch: your activity over the last week is ",
                    Math.round(Math.abs(w.change) * 100),
                    "% ",
                    w.change >= 0 ? "above" : "below",
                    " the scale window, worth ",
                    React.createElement("b", null, fmtSigned(r.shift)),
                    " (limit \u00B1",
                    MODEL.watchCap,
                    ").")
                : w.calibrated
                    ? React.createElement(React.Fragment, null, "Watch: calibrated, but it needs 5 of the last 7 days logged to vote. No change.")
                    : React.createElement(React.Fragment, null,
                        "Watch: not counted yet. It starts adjusting your number around ",
                        fmtDay(calibrationDate(w, s, r.k)),
                        ", once it has ",
                        MODEL.calibMinWatch,
                        " days in a four-week window.")),
            React.createElement("li", null,
                "Maintenance ",
                React.createElement("b", null, fmtInt(r.maint)),
                " minus ",
                fmtInt(deficit),
                " for ",
                s.goalRate,
                " lb/week, rounded to 50 = ",
                React.createElement("b", null, fmtInt(r.raw)),
                ".",
                r.capped && isNum(prevTarget) && React.createElement(React.Fragment, null,
                    " That's more than ",
                    s.targetMode === "weekly" ? MODEL.weeklyCap : MODEL.dailyCap,
                    " from ",
                    s.targetMode === "weekly" ? "last week's" : "yesterday's",
                    " ",
                    fmtInt(prevTarget),
                    ", so today's target is held at ",
                    React.createElement("b", null, fmtInt(r.target)),
                    ".")))));
}
/* ---------- check-in form ---------- */
const FIELDS = [
    { key: "weight", label: "Weight this morning (lb)", ph: "208.4", dec: true, min: 80, max: 500 },
    { key: "intake", label: "Calories", ph: "2700", min: 0, max: 12000, prev: true },
    { key: "protein", label: "Protein (g)", ph: "190", min: 0, max: 600, prev: true },
    { key: "active", label: "Watch active", ph: "1100", min: 0, max: 8000, prev: true },
];
function cleanVal(v, f) {
    const n = parseNum(v);
    if (n == null)
        return { v: null };
    if (Number.isNaN(n) || n < f.min || n > f.max)
        return { err: true };
    return { v: f.dec ? Math.round(n * 10) / 10 : Math.round(n) };
}
function CheckIn({ data, today, onSave, prefill, onPrefillUsed }) {
    const preDate = prefill && isKey(prefill.date) && prefill.date <= today ? prefill.date : null;
    const [date, setDate] = useState(preDate || today);
    const [vals, setVals] = useState({});
    const [water, setWater] = useState(null);
    const [msg, setMsg] = useState(null);
    const prevK = addDays(date, -1);
    const bottleOz = data.settings.bottleOz || 24;
    const collect = (v, wt) => {
        const out = {};
        for (const f of FIELDS) {
            const c = cleanVal(v[f.key], f);
            if (c.err)
                return { error: `${f.label.replace(" (lb)", "").replace(" (g)", "")} doesn't look right.` };
            if (c.v != null)
                out[f.key] = c.v;
        }
        if (wt != null)
            out.water = wt;
        if (!Object.keys(out).length)
            return { error: "Enter at least one value to save." };
        return { out };
    };
    useEffect(() => {
        const e = data.entries[date] || {};
        const p = data.entries[addDays(date, -1)] || {};
        const v = {};
        for (const f of FIELDS) {
            const src = f.prev ? p : e;
            v[f.key] = isNum(src[f.key]) ? String(src[f.key]) : "";
        }
        let wt = isNum(p.water) ? p.water : null;
        let m = null;
        if (prefill) {
            const map = { w: "weight", cal: "intake", protein: "protein", active: "active" };
            let any = false;
            for (const [q, f] of Object.entries(map)) {
                if (prefill[q] == null)
                    continue;
                const fd = FIELDS.find((x) => x.key === f);
                const c = cleanVal(prefill[q], fd);
                if (c.v != null) {
                    v[f] = String(c.v);
                    any = true;
                }
            }
            const pw = parseNum(prefill.water);
            if (pw != null && !Number.isNaN(pw) && pw >= 0 && pw < 40) {
                wt = Math.round(pw * 2) / 2;
                any = true;
            }
            if (any) {
                m = { err: false, t: "Filled in from your Shortcut. Check the numbers, then save." };
                if (prefill.save === "1") {
                    const r = collect(v, wt);
                    if (r.out && isNum(r.out.weight)) {
                        onSave(date, r.out);
                        m = { err: false, t: `Saved from your Shortcut for ${fmtDay(date)}. Edit and save again if anything's off.` };
                    }
                }
            }
            onPrefillUsed && onPrefillUsed();
        }
        setVals(v);
        setWater(wt);
        setMsg(m);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [date]);
    const exists = isNum((data.entries[date] || {}).weight);
    const submit = () => {
        const r = collect(vals, water);
        if (r.error)
            return setMsg({ err: true, t: r.error });
        onSave(date, r.out);
        setMsg({ err: false, t: `Saved check-in for ${fmtDay(date)}.` });
    };
    const set = (k) => (e) => setVals({ ...vals, [k]: e.target.value });
    return (React.createElement("section", { className: "sec" },
        React.createElement("h2", null, "Morning check-in"),
        React.createElement("div", { className: "panel" },
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Date"),
                React.createElement("input", { className: "input sm", type: "date", value: date, max: today, onChange: (e) => e.target.value && setDate(e.target.value) })),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Weight this morning (lb)"),
                React.createElement("input", { className: "input", inputMode: "decimal", placeholder: "208.4", value: vals.weight || "", onChange: set("weight") })),
            React.createElement("p", { className: "note", style: { margin: "2px 0 10px" } },
                "Everything below is for ",
                fmtDayLong(prevK),
                "."),
            React.createElement("div", { className: "row2" },
                React.createElement("label", { className: "field" },
                    React.createElement("span", null, "Calories"),
                    React.createElement("input", { className: "input", inputMode: "numeric", placeholder: "2700", value: vals.intake || "", onChange: set("intake") })),
                React.createElement("label", { className: "field" },
                    React.createElement("span", null, "Protein (g)"),
                    React.createElement("input", { className: "input", inputMode: "numeric", placeholder: "190", value: vals.protein || "", onChange: set("protein") })),
                React.createElement("label", { className: "field" },
                    React.createElement("span", null, "Watch active"),
                    React.createElement("input", { className: "input", inputMode: "numeric", placeholder: "1100", value: vals.active || "", onChange: set("active") }))),
            React.createElement("div", { className: "field" },
                React.createElement("span", { style: { display: "block", fontSize: 14, color: "var(--muted)", marginBottom: 5 } },
                    "Water bottles (",
                    bottleOz,
                    " oz)"),
                React.createElement("div", { className: "stepper" },
                    React.createElement("button", { "aria-label": "One fewer bottle", onClick: () => setWater(Math.max(0, (water || 0) - 1)) }, "\u2212"),
                    React.createElement("span", { className: "count" }, water == null ? "–" : water),
                    React.createElement("button", { "aria-label": "One more bottle", onClick: () => setWater((water || 0) + 1) }, "+"),
                    water != null && React.createElement("span", { className: "note" },
                        fmtInt(water * bottleOz),
                        " oz"))),
            React.createElement("p", { className: "note", style: { marginBottom: 12 } }, "Watch active is the calorie number on your Move ring. Your resting burn is estimated from your weight."),
            React.createElement("button", { className: "btn", onClick: submit }, exists ? "Update check-in" : "Save check-in"),
            msg && React.createElement("p", { className: msg.err ? "err" : "ok", role: "status" }, msg.t))));
}
/* ---------- tabs ---------- */
function TodayTab({ data, der, today, onSave, prefill, onPrefillUsed, onRestore }) {
    const s = data.settings;
    const [open, setOpen] = useState(false);
    const r = der.row;
    const yesterday = der.byKey[addDays(today, -1)];
    const prevTarget = s.targetMode === "weekly" ? (der.byKey[addDays(weekStart(today), -1)] || {}).target : (yesterday || {}).target;
    const status = rateStatus(der);
    const empty = Object.keys(data.entries).length === 0;
    const target = r ? r.target : null;
    let when;
    if (!r)
        when = "Log a weigh-in to get a target.";
    else if (s.targetMode === "weekly")
        when = `Set for ${fmtDay(weekStart(today))} to ${fmtDay(addDays(weekStart(today), 6))}${der.checkedIn || dow(today) !== 6 ? "." : ", final once you log this morning."}`;
    else
        when = der.checkedIn ? "Updated with this morning's check-in." : "Provisional until you log this morning.";
    return (React.createElement(React.Fragment, null,
        empty && (React.createElement("section", { className: "sec" },
            React.createElement("div", { className: "panel" },
                React.createElement("h2", null, "Start here"),
                React.createElement("p", null, "Moving over from an earlier version? Restore your backup file first so your history comes with you."),
                React.createElement("button", { className: "btn ghost", style: { marginTop: 12 }, onClick: onRestore }, "Restore a backup")))),
        React.createElement("section", { className: "hero" },
            React.createElement("p", { className: "hero-label" }, "Eat today"),
            React.createElement("div", { className: "hero-num" },
                target != null ? fmtInt(target) : "–",
                React.createElement("span", { className: "hero-unit" }, "kcal")),
            React.createElement("p", null,
                "Protein ",
                s.proteinLow,
                "\u2013",
                s.proteinHigh,
                " g. ",
                when),
            r && React.createElement("p", null,
                "Maintenance calories ",
                fmtInt(r.maint),
                r.meas ? `, scale alone says ${fmtInt(r.meas.obs)} ± ${fmtInt(r.meas.sigma)}` : "",
                "."),
            der.last7.length > 0 && (React.createElement("p", null,
                "Last 7 days you averaged ",
                fmtInt(mean(der.last7)),
                " kcal",
                der.prot7.length ? ` and ${fmtInt(mean(der.prot7))} g protein` : "",
                ".")),
            r && (React.createElement("button", { className: "link", "aria-expanded": open, onClick: () => setOpen((v) => !v) }, open ? "Hide the math" : "How today's number was set")),
            open && React.createElement(Breakdown, { r: r, s: s, prevTarget: prevTarget })),
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Today's read"),
            React.createElement("p", null, buildRead(der, today)),
            status && React.createElement("p", { className: `status ${status.tone}` }, status.text)),
        React.createElement(CheckIn, { data: data, today: today, onSave: onSave, prefill: prefill, onPrefillUsed: onPrefillUsed })));
}
function ChartTip({ active, payload }) {
    if (!active || !payload || !payload.length)
        return null;
    const r = payload[0].payload;
    return (React.createElement("div", { className: "tip" },
        React.createElement("div", { className: "tip-d" }, fmtDayN(r.x)),
        isNum(r.weight) && React.createElement("div", null,
            "Weigh-in ",
            fmt1(r.weight)),
        isNum(r.avg) && React.createElement("div", null,
            "7-day avg ",
            fmt1(r.avg)),
        isNum(r.plan) && React.createElement("div", null,
            "Plan ",
            fmt1(r.plan)),
        isNum(r.pace) && React.createElement("div", null,
            "Current pace ",
            fmt1(r.pace)),
        isNum(r.maint) && React.createElement("div", null,
            "Maintenance ",
            fmtInt(r.maint)),
        isNum(r.target) && React.createElement("div", null,
            "Target ",
            fmtInt(r.target)),
        isNum(r.ate) && React.createElement("div", null,
            "Ate ",
            fmtInt(r.ate))));
}
function TrendTab({ data, der, today, pal }) {
    const [mode, setMode] = useState("recent");
    const s = data.settings;
    const { pts, last, t14 } = der;
    if (!last)
        return React.createElement("section", { className: "sec" },
            React.createElement("p", null, "Log a few weigh-ins and your trend shows up here."));
    const x0 = last.x;
    const w0 = t14 ? t14.now : last.w;
    const paceRate = t14 ? t14.rateWk : null;
    const plan = forecastLine(x0, w0, s.goalRate, s.goalLow);
    const pace = paceRate != null && paceRate > 0.05 ? forecastLine(x0, w0, paceRate, s.goalLow) : [];
    const map = new Map();
    const put = (x, key, v) => { const o = map.get(x) || { x }; o[key] = v; map.set(x, o); };
    pts.forEach((p) => { put(p.x, "weight", p.w); const a = avg7(data.entries, p.k); if (a != null)
        put(p.x, "avg", a); });
    plan.forEach((p) => put(p.x, "plan", p.y));
    pace.forEach((p) => put(p.x, "pace", p.y));
    const rows = [...map.values()].sort((a, b) => a.x - b.x);
    const first = pts[0].x;
    const lastForecast = Math.max(x0, ...rows.map((r) => r.x));
    const d0 = mode === "recent" ? Math.max(first, x0 - 41) : first;
    const d1 = mode === "recent" ? x0 + 28 : Math.max(lastForecast, x0 + 28);
    const vis = rows.filter((r) => r.x >= d0 && r.x <= d1);
    const ys = vis.flatMap((r) => ["weight", "avg", "plan", "pace"].map((k) => r[k]).filter(isNum));
    if (mode === "goal")
        ys.push(s.goalLow, s.goalHigh);
    const y0 = Math.floor(Math.min(...ys) - 1), y1 = Math.ceil(Math.max(...ys) + 1);
    const ticks = [0, 1, 2, 3, 4].map((i) => Math.round(d0 + ((d1 - d0) * i) / 4));
    const eta = (rate, goal) => (rate != null && rate > 0.05 && w0 > goal ? keyOf(x0 + (w0 - goal) / (rate / 7)) : null);
    const planHigh = eta(s.goalRate, s.goalHigh), planLow = eta(s.goalRate, s.goalLow);
    const paceHigh = eta(paceRate, s.goalHigh), paceLow = eta(paceRate, s.goalLow);
    const mid = (s.goalLow + s.goalHigh) / 2;
    const nowRow = der.row;
    const maintAtGoal = nowRow ? nowRow.est - (w0 - mid) * perLb(s) : null;
    // maintenance chart
    const mrows = der.rows.filter((r) => isNum(r.maint)).map((r) => {
        const e = data.entries[r.k];
        return { x: dayNum(r.k), maint: r.maint, target: data.given[r.k] ?? r.target, ate: e && isNum(e.intake) ? e.intake : undefined };
    });
    const mys = mrows.flatMap((r) => [r.maint, r.target, r.ate].filter(isNum));
    const my0 = mys.length ? Math.floor((Math.min(...mys) - 100) / 100) * 100 : 0;
    const my1 = mys.length ? Math.ceil((Math.max(...mys) + 100) / 100) * 100 : 1;
    const mx0 = mrows.length ? mrows[0].x : 0, mx1 = mrows.length ? mrows[mrows.length - 1].x : 1;
    const mticks = [0, 1, 2, 3].map((i) => Math.round(mx0 + ((mx1 - mx0) * i) / 3));
    const weeks = weekRows(data, der, today);
    return (React.createElement(React.Fragment, null,
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Weight"),
            React.createElement("div", { className: "seg", role: "group", "aria-label": "Chart range" },
                React.createElement("button", { "aria-pressed": mode === "recent", onClick: () => setMode("recent") }, "Recent"),
                React.createElement("button", { "aria-pressed": mode === "goal", onClick: () => setMode("goal") }, "To goal")),
            React.createElement("div", { style: { width: "100%", height: 270 } },
                React.createElement(ResponsiveContainer, null,
                    React.createElement(LineChart, { data: rows, margin: { top: 8, right: 10, bottom: 0, left: -14 } },
                        React.createElement(CartesianGrid, { stroke: pal.line, strokeDasharray: "2 4", vertical: false }),
                        React.createElement(ReferenceArea, { y1: s.goalLow, y2: s.goalHigh, fill: pal.amber, fillOpacity: 0.14, stroke: "none", ifOverflow: "hidden" }),
                        React.createElement(ReferenceLine, { x: x0, stroke: pal.line, strokeWidth: 1.5 }),
                        React.createElement(XAxis, { type: "number", dataKey: "x", domain: [d0, d1], ticks: ticks, allowDataOverflow: true, tickFormatter: fmtDayN, tick: { fill: pal.muted, fontSize: 12 }, axisLine: { stroke: pal.line }, tickLine: false }),
                        React.createElement(YAxis, { domain: [y0, y1], allowDataOverflow: true, tickFormatter: (v) => v.toFixed(0), width: 46, tick: { fill: pal.muted, fontSize: 12 }, axisLine: false, tickLine: false }),
                        React.createElement(Tooltip, { content: React.createElement(ChartTip, null) }),
                        React.createElement(Line, { dataKey: "pace", stroke: pal.muted, strokeWidth: 2, strokeDasharray: "2 5", dot: false, connectNulls: true, isAnimationActive: false }),
                        React.createElement(Line, { dataKey: "plan", stroke: pal.amber, strokeWidth: 2.25, strokeDasharray: "7 5", dot: false, connectNulls: true, isAnimationActive: false }),
                        React.createElement(Line, { dataKey: "avg", stroke: pal.accent, strokeWidth: 2.75, dot: false, connectNulls: true, isAnimationActive: false }),
                        React.createElement(Line, { dataKey: "weight", stroke: "none", strokeWidth: 0, dot: { r: 2.75, fill: pal.ink, stroke: "none" }, activeDot: { r: 4.5 }, isAnimationActive: false })))),
            React.createElement("div", { className: "legend" },
                React.createElement("span", null,
                    React.createElement("span", { className: "sw dot", style: { background: pal.ink } }),
                    "Weigh-ins"),
                React.createElement("span", null,
                    React.createElement("span", { className: "sw", style: { borderColor: pal.accent } }),
                    "7-day average"),
                React.createElement("span", null,
                    React.createElement("span", { className: "sw", style: { borderColor: pal.amber, borderTopStyle: "dashed" } }),
                    "Plan, ",
                    s.goalRate,
                    " lb/wk"),
                pace.length > 0 && React.createElement("span", null,
                    React.createElement("span", { className: "sw", style: { borderColor: pal.muted, borderTopStyle: "dotted" } }),
                    "Current pace"),
                React.createElement("span", null,
                    React.createElement("span", { className: "sw band", style: { background: pal.amber, opacity: 0.3 } }),
                    "Goal ",
                    s.goalLow,
                    "\u2013",
                    s.goalHigh))),
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Forecast"),
            React.createElement("h3", null,
                "At your plan (",
                s.goalRate,
                " lb/week)"),
            React.createElement("div", { className: "eta" },
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, planHigh ? fmtDayYear(planHigh) : "–"),
                    React.createElement("div", { className: "eta-l" },
                        "reach ",
                        s.goalHigh)),
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, planLow ? fmtDayYear(planLow) : "–"),
                    React.createElement("div", { className: "eta-l" },
                        "reach ",
                        s.goalLow))),
            paceRate != null && paceRate > 0.05 && (React.createElement(React.Fragment, null,
                React.createElement("h3", null,
                    "At your two-week pace (",
                    fmt1(paceRate),
                    " lb/week)"),
                React.createElement("div", { className: "eta" },
                    React.createElement("div", null,
                        React.createElement("div", { className: "eta-v" }, paceHigh ? fmtDayYear(paceHigh) : "–"),
                        React.createElement("div", { className: "eta-l" },
                            "reach ",
                            s.goalHigh)),
                    React.createElement("div", null,
                        React.createElement("div", { className: "eta-v" }, paceLow ? fmtDayYear(paceLow) : "–"),
                        React.createElement("div", { className: "eta-l" },
                            "reach ",
                            s.goalLow))))),
            maintAtGoal != null && (React.createElement("p", { className: "note", style: { marginTop: 14 } },
                "Estimated maintenance once you're around ",
                fmt1(mid),
                " lb: roughly ",
                fmtInt(round50(maintAtGoal)),
                " kcal, versus ",
                fmtInt(round50(nowRow.est)),
                " now."))),
        mrows.length > 1 && (React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Maintenance calories"),
            React.createElement("div", { style: { width: "100%", height: 230 } },
                React.createElement(ResponsiveContainer, null,
                    React.createElement(LineChart, { data: mrows, margin: { top: 8, right: 10, bottom: 0, left: -6 } },
                        React.createElement(CartesianGrid, { stroke: pal.line, strokeDasharray: "2 4", vertical: false }),
                        React.createElement(XAxis, { type: "number", dataKey: "x", domain: [mx0, mx1], ticks: mticks, tickFormatter: fmtDayN, tick: { fill: pal.muted, fontSize: 12 }, axisLine: { stroke: pal.line }, tickLine: false }),
                        React.createElement(YAxis, { domain: [my0, my1], tickFormatter: (v) => fmtInt(v), width: 52, tick: { fill: pal.muted, fontSize: 12 }, axisLine: false, tickLine: false }),
                        React.createElement(Tooltip, { content: React.createElement(ChartTip, null) }),
                        React.createElement(Line, { dataKey: "maint", stroke: pal.accent, strokeWidth: 2.75, dot: false, isAnimationActive: false }),
                        React.createElement(Line, { dataKey: "target", type: "stepAfter", stroke: pal.amber, strokeWidth: 2, dot: false, isAnimationActive: false }),
                        React.createElement(Line, { dataKey: "ate", stroke: "none", strokeWidth: 0, dot: { r: 2.5, fill: pal.ink, stroke: "none" }, isAnimationActive: false })))),
            React.createElement("div", { className: "legend" },
                React.createElement("span", null,
                    React.createElement("span", { className: "sw", style: { borderColor: pal.accent } }),
                    "Maintenance"),
                React.createElement("span", null,
                    React.createElement("span", { className: "sw", style: { borderColor: pal.amber } }),
                    "Target"),
                React.createElement("span", null,
                    React.createElement("span", { className: "sw dot", style: { background: pal.ink } }),
                    "What you ate")))),
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Weeks"),
            React.createElement("table", { className: "tbl" },
                React.createElement("thead", null,
                    React.createElement("tr", null,
                        React.createElement("th", null, "Week of"),
                        React.createElement("th", { className: "r" }, "Target"),
                        React.createElement("th", { className: "r" }, "Avg eaten"),
                        React.createElement("th", { className: "r" }, "Avg change"))),
                React.createElement("tbody", null, weeks.map((r) => (React.createElement("tr", { key: r.ws },
                    React.createElement("td", null, fmtDay(r.ws)),
                    React.createElement("td", { className: "r" }, r.target != null ? fmtInt(round50(r.target)) : React.createElement("span", { className: "dim" }, "\u2013")),
                    React.createElement("td", { className: "r" }, r.avg != null ? React.createElement(React.Fragment, null,
                        fmtInt(r.avg),
                        " ",
                        React.createElement("span", { className: "dim" },
                            "(",
                            r.n,
                            "d)")) : React.createElement("span", { className: "dim" }, "\u2013")),
                    React.createElement("td", { className: "r" }, r.change != null ? `${r.change <= 0 ? "−" : "+"}${fmt1(Math.abs(r.change))}` : React.createElement("span", { className: "dim" }, "\u2013"))))))),
            React.createElement("p", { className: "note", style: { marginTop: 8 } }, "Target is what the app told you that week. Avg change is the shift in your 7-day average across the week."))));
}
function WatchTab({ data, der, pal, today }) {
    const s = data.settings;
    const r = der.row;
    const sum = watchSummary(data.entries, s, today);
    if (!sum) {
        return (React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Apple Watch summary"),
            React.createElement("p", null, "No watch numbers yet. Add yesterday's Move calories in your morning check-in and this fills in.")));
    }
    const w = r ? r.watch : null;
    const pct = w && isNum(w.ratio) ? (w.ratio - 1) * 100 : null;
    const pctSig = w && isNum(w.ratioSigma) ? w.ratioSigma * 100 : null;
    const ref = w && w.meas ? w.meas.obs : null;
    const yMin = Math.floor((Math.min(...sum.bars.map((b) => b.burn), ref ?? Infinity) * 0.85) / 100) * 100;
    const chg = sum.change;
    let accuracy;
    if (!w || !w.meas)
        accuracy = "The comparison needs about a week of watch numbers after the first two weeks of the cut.";
    else if (pctSig != null && Math.abs(pct) <= pctSig)
        accuracy = `Over the last four weeks the watch reads ${fmt1(Math.abs(pct))}% ${pct >= 0 ? "higher" : "lower"} than your scale and food log, ${fmtInt(w.meanBurn)} versus ${fmtInt(w.meas.obs)} ± ${fmtInt(w.meas.sigma)}. That's inside the margin of error, so no verdict yet.`;
    else
        accuracy = `Over the last four weeks the watch reads about ${fmt1(Math.abs(pct))}% ${pct >= 0 ? "high" : "low"} compared with your scale and food log, ${fmtInt(w.meanBurn)} versus ${fmtInt(w.meas.obs)} ± ${fmtInt(w.meas.sigma)}.`;
    let status;
    if (w && w.calibrated && w.active)
        status = `Calibrated. This week's activity is ${Math.round(Math.abs(w.change) * 100)}% ${w.change >= 0 ? "above" : "below"} your recent normal, which moves today's maintenance ${fmtSigned(r.shift)}.${w.flag ? " That's a big change. Did something in your routine change?" : ""}`;
    else if (w && w.calibrated)
        status = "Calibrated. It adjusts your calories again once 5 of the last 7 days have a watch number.";
    else
        status = `Not adjusting your calories yet. It starts around ${fmtDay(calibrationDate(w, s, today))}, once it has ${MODEL.calibMinWatch} days of watch numbers in a four-week window, and then it can move maintenance by up to ${MODEL.watchCap} when your activity changes.`;
    return (React.createElement(React.Fragment, null,
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Apple Watch summary"),
            React.createElement("div", { className: "eta" },
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, sum.lastActive != null ? fmtInt(sum.lastActive) : "–"),
                    React.createElement("div", { className: "eta-l" }, "Move calories a day, last 7 days")),
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, chg != null ? `${chg >= 0 ? "+" : "−"}${Math.round(Math.abs(chg) * 100)}%` : "–"),
                    React.createElement("div", { className: "eta-l" }, "versus the week before")),
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, sum.lastBurn != null ? fmtInt(sum.lastBurn) : "–"),
                    React.createElement("div", { className: "eta-l" }, "total burn a day, last 7 days")),
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, fmtDay(sum.top)),
                    React.createElement("div", { className: "eta-l" },
                        "most active day, ",
                        fmtInt(sum.topActive),
                        " Move calories")))),
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Daily burn"),
            React.createElement("div", { style: { width: "100%", height: 230 } },
                React.createElement(ResponsiveContainer, null,
                    React.createElement(BarChart, { data: sum.bars, margin: { top: 22, right: 10, bottom: 0, left: -10 } },
                        React.createElement(CartesianGrid, { stroke: pal.line, strokeDasharray: "2 4", vertical: false }),
                        React.createElement(XAxis, { dataKey: "label", tick: { fill: pal.muted, fontSize: 11 }, axisLine: { stroke: pal.line }, tickLine: false, interval: "preserveStartEnd", minTickGap: 18 }),
                        React.createElement(YAxis, { domain: [yMin, "auto"], tickFormatter: (v) => fmtInt(v), width: 52, tick: { fill: pal.muted, fontSize: 12 }, axisLine: false, tickLine: false }),
                        React.createElement(Tooltip, { cursor: { fill: pal.line, fillOpacity: 0.3 }, contentStyle: { background: pal.surface, border: `1px solid ${pal.line}`, borderRadius: 10, color: pal.ink, fontSize: 13 }, formatter: (v) => [fmtInt(v), "Total burn"] }),
                        React.createElement(Bar, { dataKey: "burn", fill: pal.accent, fillOpacity: 0.75, radius: [4, 4, 0, 0], isAnimationActive: false }),
                        ref != null && (React.createElement(ReferenceLine, { y: ref, stroke: pal.amber, strokeWidth: 2, strokeDasharray: "6 4", label: { value: `Scale says ${fmtInt(ref)}`, position: "insideTopRight", fill: pal.amber, fontSize: 12, fontWeight: 600 } }))))),
            React.createElement("p", { className: "note" }, "Each bar is the watch's Move calories plus your resting burn for the whole day, estimated from your weight, plus about 10% of what you ate for digestion.")),
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Accuracy against the scale"),
            React.createElement("p", null, accuracy),
            React.createElement("p", { className: "note", style: { marginTop: 10 } }, status))));
}
const EDIT_FIELDS = [
    { key: "weight", label: "Weight", dec: true, min: 80, max: 500 },
    { key: "intake", label: "Ate", min: 0, max: 12000 },
    { key: "protein", label: "Protein", min: 0, max: 600 },
    { key: "active", label: "Active", min: 0, max: 8000 },
    { key: "water", label: "Bottles", dec: true, min: 0, max: 40 },
];
function HistRow({ k, e, onSave }) {
    const [edit, setEdit] = useState(false);
    const [v, setV] = useState({});
    const [err, setErr] = useState(null);
    const begin = () => {
        const o = {};
        EDIT_FIELDS.forEach((f) => { o[f.key] = isNum(e[f.key]) ? String(e[f.key]) : ""; });
        setV(o);
        setErr(null);
        setEdit(true);
    };
    const save = () => {
        const next = {};
        for (const f of EDIT_FIELDS) {
            const c = cleanVal(v[f.key], f);
            if (c.err)
                return setErr(`${f.label} doesn't look right. Use a plain number, or leave it blank to clear it.`);
            if (c.v != null)
                next[f.key] = c.v;
        }
        onSave(k, next);
        setEdit(false);
    };
    if (!edit) {
        return (React.createElement("div", { className: "hist-row" },
            React.createElement("span", null, fmtDayLong(k)),
            React.createElement("span", null, isNum(e.weight) ? fmt1(e.weight) : React.createElement("span", { className: "dim" }, "\u2013")),
            React.createElement("span", null, isNum(e.intake) ? fmtInt(e.intake) : React.createElement("span", { className: "dim" }, "\u2013")),
            React.createElement("span", null, isNum(e.active) ? fmtInt(e.active) : React.createElement("span", { className: "dim" }, "\u2013")),
            React.createElement("button", { className: "link", style: { marginTop: 0 }, onClick: begin, "aria-label": `Edit ${fmtDay(k)}` }, "Edit")));
    }
    return (React.createElement("div", { className: "hist-edit" },
        React.createElement("p", { style: { fontWeight: 600, marginBottom: 8 } }, fmtDayLong(k)),
        React.createElement("div", { className: "row2", style: { gridTemplateColumns: "1fr 1fr 1fr" } }, EDIT_FIELDS.map((f) => (React.createElement("label", { className: "field", key: f.key },
            React.createElement("span", null, f.label),
            React.createElement("input", { className: "input sm", inputMode: f.dec ? "decimal" : "numeric", value: v[f.key] || "", onChange: (ev) => setV({ ...v, [f.key]: ev.target.value }) }))))),
        React.createElement("div", { className: "btns", style: { marginTop: 0 } },
            React.createElement("button", { className: "btn sm", onClick: save }, "Save day"),
            React.createElement("button", { className: "btn ghost sm", onClick: () => setEdit(false) }, "Cancel"),
            React.createElement("button", { className: "btn danger sm", onClick: () => { onSave(k, {}); setEdit(false); } }, "Delete day")),
        err && React.createElement("p", { className: "err" }, err)));
}
const SETTING_GROUPS = [
    { title: "Plan", fields: [
            { key: "goalRate", label: "Planned loss rate (lb/week)" },
            { key: "maxRate", label: "Rate cap (lb/week)" },
            { key: "minRate", label: "Slowest acceptable rate" },
            { key: "calorieFloor", label: "Never go below (kcal)" },
            { key: "goalHigh", label: "Goal range top (lb)" },
            { key: "goalLow", label: "Goal range bottom (lb)" },
            { key: "proteinLow", label: "Protein low (g)" },
            { key: "proteinHigh", label: "Protein high (g)" },
        ] },
    { title: "About you", fields: [
            { key: "heightIn", label: "Height (in)" },
            { key: "age", label: "Age" },
            { key: "activity", label: "Activity multiplier" },
            { key: "bottleOz", label: "Water bottle size (oz)" },
        ] },
];
const SETTING_FIELDS = SETTING_GROUPS.flatMap((g) => g.fields);
function Settings({ data, onSave }) {
    const toStrings = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
    const [f, setF] = useState(() => toStrings(data.settings));
    const [msg, setMsg] = useState(null);
    const save = () => {
        const next = { ...data.settings };
        for (const { key, label } of SETTING_FIELDS) {
            const v = parseNum(f[key]);
            if (v == null || Number.isNaN(v) || v <= 0)
                return setMsg({ err: true, t: `${label} needs a number.` });
            next[key] = v;
        }
        next.sex = f.sex === "female" ? "female" : "male";
        next.targetMode = f.targetMode === "weekly" ? "weekly" : "daily";
        if (isKey(f.cutStart))
            next.cutStart = f.cutStart;
        if (next.goalRate > next.maxRate)
            next.goalRate = next.maxRate;
        if (next.goalLow > next.goalHigh)
            [next.goalLow, next.goalHigh] = [next.goalHigh, next.goalLow];
        onSave(next);
        setF(toStrings(next));
        setMsg({ err: false, t: "Settings saved. Today's number is recalculated with them." });
    };
    const input = ({ key, label }) => (React.createElement("label", { className: "field", key: key },
        React.createElement("span", null, label),
        React.createElement("input", { className: "input sm", inputMode: "decimal", value: f[key] ?? "", onChange: (e) => setF({ ...f, [key]: e.target.value }) })));
    return (React.createElement("div", { className: "panel" },
        React.createElement("h3", null, "Plan"),
        React.createElement("label", { className: "field" },
            React.createElement("span", null, "Target changes"),
            React.createElement("select", { className: "input sm", value: f.targetMode, onChange: (e) => setF({ ...f, targetMode: e.target.value }) },
                React.createElement("option", { value: "daily" },
                    "Every morning, at most ",
                    MODEL.dailyCap,
                    " at a time"),
                React.createElement("option", { value: "weekly" },
                    "Once a week on Saturday, at most ",
                    MODEL.weeklyCap,
                    " at a time"))),
        React.createElement("div", { className: "row2" }, SETTING_GROUPS[0].fields.map(input)),
        React.createElement("h3", null, "About you"),
        React.createElement("div", { className: "row2" },
            SETTING_GROUPS[1].fields.map(input),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Sex (for the formula)"),
                React.createElement("select", { className: "input sm", value: f.sex, onChange: (e) => setF({ ...f, sex: e.target.value }) },
                    React.createElement("option", { value: "male" }, "Male"),
                    React.createElement("option", { value: "female" }, "Female"))),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Cut start date"),
                React.createElement("input", { className: "input sm", type: "date", value: f.cutStart, onChange: (e) => setF({ ...f, cutStart: e.target.value }) }))),
        React.createElement("p", { className: "note", style: { marginBottom: 12 } }, "The app replays every day from your cut start, so changing these recalculates your maintenance calories from the beginning. What it told you on past days stays in the history."),
        React.createElement("button", { className: "btn", onClick: save }, "Save settings"),
        msg && React.createElement("p", { className: msg.err ? "err" : "ok", role: "status" }, msg.t)));
}
function SettingsSheet({ data, der, onClose, onSaveSettings, onImport }) {
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        const onKey = (e) => { if (e.key === "Escape")
            onClose(); };
        window.addEventListener("keydown", onKey);
        return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (React.createElement("div", { className: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Settings" },
        React.createElement("div", { className: "sheet-bar" },
            React.createElement("div", { className: "sheet-bar-in" },
                React.createElement("h2", null, "Settings"),
                React.createElement("button", { className: "btn ghost sm", onClick: onClose }, "Close"))),
        React.createElement("div", { className: "sheet-body" },
            React.createElement("section", { className: "sec" },
                React.createElement(Settings, { data: data, onSave: onSaveSettings })),
            React.createElement("section", { className: "sec" },
                React.createElement("h2", null, "Your data"),
                React.createElement(ExportPanel, { data: data, der: der, onImport: onImport })))));
}
function ExportPanel({ data, der, onImport }) {
    const [out, setOut] = useState(null);
    const [inp, setInp] = useState("");
    const [msg, setMsg] = useState(null);
    const report = (res, what) => {
        if (res === "shared")
            setMsg({ err: false, t: `${what} shared.` });
        else if (res === "downloaded")
            setMsg({ err: false, t: `${what} downloaded.` });
        else if (res === "failed")
            setMsg({ err: true, t: "Couldn't export here. Use Show as text and copy it instead." });
    };
    const stamp = todayKey();
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(out);
            setMsg({ err: false, t: "Copied." });
        }
        catch {
            setMsg({ err: true, t: "Copy blocked here. Select the text and copy it manually." });
        }
    };
    const importText = (t) => {
        try {
            const d = migrate(JSON.parse(t), todayKey());
            if (!d)
                throw new Error("bad");
            onImport(d);
            setInp("");
            setMsg({ err: false, t: `Backup restored with ${Object.keys(d.entries).length} days of data.` });
        }
        catch {
            setMsg({ err: true, t: "That doesn't look like a backup from this app. Use the full exported file or text." });
        }
    };
    return (React.createElement("div", { className: "panel" },
        React.createElement("p", { className: "note", style: { marginBottom: 10 } }, "Your data lives only on this phone. Export now and then. The share sheet lets you save to Files, AirDrop it, or send it to Obsidian."),
        React.createElement("div", { className: "btns", style: { marginTop: 0 } },
            React.createElement("button", { className: "btn sm", onClick: async () => report(await shareFile(`cut-tracker-backup-${stamp}.json`, JSON.stringify(data), "application/json"), "Backup") }, "Export backup"),
            React.createElement("button", { className: "btn ghost sm", onClick: async () => report(await shareFile(`cut-tracker-${stamp}.csv`, toCSV(data, der), "text/csv"), "CSV") }, "Export CSV"),
            React.createElement("button", { className: "btn ghost sm", onClick: () => { setOut(JSON.stringify(data)); setMsg(null); } }, "Show as text"),
            out && React.createElement("button", { className: "btn ghost sm", onClick: copy }, "Copy")),
        out && React.createElement("textarea", { className: "input", readOnly: true, value: out, style: { marginTop: 10 }, onFocus: (e) => e.target.select() }),
        React.createElement("h3", null, "Restore"),
        React.createElement("p", { className: "note", style: { marginBottom: 8 } }, "Restoring replaces everything currently in the app. Backups from earlier versions work too."),
        React.createElement("label", { className: "btn ghost sm filebtn" },
            "Choose backup file",
            React.createElement("input", { type: "file", accept: ".json,application/json,text/plain", onChange: async (e) => {
                    const fl = e.target.files && e.target.files[0];
                    if (fl)
                        importText(await fl.text());
                    e.target.value = "";
                } })),
        React.createElement("label", { className: "field", style: { marginTop: 14 } },
            React.createElement("span", null, "Or paste backup text"),
            React.createElement("textarea", { className: "input", value: inp, onChange: (e) => setInp(e.target.value), placeholder: "Paste exported text here" })),
        React.createElement("button", { className: "btn ghost sm", onClick: () => importText(inp), disabled: !inp.trim() }, "Restore from pasted text"),
        msg && React.createElement("p", { className: msg.err ? "err" : "ok", role: "status" }, msg.t)));
}
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthSummary(E, ks) {
    const w = ks.map((k) => E[k].weight).filter(isNum);
    const c = ks.map((k) => E[k].intake).filter(isNum);
    const parts = [`${ks.length} day${ks.length === 1 ? "" : "s"}`];
    if (w.length)
        parts.push(`avg ${fmt1(mean(w))} lb`);
    if (c.length)
        parts.push(`${fmtInt(mean(c))} kcal`);
    return parts.join(", ");
}
function HistoryTab({ data, onSaveEntry }) {
    const E = data.entries;
    const keys = Object.keys(E).sort().reverse();
    if (!keys.length)
        return React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Daily log"),
            React.createElement("p", null, "Nothing logged yet. Your first check-in shows up here."));
    const years = [];
    keys.forEach((k) => {
        const y = k.slice(0, 4), m = k.slice(0, 7);
        let yr = years[years.length - 1];
        if (!yr || yr.y !== y) {
            yr = { y, months: [] };
            years.push(yr);
        }
        let mo = yr.months[yr.months.length - 1];
        if (!mo || mo.m !== m) {
            mo = { m, keys: [] };
            yr.months.push(mo);
        }
        mo.keys.push(k);
    });
    return (React.createElement("section", { className: "sec" },
        React.createElement("h2", null, "Daily log"),
        React.createElement("p", { className: "note", style: { marginBottom: 6 } }, "Weight is that morning. Everything else is for that whole day, entered the next morning. Tap Edit to see protein and water."),
        years.map((yr, yi) => (React.createElement("details", { className: "grp year", key: yr.y, open: yi === 0 },
            React.createElement("summary", null,
                React.createElement("span", { className: "ttl" }, yr.y),
                React.createElement("span", { className: "note" },
                    yr.months.reduce((a, m) => a + m.keys.length, 0),
                    " days")),
            yr.months.map((mo, mi) => (React.createElement("details", { className: "grp month", key: mo.m, open: yi === 0 && mi === 0 },
                React.createElement("summary", null,
                    React.createElement("span", { className: "ttl" }, MONTHS_FULL[Number(mo.m.slice(5, 7)) - 1]),
                    React.createElement("span", { className: "sum" }, monthSummary(E, mo.keys))),
                React.createElement("div", { className: "hist-row hist-head" },
                    React.createElement("span", null, "Day"),
                    React.createElement("span", null, "Weight"),
                    React.createElement("span", null, "Ate"),
                    React.createElement("span", null, "Active"),
                    React.createElement("span", null)),
                mo.keys.map((k) => React.createElement(HistRow, { key: k, k: k, e: E[k], onSave: onSaveEntry }))))))))));
}
/* ---------- app ---------- */
function readPrefill() {
    try {
        const p = new URLSearchParams(window.location.search);
        const o = {};
        ["w", "cal", "protein", "active", "water", "date", "save"].forEach((k) => { const v = p.get(k); if (v)
            o[k] = v; });
        return Object.keys(o).length ? o : null;
    }
    catch {
        return null;
    }
}
// Remember what the app told you each day, so history shows the real advice even if settings change later.
function withGiven(d, day) {
    const der = derive(d, day);
    const r = der.byKey[day];
    if (!r || !isNum(r.target) || !(d.entries[day] && isNum(d.entries[day].weight)))
        return d;
    if (d.given[day] === r.target)
        return d;
    return { ...d, given: { ...d.given, [day]: r.target } };
}
function App() {
    const today = todayKey();
    const dark = usePrefersDark();
    const pal = dark ? PAL_DARK : PAL_LIGHT;
    const [data, setData] = useState(null);
    const [tab, setTab] = useState("today");
    const [storeErr, setStoreErr] = useState(null);
    const [prefill, setPrefill] = useState(readPrefill);
    const [showSettings, setShowSettings] = useState(false);
    const persist = async (next) => {
        setData(next);
        try {
            const r = await storage.set(KEY, JSON.stringify(next));
            if (!r)
                throw new Error("no result");
            setStoreErr(null);
        }
        catch (e) {
            setStoreErr("Couldn't save to this phone's storage, so recent changes may be lost. Export a backup from History.");
        }
    };
    useEffect(() => {
        if (prefill) {
            try {
                window.history.replaceState(null, "", window.location.pathname);
            }
            catch { /* ignore */ }
        }
        try {
            navigator.storage && navigator.storage.persist && navigator.storage.persist();
        }
        catch { /* ignore */ }
        let alive = true;
        (async () => {
            let raw = null;
            try {
                const r = await storage.get(KEY);
                if (r && r.value)
                    raw = JSON.parse(r.value);
            }
            catch (e) { /* nothing stored yet */ }
            let d = raw ? migrate(raw, today) : null;
            const fresh = !d;
            if (!d)
                d = emptyData();
            const upgraded = !!raw && (raw.version || 1) < VERSION;
            const checked = withGiven(d, today);
            if (!alive)
                return;
            if (fresh || upgraded || checked !== d)
                persist(checked);
            else
                setData(d);
        })();
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const der = useMemo(() => (data ? derive(data, today) : null), [data, today]);
    const saveCheckIn = (date, vals) => {
        const entries = { ...data.entries };
        const pk = addDays(date, -1);
        if (isNum(vals.weight))
            entries[date] = { ...(entries[date] || {}), weight: vals.weight };
        const prevFields = {};
        for (const f of ["intake", "protein", "active", "resting", "water"])
            if (isNum(vals[f]))
                prevFields[f] = vals[f];
        if (Object.keys(prevFields).length)
            entries[pk] = { ...(entries[pk] || {}), ...prevFields };
        persist(withGiven({ ...data, entries }, date));
    };
    const saveEntry = (k, entry) => {
        const entries = { ...data.entries };
        if (Object.keys(entry).length)
            entries[k] = entry;
        else
            delete entries[k];
        persist({ ...data, entries });
    };
    const shell = (children) => (React.createElement("div", { className: "ct" },
        React.createElement("style", null, CSS),
        React.createElement("div", { className: "sbar" }),
        React.createElement("div", { className: "wrap" }, children)));
    if (!data || !der)
        return shell(React.createElement("p", { className: "note", style: { paddingTop: 24 } }, "Loading your log\u2026"));
    const s = data.settings;
    const rate = der.t14 ? der.t14.rateWk : null;
    const toGo = der.t14 ? der.t14.now - s.goalHigh : der.last ? der.last.w - s.goalHigh : null;
    return shell(React.createElement(React.Fragment, null,
        React.createElement("div", { className: "top" },
            React.createElement("div", { className: "brand" }, "Cut tracker"),
            React.createElement("button", { className: "gear", "aria-label": "Settings", onClick: () => setShowSettings(true) },
                React.createElement("svg", { width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
                    React.createElement("circle", { cx: "12", cy: "12", r: "3" }),
                    React.createElement("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" })))),
        React.createElement("div", { className: "readout" },
            React.createElement(Stat, { v: der.last ? fmt1(der.last.w) : "–", l: der.last ? (der.last.k === today ? "this morning" : `on ${fmtDay(der.last.k)}`) : "no weigh-ins" }),
            React.createElement(Stat, { v: der.avgNow != null ? fmt1(der.avgNow) : "–", l: "7-day average" }),
            React.createElement(Stat, { v: rate != null ? `${rate >= 0 ? "−" : "+"}${fmt1(Math.abs(rate))}` : "–", l: "lb/week, 2-wk trend" }),
            React.createElement(Stat, { v: toGo != null ? fmt1(Math.max(0, toGo)) : "–", l: `lb to ${s.goalHigh}` })),
        React.createElement("nav", { className: "tabs", role: "tablist", "aria-label": "Sections" }, [["today", "Today"], ["trend", "Trend"], ["watch", "Watch"], ["history", "History"]].map(([id, label]) => (React.createElement("button", { key: id, role: "tab", className: "tab", "aria-selected": tab === id, onClick: () => setTab(id) }, label)))),
        storeErr && React.createElement("p", { className: "err" }, storeErr),
        tab === "today" && (React.createElement(TodayTab, { data: data, der: der, today: today, onSave: saveCheckIn, prefill: prefill, onPrefillUsed: () => setPrefill(null), onRestore: () => setTab("history") })),
        tab === "trend" && React.createElement(TrendTab, { data: data, der: der, today: today, pal: pal }),
        tab === "watch" && React.createElement(WatchTab, { data: data, der: der, pal: pal, today: today }),
        tab === "history" && React.createElement(HistoryTab, { data: data, onSaveEntry: saveEntry }),
        showSettings && (React.createElement(SettingsSheet, { data: data, der: der, onClose: () => setShowSettings(false), onSaveSettings: (settings) => persist({ ...data, settings }), onImport: (d) => persist(withGiven(d, today)) }))));
}
createRoot(document.getElementById("root")).render(React.createElement(App, null));
window.__cutTrackerLoaded = true;
