import { useState, useEffect, useMemo } from "react";
import "./App.css";

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
  riotId?: string; // Riot APIで登録した場合のみ保存
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

/* 10人の全126通りを評価し、上位5候補だけを保持（A/B入れ替えは同一編成） */
function rankedAssignments10(players: BalPlayer[], pairCounts: PairCounts): Assignment[] {
  if (players.length !== 10) return [];
  const candidates: Assignment[] = [];
  for (let a1 = 1; a1 < 10; a1++) {
    for (let a2 = a1 + 1; a2 < 10; a2++) {
      for (let a3 = a2 + 1; a3 < 10; a3++) {
        for (let a4 = a3 + 1; a4 < 10; a4++) {
          const aIdx = new Set([0, a1, a2, a3, a4]);
          const teamA = players.filter((_, i) => aIdx.has(i));
          const teamB = players.filter((_, i) => !aIdx.has(i));
          candidates.push(scoreAssignment(teamA, teamB, pairCounts));
        }
      }
    }
  }
  // スコア最小を優先し、同点ならMMR差が小さいものを優先
  return candidates.sort((a, b) => a.score - b.score || a.mmrScore - b.mmrScore).slice(0, 5);
}

/* Riot APIのソロランクをTEAMMIXのランクキーへ変換 */
type RiotRankResponse = {
  gameName: string;
  tagLine: string;
  rank: { tier: string; division: string; lp: number } | null;
};

function riotRankToKey(data: RiotRankResponse): string | null {
  if (!data.rank) return null;
  const tier = data.rank.tier.toLowerCase();
  const division = ({ I: "1", II: "2", III: "3", IV: "4" } as Record<string, string>)[data.rank.division];
  const key = ["master", "grandmaster", "challenger"].includes(tier) ? tier : `${tier}${division ?? ""}`;
  return RANKS.includes(key) ? key : null;
}

async function fetchRiotRank(riotId: string): Promise<RiotRankResponse> {
  const hash = riotId.lastIndexOf("#");
  const gameName = riotId.slice(0, hash).trim();
  const tagLine = riotId.slice(hash + 1).trim();
  if (hash < 1 || !gameName || !tagLine) {
    throw new Error("Riot IDは ゲーム名#タグ の形式で入力してください。");
  }
  let response: Response;
  try {
    response = await fetch(`http://localhost:3001/api/rank?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}`);
  } catch {
    throw new Error("APIサーバーに接続できません。node server/index.cjs を起動してください。");
  }
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(`${details.error ?? "ランクの取得に失敗しました"}（HTTP ${response.status}）`);
  }
  return await response.json() as RiotRankResponse;
}

