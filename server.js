// Buzzline — live multiplayer quiz server.
// The server owns all game state and timing, so every player sees the same
// question at the same moment and scores can't be faked from a phone.

const http = require("http");
const crypto = require("crypto");
const next = require("next");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const HOST_PIN = (process.env.HOST_PIN || "").trim(); // optional: require a PIN to host
const HOST_ACCESS_PASSWORD = (process.env.HOST_ACCESS_PASSWORD || "").trim();
const HOST_SESSION_COOKIE = "sisu-host-auth";
const TIMES = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const GRACE_MS = 600; // network allowance after the timer hits zero

const app = next({ dev: process.env.NODE_ENV !== "production" });
const handle = app.getRequestHandler();
const server = http.createServer((req, res) => handle(req, res));
const io = new Server(server, {
  maxHttpBufferSize: 2e5,
  pingInterval: 10000,
  pingTimeout: 8000,
});

/* ---------------- helpers ---------------- */
const games = new Map(); // code -> game

function hasHostSession(cookieHeader) {
  if (!HOST_ACCESS_PASSWORD || !cookieHeader) return false;
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(HOST_SESSION_COOKIE + "="));
  if (!cookie) return false;

  const token = cookie.slice(HOST_SESSION_COOKIE.length + 1);
  const separator = token.indexOf(".");
  if (separator < 1) return false;
  const expires = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^\d+$/.test(expires) || Number(expires) <= Date.now()) return false;

  const expected = crypto
    .createHmac("sha256", HOST_ACCESS_PASSWORD)
    .update(expires)
    .digest("base64url");
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature);
  return (
    expectedBytes.length === signatureBytes.length &&
    crypto.timingSafeEqual(expectedBytes, signatureBytes)
  );
}

const clean = (s, max) =>
  String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function validateQuiz(raw) {
  if (!raw || !Array.isArray(raw.questions)) return null;
  const qs = raw.questions.slice(0, 100).map((q) => {
    const options = (Array.isArray(q.options) ? q.options : [])
      .slice(0, 4)
      .map((o) => clean(o, 60));
    return {
      text: clean(q.text, 160),
      explanation: clean(q.explanation, 500),
      options,
      correct: Number.isInteger(q.correct) ? q.correct : -1,
      time: TIMES.includes(q.time) ? q.time : 20,
    };
  });
  const ok =
    qs.length > 0 &&
    qs.every(
      (q) =>
        q.text &&
        q.options.length >= 2 &&
        q.options.every(Boolean) &&
        q.correct >= 0 &&
        q.correct < q.options.length,
    );
  return ok ? { title: clean(raw.title, 80) || "Quiz", questions: qs } : null;
}

function newCode() {
  let c;
  do c = String(crypto.randomInt(100000, 1000000));
  while (games.has(c));
  return c;
}

function ranked(g) {
  const arr = [...g.players.values()].sort(
    (a, b) => b.score - a.score || a.joinedAt - b.joinedAt,
  );
  let rank = 0,
    prev = null;
  arr.forEach((p, i) => {
    if (p.score !== prev) {
      rank = i + 1;
      prev = p.score;
    }
    p.rank = rank;
  });
  return arr;
}

const curQ = (g) => g.quiz.questions[g.qi];
const remaining = (g) => Math.max(0, g.qEnd - Date.now());
const onlineCount = (g) =>
  [...g.players.values()].filter((p) => p.online).length;

/* What every player may see. The correct answer is only included after the reveal. */
function publicState(g) {
  const s = {
    code: g.code,
    title: g.quiz.title,
    phase: g.phase,
    qi: g.qi,
    n: g.quiz.questions.length,
    np: g.players.size,
  };
  if (g.qi >= 0 && g.phase !== "lobby") {
    const q = curQ(g);
    s.q = { text: q.text, options: q.options, time: q.time };
    if (g.phase === "question") {
      s.rem = remaining(g);
      s.answered = g.answers.size;
    } else {
      s.counts = g.counts;
      s.correct = q.correct;
      s.q.explanation = q.explanation;
    }
  }
  s.top = ranked(g)
    .slice(0, 3)
    .map((p) => ({ nick: p.nick, score: p.score }));
  return s;
}

function hostState(g) {
  const s = publicState(g);
  s.hostOnline = !!g.hostSid;
  s.online = onlineCount(g);
  s.players = ranked(g).map((p) => ({
    nick: p.nick,
    score: p.score,
    rank: p.rank,
    online: p.online,
    gained: p.last && p.last.qi === g.qi ? p.last.pts : 0,
  }));
  return s;
}

function meState(g, p) {
  ranked(g);
  const a = g.phase === "question" ? g.answers.get(p.pid) : null;
  return {
    nick: p.nick,
    score: p.score,
    rank: p.rank,
    last: p.last,
    picked: a ? a.c : null,
  };
}

