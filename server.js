const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Load .env manually ──────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

const PORT = process.env.PORT || 3001;
const TWITTER_KEY = process.env.TWITTER_API_KEY || '';
const TWITTER_HOST = 'twitter-api45.p.rapidapi.com';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const CACHE_DIR = path.join(__dirname, '.cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// ── In-memory response cache (instant responses) ────────────
let memoryFeedCache = null;       // { cards, timestamp, json, gzipped }
let feedBuildInProgress = false;

function setMemoryCache(cards) {
  const payload = { cards, cached: true, timestamp: Date.now() };
  const json = JSON.stringify(payload);
  memoryFeedCache = {
    cards,
    timestamp: Date.now(),
    json,
    gzipped: zlib.gzipSync(json),
  };
}

// ── PostgreSQL (optional — falls back to file cache) ────────
let pool = null;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL — using file cache only');
    return;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected');
    await ensureSchema();
  } catch (err) {
    console.error('PostgreSQL init failed, falling back to file cache:', err.message);
    pool = null;
  }
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweets (
      tweet_id TEXT PRIMARY KEY,
      screenname TEXT NOT NULL,
      text TEXT,
      favorites INT DEFAULT 0,
      views TEXT,
      bookmarks INT DEFAULT 0,
      retweets INT DEFAULT 0,
      reply_to TEXT,
      created_at TEXT,
      author_name TEXT,
      author_screen_name TEXT,
      author_avatar TEXT,
      raw_json JSONB,
      inserted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_cards (
      id TEXT PRIMARY KEY,
      handle TEXT,
      name TEXT,
      avatar TEXT,
      summary TEXT,
      score REAL,
      likes INT DEFAULT 0,
      views INT DEFAULT 0,
      bookmarks INT DEFAULT 0,
      date TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_state (
      screenname TEXT PRIMARY KEY,
      last_tweet_id TEXT,
      last_scanned_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Performance indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tweets_screenname ON tweets(screenname)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feed_cards_score ON feed_cards(score DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feed_cards_date ON feed_cards(created_at DESC)`);
  console.log('DB schema + indexes ensured');
}

// ── DB helper functions ─────────────────────────────────────
async function getKnownTweetIds(screenname) {
  if (!pool) return new Set();
  try {
    const res = await pool.query(
      'SELECT tweet_id FROM tweets WHERE screenname = $1',
      [screenname]
    );
    return new Set(res.rows.map(r => r.tweet_id));
  } catch (err) {
    console.error('getKnownTweetIds error:', err.message);
    return new Set();
  }
}

async function storeTweets(tweets, screenname) {
  if (!pool || tweets.length === 0) return;
  try {
    // Batch insert using unnest for performance
    const tweetIds = [], screennames = [], texts = [], favorites = [];
    const viewsArr = [], bookmarksArr = [], retweetsArr = [], replyTos = [];
    const createdAts = [], authorNames = [], authorScreenNames = [];
    const authorAvatars = [], rawJsons = [];

    for (const t of tweets) {
      const author = t.author || {};
      tweetIds.push(t.tweet_id);
      screennames.push(screenname);
      texts.push(t.text || '');
      favorites.push(t.favorites || 0);
      viewsArr.push(String(t.views || '0'));
      bookmarksArr.push(t.bookmarks || 0);
      retweetsArr.push(t.retweets || 0);
      replyTos.push(t.reply_to || null);
      createdAts.push(t.created_at || null);
      authorNames.push(author.name || '');
      authorScreenNames.push(author.screen_name || '');
      authorAvatars.push(author.avatar || '');
      rawJsons.push(JSON.stringify(t));
    }

    await pool.query(`
      INSERT INTO tweets (tweet_id, screenname, text, favorites, views, bookmarks, retweets, reply_to, created_at, author_name, author_screen_name, author_avatar, raw_json)
      SELECT * FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::int[], $5::text[],
        $6::int[], $7::int[], $8::text[], $9::text[], $10::text[],
        $11::text[], $12::text[], $13::jsonb[]
      )
      ON CONFLICT (tweet_id) DO NOTHING
    `, [tweetIds, screennames, texts, favorites, viewsArr, bookmarksArr,
        retweetsArr, replyTos, createdAts, authorNames, authorScreenNames,
        authorAvatars, rawJsons]);
  } catch (err) {
    console.error('storeTweets batch error:', err.message);
    // Fallback to individual inserts
    for (const t of tweets) {
      try {
        const author = t.author || {};
        await pool.query(`
          INSERT INTO tweets (tweet_id, screenname, text, favorites, views, bookmarks, retweets, reply_to, created_at, author_name, author_screen_name, author_avatar, raw_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (tweet_id) DO NOTHING
        `, [
          t.tweet_id, screenname, t.text,
          t.favorites || 0, String(t.views || '0'), t.bookmarks || 0, t.retweets || 0,
          t.reply_to || null, t.created_at || null,
          author.name || '', author.screen_name || '', author.avatar || '',
          JSON.stringify(t)
        ]);
      } catch (e) { /* skip individual failures */ }
    }
  }
}

async function updateScanState(screenname, lastTweetId) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO scan_state (screenname, last_tweet_id, last_scanned_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (screenname) DO UPDATE SET last_tweet_id = $2, last_scanned_at = NOW()
    `, [screenname, lastTweetId]);
  } catch (err) {
    console.error('updateScanState error:', err.message);
  }
}

async function getFeedCardsFromDb() {
  if (!pool) return null;
  try {
    const res = await pool.query(
      'SELECT id, handle, name, avatar, summary, score, likes, views, bookmarks, date FROM feed_cards ORDER BY score DESC, created_at DESC'
    );
    if (res.rows.length === 0) return null;
    return res.rows;
  } catch (err) {
    console.error('getFeedCardsFromDb error:', err.message);
    return null;
  }
}

async function storeFeedCards(cards) {
  if (!pool || cards.length === 0) return;
  try {
    // Batch upsert
    const ids = [], handles = [], names = [], avatars = [], summaries = [];
    const scores = [], likes = [], views = [], bookmarks = [], dates = [];

    for (const c of cards) {
      ids.push(c.id); handles.push(c.handle); names.push(c.name);
      avatars.push(c.avatar); summaries.push(c.summary); scores.push(c.score);
      likes.push(c.likes); views.push(c.views); bookmarks.push(c.bookmarks);
      dates.push(c.date);
    }

    await pool.query(`
      INSERT INTO feed_cards (id, handle, name, avatar, summary, score, likes, views, bookmarks, date)
      SELECT * FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
        $6::real[], $7::int[], $8::int[], $9::int[], $10::text[]
      )
      ON CONFLICT (id) DO UPDATE SET
        summary = EXCLUDED.summary, score = EXCLUDED.score,
        likes = EXCLUDED.likes, views = EXCLUDED.views,
        bookmarks = EXCLUDED.bookmarks, date = EXCLUDED.date
    `, [ids, handles, names, avatars, summaries, scores, likes, views, bookmarks, dates]);
  } catch (err) {
    console.error('storeFeedCards batch error:', err.message);
    // Fallback to individual
    for (const c of cards) {
      try {
        await pool.query(`
          INSERT INTO feed_cards (id, handle, name, avatar, summary, score, likes, views, bookmarks, date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (id) DO UPDATE SET
            summary = EXCLUDED.summary, score = EXCLUDED.score,
            likes = EXCLUDED.likes, views = EXCLUDED.views,
            bookmarks = EXCLUDED.bookmarks, date = EXCLUDED.date
        `, [c.id, c.handle, c.name, c.avatar, c.summary, c.score, c.likes, c.views, c.bookmarks, c.date]);
      } catch (e) { /* skip */ }
    }
  }
}

// ── Top ~100 AI SaaS builder accounts ───────────────────────
const ACCOUNTS = [
  'levelsio','marc_louvion','tdinh_me','dannypostmaa','mckaywrigley',
  'bentossell','shpigford','thesamparr','dvassallo','nathanbarry',
  'gregisenberg','ShaanVP','arvidkahl','thepatwalls','csallen',
  'marckohlbrugge','noahkagan','robwalling','hnshah','randfish',
  'yongfook','tibo_maker','damengchen','ajlkn','dagorenouf',
  'jakobgreenfeld','kiwicopple','panphora','PierreDeWulf','Insharamin',
  'yannick_veys','SimonHoiberg','stephsmithio','dru_riley','monicalent',
  'thisiskp_','mubashariqbal','brian_lovin','mijustin','coreyhainesco',
  'jasonlk','nathanlatka','danmartell','steli','Pauline_Cx',
  'MarieMartens','petecodes','alexwestco','TaraReed_','chddaniel',
  'johnrushx','yoheinakajima','JimRaptis','mattiapomelli','pjrvs',
  'tylermking','lunchbag','MattCowlin',
  'rileybrown_ai','florinpop1705','pbteja1998','sobedominik','czue',
  'qayyumrajan','louispereira','NotechAna','saasmakermac','dylan_hey',
  'DmytroKrasun','helloitsolly','itsjustamar','philostar','ankit_saas',
  'code_rams','phuctm97','nico_jeannen','jasonleowsg','JhumanJ',
  'pie6k','daniel_nguyenx','PaulYacoubian','_rchase_','SlamingDev',
  'mikestrives','MatthewBerman','patio11','dharmesh','lennysan',
  'swyx','karpathy',
];

// ── Helpers ─────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function cachePath(name) {
  return path.join(CACHE_DIR, `${name}_${todayStr()}.json`);
}

