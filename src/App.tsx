import { useState, useEffect, useMemo } from "react";

/* -------------------- 定数・型 -------------------- */
const RANKS = [
  "iron4", "iron3", "iron2", "iron1",
  "bronze4", "bronze3", "bronze2", "bronze1",
  "silver4", "silver3", "silver2", "silver1",
  "gold4", "gold3", "gold2", "gold1",
  "platinum4", "platinum3", "platinum2", "platinum1",
  "emerald4", "emerald3", "emerald2", "emerald1",
  "diamond4", "diamond3", "diamond2", "diamond1",
  "master", "grandmaster", "challenger"
];

const RANK_TO_MMR: Record<string, number> = {
  iron4: 600, iron3: 650, iron2: 700, iron1: 750,
  bronze4: 800, bronze3: 850, bronze2: 900, bronze1: 950,
  silver4: 1000, silver3: 1050, silver2: 1100, silver1: 1150,
  gold4: 1200, gold3: 1250, gold2: 1300, gold1: 1350,
  platinum4: 1400, platinum3: 1450, platinum2: 1500, platinum1: 1550,
  emerald4: 1600, emerald3: 1650, emerald2: 1700, emerald1: 1750,
  diamond4: 1800, diamond3: 1900, diamond2: 2000, diamond1: 2100,
  master: 2300, grandmaster: 2500, challenger: 2700,
};

// ストリーク補正：2連から±25、以後±25ずつ、最大±100
const STREAK_UNIT = 25;
const STREAK_CAP = 100;

// 「同じ人同士で同チームになり続けない」ための設定
const TEAMMATE_LOOKBACK = 3;   // 直近何試合分の履歴を見るか（最新から）
const TEAMMATE_PENALTY = 20;  // 同一ペアが再同席したときのペナルティ（×回数）

/* -------------------- 型 -------------------- */
type Player = {
  id: string;
  name: string;
  rank: string;
  selected: boolean;
  wins: number;
  losses: number;
  streak: number; // >0 連勝, <0 連敗, 0 なし
};

// ★ ID ベースで運用（重複名でも安全）
type BalPlayer = { id: string; name: string; mmr: number };

type Assignment = {
  teamA: BalPlayer[];
  teamB: BalPlayer[];
  score: number; // MMR差 + 再同席ペナルティ
  mmrA: number;
  mmrB: number;
  mmrScore: number;   // |MMR差|
  pairScore: number;  // 同席ペナルティ合計
};

type MatchRecord = {
  id: string;
  index: number;     // 第n戦
  timeISO: string;   // 記録時刻
  winner: "A" | "B";
  loser: "A" | "B";
  mmrA: number;
  mmrB: number;
  score: number;
  teamA: string[];   // names（表示用に残す）
  teamB: string[];   // names（表示用に残す）
  teamAIds?: string[]; // ★追加（新データ）
  teamBIds?: string[]; // ★追加（新データ）
};

/* -------------------- ユーティリティ -------------------- */
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// 2連から補正開始：2=±25, 3=±50, 4=±75, 5+=±100
function streakAdj(streak: number): number {
  const abs = Math.abs(streak);
  if (abs < 2) return 0;
  const sign = Math.sign(streak);
  const raw = (abs - 1) * STREAK_UNIT;
  return clamp(sign * raw, -STREAK_CAP, STREAK_CAP);
}

/* ===== 同チーム再発のペナルティ計算（ペア回数） ===== */
function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

type PairCounts = Record<string, number>;

function buildPairCounts(hist: MatchRecord[], lookback: number): PairCounts {
  const pc: PairCounts = {};
  const slice = hist.slice(0, lookback); // 最新から lookback 件
  for (const h of slice) {
    // ★ 新データ（ID配列）があればそれを使う。なければスキップ（後方互換）
    const A = h.teamAIds ?? [];
    const B = h.teamBIds ?? [];

    for (let i = 0; i < A.length; i++) {
      for (let j = i + 1; j < A.length; j++) {
        const k = pairKey(A[i], A[j]);
        pc[k] = (pc[k] ?? 0) + 1;
      }
    }
    for (let i = 0; i < B.length; i++) {
      for (let j = i + 1; j < B.length; j++) {
        const k = pairKey(B[i], B[j]);
        pc[k] = (pc[k] ?? 0) + 1;
      }
    }
  }
  return pc;
}

