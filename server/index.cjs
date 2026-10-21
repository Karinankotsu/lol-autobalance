
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://lol-autobalance.vercel.app"
  ]
}));
app.use(express.json());

const API_KEY = process.env.RIOT_API_KEY;
console.log("APIキーの確認:", {
  exists: Boolean(API_KEY),
  prefixOK: API_KEY?.startsWith("RGAPI-"),
  length: API_KEY?.length,
  hasWhitespace: API_KEY !== API_KEY?.trim(),
});

app.get("/api/rank", async (req, res) => {
  try {
    const { gameName, tagLine } = req.query;

    if (!gameName || !tagLine) {
      return res.status(400).json({ error: "Riot IDを入力してください" });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: "APIキーが設定されていません" });
    }

    // Riot IDからPUUIDを取得（アジア地域）
    const accountResponse = await fetch(
      `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      { headers: { "X-Riot-Token": API_KEY } }
    );

    if (!accountResponse.ok) {
      console.error("Riot API Error:", accountResponse.status);

      return res.status(accountResponse.status).json({
        error: "Riot IDを取得できませんでした",
        status: accountResponse.status,
      });
    }

    const account = await accountResponse.json();

    // PUUIDから日本サーバーのランクを取得
    const rankResponse = await fetch(
      `https://jp1.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(account.puuid)}`,
      { headers: { "X-Riot-Token": API_KEY } }
    );

    if (!rankResponse.ok) {
      return res.status(rankResponse.status).json({
        error: "ランク情報を取得できませんでした",
      });
    }

    const entries = await rankResponse.json();
    const solo = entries.find(
      (entry) => entry.queueType === "RANKED_SOLO_5x5"
    );

    res.json({
      gameName: account.gameName,
      tagLine: account.tagLine,
      rank: solo
        ? {
          tier: solo.tier,
          division: solo.rank,
          lp: solo.leaguePoints,
        }
        : null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "サーバーエラーが発生しました" });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Riot API server running on port ${PORT}`);
});
