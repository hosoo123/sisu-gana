# SISU Live Quiz

Host a quiz on a big screen. Players join from their phones with a link and a 6-digit code. No accounts needed.

The app uses Next.js and TypeScript. The existing quiz interface and game rules are preserved, with Socket.IO attached to the Next.js custom server.

- **Players:** `https://your-address/` → enter the code and a nickname (or scan the QR code on the big screen)
- **Host:** `https://your-address/host` → build the quiz, start a game, run it from the projector

## Option A — Put it online for free (anyone, anywhere)

This uses [Render](https://render.com). Any Node.js host works the same way (Railway, Fly.io, a VPS).

1. Create a free GitHub account if you don't have one, then create a new repository and upload everything in this folder.
2. Sign in to Render and choose **New → Web Service**, then connect that GitHub repository.
3. Use these settings:
   - **Runtime:** Node 18.18 or newer
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Under **Environment**, add `HOST_ACCESS_PASSWORD` with a strong password. The `/host` page and host mode require browser authentication (`host` as the username). Players do not need it. Optionally set `HOST_PIN` to a separate game-creation PIN.
5. Click **Create Web Service**. After a minute or two Render gives you an address like `https://buzzline-xxxx.onrender.com`. Share it with players.

If the frontend is also deployed to Vercel, add the same `HOST_ACCESS_PASSWORD` under that project's **Settings → Environment Variables** and redeploy. Without it, production host routes return `503`; player routes remain public.

Free Render services go to sleep after a period of no visitors. Open the host page a minute before you start so it's awake when players arrive.

## Option B — Run it on your computer (everyone on the same Wi-Fi)

1. Install Node.js 18.18 or newer from https://nodejs.org.
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open `http://localhost:3000/host` on your computer for the host screen.
4. Find your computer's local IP address (Windows: `ipconfig`; Mac: System Settings → Wi-Fi → Details). Players open `http://THAT-IP:3000` on phones connected to the same Wi-Fi. The QR code on the lobby screen only works for them if you open the host page using that IP address instead of `localhost`.

For local development, use `npm run dev`. To require a host PIN locally: `HOST_PIN=1234 npm start` (Mac/Linux) or `set HOST_PIN=1234 && npm start` (Windows).

## Running a game

1. On `/host`, edit the sample quiz or build your own. Each question has 2–4 answers, one correct answer and a time limit. Your quiz is saved in that browser; use **Export quiz** to keep a copy or move it to another computer, and **Import quiz** to load it.
2. Click **Start game**. The lobby shows the join address, a QR code, the code and everyone who joins. Click × on a name to remove someone.
3. Click **Start game** again to show the first question. It closes when the timer ends or everyone has answered.
4. After each question: answer counts and the correct answer, then **Leaderboard**, then **Next question**. After the last question you get the podium.

## How it works

- The server keeps the game state and the clock, so every phone shows the same question at the same moment and answer times are measured on the server.
- Scoring: a correct answer earns 500–1000 points (1000 for an instant answer, 500 at the buzzer). Wrong or missed answers earn 0.
- Nicknames must be unique (case doesn't matter) and can't be empty.
- A player whose phone locks or loses signal can reopen the page and keeps their score. If the host's page reloads, it reconnects to the running game.
- Games live in the server's memory. Restarting the server ends any game in progress. Abandoned games are cleaned up after 3 hours.
