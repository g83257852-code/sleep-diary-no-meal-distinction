"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * SleepDiaryPainter（30日ビュー / 15分エポック = 96セル）
 * - ドラッグ/タップで塗る（1=睡眠, 0=覚醒）
 * - 参加者IDごとに端末内保存（同端末・同ブラウザで続きから）
 * - 休日/目覚ましチェック
 * - 食事（朝・昼・夕・間食）の時刻入力（間食は複数可）
 * - 時刻ラベル：行ごとに1h/2h間隔で表示（トグル可）
 * - CSV（30日一括）：date,weekday,holiday,alarm,breakfast,lunch,dinner,snacks,bedtime,wakeup,00:00,...,23:45
 * - SRI計算：隣接日ペアの時刻一致率（未入力日は除外）→ UI表示 + CSVにサマリ追記
 * - SJL計算：土日(holiday=true)と平日(holiday=false)の mid-sleep 差 |MSF - MSW| を表示（ボタン）
 *
 * Hydration-safe（SSR安全）対応：
 * - 初期 rangeStart を SSR では空にして、マウント後に new Date() を代入
 * - localStorage 読みは useEffect 内のみ
 * - 日付パースはローカル確定（parseLocalISO）
 */

const MIN_PER_CELL = 15;
const CELLS_PER_DAY = (24 * 60) / MIN_PER_CELL; // 96
const LS_KEY = "sleep-diary-painter-v1";
const PID_KEY = "sleep-diary-pid";
const getStoreKey = (pid: string) => `${LS_KEY}:${pid || "anon"}`;

const WEEKDAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad2 = (n: number) => n.toString().padStart(2, "0");
const fmtDateKey = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// ローカル日付として安全にパース（UTC依存のブレ回避）
const parseLocalISO = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1); // ローカル 00:00
};

const makeEmptyDay = (): number[] => Array.from({ length: CELLS_PER_DAY }, () => 0);
const clone = (arr: number[]) => arr.slice();

const download = (filename: string, text: string) => {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 300);
};

// ===== localStorage helpers（サーバ実行を避ける） =====
const safeGetItem = (k: string) => {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const safeSetItem = (k: string, v: string) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(k, v);
  } catch {}
};
const loadAll = (pid = "anon"): Record<string, number[]> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(getStoreKey(pid));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};
const saveAll = (obj: Record<string, number[]>, pid = "anon") => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getStoreKey(pid), JSON.stringify(obj));
  } catch {}
};

// ===== 食事メタ情報 =====
export type Meta = {
  holiday: boolean;
  alarm: boolean;
  breakfast: string | null; // "HH:MM" or null
  lunch: string | null;
  dinner: string | null;
  snacks: string[]; // ["HH:MM", ...]
};

const defaultMeta: Meta = {
  holiday: false,
  alarm: false,
  breakfast: null,
  lunch: null,
  dinner: null,
  snacks: [],
};

