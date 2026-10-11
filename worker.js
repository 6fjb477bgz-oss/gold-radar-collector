// Gold Radar: frozen experimental model. Virtual tests only.
const thresholds = { speed: 1.2313913373731582, acceleration: 1.2555409672986888, volatilityRatio: 1.0746235240415634 };
const MODEL = 'v3-live-level-rejection-frozen-july-2026';
function analyseBehaviour(points, now) {
    const bins = new Map();
    for (const q of [...points].sort((a, b) => a.ts - b.ts)) {
        const t = Math.floor(q.ts / 10000) * 10000;
        if (t + 10000 > now)
            continue;
        const b = bins.get(t);
        if (b) {
            b.c = q.price;
            b.h = Math.max(b.h, q.price);
            b.l = Math.min(b.l, q.price);
        }
        else
            bins.set(t, { t, c: q.price, h: q.price, l: q.price });
    }
    const b = [...bins.values()];
    let continuous = 0;
    for (let j = b.length - 1; j >= 0; j--) {
        if (j < b.length - 1 && b[j + 1].t - b[j].t !== 10000)
            break;
        continuous++;
    }
    if (continuous < 301 || !b.length || now - (b.at(-1).t + 10000) > 10000)
        return { ready: false, candidate: 0, features: null, reason: `Données insuffisantes ou interrompues : ${(continuous / 6).toFixed(1)} minutes continues sur les 50 minutes nécessaires.` };
    const i = b.length - 1, c = b[i].c, speed = c - b[i - 3].c, oldSpeed = b[i - 3].c - b[i - 6].c, accel = speed - oldSpeed;
    let sum = 0;
    for (let j = i - 32; j < i - 2; j++)
        sum += (b[j].c - b[j - 1].c) ** 2;
    const scale = Math.sqrt(sum / 30) || 1e-9;
    let shortSum = 0;
    for (let j = i - 5; j <= i; j++)
        shortSum += (b[j].c - b[j - 1].c) ** 2;
    const minuteMap = new Map();
    for (const z of b) {
        const m = Math.floor(z.t / 60000);
        if ((m + 1) * 60000 > now)
            continue;
        const v = minuteMap.get(m);
        if (v) {
            v.h = Math.max(v.h, z.h);
            v.l = Math.min(v.l, z.l);
            v.c = z.c;
        }
        else
            minuteMap.set(m, { h: z.h, l: z.l, c: z.c });
    }
    const m = [...minuteMap.values()];
    let ema20 = m[0].c, ema50 = m[0].c;
    const ranges = [];
    for (let j = 0; j < m.length; j++) {
        const z = m[j], prev = j ? m[j - 1].c : z.c;
        ema20 += 2 / 21 * (z.c - ema20);
        ema50 += 2 / 51 * (z.c - ema50);
        ranges.push(Math.max(z.h - z.l, Math.abs(z.h - prev), Math.abs(z.l - prev)));
    }
    const atr = ranges.slice(-14).reduce((a, x) => a + x, 0) / 14;
    const prev = m.slice(-21, -1), high = Math.max(...prev.map(x => x.h)), low = Math.min(...prev.map(x => x.l));
    const zAccel = Math.abs(accel) / (scale * Math.sqrt(6));
    const hour = new Date(now).getUTCHours();
    const valid = hour >= 7 && hour < 20 && zAccel >= thresholds.acceleration && speed * oldSpeed < 0;
    const candidate = valid ? (speed > 0 && c <= low + atr * .25 ? 1 : speed < 0 && c >= high - atr * .25 ? -1 : 0) : 0;
    return { ready: true, candidate, features: { speed, oldSpeed, accel, zSpeed: Math.abs(speed) / (scale * Math.sqrt(3)), zAccel, volRatio: Math.sqrt(shortSum / 6) / scale, ema20, ema50, atr, high, low, availableThrough: b.at(-1).t + 10000, model: MODEL }, reason: 'Réaction à un niveau et changement de vitesse, règle expérimentale non validée' };
}