function push(g) {
  g.touched = Date.now();
  if (g.hostSid) io.to(g.hostSid).emit("host:state", hostState(g));
  const pub = publicState(g);
  for (const p of g.players.values()) {
    if (p.sid) io.to(p.sid).emit("game:state", { ...pub, me: meState(g, p) });
  }
}

/* ---------------- game flow ---------------- */
function startQuestion(g, i) {
  clearTimeout(g.timer);
  const q = g.quiz.questions[i];
  g.phase = "question";
  g.qi = i;
  g.qStart = Date.now();
  g.qEnd = g.qStart + q.time * 1000;
  g.answers = new Map();
  g.counts = new Array(q.options.length).fill(0);
  g.timer = setTimeout(() => reveal(g), q.time * 1000 + GRACE_MS);
  push(g);
}

function reveal(g) {
  if (g.phase !== "question") return;
  clearTimeout(g.timer);
  const q = curQ(g),
    limit = q.time * 1000;
  for (const p of g.players.values()) {
    const a = g.answers.get(p.pid);
    const correct = !!a && a.c === q.correct;
    // Correct answers earn 500–1000 points: full 1000 instantly, 500 at the buzzer.
    const pts = correct
      ? Math.round(1000 * (1 - Math.min(a.ms, limit) / limit / 2))
      : 0;
    p.score += pts;
    p.last = { qi: g.qi, correct, answered: !!a, pts };
  }
  g.phase = "reveal";
  push(g);
}

function finish(g) {
  if (g.phase === "question") reveal(g);
  clearTimeout(g.timer);
  g.phase = "final";
  push(g);
}

function closeGame(g, reason) {
  clearTimeout(g.timer);
  for (const p of g.players.values())
    if (p.sid) io.to(p.sid).emit("game:closed", { reason });
  io.in("g:" + g.code).socketsLeave("g:" + g.code);
  games.delete(g.code);
}

// Remove abandoned games: no activity for 3 hours, or host gone for 30 minutes.
setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    if (
      now - g.touched > 3 * 3600e3 ||
      (!g.hostSid && now - g.hostLeftAt > 30 * 60e3)
    )
      closeGame(g, "expired");
  }
}, 60e3).unref();