function teammatePenalty(team: BalPlayer[], pairCounts: PairCounts): number {
  let pen = 0;
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      const k = pairKey(team[i].id, team[j].id);
      const times = pairCounts[k] ?? 0;
      if (times > 0) pen += times * TEAMMATE_PENALTY;
    }
  }
  return pen;
}

/* ===== スコア計算（MMR差 + 再同席ペナルティ） ===== */
function scoreAssignment(teamA: BalPlayer[], teamB: BalPlayer[], pairCounts: PairCounts): Assignment {
  const mmrA = teamA.reduce((s, p) => s + p.mmr, 0);
  const mmrB = teamB.reduce((s, p) => s + p.mmr, 0);
  const mmrScore = Math.abs(mmrA - mmrB);
  const pairScore = teammatePenalty(teamA, pairCounts) + teammatePenalty(teamB, pairCounts);
  const score = mmrScore + pairScore;
  return { teamA, teamB, score, mmrA, mmrB, mmrScore, pairScore };
}

/* ===== ランダム探索（一般） ===== */
function bestOf(players: BalPlayer[], iters = 3000, pairCounts: PairCounts): Assignment | null {
  if (players.length < 6) return null;
  let best: Assignment | null = null;
  for (let i = 0; i < iters; i++) {
    const s = shuffle(players);
    const mid = Math.floor(s.length / 2);
    const cand = scoreAssignment(s.slice(0, mid), s.slice(mid), pairCounts);
    if (!best || cand.score < best.score) best = cand;
  }
  return best;
}

/* ===== 厳密最適化（10人専用・全探索/対称性除去） ===== */
function bestOfExact10(players: BalPlayer[], pairCounts: PairCounts): Assignment | null {
  if (players.length !== 10) return null;
  const idx = [...players.keys()];
  const fixed = 0; // idx0 を A に固定し対称性を除去
  let best: Assignment | null = null;

  for (let a1 = 1; a1 < 10; a1++) {
    for (let a2 = a1 + 1; a2 < 10; a2++) {
      for (let a3 = a2 + 1; a3 < 10; a3++) {
        for (let a4 = a3 + 1; a4 < 10; a4++) {
          const aIdx = new Set([fixed, a1, a2, a3, a4]);
          const teamA = idx.filter(i => aIdx.has(i)).map(i => players[i]);
          const teamB = idx.filter(i => !aIdx.has(i)).map(i => players[i]);
          const cand = scoreAssignment(teamA, teamB, pairCounts);
          if (!best || cand.score < best.score) best = cand;
        }
      }
    }
  }
  return best;
}

