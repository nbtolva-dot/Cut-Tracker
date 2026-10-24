// Cut tracker. Built from app.jsx.
import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceLine, ResponsiveContainer, } from "recharts";
/* ---------- constants ---------- */
const KEY = "cut-tracker:v1";
const KCAL_PER_LB = 3500;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULTS = {
    heightIn: 71, age: 25, sex: "male", activity: 1.675,
    goalRate: 1.25, minRate: 1.0, maxRate: 1.5,
    goalLow: 180, goalHigh: 185, cutStart: "2026-10-12",
    sleepHours: 7.5, calorieFloor: 2000, proteinLow: 180, proteinHigh: 200,
};
// Local storage on this device, same interface the Claude version used.
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
// weeks run Saturday to Friday
const weekStart = (k) => addDays(k, -((dow(k) + 1) % 7));
/* ---------- number helpers ---------- */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round50 = (x) => Math.round(x / 50) * 50;
const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const parseNum = (s) => {
    const t = String(s ?? "").replace(/[^0-9.\-]/g, "").trim();
    if (!t)
        return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : NaN;
};
/* ---------- empty starting data ---------- */
function emptyData() {
    return { version: 1, entries: {}, weeks: {}, settings: { ...DEFAULTS } };
}
function normalize(d) {
    if (!d || typeof d !== "object" || !d.entries)
        return null;
    return { version: 1, entries: d.entries || {}, weeks: d.weeks || {}, settings: { ...DEFAULTS, ...(d.settings || {}) } };
}
/* ---------- model ---------- */
function weightPts(entries, upTo) {
    return Object.keys(entries)
        .filter((k) => isNum(entries[k].weight) && (!upTo || k <= upTo))
        .sort()
        .map((k) => ({ k, x: dayNum(k), w: entries[k].weight }));
}
function latestWeightKey(entries, onOrBefore) {
    const ks = Object.keys(entries).filter((k) => k <= onOrBefore && isNum(entries[k].weight)).sort();
    return ks.length ? ks[ks.length - 1] : null;
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
    return { slope, at: (x) => my + slope * (x - mx), n };
}
function mifflin(lb, s) {
    const base = 10 * lb * 0.453592 + 6.25 * s.heightIn * 2.54 - 5 * s.age;
    return s.sex === "female" ? base - 161 : base + 5;
}
// Weights from startK..endK, intake from startK..endK-1 (each day's food shows up on the next morning's scale).
function windowStats(entries, startK, endK) {
    const s0 = dayNum(startK), s1 = dayNum(endK);
    const ws = [], intakes = [], watches = [];
    for (let n = s0; n <= s1; n++) {
        const e = entries[keyOf(n)];
        if (!e)
            continue;
        if (isNum(e.weight))
            ws.push([n - s1, e.weight]);
        if (n < s1) {
            if (isNum(e.intake))
                intakes.push(e.intake);
            if (isNum(e.watch))
                watches.push(e.watch);
        }
    }
    const reg = ws.length >= 5 ? linreg(ws) : null;
    const avgIntake = intakes.length ? mean(intakes) : null;
    const slope = reg ? reg.slope : null;
    const scaleBurn = reg && intakes.length >= 5 ? avgIntake - slope * KCAL_PER_LB : null;
    return {
        nW: ws.length, nI: intakes.length, nWatch: watches.length,
        avgIntake, avgWatch: watches.length ? mean(watches) : null,
        slope, rateWk: slope != null ? -slope * 7 : null,
        trendNow: reg ? reg.at(0) : null, scaleBurn,
    };
}
// Maintenance estimate: blend the formula with what the scale says, trusting the scale more as the cut matures.
function estimate(data, endK) {
    const s = data.settings;
    const startK = addDays(endK, -13);
    const w = windowStats(data.entries, startK, endK);
    const lastK = latestWeightKey(data.entries, endK);
    const cur = w.trendNow ?? avg7(data.entries, endK) ?? (lastK ? data.entries[lastK].weight : null);
    if (cur == null)
        return null;
    const formula = mifflin(cur, s) * s.activity;
    const daysIn = dayNum(endK) - dayNum(s.cutStart);
    const washout = clamp((daysIn - 7) / 21, 0, 1); // early water loss fades out over weeks 1 to 4
    const coverage = clamp(w.nI / 13, 0, 1);
    const trust = w.scaleBurn != null ? 0.9 * washout * coverage : 0;
    const tdee = w.scaleBurn != null ? trust * w.scaleBurn + (1 - trust) * formula : formula;
    return { ...w, startK, endK, cur, formula, daysIn, trust, tdee };
}
function recommend(est, s) {
    return Math.max(s.calorieFloor, round50(est.tdee - (s.goalRate * KCAL_PER_LB) / 7));
}
function basisOf(est, s) {
    return {
        startK: est.startK, endK: est.endK, avgIntake: est.avgIntake, nI: est.nI,
        rateWk: est.rateWk, scaleBurn: est.scaleBurn, formula: est.formula,
        trust: est.trust, tdee: est.tdee, goalRate: s.goalRate,
        deficit: (s.goalRate * KCAL_PER_LB) / 7,
    };
}
function lockWeek(data, ws, endK) {
    if (!endK)
        return data;
    const est = estimate(data, endK);
    if (!est)
        return data;
    const target = recommend(est, data.settings);
    return { ...data, weeks: { ...data.weeks, [ws]: { target, setOn: endK, basis: basisOf(est, data.settings) } } };
}
// Lock this week's target once the first weigh-in of the week exists.
function ensureWeek(data, today) {
    const ws = weekStart(today);
    if (data.weeks[ws])
        return data;
    const ks = Object.keys(data.entries).filter((k) => k >= ws && k <= today && isNum(data.entries[k].weight)).sort();
    return ks.length ? lockWeek(data, ws, ks[0]) : data;
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
function derive(data, today) {
    const s = data.settings;
    const pts = weightPts(data.entries, today);
    const last = pts[pts.length - 1] || null;
    const prev = pts[pts.length - 2] || null;
    const est = last ? estimate(data, last.k) : null;
    const avgNow = last ? avg7(data.entries, last.k) : null;
    const avgWeekAgo = last ? avg7(data.entries, addDays(last.k, -7)) : null;
    const ws = weekStart(today);
    const we = addDays(ws, 6);
    const locked = data.weeks[ws] || null;
    const provisional = !locked && est ? recommend(est, s) : null;
    const target = locked ? locked.target : provisional;
    const wkIntake = [];
    for (let k = ws; k < today; k = addDays(k, 1)) {
        const e = data.entries[k];
        if (e && isNum(e.intake))
            wkIntake.push(e.intake);
    }
    return { s, pts, last, prev, est, avgNow, avgWeekAgo, ws, we, locked, provisional, target, wkIntake };
}
function rateStatus(est, s) {
    if (!est || est.rateWk == null)
        return null;
    const r = est.rateWk;
    const early = est.daysIn < 21;
    if (r > s.maxRate) {
        return early
            ? { tone: "muted", text: `Faster than your ${s.maxRate} lb/week cap, but the first few weeks include water loss. The target adjusts on its own once that washes out.` }
            : { tone: "warn", text: `Faster than your ${s.maxRate} lb/week cap. Next week's target will come up to slow it down.` };
    }
    if (r >= s.minRate)
        return { tone: "good", text: `Inside your ${s.minRate}–${s.maxRate} lb/week range.` };
    if (r > 0)
        return { tone: "muted", text: `Slower than ${s.minRate} lb/week. Next week's target will come down if this holds.` };
    return { tone: "warn", text: "The trend isn't heading down. Check that logging has been complete." };
}
function buildRead(der, today) {
    const { last, prev, avgNow, avgWeekAgo, est } = der;
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
            const change = Math.abs(c) < 0.05 ? "unchanged" : `${c < 0 ? "down" : "up"} ${fmt1(Math.abs(c))}`;
            parts.push(`Your 7-day average is ${fmt1(avgNow)}, ${change} from a week ago.`);
        }
        else {
            parts.push(`Your 7-day average is ${fmt1(avgNow)}.`);
        }
    }
    if (est && est.rateWk != null) {
        parts.push(est.rateWk >= 0
            ? `The two-week trend has you losing ${fmt1(est.rateWk)} lb/week.`
            : `The two-week trend has you gaining ${fmt1(-est.rateWk)} lb/week.`);
    }
    return parts.join(" ");
}
function weekRows(data, der, today) {
    const out = [];
    const first = weekStart(data.settings.cutStart);
    for (let ws = der.ws; ws >= first; ws = addDays(ws, -7)) {
        const we = addDays(ws, 6);
        const ints = [];
        for (let k = ws; k <= we && k < today; k = addDays(k, 1)) {
            const e = data.entries[k];
            if (e && isNum(e.intake))
                ints.push(e.intake);
        }
        const endK = we < today ? we : today;
        const a1 = avg7(data.entries, endK);
        const a0 = avg7(data.entries, addDays(ws, -1));
        out.push({
            ws, target: data.weeks[ws]?.target ?? null,
            avg: ints.length ? mean(ints) : null, n: ints.length,
            change: a1 != null && a0 != null ? a1 - a0 : null,
        });
    }
    return out;
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
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.link{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:14px;color:var(--accent);text-decoration:underline;text-underline-offset:3px;cursor:pointer;margin-top:8px}
.note{font-size:14px;color:var(--muted)}
.ct .ok{font-size:14px;color:var(--good);margin-top:10px}
.ct .err{font-size:14px;color:var(--warn);margin-top:10px}
.ct .status{font-size:15px;margin-top:8px}
.status.warn{color:var(--warn)} .status.good{color:var(--good)} .status.muted{color:var(--muted)}
.basis{font-size:14px;color:var(--muted);margin-top:10px;padding-left:12px;border-left:3px solid var(--line)}
.seg{display:inline-flex;background:var(--surface);border-radius:10px;padding:3px;margin-bottom:10px}
.seg button{appearance:none;border:0;background:none;font:inherit;font-size:14px;color:var(--muted);padding:7px 14px;border-radius:8px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent);font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:var(--muted);margin-top:6px}
.sw{display:inline-block;width:16px;height:0;border-top:2.5px solid;vertical-align:middle;margin-right:6px}
.sw.dot{width:7px;height:7px;border:0;border-radius:50%;margin-right:6px}
.sw.band{height:9px;border:0;border-radius:2px;margin-right:6px}
.eta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px}
.eta-v{font-family:var(--display);font-weight:600;font-size:24px;line-height:1.05;font-variant-numeric:tabular-nums}
.eta-l{font-size:13px;color:var(--muted)}
.tbl{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:15px}
.tbl th{text-align:left;font-weight:500;font-size:13px;color:var(--muted);padding:6px 4px;border-bottom:1px solid var(--line)}
.tbl td{padding:9px 4px;border-bottom:1px solid var(--line)}
.tbl .r{text-align:right}
.hist-row{display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr auto;align-items:center;gap:6px;padding:10px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;font-size:15px}
.hist-head{font-size:13px;color:var(--muted);padding:6px 0}
.hist-edit{padding:12px 0;border-bottom:1px solid var(--line)}
.dim{color:var(--muted)}
.tip{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:13px;color:var(--ink);font-variant-numeric:tabular-nums}
.tip-d{font-weight:600;margin-bottom:2px}
.filebtn{display:inline-block;position:relative;overflow:hidden;text-align:center}
.filebtn input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
textarea.input{font-size:12px;min-height:120px;font-family:ui-monospace,Menlo,monospace}
@media (max-width:380px){ .hero-num{font-size:88px} .stat-v{font-size:23px} }
`;
/* ---------- small components ---------- */
function Stat({ v, l }) {
    return (React.createElement("div", null,
        React.createElement("div", { className: "stat-v" }, v),
        React.createElement("div", { className: "stat-l" }, l)));
}
function Basis({ b, target }) {
    if (!b)
        return null;
    return (React.createElement("div", { className: "basis" },
        React.createElement("p", null,
            "Window ",
            fmtDay(b.startK),
            " to ",
            fmtDay(b.endK),
            ".",
            " ",
            b.avgIntake != null && b.rateWk != null
                ? React.createElement(React.Fragment, null,
                    "You averaged ",
                    fmtInt(b.avgIntake),
                    " kcal over ",
                    b.nI,
                    " logged days while the scale trended ",
                    b.rateWk >= 0 ? "down" : "up",
                    " ",
                    fmt1(Math.abs(b.rateWk)),
                    " lb/week",
                    b.scaleBurn != null ? React.createElement(React.Fragment, null,
                        ", which implies a burn of ",
                        fmtInt(b.scaleBurn)) : null,
                    ".")
                : React.createElement(React.Fragment, null, "Not enough logged days yet to use the scale.")),
        React.createElement("p", null,
            "The formula estimate is ",
            fmtInt(b.formula),
            ". The scale got ",
            Math.round(b.trust * 100),
            "% of the weight (it earns more trust as the cut matures and logging fills in), giving maintenance of ",
            fmtInt(b.tdee),
            ". Subtract ",
            fmtInt(b.deficit),
            " for ",
            b.goalRate,
            " lb/week and round: ",
            fmtInt(target),
            ".")));
}
/* ---------- check-in form ---------- */
function CheckIn({ data, today, onSave, prefill, onPrefillUsed }) {
    const preDate = prefill?.date && /^\d{4}-\d{2}-\d{2}$/.test(prefill.date) && prefill.date <= today ? prefill.date : null;
    const [date, setDate] = useState(preDate || today);
    const [w, setW] = useState("");
    const [cal, setCal] = useState("");
    const [watch, setWatch] = useState("");
    const [msg, setMsg] = useState(null);
    const prevK = addDays(date, -1);
    useEffect(() => {
        const e = data.entries[date] || {};
        const p = data.entries[addDays(date, -1)] || {};
        let wv = isNum(e.weight) ? String(e.weight) : "";
        let cv = isNum(p.intake) ? String(p.intake) : "";
        let xv = isNum(p.watch) ? String(p.watch) : "";
        let m = null;
        if (prefill) {
            const clean = (v, dec) => { const n = parseNum(v); return n == null || Number.isNaN(n) ? null : String(dec ? Math.round(n * 10) / 10 : Math.round(n)); };
            const a = clean(prefill.w, true), b = clean(prefill.cal, false), c = clean(prefill.watch, false);
            if (a)
                wv = a;
            if (b)
                cv = b;
            if (c)
                xv = c;
            if (a || b || c)
                m = { err: false, t: "Filled in from your Shortcut. Check the numbers, then save." };
            onPrefillUsed && onPrefillUsed();
        }
        setW(wv);
        setCal(cv);
        setWatch(xv);
        setMsg(m);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [date]);
    const exists = isNum((data.entries[date] || {}).weight);
    const submit = () => {
        const wv = parseNum(w), cv = parseNum(cal), xv = parseNum(watch);
        if (Number.isNaN(wv) || (wv != null && (wv < 80 || wv > 500)))
            return setMsg({ err: true, t: "Weight should be a number in lb, like 211.8." });
        if (Number.isNaN(cv) || (cv != null && (cv < 0 || cv > 12000)))
            return setMsg({ err: true, t: "Calories should be a whole number, like 2550." });
        if (Number.isNaN(xv) || (xv != null && (xv < 0 || xv > 12000)))
            return setMsg({ err: true, t: "Watch total should be a whole number, like 3100." });
        if (wv == null && cv == null && xv == null)
            return setMsg({ err: true, t: "Enter at least one value to save." });
        onSave(date, wv == null ? null : Math.round(wv * 10) / 10, cv == null ? null : Math.round(cv), xv == null ? null : Math.round(xv));
        setMsg({ err: false, t: `Saved check-in for ${fmtDay(date)}.` });
    };
    return (React.createElement("section", { className: "sec" },
        React.createElement("h2", null, "Morning check-in"),
        React.createElement("div", { className: "panel" },
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Date"),
                React.createElement("input", { className: "input sm", type: "date", value: date, max: today, onChange: (e) => e.target.value && setDate(e.target.value) })),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Weight this morning (lb)"),
                React.createElement("input", { className: "input", inputMode: "decimal", placeholder: "211.8", value: w, onChange: (e) => setW(e.target.value) })),
            React.createElement("div", { className: "row2" },
                React.createElement("label", { className: "field" },
                    React.createElement("span", null,
                        "Calories eaten ",
                        fmtDay(prevK)),
                    React.createElement("input", { className: "input", inputMode: "numeric", placeholder: "2550", value: cal, onChange: (e) => setCal(e.target.value) })),
                React.createElement("label", { className: "field" },
                    React.createElement("span", null,
                        "Watch total ",
                        fmtDay(prevK)),
                    React.createElement("input", { className: "input", inputMode: "numeric", placeholder: "3100", value: watch, onChange: (e) => setWatch(e.target.value) }))),
            React.createElement("p", { className: "note", style: { marginTop: -4, marginBottom: 12 } }, "Watch total means active plus resting energy."),
            React.createElement("button", { className: "btn", onClick: submit }, exists ? "Update check-in" : "Save check-in"),
            msg && React.createElement("p", { className: msg.err ? "err" : "ok", role: "status" }, msg.t))));
}
/* ---------- tabs ---------- */
function TodayTab({ data, der, today, onSave, onRecalc, prefill, onPrefillUsed, onRestore }) {
    const s = data.settings;
    const [open, setOpen] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const wkAvg = der.wkIntake.length ? mean(der.wkIntake) : null;
    const status = rateStatus(der.est, s);
    const suggestion = der.est ? recommend(der.est, s) : null;
    let diffText = null;
    if (wkAvg != null && der.target != null) {
        const d = wkAvg - der.target;
        diffText = Math.abs(d) < 50 ? "right on target" : d > 0 ? `${fmtInt(d)} over target` : `${fmtInt(-d)} under target`;
    }
    const empty = Object.keys(data.entries).length === 0;
    return (React.createElement(React.Fragment, null,
        empty && (React.createElement("section", { className: "sec" },
            React.createElement("div", { className: "panel" },
                React.createElement("h2", null, "Start here"),
                React.createElement("p", null, "Moving over from the Claude version? Restore your backup file first so your history and this week's target come with you."),
                React.createElement("button", { className: "btn ghost", style: { marginTop: 12 }, onClick: onRestore }, "Restore a backup")))),
        React.createElement("section", { className: "hero" },
            React.createElement("p", { className: "hero-label" }, "Eat today"),
            React.createElement("div", { className: "hero-num" },
                der.target != null ? fmtInt(der.target) : "–",
                React.createElement("span", { className: "hero-unit" }, "kcal")),
            React.createElement("p", null,
                "Protein ",
                s.proteinLow,
                "\u2013",
                s.proteinHigh,
                " g.",
                " ",
                der.locked ? `Set for ${fmtDay(der.ws)} to ${fmtDay(der.we)}.` : der.target != null ? "Provisional until you log this morning's weight." : "Log a weigh-in to get a target."),
            wkAvg != null && (React.createElement("p", null,
                "This week so far: ",
                fmtInt(wkAvg),
                " average over ",
                der.wkIntake.length,
                " day",
                der.wkIntake.length === 1 ? "" : "s",
                ", ",
                diffText,
                ".")),
            der.target != null && (React.createElement("button", { className: "link", "aria-expanded": open, onClick: () => { setOpen((v) => !v); setConfirm(false); } }, open ? "Hide details" : "How this number was set")),
            open && (React.createElement("div", null,
                der.locked?.note && React.createElement("div", { className: "basis" },
                    React.createElement("p", null, der.locked.note)),
                der.locked?.basis && React.createElement(Basis, { b: der.locked.basis, target: der.locked.target }),
                !der.locked && der.est && React.createElement(Basis, { b: basisOf(der.est, s), target: der.provisional }),
                der.locked && suggestion != null && suggestion !== der.locked.target && (React.createElement("div", { className: "basis" },
                    React.createElement("p", null,
                        "Recalculated with today's data and settings, it would be ",
                        fmtInt(suggestion),
                        "."),
                    !confirm
                        ? React.createElement("button", { className: "btn ghost sm", style: { marginTop: 8 }, onClick: () => setConfirm(true) }, "Recalculate this week")
                        : React.createElement("div", { className: "btns" },
                            React.createElement("button", { className: "btn sm", onClick: () => { onRecalc(); setConfirm(false); } },
                                "Use ",
                                fmtInt(suggestion)),
                            React.createElement("button", { className: "btn ghost sm", onClick: () => setConfirm(false) },
                                "Keep ",
                                fmtInt(der.locked.target)))))))),
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
            fmt1(r.pace))));
}
function TrendTab({ data, der, today, pal }) {
    const [mode, setMode] = useState("recent");
    const s = data.settings;
    const { pts, est, last } = der;
    if (!last)
        return React.createElement("section", { className: "sec" },
            React.createElement("p", null, "Log a few weigh-ins and your trend shows up here."));
    const x0 = last.x;
    const w0 = est ? est.cur : last.w;
    const paceRate = est?.rateWk ?? null;
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
    const y0 = Math.floor(Math.min(...ys) - 1);
    const y1 = Math.ceil(Math.max(...ys) + 1);
    const ticks = [0, 1, 2, 3, 4].map((i) => Math.round(d0 + ((d1 - d0) * i) / 4));
    const eta = (rate, goal) => (rate != null && rate > 0.05 && w0 > goal ? keyOf(x0 + (w0 - goal) / (rate / 7)) : null);
    const planHigh = eta(s.goalRate, s.goalHigh), planLow = eta(s.goalRate, s.goalLow);
    const paceHigh = eta(paceRate, s.goalHigh), paceLow = eta(paceRate, s.goalLow);
    const mid = (s.goalLow + s.goalHigh) / 2;
    const perLb = 10 * 0.453592 * s.activity;
    const maintAtGoal = est ? est.tdee - (w0 - mid) * perLb : null;
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
                    "At your current pace (",
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
                            s.goalLow))),
                paceRate > s.maxRate && React.createElement("p", { className: "note", style: { marginTop: 8 } },
                    "Current pace is above your ",
                    s.maxRate,
                    " lb/week cap, so the plan line is the realistic one."))),
            maintAtGoal != null && (React.createElement("p", { className: "note", style: { marginTop: 14 } },
                "Estimated maintenance once you're around ",
                fmt1(mid),
                " lb: roughly ",
                fmtInt(round50(maintAtGoal)),
                " kcal. Your current estimate is ",
                fmtInt(round50(est.tdee)),
                "."))),
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
                    React.createElement("td", { className: "r" }, r.target != null ? fmtInt(r.target) : React.createElement("span", { className: "dim" }, "\u2013")),
                    React.createElement("td", { className: "r" }, r.avg != null ? React.createElement(React.Fragment, null,
                        fmtInt(r.avg),
                        " ",
                        React.createElement("span", { className: "dim" },
                            "(",
                            r.n,
                            "d)")) : React.createElement("span", { className: "dim" }, "\u2013")),
                    React.createElement("td", { className: "r" }, r.change != null ? `${r.change <= 0 ? "−" : "+"}${fmt1(Math.abs(r.change))}` : React.createElement("span", { className: "dim" }, "\u2013"))))))),
            React.createElement("p", { className: "note", style: { marginTop: 8 } }, "Avg change is the shift in your 7-day average across the week."))));
}
function WatchTab({ data, der, pal }) {
    const s = data.settings;
    const { last } = der;
    const head = React.createElement("h2", null, "Apple Watch accuracy");
    if (!last)
        return React.createElement("section", { className: "sec" },
            head,
            React.createElement("p", null, "Log weigh-ins and watch totals to start the comparison."));
    const end = last.k;
    const days = [];
    for (let k = addDays(end, -28); k < end; k = addDays(k, 1)) {
        const e = data.entries[k];
        if (e && isNum(e.watch))
            days.push({ k, watch: e.watch });
    }
    if (!days.length) {
        return (React.createElement("section", { className: "sec" },
            head,
            React.createElement("p", null, "No watch totals yet. Add yesterday's total (active plus resting) in your morning check-in."),
            React.createElement("p", { className: "note" }, "After about two weeks, this compares the watch's average against the burn your scale and food log imply. Three to four weeks gives a solid read.")));
    }
    const start = days[0].k;
    const n = days.length;
    const ws = windowStats(data.entries, start, end);
    const cur = der.est ? der.est.cur : last.w;
    const overnight = (mifflin(cur, s) / 24) * s.sleepHours;
    const raw = mean(days.map((d) => d.watch));
    const adj = raw + overnight;
    const scale = n >= 7 ? ws.scaleBurn : null;
    const early = dayNum(start) - dayNum(s.cutStart) < 21;
    const pct = scale ? (adj / scale - 1) * 100 : null;
    const factor = scale ? scale / adj : null;
    const ref = scale ?? der.est?.tdee ?? null;
    const bars = days.map((d) => ({ label: fmtDay(d.k), adj: d.watch + overnight }));
    const yMin = Math.floor((Math.min(...bars.map((b) => b.adj), ref ?? Infinity) * 0.85) / 100) * 100;
    return (React.createElement(React.Fragment, null,
        React.createElement("section", { className: "sec" },
            head,
            React.createElement("div", { className: "eta" },
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, fmtInt(raw)),
                    React.createElement("div", { className: "eta-l" },
                        "watch average, ",
                        n,
                        " day",
                        n === 1 ? "" : "s")),
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, fmtInt(adj)),
                    React.createElement("div", { className: "eta-l" },
                        "plus ~",
                        fmtInt(overnight),
                        " overnight")),
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, scale ? fmtInt(scale) : "–"),
                    React.createElement("div", { className: "eta-l" }, "burn your scale implies")),
                React.createElement("div", null,
                    React.createElement("div", { className: "eta-v" }, pct != null ? `${pct >= 0 ? "+" : "−"}${fmt1(Math.abs(pct))}%` : "–"),
                    React.createElement("div", { className: "eta-l" }, "watch vs scale"))),
            scale == null && React.createElement("p", { className: "note", style: { marginTop: 12 } },
                "Needs at least 7 days of watch totals for a first comparison. You have ",
                n,
                "."),
            scale != null && (React.createElement("p", { style: { marginTop: 12 } },
                Math.abs(pct) < 5
                    ? "So far the watch is tracking your real burn closely."
                    : pct > 0 ? `So far the watch reads about ${fmt1(pct)}% high.` : `So far the watch reads about ${fmt1(-pct)}% low.`,
                " ",
                "To convert a watch total into an estimate of your real burn, add ",
                fmtInt(overnight),
                " and multiply by ",
                factor.toFixed(2),
                ".")),
            scale != null && n < 21 && React.createElement("p", { className: "note" }, "Early read. Day-to-day scale noise moves this a lot until you have three or more weeks of watch data."),
            scale != null && early && React.createElement("p", { className: "note" }, "Some of these days fall in the first three weeks of the cut, when water loss inflates the scale's number. Expect the watch to look a bit lower than it really is until those days roll out.")),
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Daily watch totals"),
            React.createElement("div", { style: { width: "100%", height: 220 } },
                React.createElement(ResponsiveContainer, null,
                    React.createElement(BarChart, { data: bars, margin: { top: 8, right: 10, bottom: 0, left: -10 } },
                        React.createElement(CartesianGrid, { stroke: pal.line, strokeDasharray: "2 4", vertical: false }),
                        React.createElement(XAxis, { dataKey: "label", tick: { fill: pal.muted, fontSize: 11 }, axisLine: { stroke: pal.line }, tickLine: false, interval: "preserveStartEnd", minTickGap: 18 }),
                        React.createElement(YAxis, { domain: [yMin, "auto"], tickFormatter: (v) => fmtInt(v), width: 52, tick: { fill: pal.muted, fontSize: 12 }, axisLine: false, tickLine: false }),
                        React.createElement(Tooltip, { cursor: { fill: pal.line, fillOpacity: 0.3 }, contentStyle: { background: pal.surface, border: `1px solid ${pal.line}`, borderRadius: 10, color: pal.ink, fontSize: 13 }, formatter: (v) => [fmtInt(v), "Watch + overnight"] }),
                        React.createElement(Bar, { dataKey: "adj", fill: pal.accent, fillOpacity: 0.75, radius: [4, 4, 0, 0], isAnimationActive: false }),
                        ref != null && React.createElement(ReferenceLine, { y: ref, stroke: pal.amber, strokeWidth: 2, strokeDasharray: "6 4" })))),
            React.createElement("p", { className: "note" },
                "Bars include the estimated overnight burn. The dashed line is ",
                scale ? "the burn your scale implies over the same days" : "your current maintenance estimate",
                "."))));
}
function HistRow({ k, e, onSave }) {
    const [edit, setEdit] = useState(false);
    const [w, setW] = useState(""), [c, setC] = useState(""), [x, setX] = useState("");
    const [err, setErr] = useState(null);
    const begin = () => {
        setW(isNum(e.weight) ? String(e.weight) : "");
        setC(isNum(e.intake) ? String(e.intake) : "");
        setX(isNum(e.watch) ? String(e.watch) : "");
        setErr(null);
        setEdit(true);
    };
    const save = () => {
        const wv = parseNum(w), cv = parseNum(c), xv = parseNum(x);
        if ([wv, cv, xv].some((v) => Number.isNaN(v)))
            return setErr("Use plain numbers, or leave a field blank to clear it.");
        const next = {};
        if (wv != null)
            next.weight = wv;
        if (cv != null)
            next.intake = Math.round(cv);
        if (xv != null)
            next.watch = Math.round(xv);
        onSave(k, next);
        setEdit(false);
    };
    if (!edit) {
        return (React.createElement("div", { className: "hist-row" },
            React.createElement("span", null, fmtDayLong(k)),
            React.createElement("span", null, isNum(e.weight) ? fmt1(e.weight) : React.createElement("span", { className: "dim" }, "\u2013")),
            React.createElement("span", null, isNum(e.intake) ? fmtInt(e.intake) : React.createElement("span", { className: "dim" }, "\u2013")),
            React.createElement("span", null, isNum(e.watch) ? fmtInt(e.watch) : React.createElement("span", { className: "dim" }, "\u2013")),
            React.createElement("button", { className: "link", style: { marginTop: 0 }, onClick: begin, "aria-label": `Edit ${fmtDay(k)}` }, "Edit")));
    }
    return (React.createElement("div", { className: "hist-edit" },
        React.createElement("p", { style: { fontWeight: 600, marginBottom: 8 } }, fmtDayLong(k)),
        React.createElement("div", { className: "row2", style: { gridTemplateColumns: "1fr 1fr 1fr" } },
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Weight"),
                React.createElement("input", { className: "input sm", inputMode: "decimal", value: w, onChange: (ev) => setW(ev.target.value) })),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Ate"),
                React.createElement("input", { className: "input sm", inputMode: "numeric", value: c, onChange: (ev) => setC(ev.target.value) })),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Watch"),
                React.createElement("input", { className: "input sm", inputMode: "numeric", value: x, onChange: (ev) => setX(ev.target.value) }))),
        React.createElement("div", { className: "btns", style: { marginTop: 0 } },
            React.createElement("button", { className: "btn sm", onClick: save }, "Save day"),
            React.createElement("button", { className: "btn ghost sm", onClick: () => setEdit(false) }, "Cancel"),
            React.createElement("button", { className: "btn danger sm", onClick: () => { onSave(k, {}); setEdit(false); } }, "Delete day")),
        err && React.createElement("p", { className: "err" }, err)));
}
const SETTING_FIELDS = [
    { key: "goalRate", label: "Planned loss rate (lb/week)" },
    { key: "maxRate", label: "Rate cap (lb/week)" },
    { key: "minRate", label: "Slowest acceptable rate" },
    { key: "goalHigh", label: "Goal range top (lb)" },
    { key: "goalLow", label: "Goal range bottom (lb)" },
    { key: "proteinLow", label: "Protein low (g)" },
    { key: "proteinHigh", label: "Protein high (g)" },
    { key: "calorieFloor", label: "Never go below (kcal)" },
    { key: "heightIn", label: "Height (in)" },
    { key: "age", label: "Age" },
    { key: "activity", label: "Activity multiplier" },
    { key: "sleepHours", label: "Hours watch is off overnight" },
];
function Settings({ data, onSave }) {
    const [f, setF] = useState(() => Object.fromEntries(Object.entries(data.settings).map(([k, v]) => [k, String(v)])));
    const [msg, setMsg] = useState(null);
    const save = () => {
        const next = { ...data.settings };
        for (const { key, label } of SETTING_FIELDS) {
            const v = parseNum(f[key]);
            if (v == null || Number.isNaN(v) || v < 0)
                return setMsg({ err: true, t: `${label} needs a number.` });
            next[key] = v;
        }
        next.sex = f.sex === "female" ? "female" : "male";
        if (/^\d{4}-\d{2}-\d{2}$/.test(f.cutStart))
            next.cutStart = f.cutStart;
        if (next.goalRate > next.maxRate)
            next.goalRate = next.maxRate;
        if (next.goalLow > next.goalHigh)
            [next.goalLow, next.goalHigh] = [next.goalHigh, next.goalLow];
        onSave(next);
        setF(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])));
        setMsg({ err: false, t: "Settings saved. They apply when next week's target is set, or right away if you recalculate this week." });
    };
    return (React.createElement("div", { className: "panel" },
        React.createElement("div", { className: "row2" },
            SETTING_FIELDS.map(({ key, label }) => (React.createElement("label", { className: "field", key: key },
                React.createElement("span", null, label),
                React.createElement("input", { className: "input sm", inputMode: "decimal", value: f[key] ?? "", onChange: (e) => setF({ ...f, [key]: e.target.value }) })))),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Sex (for the formula)"),
                React.createElement("select", { className: "input sm", value: f.sex, onChange: (e) => setF({ ...f, sex: e.target.value }) },
                    React.createElement("option", { value: "male" }, "Male"),
                    React.createElement("option", { value: "female" }, "Female"))),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Cut start date"),
                React.createElement("input", { className: "input sm", type: "date", value: f.cutStart, onChange: (e) => setF({ ...f, cutStart: e.target.value }) }))),
        React.createElement("p", { className: "note", style: { marginBottom: 12 } }, "An activity multiplier of 1.675 reproduces the 3,300 kcal Mifflin\u2013St Jeor estimate at 211 lb."),
        React.createElement("button", { className: "btn", onClick: save }, "Save settings"),
        msg && React.createElement("p", { className: msg.err ? "err" : "ok", role: "status" }, msg.t)));
}
function Backup({ data, onImport }) {
    const [out, setOut] = useState(null);
    const [inp, setInp] = useState("");
    const [msg, setMsg] = useState(null);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(out);
            setMsg({ err: false, t: "Copied." });
        }
        catch {
            setMsg({ err: true, t: "Copy blocked here. Select the text and copy it manually." });
        }
    };
    const download = () => {
        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `cut-tracker-backup-${todayKey()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    };
    const importText = (t) => {
        try {
            const d = normalize(JSON.parse(t));
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
        React.createElement("p", { className: "note", style: { marginBottom: 10 } }, "Your data lives only on this phone. Download a backup now and then and drop it in Obsidian."),
        React.createElement("div", { className: "btns", style: { marginTop: 0 } },
            React.createElement("button", { className: "btn ghost sm", onClick: download }, "Download backup"),
            React.createElement("button", { className: "btn ghost sm", onClick: () => { setOut(JSON.stringify(data)); setMsg(null); } }, "Show as text"),
            out && React.createElement("button", { className: "btn sm", onClick: copy }, "Copy")),
        out && React.createElement("textarea", { className: "input", readOnly: true, value: out, style: { marginTop: 10 }, onFocus: (e) => e.target.select() }),
        React.createElement("h3", null, "Restore"),
        React.createElement("p", { className: "note", style: { marginBottom: 8 } }, "Restoring replaces everything currently in the app."),
        React.createElement("label", { className: "btn sm filebtn" },
            "Choose backup file",
            React.createElement("input", { type: "file", accept: ".json,application/json,text/plain", onChange: async (e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f)
                        importText(await f.text());
                    e.target.value = "";
                } })),
        React.createElement("label", { className: "field", style: { marginTop: 14 } },
            React.createElement("span", null, "Or paste backup text"),
            React.createElement("textarea", { className: "input", value: inp, onChange: (e) => setInp(e.target.value), placeholder: "Paste exported text here" })),
        React.createElement("button", { className: "btn ghost sm", onClick: () => importText(inp), disabled: !inp.trim() }, "Restore from pasted text"),
        msg && React.createElement("p", { className: msg.err ? "err" : "ok", role: "status" }, msg.t)));
}
function HistoryTab({ data, onSaveEntry, onSaveSettings, onImport }) {
    const keys = Object.keys(data.entries).sort().reverse();
    return (React.createElement(React.Fragment, null,
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Daily log"),
            React.createElement("p", { className: "note", style: { marginBottom: 6 } }, "Weight is that morning. Calories and watch are for that whole day, entered the next morning."),
            React.createElement("div", { className: "hist-row hist-head" },
                React.createElement("span", null, "Day"),
                React.createElement("span", null, "Weight"),
                React.createElement("span", null, "Ate"),
                React.createElement("span", null, "Watch"),
                React.createElement("span", null)),
            keys.map((k) => React.createElement(HistRow, { key: k, k: k, e: data.entries[k], onSave: onSaveEntry }))),
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Settings"),
            React.createElement(Settings, { data: data, onSave: onSaveSettings })),
        React.createElement("section", { className: "sec" },
            React.createElement("h2", null, "Backup"),
            React.createElement(Backup, { data: data, onImport: onImport }))));
}
/* ---------- app ---------- */
function readPrefill() {
    try {
        const p = new URLSearchParams(window.location.search);
        const o = {};
        ["w", "cal", "watch", "date"].forEach((k) => { const v = p.get(k); if (v)
            o[k] = v; });
        return Object.keys(o).length ? o : null;
    }
    catch {
        return null;
    }
}
function App() {
    const today = todayKey();
    const dark = usePrefersDark();
    const pal = dark ? PAL_DARK : PAL_LIGHT;
    const [data, setData] = useState(null);
    const [tab, setTab] = useState("today");
    const [storeErr, setStoreErr] = useState(null);
    const [prefill, setPrefill] = useState(readPrefill);
    const persist = async (next) => {
        setData(next);
        try {
            const r = await storage.set(KEY, JSON.stringify(next));
            if (!r)
                throw new Error("no result");
            setStoreErr(null);
        }
        catch (e) {
            setStoreErr("Couldn't save to this phone's storage, so recent changes may be lost. Download a backup from History.");
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
            let d = null;
            try {
                const r = await storage.get(KEY);
                if (r && r.value)
                    d = normalize(JSON.parse(r.value));
            }
            catch (e) { /* nothing stored yet */ }
            const fresh = !d;
            if (!d)
                d = emptyData();
            const checked = ensureWeek(d, today);
            if (!alive)
                return;
            if (fresh || checked !== d)
                persist(checked);
            else
                setData(d);
        })();
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const der = useMemo(() => (data ? derive(data, today) : null), [data, today]);
    const saveCheckIn = (date, w, cal, watch) => {
        const entries = { ...data.entries };
        const pk = addDays(date, -1);
        if (w != null)
            entries[date] = { ...(entries[date] || {}), weight: w };
        if (cal != null || watch != null) {
            const p = { ...(entries[pk] || {}) };
            if (cal != null)
                p.intake = cal;
            if (watch != null)
                p.watch = watch;
            entries[pk] = p;
        }
        persist(ensureWeek({ ...data, entries }, today));
    };
    const saveEntry = (k, entry) => {
        const entries = { ...data.entries };
        if (Object.keys(entry).length)
            entries[k] = entry;
        else
            delete entries[k];
        persist(ensureWeek({ ...data, entries }, today));
    };
    const recalc = () => {
        const ws = weekStart(today);
        persist(lockWeek(data, ws, latestWeightKey(data.entries, today)));
    };
    const shell = (children) => (React.createElement("div", { className: "ct" },
        React.createElement("style", null, CSS),
        React.createElement("div", { className: "sbar" }),
        React.createElement("div", { className: "wrap" }, children)));
    if (!data || !der)
        return shell(React.createElement("p", { className: "note", style: { paddingTop: 24 } }, "Loading your log\u2026"));
    const s = data.settings;
    const rate = der.est?.rateWk;
    const toGo = der.est ? der.est.cur - s.goalHigh : der.last ? der.last.w - s.goalHigh : null;
    return shell(React.createElement(React.Fragment, null,
        React.createElement("div", { className: "brand" }, "Cut tracker"),
        React.createElement("div", { className: "readout" },
            React.createElement(Stat, { v: der.last ? fmt1(der.last.w) : "–", l: der.last ? (der.last.k === today ? "this morning" : `on ${fmtDay(der.last.k)}`) : "no weigh-ins" }),
            React.createElement(Stat, { v: der.avgNow != null ? fmt1(der.avgNow) : "–", l: "7-day average" }),
            React.createElement(Stat, { v: rate != null ? `${rate >= 0 ? "−" : "+"}${fmt1(Math.abs(rate))}` : "–", l: "lb/week, 2-wk trend" }),
            React.createElement(Stat, { v: toGo != null ? fmt1(Math.max(0, toGo)) : "–", l: `lb to ${s.goalHigh}` })),
        React.createElement("nav", { className: "tabs", role: "tablist", "aria-label": "Sections" }, [["today", "Today"], ["trend", "Trend"], ["watch", "Watch"], ["history", "History"]].map(([id, label]) => (React.createElement("button", { key: id, role: "tab", className: "tab", "aria-selected": tab === id, onClick: () => setTab(id) }, label)))),
        storeErr && React.createElement("p", { className: "err" }, storeErr),
        tab === "today" && (React.createElement(TodayTab, { data: data, der: der, today: today, onSave: saveCheckIn, onRecalc: recalc, prefill: prefill, onPrefillUsed: () => setPrefill(null), onRestore: () => setTab("history") })),
        tab === "trend" && React.createElement(TrendTab, { data: data, der: der, today: today, pal: pal }),
        tab === "watch" && React.createElement(WatchTab, { data: data, der: der, pal: pal }),
        tab === "history" && (React.createElement(HistoryTab, { data: data, onSaveEntry: saveEntry, onSaveSettings: (settings) => persist({ ...data, settings }), onImport: (d) => { persist(ensureWeek(d, today)); } }))));
}
createRoot(document.getElementById("root")).render(React.createElement(App, null));
window.__cutTrackerLoaded = true;