/* ---------------- sockets ---------------- */
io.on("connection", (socket) => {
  let hosting = null; // game this socket hosts
  let playing = null; // { g, pid }
  const hostAuthenticated = hasHostSession(socket.handshake.headers.cookie);

  const ack = (cb, v) => {
    if (typeof cb === "function") cb(v);
  };
  const hostGame = () =>
    hosting && games.get(hosting.code) === hosting ? hosting : null;

  /* ---- host ---- */
  socket.on("host:create", (data, cb) => {
    data = data || {};
    if (process.env.NODE_ENV === "production" && !HOST_ACCESS_PASSWORD)
      return ack(cb, { ok: false, err: "Host access is not configured." });
    if (HOST_ACCESS_PASSWORD && !hostAuthenticated)
      return ack(cb, { ok: false, err: "Host authentication required." });
    if (HOST_PIN && String(data.pin || "") !== HOST_PIN)
      return ack(cb, { ok: false, err: "pin" });
    const quiz = validateQuiz(data.quiz);
    if (!quiz)
      return ack(cb, {
        ok: false,
        err: "Every question needs text, 2–4 filled answers and a correct answer.",
      });
    const g = {
      code: newCode(),
      hostKey: crypto.randomBytes(16).toString("hex"),
      hostSid: socket.id,
      hostLeftAt: 0,
      quiz,
      phase: "lobby",
      qi: -1,
      qStart: 0,
      qEnd: 0,
      timer: null,
      players: new Map(),
      answers: new Map(),
      counts: [],
      touched: Date.now(),
    };
    games.set(g.code, g);
    hosting = g;
    ack(cb, { ok: true, code: g.code, hostKey: g.hostKey });
    push(g);
  });

  socket.on("host:resume", (data, cb) => {
    const g = games.get(String((data && data.code) || ""));
    if (!g || g.hostKey !== (data && data.hostKey))
      return ack(cb, { ok: false });
    if (g.hostSid && g.hostSid !== socket.id)
      io.to(g.hostSid).emit("host:replaced");
    g.hostSid = socket.id;
    hosting = g;
    ack(cb, { ok: true, code: g.code });
    push(g);
  });

  socket.on("host:action", (data) => {
    const g = hostGame();
    if (!g || g.hostSid !== socket.id) return;
    const a = data && data.action;
    if (a === "start" && g.phase === "lobby" && g.players.size)
      startQuestion(g, 0);
    else if (a === "reveal" && g.phase === "question") reveal(g);
    else if (a === "board" && g.phase === "reveal") {
      g.phase = "board";
      push(g);
    } else if (a === "next" && (g.phase === "board" || g.phase === "reveal")) {
      g.qi + 1 < g.quiz.questions.length
        ? startQuestion(g, g.qi + 1)
        : finish(g);
    } else if (a === "end" && g.phase !== "lobby" && g.phase !== "final")
      finish(g);
    else if (a === "kick" && typeof data.nick === "string") {
      for (const p of g.players.values()) {
        if (p.nick === data.nick) {
          if (p.sid) io.to(p.sid).emit("game:closed", { reason: "removed" });
          g.players.delete(p.pid);
          g.answers.delete(p.pid);
        }
      }
      push(g);
    } else if (a === "close") {
      closeGame(g, "closed");
      hosting = null;
    }
  });

  /* ---- player ---- */
  socket.on("player:join", (data, cb) => {
    data = data || {};
    const g = games.get(String(data.code || "").trim());
    if (!g)
      return ack(cb, {
        ok: false,
        err: "No game is running with that code. Check the big screen.",
      });
    const pid = clean(data.pid, 64);
    if (!pid)
      return ack(cb, {
        ok: false,
        err: "Something went wrong. Reload the page and try again.",
      });
    const nick = clean(data.nick, 20);

    // Reconnecting with the same device id: restore the player.
    const existing = g.players.get(pid);
    if (
      existing &&
      (!nick || existing.nick.toLowerCase() === nick.toLowerCase())
    ) {
      if (existing.sid && existing.sid !== socket.id)
        io.to(existing.sid).emit("game:closed", { reason: "elsewhere" });
      existing.sid = socket.id;
      existing.online = true;
      playing = { g, pid };
      ack(cb, { ok: true, nick: existing.nick });
      return push(g);
    }
    if (!nick) return ack(cb, { ok: false, err: "Pick a nickname." });
    if (g.phase === "final")
      return ack(cb, { ok: false, err: "This game has already finished." });
    const taken = [...g.players.values()].some(
      (p) => p.nick.toLowerCase() === nick.toLowerCase(),
    );
    if (taken)
      return ack(cb, {
        ok: false,
        err: `Someone already has the name “${nick}”. Pick another.`,
      });
    if (g.players.size >= 300)
      return ack(cb, { ok: false, err: "This game is full." });
    if (existing) g.players.delete(pid); // same device, new name
    g.players.set(pid, {
      pid,
      nick,
      sid: socket.id,
      online: true,
      score: 0,
      last: null,
      rank: 0,
      joinedAt: Date.now(),
    });
    playing = { g, pid };
    ack(cb, { ok: true, nick });
    push(g);
  });

  socket.on("player:answer", (data) => {
    if (!playing) return;
    const { g, pid } = playing;
    const p = g.players.get(pid);
    if (!p || games.get(g.code) !== g || g.phase !== "question") return;
    if (!data || data.qi !== g.qi || g.answers.has(pid)) return;
    const c = data.c,
      q = curQ(g);
    if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return;
    const ms = Date.now() - g.qStart;
    if (ms > q.time * 1000 + GRACE_MS) return;
    g.answers.set(pid, { c, ms });
    g.counts[c]++;
    const online = onlineCount(g);
    if (
      online &&
      [...g.players.values()].every((x) => !x.online || g.answers.has(x.pid))
    )
      return reveal(g);
    push(g);
  });

  socket.on("player:leave", () => {
    if (!playing) return;
    const { g, pid } = playing;
    if (g.phase === "lobby") g.players.delete(pid);
    else {
      const p = g.players.get(pid);
      if (p) {
        p.online = false;
        p.sid = null;
      }
    }
    playing = null;
    if (games.get(g.code) === g) push(g);
  });

  socket.on("disconnect", () => {
    if (hosting && hosting.hostSid === socket.id) {
      hosting.hostSid = null;
      hosting.hostLeftAt = Date.now();
    }
    if (playing) {
      const { g, pid } = playing;
      const p = g.players.get(pid);
      if (p && p.sid === socket.id) {
        // In the lobby a player who drops frees their name; mid-game they keep their score.
        if (g.phase === "lobby") g.players.delete(pid);
        else {
          p.online = false;
          p.sid = null;
        }
        if (games.get(g.code) === g) push(g);
      }
    }
  });
});

app.prepare().then(() => {
  const listen = (port) => {
    const onError = (error) => {
      if (
        error.code === "EADDRINUSE" &&
        process.env.NODE_ENV !== "production"
      ) {
        const nextPort = Number(port) + 1;
        console.warn(`Port ${port} is already in use; trying ${nextPort}.`);
        return listen(nextPort);
      }
      throw error;
    };
    server.once("error", onError);
    server.listen(port, () => {
      const address = server.address();
      const activePort =
        address && typeof address === "object" ? address.port : port;
      console.log(`SISU Live Quiz running on http://localhost:${activePort}`);
      console.log(`  Players:  http://localhost:${activePort}/`);
      console.log(`  Host:     http://localhost:${activePort}/host`);
      if (HOST_PIN) console.log("  Hosting requires the HOST_PIN.");
    });
  };
  listen(Number(PORT));
});