const MAX_SOURCE_AGE_SECONDS = 3;
function decide(q, a, sourceError = null, engineError = null) {
    if (sourceError || !q)
        return { state: 'source_error', decision: 'ATTENDRE', side: 0, reason: 'Collecte interrompue : aucun nouveau signal évalué.' };
    if (q.age > MAX_SOURCE_AGE_SECONDS)
        return { state: 'stale', decision: 'ATTENDRE', side: 0, reason: `Cotation reçue âgée de ${q.age.toFixed(1)} s : le filtre historique exige au plus 3 s.` };
    if (engineError)
        return { state: 'engine_error', decision: 'ATTENDRE', side: 0, reason: 'Prix disponible, mais analyse temporairement indisponible.' };
    if (!a?.ready || !a.features)
        return { state: 'insufficient', decision: 'ATTENDRE', side: 0, reason: a?.reason || 'Données insuffisantes pour analyser les cinq prochaines minutes.' };
    const f = a.features, spread = q.ask !== null && q.bid !== null ? q.ask - q.bid : null;
    if (spread === null || f.atr <= 0)
        return { state: 'insufficient', decision: 'ATTENDRE', side: 0, reason: 'Bid/ask ou volatilité mesurée indisponibles.' };
    if (spread > f.atr * .2)
        return { state: 'spread', decision: 'ATTENDRE', side: 0, reason: `Prix disponible ; spread ${spread.toFixed(2)} $ trop élevé par rapport à la volatilité mesurée.` };
    const hour = new Date(q.ts).getUTCHours();
    if (hour < 7 || hour >= 20)
        return { state: 'session', decision: 'ATTENDRE', side: 0, reason: 'Données disponibles ; hors de la session historique étudiée, de 07 h à 20 h UTC.' };
    if (!a.candidate)
        return { state: 'no_signal', decision: 'ATTENDRE', side: 0, reason: 'Données disponibles ; les critères historiques de réaction à un niveau et de changement de vitesse ne sont pas réunis.' };
    const direction = a.candidate === 1 ? 'haussière' : 'baissière', level = a.candidate === 1 ? 'support' : 'résistance';
    return { state: 'potential', decision: a.candidate === 1 ? 'ACHAT POTENTIEL' : 'VENTE POTENTIELLE', side: a.candidate, reason: `Réaction au ${level} ${Number(a.candidate === 1 ? f.low : f.high).toFixed(2)} $, accélération ${direction} ; tendance ${f.ema20 >= f.ema50 ? 'haussière' : 'baissière'}, volatilité ×${f.volRatio.toFixed(2)}, spread ${spread.toFixed(2)} $ accepté.` };
}