/* -------------------- メインUI -------------------- */
export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [name, setName] = useState("");
  const [rank, setRank] = useState("silver4");
  const [riotIdInput, setRiotIdInput] = useState("");
  const [riotBusy, setRiotBusy] = useState(false);
  const [riotUpdatingId, setRiotUpdatingId] = useState<string | null>(null);
  const [riotMessage, setRiotMessage] = useState("");
  const [result, setResult] = useState<Assignment | null>(null);
  const [candidates, setCandidates] = useState<Assignment[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);

  // 対戦履歴（最新が先頭）
  const [history, setHistory] = useState<MatchRecord[]>([]);

  // 前回の編成（「チームが変わった人」を出すため）
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
    invalidateTeams();
    setPlayers([...players, newP]);
    setName("");
  };

  const addFromRiot = async () => {
    if (riotBusy) return;
    if (players.length >= 20) return alert("最大20人までです。");
    setRiotBusy(true);
    setRiotMessage("");
    try {
      const data = await fetchRiotRank(riotIdInput);
      const rankKey = riotRankToKey(data);
      if (!rankKey) throw new Error("ソロランクが未取得、または対応外のランクです。手動登録をご利用ください。");
      const fullId = `${data.gameName}#${data.tagLine}`;
      if (players.some(p => p.riotId?.toLowerCase() === fullId.toLowerCase())) {
        throw new Error("このRiot IDはすでに登録されています。");
      }
      if (players.some(p => p.name === fullId) && !confirm("同じ名前のプレイヤーがいます。登録しますか？")) return;
      invalidateTeams();
      setPlayers(prev => {
        if (prev.length >= 20) return prev;
        return [...prev, {
          id: crypto.randomUUID(), name: fullId, riotId: fullId, rank: rankKey,
          selected: prev.filter(p => p.selected).length < 10,
          wins: 0, losses: 0, streak: 0,
        }];
      });
      setRiotIdInput("");
      setRiotMessage(`${fullId} を ${rankKey.toUpperCase()} で登録しました。`);
    } catch (error) {
      setRiotMessage(error instanceof Error ? error.message : "取得に失敗しました。");
    } finally {
      setRiotBusy(false);
    }
  };

  const refreshRiotRank = async (player: Player) => {
    if (!player.riotId || riotUpdatingId) return;
    setRiotUpdatingId(player.id);
    setRiotMessage("");
    try {
      const data = await fetchRiotRank(player.riotId);
      const rankKey = riotRankToKey(data);
      if (!rankKey) throw new Error("ソロランクを取得できませんでした。現在のランクを維持します。");
      invalidateTeams();
      setPlayers(prev => prev.map(p => p.id === player.id ? { ...p, rank: rankKey } : p));
      setRiotMessage(`${player.name} のランクを ${rankKey.toUpperCase()} に更新しました。`);
    } catch (error) {
      setRiotMessage(error instanceof Error ? error.message : "更新に失敗しました。");
    } finally {
      setRiotUpdatingId(null);
    }
  };

  const invalidateTeams = () => { setCandidates([]); setCandidateIndex(0); setResult(null); setChanged({}); };

  const removePlayer = (id: string) => { setPlayers(players.filter(p => p.id !== id)); invalidateTeams(); };

  const toggleSelect = (id: string) => {
    invalidateTeams();
    const selectedCount = players.filter(p => p.selected).length;
    setPlayers(prev => prev.map(p =>
      p.id === id ? { ...p, selected: p.selected ? false : selectedCount < 10 } : p
    ));
  };

  const updateRank = (id: string, newRank: string) => {
    invalidateTeams();
    setPlayers(prev => prev.map(p => (p.id === id ? { ...p, rank: newRank } : p)));
  };

  // 個別ストリークリセット
  const resetStreakOne = (id: string) => {
    invalidateTeams();
    setPlayers(prev => prev.map(p => (p.id === id ? { ...p, streak: 0 } : p)));
  };
  // 全員ストリークリセット
  const resetStreakAll = () => {
    if (!confirm("全員のストリークをリセットしますか？")) return;
    invalidateTeams();
    setPlayers(prev => prev.map(p => ({ ...p, streak: 0 })));
  };


  // 直近履歴から同席ペアカウントを構築（ID ベース、新旧混在は旧を無視）
  const pairCounts = useMemo(() => buildPairCounts(history, TEAMMATE_LOOKBACK), [history]);

  // 変更者はプレイヤーIDで比較。A/B全体の入れ替えは「変更」と扱わない。
  const showAssignment = (next: Assignment, previous: Assignment | null) => {
    const changedMap: Record<string, boolean> = {};
    if (previous) {
      const previousA = new Set(previous.teamA.map(p => p.id));
      const previousB = new Set(previous.teamB.map(p => p.id));
      const nextA = new Set(next.teamA.map(p => p.id));
      const direct = [...nextA].filter(id => previousB.has(id)).length;
      const swapped = [...nextA].filter(id => previousA.has(id)).length;
      const flipLabels = swapped < direct;
      for (const p of [...next.teamA, ...next.teamB]) {
        const nowA = nextA.has(p.id);
        changedMap[p.id] = flipLabels
          ? (nowA ? previousA.has(p.id) : previousB.has(p.id))
          : (nowA ? previousB.has(p.id) : previousA.has(p.id));
      }
    }
    setChanged(changedMap);
    setResult(next);
  };

  /* 全126通りからバランス上位5候補を選び、最良の候補を表示 */
  const runAutoBalance = () => {
    const selected = players.filter(p => p.selected);
    if (selected.length !== 10) return alert(`ちょうど10人選んでください（現在${selected.length}人）`);
    const balPlayers: BalPlayer[] = selected.map(p => ({
      id: p.id, name: p.name,
      mmr: (RANK_TO_MMR[p.rank] ?? 1200) + streakAdj(p.streak),
    }));
    const ranked = rankedAssignments10(balPlayers, pairCounts);
    if (!ranked.length) return;
    setCandidates(ranked);
    setCandidateIndex(0);
    showAssignment(ranked[0], result);
  };

  /* 次点のバランス候補へ。上位5通りを巡回 */
  const changeTeam = () => {
    if (!candidates.length || !result) return;
    const nextIndex = (candidateIndex + 1) % candidates.length;
    setCandidateIndex(nextIndex);
    showAssignment(candidates[nextIndex], result);
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
    invalidateTeams();
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

  const selectedCount = players.filter(p => p.selected).length;
  return (
    <div className="studio-page">
      <div className="studio-layout">
        <header className="studio-header">
          <div className="studio-brand"><span className="studio-brandmark"><i></i><i></i><i></i><i></i></span><span>TEAM<span className="brand-accent">MIX</span><small>LEAGUE CUSTOM BALANCER</small></span></div>
          <div className="studio-status"><span className="status-dot" /> LOCAL WORKSPACE <span className="status-divider" /> v2.0</div>
        </header>
        <section className="studio-intro">
          <div><div className="eyebrow"><span className="eyebrow-line" /> MATCH SETUP / 01</div><h1>ちょうどいいチームを、<br /><em>かんたんに。</em></h1><p>プレイヤーを選んで、ワンクリックでフェアな5対5に。<br />ランク・連勝補正・過去の組み合わせまで考慮します。</p></div>
          <div className="intro-stat"><span className="stat-overline">READY TO PLAY</span><strong>{selectedCount}<span> / 10</span></strong><span className="stat-foot">選択中のプレイヤー</span><div className="stat-track"><span style={{ width: `${selectedCount * 10}%` }} /></div></div>
        </section>
        <div className="studio-grid">
          <main className="studio-main">
            <section className="panel player-panel">
              <div className="panel-heading"><div><span className="section-kicker">01 / PLAYERS</span><h2>プレイヤー管理 <span className="count-pill">{players.length} / 20</span></h2></div><span className="muted-caption">参加メンバーを登録・選択</span></div>
              <div className="add-form"><input aria-label="プレイヤー名" placeholder="プレイヤー名を入力" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addPlayer(); }} /><select aria-label="ランク" value={rank} onChange={e => setRank(e.target.value)}>{RANKS.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}</select><button className="btn btn-dark" onClick={addPlayer}>プレイヤーを追加 <span>＋</span></button></div>
              <div className="riot-register">
                <div className="riot-register-title">Riot IDで自動登録 <span>SOLO RANK</span></div>
                <div className="riot-register-fields">
                  <input aria-label="Riot ID" placeholder="ゲーム名#タグ（例：Karina#nkotu）" value={riotIdInput}
                    onChange={e => setRiotIdInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") void addFromRiot(); }} />
                  <button className="btn btn-riot" type="button" disabled={riotBusy || players.length >= 20}
                    onClick={() => void addFromRiot()}>{riotBusy ? "取得中…" : "ランク取得して登録"}</button>
                </div>
                {riotMessage && <div className="riot-feedback" role="status">{riotMessage}</div>}
              </div>
              <div className="player-list player-list-minimal"> {players.length === 0 ? <div className="empty-state">まだプレイヤーがいません。上のフォームから追加してください。</div> : players.map(p => (
                <div className={`player-row player-tile ${p.selected ? 'is-selected' : ''}`} key={p.id}>
                  <label className="player-tile-main">
                    <input type="checkbox" checked={p.selected} onChange={() => toggleSelect(p.id)} disabled={!p.selected && selectedCount >= 10} aria-label={`${p.name}を参加メンバーに選択`} />
                    <span className="player-tile-check" aria-hidden="true" />
                    <span className="player-tile-name" title={p.name}>{p.name}</span>
                  </label>
                  <div className="player-tile-bottom">
                    <select value={p.rank} aria-label={`${p.name}のランク`} onChange={e => updateRank(p.id, e.target.value)}>{RANKS.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}</select>
                    <details className="player-tile-details">
                      <summary aria-label={`${p.name}の詳細設定`}>詳細</summary>
                      <div className="player-tile-menu">
                        <div>戦績：{p.wins}勝 {p.losses}敗</div>
                        <div>{p.streak === 0 ? '連勝・連敗なし' : `${Math.abs(p.streak)}連${p.streak > 0 ? '勝' : '敗'} / 補正 ${streakAdj(p.streak) > 0 ? '+' : ''}${streakAdj(p.streak)} MMR`}</div>
                        {p.riotId && <button type="button" disabled={riotUpdatingId !== null} onClick={() => refreshRiotRank(p)}>{riotUpdatingId === p.id ? '取得中...' : 'Riotランクを更新'}</button>}
                        <button type="button" onClick={() => resetStreakOne(p.id)}>連勝・連敗をリセット</button>
                        <button type="button" className="player-tile-delete" onClick={() => { if (confirm(`${p.name}を削除しますか？`)) removePlayer(p.id); }}>プレイヤーを削除</button>
                      </div>
                    </details>
                  </div>
                </div>
              ))}</div>
            </section>
            <section className="panel results-panel"><div className="panel-heading"><div><span className="section-kicker">02 / TEAM RESULT</span><h2>チーム編成</h2></div><span className="muted-caption">バランス結果を比較</span></div>
              {!result ? <div className="result-placeholder"><div className="placeholder-graphic"><div className="placeholder-card a" /><div className="placeholder-card b" /><div className="placeholder-center">VS</div></div><strong>まだチームが編成されていません</strong><p>10人選択して「チームを編成」を押してください。</p></div> : <><div className="teams-grid"><div className="team-card team-a"><div className="team-title"><span>TEAM A</span><strong>{result.mmrA.toLocaleString()} <small>MMR</small></strong></div><div className="team-members">{[...result.teamA].sort((a, b) => b.mmr - a.mmr).map((p, i) => <div className="team-member" key={p.id}><span className="team-index">{String(i + 1).padStart(2, '0')}</span><strong>{p.name}</strong>{changed[p.id] && <span className="changed-label">変更</span>}<span className="member-mmr">{p.mmr}</span></div>)}</div></div><div className="team-card team-b"><div className="team-title"><span>TEAM B</span><strong>{result.mmrB.toLocaleString()} <small>MMR</small></strong></div><div className="team-members">{[...result.teamB].sort((a, b) => b.mmr - a.mmr).map((p, i) => <div className="team-member" key={p.id}><span className="team-index">{String(i + 1).padStart(2, '0')}</span><strong>{p.name}</strong>{changed[p.id] && <span className="changed-label">変更</span>}<span className="member-mmr">{p.mmr}</span></div>)}</div></div></div><div className="score-strip"><div><span>MMR DIFFERENCE</span><strong>{result.mmrScore}</strong></div><div><span>PAIR PENALTY</span><strong>{result.pairScore}</strong></div><div><span>TOTAL SCORE</span><strong>{result.score}</strong></div></div><div className="team-switch-actions"><button type="button" className="btn btn-switch" onClick={changeTeam} disabled={candidates.length < 2}>別のチーム編成を見る ↻</button><span>候補 {candidateIndex + 1} / {candidates.length}（スコアが低い順）</span></div><div className="win-actions"><span>試合結果を記録</span><button className="btn win-a" onClick={() => recordResult('A')}>TEAM A WIN</button><button className="btn win-b" onClick={() => recordResult('B')}>TEAM B WIN</button></div></>}
            </section>
            <section className="panel history-panel"><div className="panel-heading"><div><span className="section-kicker">03 / MATCH LOG</span><h2>対戦履歴 <span className="count-pill">{history.length}</span></h2></div>{history.length > 0 && <button className="subtle-link" onClick={clearHistory}>履歴をすべて削除</button>}</div>{history.length === 0 ? <div className="empty-state">まだ対戦履歴はありません。</div> : <div className="history-list">{history.map(h => <details className="history-entry" key={h.id}><summary><span className="history-round">MATCH {String(h.index).padStart(2, '0')}</span><strong>TEAM {h.winner} WIN</strong><small>{new Date(h.timeISO).toLocaleString('ja-JP')}</small><span className="history-chevron">⌄</span></summary><div className="history-detail"><div><b>TEAM A</b>{h.teamA.join(' / ')}</div><div><b>TEAM B</b>{h.teamB.join(' / ')}</div><p>MMR {h.mmrA} : {h.mmrB}　/　スコア {h.score}</p></div></details>)}</div>}</section>
          </main>
          <aside className="studio-side"><section className="side-card action-card"><span className="section-kicker">QUICK ACTION</span><h2>準備ができたら<br />チームを作成。</h2><p>選択中の10人をもとに最適な組み合わせを計算します。</p><div className="selection-meter"><span>選択済み</span><strong>{selectedCount} <small>/ 10人</small></strong></div><div className="meter-dots">{Array.from({ length: 10 }, (_, i) => <span key={i} className={i < selectedCount ? 'active' : ''} />)}</div><button className="btn btn-primary" disabled={selectedCount !== 10} onClick={runAutoBalance}>チームを編成する <span>↗</span></button><small className="action-hint">{selectedCount === 10 ? '編成できます' : `あと${10 - selectedCount}人選択してください`}</small></section>
            <section className="side-card streak-card"><div className="side-heading"><span className="section-kicker">CURRENT STREAK</span><button className="subtle-link" onClick={resetStreakAll}>全員リセット</button></div><h3>連勝・連敗の状況</h3><div className="streak-item"><span className="streak-indicator win" /><div><small>WIN STREAK</small><strong>{maxWin.n > 0 ? `${maxWin.n} 連勝` : '記録なし'}</strong><span>{maxWin.names.join('、') || '—'}</span></div></div><div className="streak-item"><span className="streak-indicator lose" /><div><small>LOSE STREAK</small><strong>{maxLose.n > 0 ? `${maxLose.n} 連敗` : '記録なし'}</strong><span>{maxLose.names.join('、') || '—'}</span></div></div></section>
            <div className="side-note"><span className="note-line" />BALANCE SYSTEM <p>MMR差と直近{TEAMMATE_LOOKBACK}試合の同席履歴を考慮して、最もバランスのよい編成を選びます。</p></div>
          </aside>
        </div>
        <footer className="studio-footer"><span>TEAMMIX / CUSTOM MATCH TOOL</span><span>Made for better matches.</span></footer>
      </div>
    </div>
  );
}