function readCache(name) {
  const p = cachePath(name);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
  }
  return null;
}

function writeCache(name, data) {
  try { fs.writeFileSync(cachePath(name), JSON.stringify(data)); } catch (e) {}
}

function pruneOldCache() {
  const today = todayStr();
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.endsWith('.json') && !f.includes(today)) {
        fs.unlinkSync(path.join(CACHE_DIR, f));
      }
    }
  } catch (e) {}
}

pruneOldCache();

// ── Gzip helper ─────────────────────────────────────────────
function sendJson(req, res, statusCode, obj) {
  const json = JSON.stringify(obj);
  const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (acceptGzip && json.length > 512) {
    res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(statusCode);
    zlib.gzip(json, (err, compressed) => {
      res.end(err ? json : compressed);
    });
  } else {
    res.writeHead(statusCode);
    res.end(json);
  }
}

function sendCachedFeed(req, res) {
  if (!memoryFeedCache) return false;

  const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

  if (acceptGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(200);
    res.end(memoryFeedCache.gzipped);
  } else {
    res.writeHead(200);
    res.end(memoryFeedCache.json);
  }
  return true;
}

// ── Static file cache (pre-read into memory) ────────────────
const staticCache = new Map();

function preloadStatic() {
  const files = ['index.html'];
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };

  for (const file of files) {
    const fullPath = path.join(__dirname, file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath);
      const ext = path.extname(file);
      const mime = mimeTypes[ext] || 'text/plain';
      staticCache.set('/' + file, {
        content,
        gzipped: zlib.gzipSync(content),
        mime,
      });
      if (file === 'index.html') {
        staticCache.set('/', { content, gzipped: zlib.gzipSync(content), mime });
      }
    }
  }
  console.log(`Pre-cached ${staticCache.size} static files`);
}