const FEED='SwissquoteLtd/Live5/premium';
const SOURCE_URL='https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD';
// Idempotent installation in the external collector's existing D1 database.
// No existing market_samples record is modified or deleted.
async function install(db){
 await db.batch([
 db.prepare(`CREATE TABLE IF NOT EXISTS radar_trials (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, source_ts INTEGER NOT NULL, expires INTEGER NOT NULL, side INTEGER NOT NULL, entry REAL NOT NULL, entry_bid REAL NOT NULL, entry_ask REAL NOT NULL, features TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, exit REAL, exit_ts INTEGER, pnl REAL)`),
 db.prepare(`CREATE TABLE IF NOT EXISTS radar_state (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL, model TEXT NOT NULL)`),
 db.prepare(`CREATE TABLE IF NOT EXISTS radar_lock (id TEXT PRIMARY KEY, until_ms INTEGER NOT NULL)`),
 db.prepare(`CREATE INDEX IF NOT EXISTS radar_sample_received ON market_samples(received_ms)`),
 db.prepare(`CREATE INDEX IF NOT EXISTS radar_trial_status ON radar_trials(status,expires)`)]);
}
async function settleTrials(db,now){
 const usable="s.source=radar_trials.source AND s.status='fresh' AND s.received_ms>=s.source_ms-1000 AND s.received_ms-s.source_ms<=3000 AND s.received_ms BETWEEN radar_trials.expires AND radar_trials.expires+5000";
 const exit=`SELECT CASE WHEN radar_trials.side=1 THEN s.bid-0.10 ELSE s.ask+0.10 END FROM market_samples s WHERE ${usable} ORDER BY s.received_ms,s.id LIMIT 1`;
 const time=`SELECT s.received_ms FROM market_samples s WHERE ${usable} ORDER BY s.received_ms,s.id LIMIT 1`;
 await db.batch([
 db.prepare(`UPDATE radar_trials SET status='closed',exit=(${exit}),exit_ts=(${time}) WHERE status='open' AND expires<=? AND (${exit}) IS NOT NULL`).bind(now),
 db.prepare("UPDATE radar_trials SET pnl=side*(exit-entry)-0.10 WHERE status='closed' AND pnl IS NULL"),
 db.prepare("UPDATE radar_trials SET status='missing' WHERE status='open' AND expires<?").bind(now-5000)]);
}
async function evaluate(db,s,clock=Date.now()){
 await settleTrials(db,clock);
 let a=null,d;
 // Delayed work is never emitted as a live signal. Frozen history is only a warm-up.
 const live=s.status==='fresh'&&clock-s.received_ms>=0&&clock-s.received_ms<=3000&&clock-s.source_ms>=-1000&&clock-s.source_ms<=3000;
 if(!live){d={state:s.status==='error'?'source_error':'stale',reason:'Cotation absente, ancienne ou évaluation retardée : aucun signal.'};}
 else {
 const history=await db.prepare(`SELECT source_ms AS ts,(bid+ask)/2 AS price,bid,ask FROM market_samples WHERE source=? AND status='fresh' AND source_ms<=? AND received_ms<=? AND received_ms>=source_ms-1000 AND received_ms-source_ms<=3000 AND source_ms>=? ORDER BY source_ms,id`).bind(FEED,s.source_ms,s.received_ms,s.source_ms-3600000).all();
 a=analyseBehaviour(history.results,s.source_ms);
 const q={ts:s.source_ms,received:s.received_ms,price:(s.bid+s.ask)/2,bid:s.bid,ask:s.ask,age:(clock-s.source_ms)/1000,source:FEED};
 d=decide(q,a);
 if(d.side&&a.features){
 const id=MODEL+'-'+FEED+'-'+a.features.availableThrough;
 const features={...a.features,origin:'live_emitted',costModel:'observed-spread+0.20-slippage+0.10-commission-per-oz',reason:d.reason,spread:s.ask-s.bid,evaluatedAt:clock};
 await db.prepare(`INSERT OR IGNORE INTO radar_trials (id,ts,source_ts,expires,side,entry,entry_bid,entry_ask,features,model,source,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,clock,s.source_ms,clock+300000,d.side,d.side===1?s.ask+.1:s.bid-.1,s.bid,s.ask,JSON.stringify(features),MODEL,FEED,'open').run();
 }
 }
 await db.prepare('INSERT INTO radar_state(id,ts,state,reason,model) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts,state=excluded.state,reason=excluded.reason,model=excluded.model').bind('engine',clock,d.state,d.reason,MODEL).run();
 return d;
}
async function collectOne(env){
 const started=Date.now();let s={received_ms:started,source_ms:null,bid:null,ask:null,source:FEED,status:'error',latency_ms:0,error:null};
 try{
 const r=await fetch(SOURCE_URL,{signal:AbortSignal.timeout(8000),redirect:'manual'});
 if(!r.ok)throw new Error('HTTP '+r.status);
 const data=await r.json();s.received_ms=Date.now();
 const row=data.find(x=>x.topo?.platform==='SwissquoteLtd'&&x.topo?.server==='Live5');
 const price=row?.spreadProfilePrices?.find(x=>x.spreadProfile==='premium');
 if(!price||!Number.isSafeInteger(row.ts)||!Number.isFinite(price.bid)||!Number.isFinite(price.ask)||price.bid<=0||price.ask<price.bid)throw new Error('Cours invalide');
 s.source_ms=row.ts;s.bid=price.bid;s.ask=price.ask;
 const age=s.received_ms-s.source_ms;s.status=age>=-1000&&age<=3000?'fresh':'stale';
 }catch(e){s.received_ms=Date.now();s.error=String(e.message||e).slice(0,250);}
 s.latency_ms=s.received_ms-started;
 await env.DB.prepare('INSERT INTO market_samples(received_ms,source_ms,bid,ask,source,status,latency_ms,error) VALUES (?,?,?,?,?,?,?,?)').bind(s.received_ms,s.source_ms,s.bid,s.ask,FEED,s.status,s.latency_ms,s.error).run();
 try{await evaluate(env.DB,s);}catch{
 await env.DB.prepare('INSERT INTO radar_state(id,ts,state,reason,model) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts,state=excluded.state,reason=excluded.reason,model=excluded.model').bind('engine',Date.now(),'engine_error','Analyse indisponible ; relevé conservé.',MODEL).run();
 }
 return s;
}
export default {
 async scheduled(event,env,ctx){ctx.waitUntil((async()=>{
 await install(env.DB);
 const start=Date.now();const lock=await env.DB.prepare('INSERT INTO radar_lock(id,until_ms) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET until_ms=excluded.until_ms WHERE radar_lock.until_ms<=? RETURNING until_ms').bind('cron',start+70000,start).first();
 if(!lock)return;
 try{
 for(let i=0;i<6;i++){
 const due=start+i*10000,delay=due-Date.now();
 if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
 if(Date.now()-due>3000)continue;
 await collectOne(env);
 }
 }finally{await env.DB.prepare('UPDATE radar_lock SET until_ms=0 WHERE id=? AND until_ms=?').bind('cron',start+70000).run();}
 })());},
 async fetch(request,env){
 const url=new globalThis.URL(request.url),headers={'Cache-Control':'no-store'};
 if(request.method!=='GET')return new Response('Méthode non autorisée',{status:405,headers});
 const protectedRoute=['/samples','/trials','/engine'].includes(url.pathname);
 if(protectedRoute&&(!env.EXPORT_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.EXPORT_TOKEN}`))return new Response('Accès refusé',{status:401,headers});
 if(url.pathname==='/samples'){
 const after=Number(url.searchParams.get('after')||'0');
 if(!Number.isSafeInteger(after)||after<0)return new Response('Paramètre invalide',{status:400,headers});
 const r=await env.DB.prepare('SELECT id,received_ms,source_ms,bid,ask,source,status,latency_ms,error FROM market_samples WHERE id>? ORDER BY id ASC LIMIT 500').bind(after).all();
 const samples=r.results||[];return Response.json({samples,next:samples.length?samples.at(-1).id:after},{headers});
 }
 if(url.pathname==='/engine'){
 try{return Response.json({engine:await env.DB.prepare("SELECT ts,state,reason,model FROM radar_state WHERE id='engine'").first(),stats:(await env.DB.prepare('SELECT status,COUNT(*) AS count,SUM(pnl) AS pnl_per_oz FROM radar_trials GROUP BY status').all()).results},{headers});}
 catch{return Response.json({engine:null,state:'installation_pending'},{headers});}
 }
 if(url.pathname==='/trials'){
 const after=Number(url.searchParams.get('after')||'0');
 if(!Number.isSafeInteger(after)||after<0)return new Response('Paramètre invalide',{status:400,headers});
 try{const trials=(await env.DB.prepare('SELECT * FROM radar_trials WHERE ts>=? ORDER BY ts,id LIMIT 500').bind(after).all()).results;return Response.json({trials},{headers});}catch{return Response.json({trials:[],state:'installation_pending'},{headers});}
 }
 const latest=await env.DB.prepare('SELECT received_ms,status FROM market_samples ORDER BY id DESC LIMIT 1').first();
 return Response.json({collector:'Gold Radar',version:'cloud-engine-v1',latest:latest||null},{headers});
 }
};
export {install,evaluate,settleTrials,collectOne};

    


      

