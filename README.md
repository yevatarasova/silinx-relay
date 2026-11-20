# A Silinx relay on Cloudflare

A relay of Silinx's shared projects (live sharing) that runs on Cloudflare Workers with one Durable Object per room,
on Cloudflare's free plan. Anyone can deploy one with their own Cloudflare account and share projects through it from
the Silinx site, with no Silinx server. A teacher can deploy one, and so can a student: everything that is counted
against the free plan's limits counts on the account that deployed the relay.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pmnmalo/Silinx/tree/main/packages/silinx-relay-cloudflare)

## What it does

It runs the same room logic as a Silinx server's relay (`core/collab-room.js`, copied as it is into `src/core/` by
`node scripts/sync-relay-cloudflare.mjs`; a test checks that the copies match). Each room has the same roles, limits
and checks: only the owner's changes and an editor's signed edits are passed on, a follower's awareness speaks for that
follower only, and so on. The relay reads nothing of a project. Its frames are encrypted with the key in the link's
fragment, which never reaches it.

- **Opening a room needs the relay's key**, a secret of the Worker (`RELAY_KEY`, 24 characters at least). Whoever
  shares a project through the relay gives it in Silinx (Share Project… ▸ Live). Followers need only the link.
- **Pages from other sites are refused**: a page's WebSocket is let in only when its origin is in `ORIGINS`
  (`wrangler.toml`; the Silinx site, `https://pmnmalo.github.io`, by default: see below). A program's WebSocket, such as the MCP
  server's, has no origin and is let in.
- **Its meeting points** (`/api/collab/meet/…`): a project hosted by its owner's page meets its followers there; they
  go peer to peer (WebRTC) when a direct path works, and through the relay otherwise. Its key opens a meeting point too.
- **A quiet room sleeps** (the WebSocket Hibernation API): Cloudflare keeps its connections open and it costs no
  duration until a message comes.

## Deploying it

### From Silinx (the easiest)

In Silinx's **Collaboration** tab, the **Cloudflare Relay** box: *Set Up a Cloudflare Relay…*. It makes a long random
key in your page (copy it), opens **Deploy to Cloudflare** in a new tab, and takes the relay's address once it is
deployed:

1. **Sign in.** The button opens Cloudflare's dashboard, *Workers & Pages* ▸ *Create an application* ▸ **Set up your
   application**: sign in to Cloudflare, or create a free account.
2. **Git account.** Choose your GitHub account (or *New GitHub connection*; GitLab works the same way). An account
   already connected needs nothing more. The first time, GitHub asks you to install Cloudflare's app: Cloudflare
   creates a new repository, so if *Only select repositories* does not let it, give it **All repositories** and narrow
   it afterwards in GitHub's *Settings* ▸ *Applications* ▸ *Cloudflare Workers and Pages* ▸ *Configure*, to the relay's
   repository alone.
3. **Repository.** Tick **Create private Git repository**: your copy of this folder goes there. Every push to it is
   deployed. The key is not in it: `RELAY_KEY` is a secret kept by Cloudflare.
4. **Project name.** Leave `silinx-relay`: the address becomes `https://silinx-relay.<your subdomain>.workers.dev`.
5. **RELAY_KEY.** Paste the key Silinx made.
6. **ORIGINS.** Leave `https://pmnmalo.github.io`, the Silinx site; add another site after a space, for example Silinx's
   local server: `https://pmnmalo.github.io http://127.0.0.1:8642` (see below).
7. **Build command** empty, **Deploy command** `npm run deploy` (`wrangler deploy`, this folder's `package.json`),
   preview builds off: leave them as they are.
8. **Deploy.** Cloudflare creates your repository (`<your account>/silinx-relay`), then builds the Worker:
   *Initializing* (a minute and a half or so), *Cloning*, *Installing*, *Deploying*: about 2 to 3 minutes in all, ending
   with **Success! Build completed.**
9. **The address**, in the build log under *Deployed silinx-relay triggers* (or the Worker's *Overview* ▸ *Domains &
   Routes*); it answers "A relay of Silinx's shared projects". Paste it in Silinx and click *Check and Save*.

Use the button, not *Workers & Pages* ▸ *Create* ▸ *Import a repository*, which only lists the repositories you
already have. Your copy does not follow this folder: to update the relay, push its new files to your repository, and
Cloudflare deploys it again.

Silinx checks the relay (it answers, it lets the Silinx site in, its key opens a meeting point), says what it found in
its console, and keeps the relay in the browser's settings. Share Project… ▸ Live then shares through it by default.

### From a terminal

`npx wrangler deploy` in this folder, then `npx wrangler secret put RELAY_KEY` (a long random key, 24 characters at
least). Its address answers "A relay of Silinx's shared projects". Then, in Silinx, *Set Up a Cloudflare Relay…* with
its address and key (or Share Project… ▸ Live ▸ Cloudflare relay).

### The sites it lets in

`ORIGINS` (`wrangler.toml`, or the Worker's *Settings* ▸ *Variables and Secrets* in Cloudflare's dashboard) lists the
Silinx sites whose pages use it; the Silinx site's, `https://pmnmalo.github.io`, by default. If Silinx's check says the
relay does not let its site in, it gives the exact line to set, for example
`ORIGINS = "https://pmnmalo.github.io http://127.0.0.1:8642"`; deploy it again after changing it. Its root tells any page
which origins it lets in (`Silinx-Origins`), so that Silinx can say why it is refused.

## The free plan's limits

Cloudflare's free plan counts per account and per day (see Cloudflare's Durable Objects pricing page for the current
figures): 100,000 requests, which include the WebSocket messages a relay receives, and 13,000 GB-s of Durable Objects'
duration, that is the time a room is awake in its 128 MB. A room whose participants are active stays awake. Once a
limit is reached, the relay refuses until the next day.