/* -------------------- メインUI -------------------- */
export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [name, setName] = useState("");
  const [rank, setRank] = useState("silver4");
  const [result, setResult] = useState<Assignment | null>(null);

  // 対戦履歴（最新が先頭）
  const [history, setHistory] = useState<MatchRecord[]>([]);

  // 前回の編成（「チームが変わった人」を出すため）
  const [prevResult, setPrevResult] = useState<Assignment | null>(null);
  const [changed, setChanged] = useState<Record<string, boolean>>({});

  /* 保存・読み込み */
  useEffect(() => {
    const saved = localStorage.getItem("players");
    if (saved) setPlayers(JSON.parse(saved));
    const savedHist = localStorage.getItem("match_history");
    if (savedHist) setHistory(JSON.parse(savedHist));
  }, []);
  useEffect(() => {
    localStorage.setItem("players", JSON.stringify(players));
  }, [players]);
  useEffect(() => {
    localStorage.setItem("match_history", JSON.stringify(history));
  }, [history]);

  /* 追加・削除・選択・ランク変更 */
  const addPlayer = () => {
    const trim = name.trim();
    if (!trim) return;
    if (players.length >= 20) return alert("最大20人までです。");
    if (players.some(p => p.name === trim)) {
      if (!confirm("同じ名前のプレイヤーが既にいます。続行しますか？")) return;
    }
    const newP: Player = {
      id: crypto.randomUUID(),
      name: trim,
      rank,
      selected: true,
      wins: 0,
      losses: 0,
      streak: 0,
    };
    setPlayers([...players, newP]);
    setName("");
  };

  const removePlayer = (id: string) => setPlayers(players.filter(p => p.id !== id));

  const toggleSelect = (id: string) => {
    const selectedCount = players.filter(p => p.selected).length;
    setPlayers(prev => prev.map(p =>
      p.id === id ? { ...p, selected: p.selected ? false : selectedCount < 10 } : p
    ));
  };

  const updateRank = (id: string, newRank: string) => {
    setPlayers(prev => prev.map(p => (p.id === id ? { ...p, rank: newRank } : p)));
  };

  // 個別ストリークリセット
  const resetStreakOne = (id: string) => {
    setPlayers(prev => prev.map(p => (p.id === id ? { ...p, streak: 0 } : p)));
  };
  // 全員ストリークリセット
  const resetStreakAll = () => {
    if (!confirm("全員のストリークをリセットしますか？")) return;
    setPlayers(prev => prev.map(p => ({ ...p, streak: 0 })));
  };


  // 直近履歴から同席ペアカウントを構築（ID ベース、新旧混在は旧を無視）
  const pairCounts = useMemo(() => buildPairCounts(history, TEAMMATE_LOOKBACK), [history]);

  /* オートバランス（ストリーク補正 + 同席回避ペナルティ + 変更者ハイライト） */
  const runAutoBalance = () => {
    const selected = players.filter(p => p.selected);
    if (selected.length !== 10) return alert(`ちょうど10人選んでください（現在${selected.length}人）`);

    const balPlayers: BalPlayer[] = selected.map(p => {
      const base = RANK_TO_MMR[p.rank] ?? 1200;
      const eff = base + streakAdj(p.streak);
      return { id: p.id, name: p.name, mmr: eff };
    });

    const res = bestOfExact10(balPlayers, pairCounts) ?? bestOf(balPlayers, 3000, pairCounts);
    if (!res) return;
    setResult(res);

    // 前回編成と比較して、チームが変わった人をマーキング（名前ベースでOK）
    const changedMap: Record<string, boolean> = {};
    if (prevResult) {
      const prevA = new Set(prevResult.teamA.map(p => p.name));
      const prevB = new Set(prevResult.teamB.map(p => p.name));
      for (const p of [...res.teamA, ...res.teamB]) {
        const nowA = res.teamA.some(x => x.name === p.name);
        const nowB = res.teamB.some(x => x.name === p.name);
        const wasA = prevA.has(p.name);
        const wasB = prevB.has(p.name);
        changedMap[p.name] = (wasA && nowB) || (wasB && nowA);
      }
    }
    setChanged(changedMap);
    setPrevResult(res);
  };

  /* 勝敗を記録 → 履歴保存＆個人戦績更新 */
  const recordResult = (winner: "A" | "B") => {
    if (!result) return alert("まずオートバランスでチームを作ってください。");

    const teamA = result.teamA.map(p => p.name);
    const teamB = result.teamB.map(p => p.name);
    const teamAIds = result.teamA.map(p => p.id);
    const teamBIds = result.teamB.map(p => p.id);
    const loser: "A" | "B" = winner === "A" ? "B" : "A";

    const rec: MatchRecord = {
      id: crypto.randomUUID(),
      index: history.length + 1,
      timeISO: new Date().toISOString(),
      winner, loser,
      mmrA: result.mmrA,
      mmrB: result.mmrB,
      score: result.score,
      teamA, teamB,
      teamAIds, teamBIds, // ★ 新データ
    };
    setHistory(prev => [rec, ...prev]);

    // 個人成績・ストリーク更新（IDで判定）
    setPlayers(prev =>
      prev.map(p => {
        const inA = teamAIds.includes(p.id);
        const inB = teamBIds.includes(p.id);
        if (!inA && !inB) return p;
        const isWin = (winner === "A" && inA) || (winner === "B" && inB);
        if (isWin) {
          return {
            ...p,
            wins: p.wins + 1,
            streak: p.streak >= 0 ? p.streak + 1 : 1,
          };
        } else {
          return {
            ...p,
            losses: p.losses + 1,
            streak: p.streak <= 0 ? p.streak - 1 : -1,
          };
        }
      })
    );

    // 今回の編成を「直近の基準」として固定（次回の変更ハイライト用）
    setPrevResult(result);
  };

  const clearHistory = () => {
    if (confirm("対戦履歴をすべて削除しますか？")) {
      setHistory([]);
    }
  };

  /* 画面用：ストリーク要約（最大連勝＆最大連敗の人） */
  const maxWin = players.reduce<{ n: number; names: string[] }>((acc, p) => {
    if (p.streak > 0) {
      if (p.streak > acc.n) return { n: p.streak, names: [p.name] };
      if (p.streak === acc.n) return { n: acc.n, names: [...acc.names, p.name] };
    }
    return acc;
  }, { n: 0, names: [] });
  const maxLose = players.reduce<{ n: number; names: string[] }>((acc, p) => {
    if (p.streak < 0) {
      const k = Math.abs(p.streak);
      if (k > acc.n) return { n: k, names: [p.name] };
      if (k === acc.n) return { n: acc.n, names: [...acc.names, p.name] };
    }
    return acc;
  }, { n: 0, names: [] });

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-5xl mx-auto bg-white rounded-2xl shadow p-6 space-y-6">
        <h1 className="text-2xl font-bold text-center">LoL オートバランス（履歴・ストリーク・同席回避）</h1>

        {/* 登録フォーム */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="プレイヤー名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border p-2 rounded-lg flex-1 min-w-[150px]"
          />
          <select value={rank} onChange={(e) => setRank(e.target.value)} className="border p-2 rounded-lg">
            {RANKS.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
          </select>
          <button onClick={addPlayer} className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg">追加</button>
        </div>

        {/* 登録済み一覧 */}
        <div>
          <h2 className="font-semibold mb-2">登録済みプレイヤー（{players.length}/20）</h2>
          {players.length === 0 ? (
            <p className="text-sm opacity-70">まだ登録されていません。</p>
          ) : (
            <ul className="divide-y">
              {players.map(p => (
                <li key={p.id} className="flex items-center justify-between py-2 px-1 hover:bg-gray-100 rounded-lg">
                  <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
                    <input
                      type="checkbox"
                      checked={p.selected}
                      onChange={() => toggleSelect(p.id)}
                      disabled={!p.selected && players.filter(pp => pp.selected).length >= 10}
                    />
                    <b className="mr-3">{p.name}</b>
                    <select
                      value={p.rank}
                      onChange={(e) => updateRank(p.id, e.target.value)}
                      className="border p-1 rounded-md text-sm"
                    >
                      {RANKS.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
                    </select>
                  </div>

                  {/* 戦績とストリーク表示 */}
                  <div className="text-xs opacity-80 text-right min-w-[200px]">
                    <div>W-L: {p.wins}-{p.losses}</div>
                    <div>
                      {p.streak > 0 && <>連勝: {p.streak}（+{streakAdj(p.streak)} MMR）</>}
                      {p.streak < 0 && <>連敗: {Math.abs(p.streak)}（{streakAdj(p.streak)} MMR）</>}
                      {p.streak === 0 && <>ストリークなし（±0）</>}
                    </div>
                    <div className="mt-1 flex gap-2 justify-end">
                      <button
                        onClick={() => resetStreakOne(p.id)}
                        className="inline-flex items-center rounded-md border px-2 py-1 text-[11px] hover:bg-gray-50"
                        title="このプレイヤーのストリークを0に"
                      >
                        ストリークリセット
                      </button>
                    </div>
                  </div>

                  <button onClick={() => removePlayer(p.id)} className="text-sm text-red-500 hover:underline ml-3">削除</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 選択状況 & 実行 */}
        <div className="bg-gray-100 rounded-xl p-3 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">選択中のメンバー ({players.filter(p => p.selected).length}/10)</h3>
            <button
              onClick={runAutoBalance}
              className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg disabled:opacity-50"
              disabled={players.filter(p => p.selected).length !== 10}
            >
              選択した10人でオートバランス
            </button>
          </div>
          {players.filter(p => p.selected).length === 0
            ? <p className="text-sm opacity-70">まだ選択されていません。</p>
            : <ul className="text-sm list-disc pl-5">
              {players.filter(p => p.selected).map(p => {
                const base = RANK_TO_MMR[p.rank] ?? 1200;
                const adj = streakAdj(p.streak);
                const eff = base + adj;
                return (
                  <li key={p.id}>
                    {p.name}（{p.rank.toUpperCase()} / 有効MMR {eff}{adj !== 0 ? `（補正 ${adj > 0 ? "+" : ""}${adj}）` : ""}）
                  </li>
                );
              })}
            </ul>}
        </div>

        {/* 結果表示 & 試合結果記録 */}
        {result && (
          <>
            <div className="mt-4 grid md:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl shadow p-4">
                <h3 className="font-semibold mb-2">チームA（MMR {result.mmrA}）</h3>
                {prevResult && (
                  <div className="text-[11px] opacity-60 mb-1">
                    前回A: {prevResult.teamA.map(p => p.name).join(", ")}
                  </div>
                )}

                <ul className="text-sm space-y-1">
                  {[...result.teamA].sort((a, b) => b.mmr - a.mmr).map(p => (
                    <li key={p.id}>
                      <span className={changed[p.name] ? "bg-yellow-100 px-1 rounded" : ""}>
                        {changed[p.name] && "⇄ "}
                        {p.name}
                      </span>
                      （MMR {p.mmr}）
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-white rounded-2xl shadow p-4">
                <h3 className="font-semibold mb-2">チームB（MMR {result.mmrB}）</h3>
                {prevResult && (
                  <div className="text-[11px] opacity-60 mb-1">
                    前回B: {prevResult.teamB.map(p => p.name).join(", ")}
                  </div>
                )}

                <ul className="text-sm space-y-1">
                  {[...result.teamB].sort((a, b) => b.mmr - a.mmr).map(p => (
                    <li key={p.id}>
                      <span className={changed[p.name] ? "bg-yellow-100 px-1 rounded" : ""}>
                        {changed[p.name] && "⇄ "}
                        {p.name}
                      </span>
                      （MMR {p.mmr}）
                    </li>
                  ))}
                </ul>
              </div>
              <div className="md:col-span-2 bg-white rounded-2xl shadow p-4">
                <div className="text-sm">総合スコア（小さいほど良）: <b>{result.score}</b></div>
                <div className="text-xs opacity-80 mt-1">内訳：MMR差 <b>{result.mmrScore}</b> ＋ 同席ペナルティ <b>{result.pairScore}</b></div>
                <div className="text-xs opacity-70">
                  ※ MMR差 + 同席ペナルティ（直近{TEAMMATE_LOOKBACK}試合）。黄色の ⇄ は「前回からチームが変わった人」。
                </div>
              </div>
            </div>

            {/* 試合結果の記録ボタン */}
            <div className="mt-4 flex items-center gap-3">
              <span className="text-sm opacity-80">試合結果を記録：</span>
              <button
                onClick={() => recordResult("A")}
                className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-2 rounded-md"
              >
                チームA WIN
              </button>
              <button
                onClick={() => recordResult("B")}
                className="bg-rose-500 hover:bg-rose-600 text-white px-3 py-2 rounded-md"
              >
                チームB WIN
              </button>
            </div>
          </>
        )}

        {/* ストリーク要約 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">ストリーク状況</h3>
            <button
              onClick={resetStreakAll}
              className="text-xs rounded-md border px-2 py-1 hover:bg-gray-50"
              title="全員のストリークを0に戻す"
            >
              全員ストリークリセット
            </button>
          </div>
          <div className="text-sm">
            {maxWin.n > 0
              ? <>現在 <b>{maxWin.names.join(", ")}</b> が <b>{maxWin.n}連勝中</b> 🔥</>
              : <>現在、連勝中のプレイヤーはいません。</>}
          </div>
          <div className="text-sm mt-1">
            {maxLose.n > 0
              ? <>現在 <b>{maxLose.names.join(", ")}</b> が <b>{maxLose.n}連敗中</b> 💧</>
              : <>現在、連敗中のプレイヤーはいません。</>}
          </div>
        </div>

        {/* 対戦履歴 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">対戦履歴（{history.length}件）</h3>
            {history.length > 0 && (
              <button onClick={clearHistory} className="text-sm text-red-500 hover:underline">
                すべて削除
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="text-sm opacity-70 mt-1">まだ記録がありません。</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {history.map(h => (
                <li key={h.id} className="rounded-lg border p-3">
                  <div className="text-sm font-semibold">
                    第{h.index}戦：{h.winner === "A" ? "チームA WIN / チームB LOSE" : "チームB WIN / チームA LOSE"}
                  </div>
                  <div className="text-xs opacity-70">
                    {new Date(h.timeISO).toLocaleString()} ｜ MMR A:{h.mmrA} / B:{h.mmrB} ｜ スコア:{h.score}
                  </div>
                  <details className="mt-1">
                    <summary className="text-xs cursor-pointer opacity-80">メンバーを見る</summary>
                    <div className="grid md:grid-cols-2 gap-2 mt-2 text-xs">
                      <div>
                        <div className="font-semibold">チームA</div>
                        <ul className="list-disc pl-4">{h.teamA.map(n => <li key={n}>{n}</li>)}</ul>
                      </div>
                      <div>
                        <div className="font-semibold">チームB</div>
                        <ul className="list-disc pl-4">{h.teamB.map(n => <li key={n}>{n}</li>)}</ul>
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}