// ── HTTPS request helper ────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Twitter API ─────────────────────────────────────────────
async function fetchTimeline(screenname) {
  const cached = readCache(`tweets_${screenname}`);
  if (cached) return cached;

  const data = await httpsRequest({
    hostname: TWITTER_HOST,
    path: `/timeline.php?screenname=${encodeURIComponent(screenname)}`,
    method: 'GET',
    headers: {
      'x-rapidapi-key': TWITTER_KEY,
      'x-rapidapi-host': TWITTER_HOST,
    }
  });

  if (data && data.timeline) {
    writeCache(`tweets_${screenname}`, data);
  }
  return data;
}

// ── Revenue / money-only pre-filter ─────────────────────────
function isMoneyTweet(text) {
  const hasDollar = /\$[\d,]+/.test(text);
  const hasRevenueKeyword = /(?:MRR|ARR|revenue|income|profit|margin|sales)/i.test(text);
  const hasMoneyKeyword = /(?:made|earned|grossed|netted|bringing in|generating)/i.test(text);
  const hasSoldKeyword = /(?:SOLD FOR|ACQUIRED FOR|sold.*\$|acquisition.*\$)/i.test(text);
  const hasCustomerProof = /(?:paying customers|paid users|subscribers|new customers|purchases|conversions)/i.test(text) && /\d/.test(text);
  const hasRevenueNumber = /\d+[KkMm]?\s*(?:MRR|ARR|\/mo|\/month|\/year|revenue)/i.test(text);

  const isAdvice = /(?:^how to|^why you|^stop |^don't|should you|^the secret|^my advice|^tip:|^thread)/i.test(text);
  const isPromo = /(?:^check out|^join |^sign up|^use code|^discount|^giveaway)/i.test(text);

  if (isAdvice || isPromo) return false;

  return hasDollar || hasSoldKeyword || hasCustomerProof || hasRevenueNumber ||
    (hasRevenueKeyword && /\d/.test(text)) ||
    (hasMoneyKeyword && /\$/.test(text));
}

// ── FOMO scoring — revenue-focused only ─────────────────────
function fomoScore(tweet) {
  const text = tweet.text || '';

  if (!isMoneyTweet(text)) return 0;

  const favs = tweet.favorites || 0;
  const views = parseInt(tweet.views) || 0;
  const bookmarks = tweet.bookmarks || 0;
  const retweets = tweet.retweets || 0;

  let score = 10;

  score += Math.min(favs / 100, 8);
  score += Math.min(views / 10000, 8);
  score += Math.min(bookmarks / 50, 6);
  score += Math.min(retweets / 20, 4);

  const dollarRe = /\$\s*([\d,]+(?:\.\d+)?)\s*([KkMm])?/g;
  let m;
  let maxDollar = 0;
  while ((m = dollarRe.exec(text)) !== null) {
    let val = parseFloat(m[1].replace(/,/g, ''));
    if (m[2] && /[Kk]/.test(m[2])) val *= 1000;
    if (m[2] && /[Mm]/.test(m[2])) val *= 1000000;
    if (val > maxDollar) maxDollar = val;
  }

  if (maxDollar >= 1000000) score += 30;
  else if (maxDollar >= 100000) score += 20;
  else if (maxDollar >= 50000) score += 15;
  else if (maxDollar >= 10000) score += 10;
  else if (maxDollar >= 1000) score += 5;

  if (/\b(?:SOLD|ACQUIRED|acquisition|exit)\b/i.test(text)) score += 15;
  if (/(?:MRR|ARR)/i.test(text)) score += 5;
  if (tweet.reply_to) score *= 0.3;

  return Math.round(score * 10) / 10;
}

// ── OpenAI summarization — strict revenue-only ──────────────
async function summarizeTweets(tweetsWithAuthors) {
  if (!OPENAI_KEY || tweetsWithAuthors.length === 0) return tweetsWithAuthors.map(() => null);

  const prompt = tweetsWithAuthors.map((t, i) =>
    `[${i}] @${t.author.screen_name} (${t.author.name}): "${t.text}"`
  ).join('\n\n');

  try {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You write ultra-short FOMO summaries of AI builders making real money.

ONLY summarize tweets that show CONCRETE PROOF of one of these:
1. Revenue numbers (MRR, ARR, monthly income, profit)
2. A sale or acquisition with a price
3. Paying customers / paid user counts
4. Earnings reports or income breakdowns

STRICT RULES:
- Return "SKIP" for anything that is NOT concrete revenue/money proof
- SKIP: opinions, advice, motivational quotes, product launches without revenue, growth without revenue, general statements
- SKIP: investments, fundraising, or spending money (we only care about MAKING money or having paying customers)
- Each summary must be ONE punchy sentence, max 120 chars
- Start with the achievement: "Made $94K in January" not "Just shared that they made..."
- Include the actual numbers from the tweet
- Do NOT include @ handles — shown separately
- Return a JSON array of strings, one per tweet, same order`
        },
        {
          role: 'user',
          content: `Summarize ONLY the money/revenue tweets. SKIP everything else:\n\n${prompt}\n\nReturn ONLY a JSON array of strings.`
        }
      ],
      temperature: 0.4,
      max_tokens: 2000,
    });

    const resp = await httpsRequest({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      }
    }, body);

    const content = resp.choices?.[0]?.message?.content || '[]';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.error('OpenAI error:', err.message);
  }

  return tweetsWithAuthors.map(() => null);
}

// ── Build the feed (incremental) ────────────────────────────
let feedBuildPromise = null;

async function buildFeed() {
  // If already building, wait for the existing build to finish
  if (feedBuildInProgress && feedBuildPromise) {
    console.log('Feed build already in progress, waiting...');
    return feedBuildPromise;
  }
  feedBuildInProgress = true;

  feedBuildPromise = _buildFeedInner();
  try {
    return await feedBuildPromise;
  } finally {
    feedBuildPromise = null;
  }
}

async function _buildFeedInner() {

  try {
    // 1. Check DB for existing cards first
    const dbCards = await getFeedCardsFromDb();
    const fileCards = readCache('feed');
    const existingCards = dbCards || fileCards || [];

    // Warm memory cache immediately if we have data
    if (existingCards.length > 0 && !memoryFeedCache) {
      setMemoryCache(existingCards);
      console.log(`Warmed memory cache with ${existingCards.length} existing cards`);
    }

    if (existingCards.length > 0) {
      console.log(`Found ${existingCards.length} existing feed cards, checking for new tweets...`);
    } else {
      console.log('Building fresh feed...');
    }

    const existingIds = new Set(existingCards.map(c => c.id));
    const allNewTweets = [];
    let fetched = 0;
    let skipped = 0;

    for (const account of ACCOUNTS) {
      fetched++;
      process.stdout.write(`  [${fetched}/${ACCOUNTS.length}] @${account}...`);
      try {
        const data = await fetchTimeline(account);
        if (data && data.timeline) {
          const knownIds = await getKnownTweetIds(account);

          let found = 0;
          for (const tweet of data.timeline) {
            if (knownIds.has(tweet.tweet_id) || existingIds.has(tweet.tweet_id)) continue;

            const score = fomoScore(tweet);
            if (score > 0) {
              allNewTweets.push({ ...tweet, _score: score });
              found++;
            }
          }

          // Batch store all timeline tweets in DB
          if (data.timeline.length > 0) {
            await storeTweets(data.timeline, account);
            await updateScanState(account, data.timeline[0].tweet_id);
          }

          console.log(` ${found} new money tweets`);
        } else {
          console.log(' no timeline');
        }
      } catch (err) {
        console.log(` error: ${err.message}`);
        skipped++;
      }
      if (!readCache(`tweets_${account}`)) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    console.log(`\nNew money tweets found: ${allNewTweets.length} (${skipped} accounts failed)`);

    if (allNewTweets.length === 0 && existingCards.length > 0) {
      console.log('No new tweets — returning existing feed\n');
      setMemoryCache(existingCards);
      return existingCards;
    }

    // 2. Score and sort new tweets, take top 50
    allNewTweets.sort((a, b) => b._score - a._score);
    const topNewTweets = allNewTweets.slice(0, 50);
    topNewTweets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 3. Summarize only new tweets
    const summaries = [];
    for (let i = 0; i < topNewTweets.length; i += 10) {
      const batch = topNewTweets.slice(i, i + 10);
      console.log(`  Summarizing batch ${Math.floor(i / 10) + 1}...`);
      const batchSummaries = await summarizeTweets(batch);
      summaries.push(...batchSummaries);
    }

    // 4. Build new feed cards
    const newCards = [];
    for (let i = 0; i < topNewTweets.length; i++) {
      const tweet = topNewTweets[i];
      const summary = summaries[i];
      if (!summary || summary === 'SKIP') continue;

      const author = tweet.author || {};
      newCards.push({
        id: tweet.tweet_id,
        handle: author.screen_name || '',
        name: author.name || '',
        avatar: (author.avatar || '').replace('_normal', '_bigger'),
        summary: summary,
        score: tweet._score,
        likes: tweet.favorites || 0,
        views: parseInt(tweet.views) || 0,
        bookmarks: tweet.bookmarks || 0,
        date: tweet.created_at || '',
      });
    }

    // 5. Merge new cards with existing, deduplicate by ID
    const mergedMap = new Map();
    for (const card of existingCards) mergedMap.set(card.id, card);
    for (const card of newCards) mergedMap.set(card.id, card);
    const mergedFeed = Array.from(mergedMap.values());
    mergedFeed.sort((a, b) => b.score - a.score || new Date(b.date) - new Date(a.date));

    // 6. Store everywhere
    await storeFeedCards(mergedFeed);
    writeCache('feed', mergedFeed);
    setMemoryCache(mergedFeed);
    console.log(`Feed built: ${mergedFeed.length} cards (${newCards.length} new, from ${ACCOUNTS.length} accounts)\n`);
    return mergedFeed;
  } finally {
    feedBuildInProgress = false;
  }
}

// ── Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Health check for Railway
  if (url.pathname === '/health' || url.pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', cards: memoryFeedCache ? memoryFeedCache.cards.length : 0 }));
  }

  if (url.pathname === '/api/feed') {
    // Fast path: serve from memory cache (sub-millisecond)
    if (memoryFeedCache) {
      return sendCachedFeed(req, res);
    }

    // No cache yet — try DB then file
    const dbCards = await getFeedCardsFromDb();
    const fileCards = readCache('feed');
    const cards = dbCards || fileCards;

    if (cards && cards.length > 0) {
      setMemoryCache(cards);
      return sendCachedFeed(req, res);
    }

    // Nothing anywhere — trigger build (first-time only)
    try {
      const feed = await buildFeed();
      return sendJson(req, res, 200, { cards: feed, cached: false, timestamp: Date.now() });
    } catch (err) {
      console.error('Feed error:', err.message);
      return sendJson(req, res, 500, { error: err.message, cards: [], timestamp: Date.now() });
    }
  }

  if (url.pathname === '/api/refresh') {
    sendJson(req, res, 200, {
      cards: memoryFeedCache ? memoryFeedCache.cards : [],
      refreshing: true,
      timestamp: Date.now(),
    });
    // Rebuild in background — don't block response
    buildFeed().catch(err => console.error('Background refresh failed:', err.message));
    return;
  }

  // Serve static files — try memory cache first
  const reqPath = url.pathname === '/' ? '/' : url.pathname;
  const cached = staticCache.get(reqPath);
  if (cached) {
    const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
    res.setHeader('Content-Type', cached.mime);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    if (acceptGzip) {
      res.setHeader('Content-Encoding', 'gzip');
      res.writeHead(200);
      return res.end(cached.gzipped);
    }
    res.writeHead(200);
    return res.end(cached.content);
  }

  // Fallback: read from disk
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'text/plain',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(content);
  });
});

// ── Start ───────────────────────────────────────────────────
async function start() {
  await initDb();
  preloadStatic();

  // Warm memory cache from DB/file before accepting traffic
  const dbCards = await getFeedCardsFromDb();
  const fileCards = readCache('feed');
  if (dbCards && dbCards.length > 0) {
    setMemoryCache(dbCards);
    console.log(`Memory cache warmed from DB: ${dbCards.length} cards`);
  } else if (fileCards && fileCards.length > 0) {
    setMemoryCache(fileCards);
    console.log(`Memory cache warmed from file: ${fileCards.length} cards`);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WhileYouWereSleeping.lol running at http://localhost:${PORT}`);
    console.log(`Tracking ${ACCOUNTS.length} accounts\n`);
    // Build in background — don't delay server start
    buildFeed().catch(err => console.error('Startup feed build failed:', err.message));
  });
}

start();
