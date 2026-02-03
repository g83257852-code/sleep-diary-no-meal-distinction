"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";

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

// ローカル日付として安全にパース
const parseLocalISO = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
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

// ===== localStorage helpers =====
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

// ===== メタ情報（休日/目覚ましのみ）=====
export type Meta = {
  holiday: boolean;
  alarm: boolean;
};
const defaultMeta: Meta = {
  holiday: false,
  alarm: false,
};

// ===== 時刻ユーティリティ =====
const idxToTime = (idx: number) => {
  const i = ((idx % CELLS_PER_DAY) + CELLS_PER_DAY) % CELLS_PER_DAY;
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${pad2(h)}:${pad2(m)}`;
};

const timeToIdx = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!isFinite(hh) || !isFinite(mm)) return null;
  const idx = Math.round((hh * 60 + mm) / MIN_PER_CELL);
  if (idx < 0 || idx >= CELLS_PER_DAY) return null;
  return idx;
};

// 連続1区間列挙
const listRuns = (arr: number[]) => {
  const runs: { s: number; e: number }[] = [];
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

// 起床“日”に紐づけた主睡眠の推定
const estimateSleepForWakeDay = (
  prevArr: number[] | null,
  dayArr: number[]
): { startIdx: number; endIdx: number; durHours: number; midHour: number } | null => {
  const twoDay = prevArr ? [...prevArr, ...dayArr] : [...Array(CELLS_PER_DAY).fill(0), ...dayArr];
  const runs = listRuns(twoDay);
  const CAND_END_MIN = CELLS_PER_DAY; // 96
  const CAND_END_MAX = CELLS_PER_DAY * 2; // 192

  let best: { s: number; e: number } | null = null;
  for (const r of runs) {
    if (r.e >= CAND_END_MIN && r.e <= CAND_END_MAX) {
      if (!best || r.e - r.s > best.e - best.s) best = r;
    }
  }
  if (!best) return null;
  const durHours = ((best.e - best.s) * MIN_PER_CELL) / 60;
  const midIdx = (best.s + best.e) / 2;
  const midHour =
    (((midIdx % CELLS_PER_DAY) + CELLS_PER_DAY) % CELLS_PER_DAY) * (MIN_PER_CELL / 60);
  return { startIdx: best.s, endIdx: best.e, durHours, midHour };
};

// ==== CSV インポート用ユーティリティ ====
const TIME_HEADERS = Array.from({ length: CELLS_PER_DAY }, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${pad2(h)}:${pad2(m)}`;
});

// ===== 食事（セル塗り） =====
// 0=なし, 1=食事, 2=軽食・おやつ
type FoodType = 0 | 1 | 2;

const FOOD_LABEL: Record<FoodType, string> = {
  0: "なし",
  1: "食事",
  2: "軽食・おやつ",
};

const FOOD_DOT_CLASS: Record<Exclude<FoodType, 0>, string> = {
  1: "bg-green-500",
  2: "bg-orange-500",
};

const makeEmptyFoodDay = (): FoodType[] =>
  Array.from({ length: CELLS_PER_DAY }, () => 0 as FoodType);

// food用のlocalStorageキー（sleepとは別）
const foodKey = (pid: string) => `${getStoreKey(pid)}:food_v1`;
const loadFoods = (pid = "anon"): Record<string, FoodType[]> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(foodKey(pid));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};
const saveFoods = (obj: Record<string, FoodType[]>, pid = "anon") => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(foodKey(pid), JSON.stringify(obj));
  } catch {}
};

const pack6 = (times: string[]) => {
  const trimmed = times.slice(0, 6);
  const slots = Array.from({ length: 6 }, (_, i) => trimmed[i] ?? "");
  return { list: trimmed, slots, count: trimmed.length };
};