// ===== 時刻ユーティリティ =====
const idxToTime = (idx: number) => {
  const i = ((idx % CELLS_PER_DAY) + CELLS_PER_DAY) % CELLS_PER_DAY; // wrap 0..95
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${pad2(h)}:${pad2(m)}`;
};

// 与えられた 0/1 配列（96 or 192）から連続1区間(run)を列挙
const listRuns = (arr: number[]) => {
  const runs: { s: number; e: number }[] = []; // [s, e) 半開区間
  let i = 0;
  while (i < arr.length) {
    if (arr[i] !== 1) {
      i++;
      continue;
    }
    const s = i;
    while (i < arr.length && arr[i] === 1) i++;
    const e = i;
    runs.push({ s, e });
  }
  return runs;
};

// その日の「主睡眠」を、当日と翌日を2日連結(192セル)して、
// 夕方〜深夜スタートの最長 run を採用して推定
const estimateNightForDay = (
  dayArr: number[],
  nextArr: number[] | null
): { startIdx: number; endIdx: number } | null => {
  const twoDay = nextArr ? [...dayArr, ...nextArr] : [...dayArr, ...Array(CELLS_PER_DAY).fill(0)];
  const runs = listRuns(twoDay);
  // 夕方(15:00=idx60)〜24:00(95)の間に開始する run を候補に
  const CAND_START_MIN = 60; // 15:00
  const CAND_START_MAX = 95; // 24:00直前
  let best: { s: number; e: number } | null = null;
  for (const r of runs) {
    if (r.s >= CAND_START_MIN && r.s <= CAND_START_MAX) {
      if (!best || r.e - r.s > best.e - best.s) best = r;
    }
  }
  if (!best) return null;
  return { startIdx: best.s, endIdx: best.e };
};

export default function SleepDiaryPainter() {
  // ===== Hydration-safe：マウント管理 =====
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ====== 状態 ======
  const [pid, setPid] = useState<string>(""); // 後読み
  const [store, setStore] = useState<Record<string, number[]>>({}); // 後読み

  const metaKey = (id: string) => `${getStoreKey(id)}:meta_v2`; // v2: 食事対応
  const [meta, setMeta] = useState<Record<string, Meta>>({}); // 後読み

  // 30日レンジ（初期=SSRでは空、マウント後に今日をセット）
  const [rangeStart, setRangeStart] = useState<string>("");
  const rangeLen = 30;

  useEffect(() => {
    if (!rangeStart) setRangeStart(fmtDateKey(new Date()));
  }, [rangeStart]);

  const rangeKeys = useMemo(() => {
    if (!rangeStart) return [] as string[];
    const start = parseLocalISO(rangeStart);
    return Array.from({ length: rangeLen }, (_, i) =>
      fmtDateKey(new Date(start.getTime() + i * 86400000))
    );
  }, [rangeStart]);

  // 描画状態
  const [isPainting, setIsPainting] = useState(false);
  const [paintValue, setPaintValue] = useState<0 | 1>(1);
  const [eraser, setEraser] = useState(false);

  // 高速ドラッグ対策：補間のための参照
  const paintingKeyRef = useRef<string | null>(null);
  const lastIdxRef = useRef<number | null>(null);

  // 時刻ラベル（1h/2h 切替）
  const [labelStepHours, setLabelStepHours] = useState<1 | 2>(2);
  const labelIndices = useMemo(() => {
    const stepCells = (60 / MIN_PER_CELL) * labelStepHours; // 1h => 4, 2h => 8
    const arr: number[] = [];
    for (let i = 0; i <= CELLS_PER_DAY; i += stepCells) arr.push(i);
    return arr;
  }, [labelStepHours]);

  // 初回マウント時にPIDを後読み
  useEffect(() => {
    const saved = safeGetItem(PID_KEY) || "";
    setPid(saved);
  }, []);

  // PIDが決まったらデータ/メタを後読み
  useEffect(() => {
    const id = pid || "anon";
    setStore(loadAll(id));
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(metaKey(id)) : null;
      setMeta(raw ? JSON.parse(raw) : {});
    } catch {
      setMeta({});
    }
    if (pid) safeSetItem(PID_KEY, pid);
  }, [pid]);

  // ====== ユーティリティ（状態操作） ======
  const getDay = (key: string) => store[key] ?? makeEmptyDay();
  const setDay = (key: string, updater: (prev: number[]) => number[]) => {
    const next = updater(getDay(key)).map((v) => Number(v) as 0 | 1);
    setStore((prev) => {
      const n = { ...prev, [key]: next };
      saveAll(n, pid || "anon");
      return n;
    });
  };

  const getMeta = (key: string): Meta => ({ ...defaultMeta, ...(meta[key] ?? {}) });
  const setMetaFor = (key: string, updater: (prev: Meta) => Meta) => {
    const next = updater(getMeta(key));
    setMeta((prev) => {
      const m = { ...prev, [key]: next };
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(metaKey(pid || "anon"), JSON.stringify(m));
        } catch {}
      }
      return m;
    });
  };

  // ====== 高速ドラッグの補間（区間塗り） ======
  const paintSpan = (key: string, fromIdx: number | null, toIdx: number, val: 0 | 1) => {
    setDay(key, (prev) => {
      const a = clone(prev);
      const start = fromIdx === null ? toIdx : Math.min(fromIdx, toIdx);
      const end = fromIdx === null ? toIdx : Math.max(fromIdx, toIdx);
      for (let i = start; i <= end; i++) a[i] = val;
      return a;
    });
    lastIdxRef.current = toIdx;
  };

  // ====== ポインタイベント ======
  const handlePointerDownAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      // 左クリック以外はスルー（マウス時のみ判定）
      if (e.pointerType === "mouse" && (e as any).button !== 0) return;

      setIsPainting(true);
      const val: 0 | 1 = eraser ? 0 : 1;
      setPaintValue(val);

      paintingKeyRef.current = key;
      lastIdxRef.current = idx;
      paintSpan(key, idx, idx, val); // まず押下セルを塗る
    };

  const handlePointerMoveAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isPainting || paintingKeyRef.current !== key) return;
      paintSpan(key, lastIdxRef.current, idx, paintValue); // 前回→今回を補間
    };

  const handlePointerEnterAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isPainting || paintingKeyRef.current !== key) return;
      paintSpan(key, lastIdxRef.current, idx, paintValue); // セル跨ぎ保険
    };

  const handlePointerUpAt = () => {
    setIsPainting(false);
    paintingKeyRef.current = null;
    lastIdxRef.current = null;
  };

  // 画面外で離した時の保険
  useEffect(() => {
    const onUp = () => {
      setIsPainting(false);
      paintingKeyRef.current = null;
      lastIdxRef.current = null;
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // ====== SRI関連 ======
  const isTouched = (arr: number[]) => arr.some((v) => v === 1); // 1が一度も無い日は未入力扱い
  type SriSummary = { percent: number; matches: number; total: number; usedPairs: number };

  const computeSriForRange = (): SriSummary => {
    let matches = 0;
    let total = 0;
    let usedPairs = 0;

    for (let i = 0; i < rangeKeys.length - 1; i++) {
      const a = getDay(rangeKeys[i]);
      const b = getDay(rangeKeys[i + 1]);
      if (!isTouched(a) || !isTouched(b)) continue; // 未入力日は除外

      usedPairs++;
      for (let t = 0; t < CELLS_PER_DAY; t++) {
        if (a[t] === b[t]) matches++;
        total++;
      }
    }

    return {
      percent: total > 0 ? (matches / total) * 100 : NaN,
      matches,
      total,
      usedPairs,
    };
  };

  // ====== 日毎の就寝/起床・mid-sleep ======
  const estimateBedWakeForDay = (key: string): { bed: string; wake: string; midHour: number | null } => {
    const day = getDay(key);
    const idx = rangeKeys.indexOf(key);
    const next = idx >= 0 && idx < rangeKeys.length - 1 ? getDay(rangeKeys[idx + 1]) : null;
    const night = estimateNightForDay(day, next);
    if (!night) return { bed: "", wake: "", midHour: null };
    const bed = idxToTime(night.startIdx);

    // endIdx は two-day 基準。wake は endIdx を HH:MM に変換
    const wake = idxToTime(night.endIdx);

    // mid-sleep（時間, 小数）
    const midIdx = (night.startIdx + night.endIdx) / 2; // 0..192
    const midHour = (midIdx * MIN_PER_CELL) / 60; // 時間単位（0..48）
    return { bed, wake, midHour };
  };

  // ====== SJL（MSF vs MSW） ======
  type SjlResult = { sjlHours: number; msf: number; msw: number; nF: number; nW: number } | null;
  const computeSJL = (): SjlResult => {
    if (rangeKeys.length === 0) return null;
    const midsFree: number[] = [];
    const midsWork: number[] = [];

    for (const key of rangeKeys) {
      const m = getMeta(key);
      const { midHour } = estimateBedWakeForDay(key);
      if (midHour == null) continue;
      if (m.holiday) midsFree.push(midHour);
      else midsWork.push(midHour);
    }

    if (midsFree.length === 0 || midsWork.length === 0) return null;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const msf = mean(midsFree);
    const msw = mean(midsWork);
    const sjl = Math.abs(msf - msw);
    return { sjlHours: sjl, msf, msw, nF: midsFree.length, nW: midsWork.length };
  };

  const [sri, setSri] = useState<number | null>(null);
  const [usedPairs, setUsedPairs] = useState<number>(0);
  const [sjl, setSjl] = useState<SjlResult>(null);

  const handleComputeSRI = () => {
    const r = computeSriForRange();
    if (!isFinite(r.percent)) {
      alert("比較できる有効な日ペアがありません（未入力日が多い可能性）。");
      setSri(null);
      setUsedPairs(0);
      return;
    }
    setSri(r.percent);
    setUsedPairs(r.usedPairs);
  };

  const handleComputeSJL = () => {
    const r = computeSJL();
    if (!r) {
      alert("SJLを計算できません（休日/平日の両方に有効な夜間睡眠が必要）。");
      setSjl(null);
      return;
    }
    setSjl(r);
  };

  // ====== CSVエクスポート（SRIサマリ追記 & 日毎の就寝/起床列を追加） ======
  const exportCsv30 = () => {
    if (!rangeStart) return;
    const header = [
      "date",
      "weekday",
      "holiday",
      "alarm",
      "breakfast",
      "lunch",
      "dinner",
      "snacks",
      "bedtime",
      "wakeup",
      ...Array.from({ length: 96 }, (_, i) => {
        const h = Math.floor(i / 4);
        const m = (i % 4) * 15;
        return `${pad2(h)}:${pad2(m)}`;
      }),
    ];
    const lines = [header.join(",")];

    for (const key of rangeKeys) {
      const arr = getDay(key).map((v) => (v ? 1 : 0));
      const m = getMeta(key);
      const weekday = WEEKDAYS_EN[parseLocalISO(key).getDay()];
      const { bed, wake } = estimateBedWakeForDay(key);
      const row = [
        key,
        weekday,
        m.holiday ? 1 : 0,
        m.alarm ? 1 : 0,
        m.breakfast ?? "",
        m.lunch ?? "",
        m.dinner ?? "",
        (m.snacks || []).join(";"),
        bed,
        wake,
        ...arr,
      ];
      lines.push(row.join(","));
    }

    // --- サマリ（SRI）を末尾に追記 ---
    const sriSumm = computeSriForRange();
    const sriLine = [
      "SRI_percent",
      isFinite(sriSumm.percent) ? sriSumm.percent.toFixed(2) : "",
      "used_pairs",
      String(sriSumm.usedPairs),
    ].join(",");
    lines.push("");
    lines.push(sriLine);

    // --- サマリ（SJL）を末尾に追記 ---
    const sjlSumm = computeSJL();
    if (sjlSumm) {
      const sjlLine = [
        "SJL_hours",
        sjlSumm.sjlHours.toFixed(2),
        "MSF",
        sjlSumm.msf.toFixed(2),
        "MSW",
        sjlSumm.msw.toFixed(2),
        "n_free",
        String(sjlSumm.nF),
        "n_work",
        String(sjlSumm.nW),
      ].join(",");
      lines.push(sjlLine);
    }

    const csv = lines.join("\n");
    download(`sleep_diary_${pid || "anon"}_${rangeStart}.csv`, csv);
  };

  // ====== 初期（SSR一致）スケルトン：hydration-safe ======
  if (!mounted || !rangeStart) {
    return <div className="p-4 sm:p-6 md:p-8 max-w-[1320px] mx-auto" />;
  }

  // ====== UI ======
  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-[1320px] mx-auto">
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">睡眠日誌（30日）</h1>

      {/* 使い方ガイド */}
      <section className="mt-3 mb-6 text-sm text-neutral-700 dark:text-neutral-300 space-y-1">
        <h2 className="font-semibold">使い方</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            各行は1日分（00:00〜23:45の96セル）。<strong>寝ている時間を塗りつぶしてください。</strong>
            <strong>塗られていない部分は覚醒時間です。</strong>
          </li>
          <li>間違えたら「消す（覚醒）」で上書きしてください（ドラッグで連続）。</li>
          <li>日をまたぐ睡眠は、当日分と翌日分に分けて入力してください。</li>
          <li>
            行左の☑で <strong>休日</strong>／<strong>目覚まし</strong> を記録。
          </li>
          <li>食事はその日の時刻を入力（間食は複数可）。</li>
        </ul>

        <div className="flex flex-wrap items-center gap-3 mt-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="inline-block w-4 h-4 bg-indigo-500" /> 睡眠（塗る）
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-4 h-4 bg-white border" /> 覚醒（消す）
          </div>
          <div className="flex items-center gap-2">
            <span className="text-neutral-600">時刻ラベル：</span>
            <button
              onClick={() => setLabelStepHours(1)}
              className={`px-2 py-1 rounded border ${
                labelStepHours === 1 ? "bg-indigo-600 text-white" : "bg-white dark:bg-neutral-900"
              }`}
            >
              1時間
            </button>
            <button
              onClick={() => setLabelStepHours(2)}
              className={`px-2 py-1 rounded border ${
                labelStepHours === 2 ? "bg-indigo-600 text-white" : "bg-white dark:bg-neutral-900"
              }`}
            >
              2時間
            </button>
          </div>
        </div>
      </section>

      {/* ヘッダ操作 */}
      <div className="mt-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <label className="text-sm font-medium">参加者ID</label>
        <input
          type="text"
          value={pid}
          onChange={(e) => setPid(e.target.value)}
          placeholder="例: S001（空でも可）"
          className="px-3 py-2 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
        />

        <label className="text-sm font-medium">開始日（30日）</label>
        <input
          type="date"
          value={rangeStart}
          onChange={(e) => setRangeStart(e.target.value)}
          className="px-3 py-2 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
        />

        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => setEraser(false)}
            className={`px-3 py-2 rounded-lg border ${
              !eraser ? "bg-indigo-600 text-white" : "bg-white dark:bg-neutral-900"
            }`}
          >
            塗る（睡眠）
          </button>
          <button
            onClick={() => setEraser(true)}
            className={`px-3 py-2 rounded-lg border ${
              eraser ? "bg-indigo-600 text-white" : "bg-white dark:bg-neutral-900"
            }`}
          >
            消す（覚醒）
          </button>
          <button onClick={exportCsv30} className="px-3 py-2 rounded-lg border">
            CSV download
          </button>
          <button onClick={handleComputeSRI} className="px-3 py-2 rounded-lg border">
            SRI計算
          </button>
          <button onClick={handleComputeSJL} className="px-3 py-2 rounded-lg border">
            SJL計算
          </button>
        </div>
      </div>

      {/* SRI表示 */}
      {sri !== null && (
        <div className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
          この30日範囲の <strong>SRI = {sri.toFixed(1)}%</strong>
          {usedPairs > 0 ? <span className="ml-2">(有効ペア: {usedPairs})</span> : null}
        </div>
      )}

      {/* SJL表示 */}
      {sjl && (
        <div className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
          SJL = <strong>{sjl.sjlHours.toFixed(2)} h</strong>
          <span className="ml-2">(MSF: {sjl.msf.toFixed(2)} h, MSW: {sjl.msw.toFixed(2)} h)</span>
          <span className="ml-2">[free n={sjl.nF}, work n={sjl.nW}]</span>
        </div>
      )}

      {/* 本体：30行（各行=96セル） */}
      <div className="mt-4 space-y-3 select-none">
        {rangeKeys.map((key) => {
          const rowArr = getDay(key);
          const m = getMeta(key);
          const { bed, wake } = estimateBedWakeForDay(key);
          return (
            <div key={key} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-2">
              {/* 行ヘッダ（左：日付/曜日/チェック、右：食事時刻） */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <div className="font-medium">
                    {key}（{WEEKDAYS_JP[parseLocalISO(key).getDay()]}）
                  </div>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={m.holiday}
                      onChange={(e) => setMetaFor(key, (prev) => ({ ...prev, holiday: e.target.checked }))}
                    />
                    休日
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={m.alarm}
                      onChange={(e) => setMetaFor(key, (prev) => ({ ...prev, alarm: e.target.checked }))}
                    />
                    目覚まし
                  </label>
                  <span className="text-neutral-500">就寝: <strong>{bed || "--:--"}</strong></span>
                  <span className="text-neutral-500">起床: <strong>{wake || "--:--"}</strong></span>
                </div>

                {/* 食事入力 */}
                <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
                  <div className="flex items-center gap-1">
                    <span className="w-10 text-right">朝食</span>
                    <input
                      type="time"
                      value={m.breakfast ?? ""}
                      onChange={(e) => setMetaFor(key, (prev) => ({ ...prev, breakfast: e.target.value || null }))}
                      className="px-2 py-1 rounded border w-[92px]"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="w-10 text-right">昼食</span>
                    <input
                      type="time"
                      value={m.lunch ?? ""}
                      onChange={(e) => setMetaFor(key, (prev) => ({ ...prev, lunch: e.target.value || null }))}
                      className="px-2 py-1 rounded border w-[92px]"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="w-10 text-right">夕食</span>
                    <input
                      type="time"
                      value={m.dinner ?? ""}
                      onChange={(e) => setMetaFor(key, (prev) => ({ ...prev, dinner: e.target.value || null }))}
                      className="px-2 py-1 rounded border w-[92px]"
                    />
                  </div>

                  {/* 間食：可変個 */}
                  <div className="flex items-center gap-1">
                    <span className="w-10 text-right">間食</span>
                    {(m.snacks || []).map((t, idx) => (
                      <div key={`${key}-snk-${idx}`} className="flex items-center gap-1">
                        <input
                          type="time"
                          value={t}
                          onChange={(e) =>
                            setMetaFor(key, (prev) => {
                              const next = [...(prev.snacks || [])];
                              next[idx] = e.target.value;
                              return { ...prev, snacks: next };
                            })
                          }
                          className="px-2 py-1 rounded border w-[92px]"
                        />
                        <button
                          className="px-2 py-1 border rounded"
                          onClick={() =>
                            setMetaFor(key, (prev) => {
                              const next = [...(prev.snacks || [])];
                              next.splice(idx, 1);
                              return { ...prev, snacks: next };
                            })
                          }
                          aria-label="間食削除"
                        >
                          −
                        </button>
                      </div>
                    ))}
                    <button
                      className="px-2 py-1 border rounded"
                      onClick={() =>
                        setMetaFor(key, (prev) => {
                          const cur = prev.snacks || [];
                          if (cur.length >= 4) return prev; // 上限4
                          return { ...prev, snacks: [...cur, ""] };
                        })
                      }
                    >
                      + 追加
                    </button>
                  </div>
                </div>
              </div>

              {/* 行ごとの時刻ラベル */}
              <div className="mt-2 flex items-center gap-2">
                <div className="w-40 shrink-0" />
                <div className="relative grow">
                  {/* ベースライン（薄い） */}
                  <div
                    className="grid text-[10px] text-neutral-500 select-none"
                    style={{ gridTemplateColumns: `repeat(${CELLS_PER_DAY}, minmax(0,1fr))` }}
                  >
                    {Array.from({ length: CELLS_PER_DAY }).map((_, i) => (
                      <div key={`tick-${i}`} className="h-3 border-b border-neutral-200 dark:border-neutral-800" />
                    ))}
                  </div>
                  {/* ラベル（1h or 2h毎） */}
                  <div
                    className="absolute inset-0 grid text-[10px] sm:text-[11px]"
                    style={{ gridTemplateColumns: `repeat(${CELLS_PER_DAY}, minmax(0,1fr))` }}
                  >
                    {Array.from({ length: CELLS_PER_DAY }).map((_, i) => {
                      const shouldLabel = labelIndices.includes(i);
                      const h = Math.floor(i / 4);
                      return (
                        <div key={`lab-${i}`} className="flex items-end justify-start">
                          {shouldLabel && <div className="translate-x-[-8px]">{pad2(h)}:00</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 96セルのグリッド本体 */}
              <div className="mt-1 flex items-center gap-2">
                <div className="w-40 shrink-0 text-xs text-neutral-500">睡眠塗りつぶし</div>
                <div
                  className="grid grow"
                  style={{ gridTemplateColumns: `repeat(${CELLS_PER_DAY}, minmax(0,1fr))` }}
                >
                  {rowArr.map((v, idx) => (
                    <div
                      key={`${key}-${idx}`}
                      className={`h-6 border border-neutral-200 dark:border-neutral-700 ${
                        v === 1 ? "bg-indigo-500/80" : "bg-white dark:bg-neutral-900"
                      }`}
                      style={{ touchAction: "none", userSelect: "none" }}
                      onPointerDown={handlePointerDownAt(key, idx)}
                      onPointerMove={handlePointerMoveAt(key, idx)}
                      onPointerEnter={handlePointerEnterAt(key, idx)}
                      onPointerUp={handlePointerUpAt}
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