// foodセル -> meals/snacks 各6列（左詰め）
const foodTimesFromCells = (cells: FoodType[]) => {
  const meals = cells
    .map((v, i) => (v === 1 ? idxToTime(i) : null))
    .filter(Boolean) as string[];
  const snacks = cells
    .map((v, i) => (v === 2 ? idxToTime(i) : null))
    .filter(Boolean) as string[];

  return {
    meals: pack6(meals),
    snacks: pack6(snacks),
  };
};

const parseTimesFromSemicolon = (s: string) =>
  (s || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);

function parseCsv(text: string) {
  const lines = text
    .replace(/\uFEFF/g, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSVにデータ行がありません。");
  const header = lines[0].split(",");

  const colIndex = (name: string) => header.findIndex((h) => h.trim() === name);
  const dateIdx = colIndex("date");
  if (dateIdx < 0) throw new Error("ヘッダーに 'date' 列がありません。");

  const idxHoliday = colIndex("holiday");
  const idxAlarm = colIndex("alarm");

  // 新形式（6列×2）
  const idxMealsN = Array.from({ length: 6 }, (_, i) => colIndex(`meals${i + 1}`));
  const idxSnacksN = Array.from({ length: 6 }, (_, i) => colIndex(`snacks${i + 1}`));

  // 旧形式（1列 ; 区切り）
  const idxMealsOld = colIndex("meals");
  const idxSnacksOld = colIndex("snacks"); // 旧でも同名があり得る

  // さらに旧形式（breakfast/lunch/dinner/snacks）
  const idxBreakfast = colIndex("breakfast");
  const idxLunch = colIndex("lunch");
  const idxDinner = colIndex("dinner");
  const idxSnacksLegacy = colIndex("snacks"); // snacks列は競合しうるが、上で idxSnacksOld と同じ

  const timeIdxMap: number[] = TIME_HEADERS.map((lab) => header.findIndex((h) => h.trim() === lab));
  const hasAllTimeCols = timeIdxMap.every((i) => i >= 0);
  if (!hasAllTimeCols)
    throw new Error("00:00〜23:45 の時刻列が見つかりません（エクスポート形式のみ対応）。");

  const store: Record<string, number[]> = {};
  const meta: Record<string, Meta> = {};
  const foodStore: Record<string, FoodType[]> = {};
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (let li = 1; li < lines.length; li++) {
    const row = lines[li].split(",");
    if (row.length < header.length) continue;
    const key = row[dateIdx]?.trim();
    if (!key || !/\d{4}-\d{2}-\d{2}/.test(key)) continue;

    // sleepセル
    const arr = new Array(CELLS_PER_DAY).fill(0).map((_, i) => {
      const idx = timeIdxMap[i];
      const v = idx >= 0 ? Number(row[idx]) : 0;
      return v === 1 ? 1 : 0;
    });
    store[key] = arr;

    // meta
    meta[key] = {
      holiday: idxHoliday >= 0 ? row[idxHoliday] === "1" : false,
      alarm: idxAlarm >= 0 ? row[idxAlarm] === "1" : false,
    };

    // food復元
    const cells = makeEmptyFoodDay();

    // 1) 新形式（6列×2）が揃ってたら最優先
    const hasMealsN = idxMealsN.every((i) => i >= 0);
    const hasSnacksN = idxSnacksN.every((i) => i >= 0);

    const timesMeals: string[] = [];
    const timesSnacks: string[] = [];

    if (hasMealsN) {
      for (let i = 0; i < 6; i++) {
        const t = (row[idxMealsN[i]] || "").trim();
        if (t) timesMeals.push(t);
      }
    }
    if (hasSnacksN) {
      for (let i = 0; i < 6; i++) {
        const t = (row[idxSnacksN[i]] || "").trim();
        if (t) timesSnacks.push(t);
      }
    }

    if (timesMeals.length || timesSnacks.length) {
      // 新形式で復元
      for (const t of timesMeals.slice(0, 6)) {
        const mi = timeToIdx(t);
        if (mi != null) cells[mi] = 1;
      }
      for (const t of timesSnacks.slice(0, 6)) {
        const si = timeToIdx(t);
        if (si != null) cells[si] = 2;
      }
    } else {
      // 2) 旧形式（meals/snacks 1列;区切り）を試す
      const mealsOld = idxMealsOld >= 0 ? (row[idxMealsOld] || "").trim() : "";
      const snacksOld = idxSnacksOld >= 0 ? (row[idxSnacksOld] || "").trim() : "";

      const oldMealsTimes = mealsOld ? parseTimesFromSemicolon(mealsOld) : [];
      const oldSnacksTimes = snacksOld ? parseTimesFromSemicolon(snacksOld) : [];

      if (oldMealsTimes.length || oldSnacksTimes.length) {
        for (const t of oldMealsTimes.slice(0, 6)) {
          const mi = timeToIdx(t);
          if (mi != null) cells[mi] = 1;
        }
        for (const t of oldSnacksTimes.slice(0, 6)) {
          const si = timeToIdx(t);
          if (si != null) cells[si] = 2;
        }
      } else {
        // 3) さらに旧形式（breakfast/lunch/dinner/snacks）から復元
        const bStr = idxBreakfast >= 0 ? (row[idxBreakfast] || "").trim() : "";
        const lStr = idxLunch >= 0 ? (row[idxLunch] || "").trim() : "";
        const dStr = idxDinner >= 0 ? (row[idxDinner] || "").trim() : "";
        const sStr = idxSnacksLegacy >= 0 ? (row[idxSnacksLegacy] || "").trim() : "";

        const mealTimesLegacy: string[] = [];
        if (bStr) mealTimesLegacy.push(bStr);
        if (lStr) mealTimesLegacy.push(lStr);
        if (dStr) mealTimesLegacy.push(dStr);

        const snackTimesLegacy = sStr ? parseTimesFromSemicolon(sStr) : [];

        for (const t of mealTimesLegacy.slice(0, 6)) {
          const mi = timeToIdx(t);
          if (mi != null) cells[mi] = 1;
        }
        for (const t of snackTimesLegacy.slice(0, 6)) {
          const si = timeToIdx(t);
          if (si != null) cells[si] = 2;
        }
      }
    }

    // 念のため：各タイプ6回に収める（万一CSVが多かった場合）
    {
      const mealIdxs = cells.map((v, i) => (v === 1 ? i : -1)).filter((x) => x >= 0);
      if (mealIdxs.length > 6) {
        const drop = mealIdxs.slice(0, mealIdxs.length - 6);
        for (const di of drop) cells[di] = 0;
      }
      const snackIdxs = cells.map((v, i) => (v === 2 ? i : -1)).filter((x) => x >= 0);
      if (snackIdxs.length > 6) {
        const drop = snackIdxs.slice(0, snackIdxs.length - 6);
        for (const di of drop) cells[di] = 0;
      }
    }

    foodStore[key] = cells;

    if (!minDate || key < minDate) minDate = key;
    if (!maxDate || key > maxDate) maxDate = key;
  }

  if (!minDate) throw new Error("有効な日付行が読み込めませんでした。");
  return { store, meta, foodStore, minDate, maxDate };
}

export default function SleepDiaryPainter() {
  // ===== Hydration-safe =====
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ===== 状態 =====
  const [pid, setPid] = useState<string>("");
  const [store, setStore] = useState<Record<string, number[]>>({});

  const metaKey = (id: string) => `${getStoreKey(id)}:meta_v2`;
  const [meta, setMeta] = useState<Record<string, Meta>>({});

  // food
  const [foodStore, setFoodStore] = useState<Record<string, FoodType[]>>({});
  const [foodMode, setFoodMode] = useState<FoodType>(0); // なし/食事/軽食

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

  // ===== Sleep 描画 =====
  const [isPainting, setIsPainting] = useState(false);
  const [paintValue, setPaintValue] = useState<0 | 1>(1);
  const [eraser, setEraser] = useState(false);
  const paintingKeyRef = useRef<string | null>(null);
  const lastIdxRef = useRef<number | null>(null);

  // 時刻ラベル
  const [labelStepHours, setLabelStepHours] = useState<1 | 2>(2);
  const labelIndices = useMemo(() => {
    const stepCells = (60 / MIN_PER_CELL) * labelStepHours; // 1h=4, 2h=8
    const arr: number[] = [];
    for (let i = 0; i <= CELLS_PER_DAY; i += stepCells) arr.push(i);
    return arr;
  }, [labelStepHours]);

  // 初回ロード
  useEffect(() => {
    const saved = safeGetItem(PID_KEY) || "";
    setPid(saved);
  }, []);

  useEffect(() => {
    const id = pid || "anon";

    // sleep
    setStore(loadAll(id));

    // meta
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(metaKey(id)) : null;
      setMeta(raw ? JSON.parse(raw) : {});
    } catch {
      setMeta({});
    }

    // food
    setFoodStore(loadFoods(id));

    if (pid) safeSetItem(PID_KEY, pid);
  }, [pid]);

  // ===== ユーティリティ =====
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

  // food util
  const getFoodDay = (key: string) => foodStore[key] ?? makeEmptyFoodDay();

  const setFoodDay = (key: string, updater: (prev: FoodType[]) => FoodType[]) => {
    const next = updater(getFoodDay(key)).map((v) => Number(v) as FoodType);
    setFoodStore((prev) => {
      const n = { ...prev, [key]: next };
      saveFoods(n, pid || "anon");
      return n;
    });
  };

  // ===== Sleep 補間塗り =====
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

  const handlePointerDownAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (e.pointerType === "mouse" && (e as any).button !== 0) return;
      setIsPainting(true);
      const val: 0 | 1 = eraser ? 0 : 1;
      setPaintValue(val);
      paintingKeyRef.current = key;
      lastIdxRef.current = idx;
      paintSpan(key, idx, idx, val);
    };

  const handlePointerMoveAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isPainting || paintingKeyRef.current !== key) return;
      paintSpan(key, lastIdxRef.current, idx, paintValue);
    };

  const handlePointerEnterAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isPainting || paintingKeyRef.current !== key) return;
      paintSpan(key, lastIdxRef.current, idx, paintValue);
    };

  const handlePointerUpAt = () => {
    setIsPainting(false);
    paintingKeyRef.current = null;
    lastIdxRef.current = null;
  };

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

  // ===== foodペイント =====
  const foodPaintingKeyRef = useRef<string | null>(null);
  const foodLastIdxRef = useRef<number | null>(null);
  const [isFoodPainting, setIsFoodPainting] = useState(false);

  const enforceLimitPerType = (a: FoodType[]) => {
    // 食事(1) 最大6
    const mealIdxs = a.map((v, i) => (v === 1 ? i : -1)).filter((x) => x >= 0);
    if (mealIdxs.length > 6) {
      const drop = mealIdxs.slice(0, mealIdxs.length - 6); // 早い時刻から落とす
      for (const di of drop) a[di] = 0;
    }
    // 軽食(2) 最大6
    const snackIdxs = a.map((v, i) => (v === 2 ? i : -1)).filter((x) => x >= 0);
    if (snackIdxs.length > 6) {
      const drop = snackIdxs.slice(0, snackIdxs.length - 6);
      for (const di of drop) a[di] = 0;
    }
  };

  const paintFoodSpan = (key: string, fromIdx: number | null, toIdx: number, val: FoodType) => {
    setFoodDay(key, (prev) => {
      const a = prev.slice();
      const start = fromIdx === null ? toIdx : Math.min(fromIdx, toIdx);
      const end = fromIdx === null ? toIdx : Math.max(fromIdx, toIdx);

      for (let i = start; i <= end; i++) {
        a[i] = val; // 0=消す, 1=食事, 2=軽食
      }

      if (val === 1 || val === 2) enforceLimitPerType(a);

      return a;
    });

    foodLastIdxRef.current = toIdx;
  };

  const handleFoodPointerDownAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (e.pointerType === "mouse" && (e as any).button !== 0) return;
      setIsFoodPainting(true);
      foodPaintingKeyRef.current = key;
      foodLastIdxRef.current = idx;
      paintFoodSpan(key, idx, idx, foodMode);
    };

  const handleFoodPointerMoveAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isFoodPainting || foodPaintingKeyRef.current !== key) return;
      paintFoodSpan(key, foodLastIdxRef.current, idx, foodMode);
    };

  const handleFoodPointerEnterAt =
    (key: string, idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isFoodPainting || foodPaintingKeyRef.current !== key) return;
      paintFoodSpan(key, foodLastIdxRef.current, idx, foodMode);
    };

  const handleFoodPointerUpAt = () => {
    setIsFoodPainting(false);
    foodPaintingKeyRef.current = null;
    foodLastIdxRef.current = null;
  };

  useEffect(() => {
    const onUp = () => {
      setIsFoodPainting(false);
      foodPaintingKeyRef.current = null;
      foodLastIdxRef.current = null;
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // ===== SRI =====
  const isTouched = (arr: number[]) => arr.some((v) => v === 1);
  type SriSummary = { percent: number; matches: number; total: number; usedPairs: number };

  const computeSriForRange = (): SriSummary => {
    let matches = 0,
      total = 0,
      usedPairs = 0;

    for (let i = 0; i < rangeKeys.length - 1; i++) {
      const a = getDay(rangeKeys[i]);
      const b = getDay(rangeKeys[i + 1]);
      if (!isTouched(a) || !isTouched(b)) continue;
      usedPairs++;
      for (let t = 0; t < CELLS_PER_DAY; t++) {
        if (a[t] === b[t]) matches++;
        total++;
      }
    }

    return { percent: total > 0 ? (matches / total) * 200 - 100 : NaN, matches, total, usedPairs };
  };

  // 起床日ベース情報
  const estimateForWakeDay = (
    key: string
  ): { bed: string; wake: string; midHour: number | null; durHours: number | null } => {
    const idx = rangeKeys.indexOf(key);
    if (idx === -1) return { bed: "", wake: "", midHour: null, durHours: null };
    const prev = idx > 0 ? getDay(rangeKeys[idx - 1]) : null;
    const day = getDay(key);
    const sl = estimateSleepForWakeDay(prev, day);
    if (!sl) return { bed: "", wake: "", midHour: null, durHours: null };
    const bed = idxToTime(sl.startIdx % CELLS_PER_DAY);
    const wake = idxToTime(sl.endIdx % CELLS_PER_DAY);
    return { bed, wake, midHour: sl.midHour, durHours: sl.durHours };
  };

  // SJL
  type SjlResult = { sjlHours: number; msf: number; msw: number; nF: number; nW: number } | null;
  const computeSJL = (): SjlResult => {
    if (rangeKeys.length === 0) return null;
    const midsFree: number[] = [];
    const midsWork: number[] = [];
    for (let i = 0; i < rangeKeys.length; i++) {
      const key = rangeKeys[i];
      const m = getMeta(key);
      const { midHour } = estimateForWakeDay(key);
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

  // ===== CSV エクスポート（食事/軽食 各6列）=====
  const exportCsv30 = () => {
    if (!rangeStart) return;

    const header = [
      "date",
      "weekday",
      "holiday",
      "alarm",
      "meals1",
      "meals2",
      "meals3",
      "meals4",
      "meals5",
      "meals6",
      "snacks1",
      "snacks2",
      "snacks3",
      "snacks4",
      "snacks5",
      "snacks6",
      "bedtime",
      "wakeup",
      "sleep_dur_h",
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
      const info = estimateForWakeDay(key);
      const durStr = info.durHours != null ? info.durHours.toFixed(2) : "";

      const ft = foodTimesFromCells(getFoodDay(key)); // meals/snacks 各6

      const row = [
        key,
        weekday,
        m.holiday ? 1 : 0,
        m.alarm ? 1 : 0,
        ...ft.meals.slots,
        ...ft.snacks.slots,
        info.bed,
        info.wake,
        durStr,
        ...arr,
      ];
      lines.push(row.join(","));
    }

    const csv = lines.join("\n");
    download(`sleep_diary_${pid || "anon"}_${rangeStart}.csv`, csv);
  };

  // ===== CSV インポート =====
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleImportCsvClick = () => fileInputRef.current?.click();

  const handleImportCsvFile = async (file: File) => {
    try {
      const text = await file.text();
      const { store: s, meta: m, foodStore: fs, minDate } = parseCsv(text);
      const id = pid || "anon";

      setStore(s);
      saveAll(s, id);

      setMeta(m);
      try {
        localStorage.setItem(metaKey(id), JSON.stringify(m));
      } catch {}

      setFoodStore(fs);
      saveFoods(fs, id);

      if (minDate) setRangeStart(minDate);

      alert("CSVを読み込みました。画面に反映しています。");
    } catch (err: any) {
      console.error(err);
      alert(`CSV読み込みに失敗しました: ${err?.message || err}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ===== PDF（印刷） =====
  const handlePrintPDF = () => {
    if (typeof window === "undefined") return;
    window.print();
  };

  if (!mounted || !rangeStart) {
    return <div className="p-4 sm:p-6 md:p-8 max-w-[1320px] mx-auto" />;
  }

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-[1320px] mx-auto bg-white">
      {/* 印刷用CSS */}
      <style jsx global>{`
        @page {
          size: A4 landscape;
          margin: 10mm;
        }
        .no-print {
        }
        .print-only {
          display: none;
        }

        @media print {
          html,
          body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            background: #ffffff !important;
          }
          .no-print {
            display: none !important;
          }
          .print-only {
            display: inline !important;
          }

          .print-container {
            width: 100% !important;
          }
          .avoid-break {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          .print-border {
            border-color: #888 !important;
          }
          .print-cell {
            height: 20px !important;
          }
          .print-food-cell {
            height: 12px !important;
          }
          .print-label {
            font-size: 10px !important;
          }
          .print-small {
            font-size: 11px !important;
          }
        }
      `}</style>

      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">睡眠日誌（30日）</h1>

      {/* 使い方（印刷非表示） */}
      <section className="mt-3 mb-6 text-sm text-neutral-700 dark:text-neutral-300 space-y-1 no-print">
        <h2 className="font-semibold">使い方</h2>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            各行は1日分（00:00〜23:45の96セル）。
            <strong>寝ている時間を塗りつぶしてください。</strong>
            <strong>塗られていない部分は覚醒時間です。</strong>
          </li>
          <li>間違えたら「消す（覚醒）」で上書きしてください。</li>
          <li>日をまたぐ睡眠は、当日分と翌日分に分けて入力してください。</li>
          <li>
            食事は上部で「食事 / 軽食・おやつ / なし」を選び、各日の「食事」行を塗って時刻を記録します（各最大6回）。
          </li>
          <li>
            「CSV出力」では、日付、起床時刻、就寝時刻、睡眠時間、食事時刻（meals1〜6 / snacks1〜6）、
            15分ごとの睡眠データが出力されます。
          </li>
          <li>「CSV読み込み」で過去のCSVを復元し、続きから記入できます。</li>
          <li>「PDF出力」では、睡眠日誌がそのまま出力されます。</li>
        </ul>

        <div className="flex flex-wrap items-center gap-3 mt-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="inline-block w-4 h-4 bg-indigo-500" /> 睡眠（塗る）
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-4 h-4 bg-white border" /> 覚醒（消す）
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 bg-green-500 rounded-full" /> 食事
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 bg-orange-500 rounded-full" /> 軽食・おやつ
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

      {/* ヘッダ操作（印刷非表示） */}
      <div className="mt-4 flex flex-col gap-3 no-print">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
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

          <div className="flex flex-wrap items-center gap-2 ml-auto">
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
              消す
            </button>

            <button onClick={exportCsv30} className="px-3 py-2 rounded-lg border">
              CSV出力
            </button>
            <button onClick={handlePrintPDF} className="px-3 py-2 rounded-lg border bg-neutral-50">
              PDF出力
            </button>

            {/* CSV インポート */}
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImportCsvFile(f);
              }}
            />
            <button onClick={handleImportCsvClick} className="px-3 py-2 rounded-lg border">
              CSV読み込み
            </button>
          </div>
        </div>

        {/* foodの選択 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-neutral-700">食事の選択</span>

          {([0, 1, 2] as FoodType[]).map((t) => (
            <button
              key={t}
              onClick={() => setFoodMode(t)}
              className={`px-3 py-2 rounded-lg border text-sm ${
                foodMode === t ? "bg-neutral-900 text-white" : "bg-white"
              }`}
              aria-pressed={foodMode === t}
            >
              {FOOD_LABEL[t]}
              {t !== 0 && (
                <span className={`ml-2 inline-block w-2.5 h-2.5 rounded-full ${FOOD_DOT_CLASS[t as 1 | 2]}`} />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 本体 */}
      <div className="mt-4 space-y-3 select-none print-container">
        {rangeKeys.map((key) => {
          const rowArr = getDay(key);
          const m = getMeta(key);
          const info = estimateForWakeDay(key);
          const ft = foodTimesFromCells(getFoodDay(key));

          return (
            <div
              key={key}
              className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-2 avoid-break print-border"
            >
              {/* 行ヘッダ */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm print-small">
                  <div className="font-medium">
                    {key}（{WEEKDAYS_JP[parseLocalISO(key).getDay()]}）
                  </div>

                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={m.holiday}
                      onChange={(e) => setMetaFor(key, (prev) => ({ ...prev, holiday: e.target.checked }))}
                      className="no-print"
                    />
                    <span className="print-only">{m.holiday ? "休日：✓" : "休日："}</span>
                    <span className="no-print">休日</span>
                  </label>

                  <label className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={m.alarm}
                      onChange={(e) => setMetaFor(key, (prev) => ({ ...prev, alarm: e.target.checked }))}
                      className="no-print"
                    />
                    <span className="print-only">{m.alarm ? "目覚まし：✓" : "目覚まし："}</span>
                    <span className="no-print">目覚まし</span>
                  </label>

                  <span className="text-neutral-500 print-small">
                    就寝: <strong>{info.bed || "--:--"}</strong>
                  </span>
                  <span className="text-neutral-500 print-small">
                    起床: <strong>{info.wake || "--:--"}</strong>
                  </span>
                  <span className="text-neutral-500 print-small">
                    睡眠時間: <strong>{info.durHours != null ? `${info.durHours.toFixed(2)} h` : "--"}</strong>
                  </span>

                  <span className="text-neutral-500 print-small">
                    食事: <strong>{ft.meals.list.length ? ft.meals.list.join(" / ") : "--"}</strong>
                  </span>
                  <span className="text-neutral-500 print-small">
                    軽食: <strong>{ft.snacks.list.length ? ft.snacks.list.join(" / ") : "--"}</strong>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm no-print">
                  <button onClick={handleComputeSRI} className="px-3 py-2 rounded-lg border">
                    SRI計算
                  </button>
                  <button onClick={handleComputeSJL} className="px-3 py-2 rounded-lg border">
                    SJL計算
                  </button>
                  {sri != null && (
                    <span className="text-neutral-700">
                      SRI: <strong>{sri.toFixed(2)}</strong>（ペア数: {usedPairs}）
                    </span>
                  )}
                  {sjl && (
                    <span className="text-neutral-700">
                      SJL: <strong>{sjl.sjlHours.toFixed(2)} h</strong>（MSF {sjl.msf.toFixed(2)} / MSW{" "}
                      {sjl.msw.toFixed(2)}）
                    </span>
                  )}
                </div>
              </div>

              {/* 行ごとの時刻ラベル */}
              <div className="mt-2 flex items-center gap-2">
                <div className="w-40 shrink-0" />
                <div className="relative grow">
                  <div
                    className="grid text-[10px] text-neutral-500 select-none"
                    style={{ gridTemplateColumns: `repeat(${CELLS_PER_DAY}, minmax(0,1fr))` }}
                  >
                    {Array.from({ length: CELLS_PER_DAY }).map((_, i) => (
                      <div
                        key={`tick-${i}`}
                        className="h-3 border-b border-neutral-200 dark:border-neutral-800 print-border"
                      />
                    ))}
                  </div>

                  <div
                    className="absolute inset-0 grid text-[10px] sm:text-[11px] print-label"
                    style={{ gridTemplateColumns: `repeat(${CELLS_PER_DAY}, minmax(0,1fr))` }}
                  >
                    {Array.from({ length: CELLS_PER_DAY }).map((_, i) => {
                      const shouldLabel = labelIndices.includes(i);
                      const h = Math.floor(i / 4);
                      return (
                        <div key={`lab-${i}`} className="flex items-center justify-start">
                          {shouldLabel && <div className="translate-x-[-8px]">{pad2(h)}:00</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 睡眠セル */}
              <div className="mt-1 flex items-center gap-2">
                <div className="w-40 shrink-0 text-xs text-neutral-500 print-small">睡眠</div>
                <div className="grid grow" style={{ gridTemplateColumns: `repeat(${CELLS_PER_DAY}, minmax(0,1fr))` }}>
                  {rowArr.map((v, idx) => (
                    <div
                      key={`${key}-${idx}`}
                      className={`h-6 border border-neutral-200 dark:border-neutral-700 print-border print-cell ${
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

              {/* foodセル */}
              <div className="mt-1 flex items-center gap-2">
                <div className="w-40 shrink-0 text-xs text-neutral-500 print-small">食事</div>
                <div className="grid grow" style={{ gridTemplateColumns: `repeat(${CELLS_PER_DAY}, minmax(0,1fr))` }}>
                  {getFoodDay(key).map((fv, idx) => (
                    <div
                      key={`food-${key}-${idx}`}
                      className={`h-4 border border-neutral-200 dark:border-neutral-700 print-border print-food-cell ${
                        fv === 0
                          ? "bg-white dark:bg-neutral-900"
                          : fv === 1
                          ? "bg-green-500"
                          : "bg-orange-500"
                      }`}
                      style={{ touchAction: "none", userSelect: "none" }}
                      onPointerDown={handleFoodPointerDownAt(key, idx)}
                      onPointerMove={handleFoodPointerMoveAt(key, idx)}
                      onPointerEnter={handleFoodPointerEnterAt(key, idx)}
                      onPointerUp={handleFoodPointerUpAt}
                      title={fv === 0 ? "" : `${FOOD_LABEL[fv]} ${idxToTime(idx)}`}
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 権利表記（フッター） */}
      <footer className="mt-10 text-xs text-neutral-500 border-t pt-4 leading-relaxed print-small">
        © 2025 京都府立医科大学 統合生理学教室.
        <br />
        本アプリケーションに含まれるすべての内容（プログラム、デザイン、画像、文章、データ等）の著作権は
        京都府立医科大学 統合生理学教室に帰属します。
        <br />
        無断での転載、複製、改変、頒布、再配布、商用利用、その他著作権法で認められた範囲を超える利用を固く禁止します。
        <br />
        本アプリケーションは研究目的で作成・運用しており、内容の正確性・完全性・安全性を保証するものではありません。
        <br />
        本アプリの利用により生じたいかなる損害についても、当教室は一切の責任を負いかねます。
      </footer>
    </div>
  );
}
