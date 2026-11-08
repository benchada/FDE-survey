/**
 * FDE Field Readiness — Cloudflare Worker
 * GET  /                  the quiz page
 * POST /api/submit        saves the participant to D1 and emails their debrief (Cloudflare Email Service)
 * GET  /admin/export.csv  every response as CSV (needs ?key=ADMIN_KEY; disabled if ADMIN_KEY isn't set)
 *
 * Bindings (see wrangler.jsonc): DB (D1), EMAIL (send_email)
 * Variables: WORKSHOP_NAME, FROM_EMAIL, SENDER_NAME, REPLY_TO, FACILITATOR_BCC
 * Secret (optional): ADMIN_KEY
 */

let CONFIG = {};
const MAX_SENDS_PER_EMAIL_PER_HOUR = 3;
const MAX_SUBMISSIONS_PER_HOUR = 500;

const KIT = { url: 'https://book.stripe.com/fZufZgbwN9rC0Qm3Ba9sk00' };
const MASTERCLASS = { url: 'https://luma.com/y4ueno3d' };

// ---------- Quiz content (single source of truth for the page and the email) ----------
const ORDER = ['code', 'ai', 'data', 'discovery', 'client', 'ownership'];

const DIMS = {
  code: { name: 'Hands-on engineering', short: 'Engineering', desc: 'Write, debug and deploy real code', badge: 'Root-Cause Hunter',
    plan: ['Build and deploy one small full-stack app end to end: API, database, simple UI, live on a cloud service.',
           'Practice debugging code you didn\'t write: pick an open-source repo and fix one real issue.',
           'Get fluent in one language (Python or TypeScript) plus Git, Docker and one cloud console.'] },
  ai: { name: 'AI systems', short: 'AI systems', desc: 'LLMs, retrieval, agents, evals', badge: 'Eval Builder',
    plan: ['Build a retrieval (RAG) app over a real document set and write a 30-question test set to score it.',
           'Build one agent with tool use on a major LLM API; log every failure and group them by cause.',
           'Learn the trade-offs: cost, latency, guardrails, human fallback, and when not to use an LLM at all.'] },
  data: { name: 'Data & integration', short: 'Data', desc: 'APIs, SQL, messy enterprise data', badge: 'Pipe Fitter',
    plan: ['In one script, pull from three source types (a REST API with auth, a SQL database, an Excel file) and join them.',
           'Sharpen SQL: joins, window functions, deduplication and null handling.',
           'Write down every data assumption and confirm it with whoever owns the data.'] },
  discovery: { name: 'Discovery & scoping', short: 'Discovery', desc: 'Turn vague asks into solvable problems', badge: 'Problem Finder',
    plan: ['Shadow one end user for half a day and map their workflow before proposing any solution.',
           'Write three one-page problem statements: who, pain, metric, constraint, first version.',
           'Practice reframing scope: present evidence, options and trade-offs to a sponsor.'] },
  client: { name: 'Client presence', short: 'Client', desc: 'Explain, demo, handle pressure', badge: 'Trusted Voice',
    plan: ['Explain one technical limitation to a non-technical person in 3 minutes and ask what they\'d do next.',
           'Run a mock demo where a colleague plays a skeptical, impatient client.',
           'Practice turning a complaint into a reproducible case: acknowledge, ask for the exact example, agree a next step.'] },
  ownership: { name: 'Field ownership', short: 'Ownership', desc: 'Ambiguity, autonomy, pace, travel', badge: 'Self-Starter',
    plan: ['Take one goal with no spec to a shipped first version within two weeks.',
           'Set your own success metric and send a short weekly update, even if nobody asks.',
           'Be clear about your travel and on-site limits now, so you choose roles that fit.'] }
};

const QUESTIONS = [
  { d: 'code', p: 'The client demo is in 3 hours. A Python service you didn\'t write is crashing in their environment. What do you do?',
    o: [['Reschedule the demo and escalate to the product team', 0], ['Switch to slides and a recorded video', 1], ['Add a guard so the demo survives, open a ticket for later', 2], ['Reproduce it from the logs, fix the root cause, demo, then send product a short write-up', 3]],
    n: 'FDEs own the outcome in the field. Fix it, then feed what you learned back to the core product team.' },
  { d: 'code', self: true, p: 'How comfortable are you building and deploying a small full-stack app (API + UI + database) on your own?',
    o: [['I haven\'t done this', 0], ['I could with tutorials and help', 1], ['I\'ve done it a few times', 2], ['I do it regularly, including cloud deployment', 3]],
    n: 'Most FDE interviews include a live build or debugging round. You need to ship without a team behind you.' },
  { d: 'ai', p: 'A client wants a chatbot that answers questions from 4,000 internal PDF manuals. What\'s your first technical move?',
    o: [['Paste the PDFs into the prompt', 0], ['Fine-tune a model on all the PDFs', 1], ['Buy an off-the-shelf chatbot product', 1], ['Build retrieval over chunked documents and a test set of 30 real questions to measure it', 3]],
    n: 'Retrieval plus an evaluation set is the standard starting point. Without a test set, you can\'t prove it works.' },
  { d: 'ai', p: 'Your LLM agent works 80% of the time in testing. The client wants it live next week.',
    o: [['Ship it; 80% is good enough', 0], ['Tweak the prompt until it feels better', 1], ['Launch narrowly with a human reviewing every output', 2], ['Build evals, group the failures by cause, add guardrails and a human fallback for the rest', 3]],
    n: 'Knowing why the 20% fails is the job. Evals and failure analysis separate a demo from a production system.' },
  { d: 'data', p: 'Day 1: the client\'s data sits in SAP, three Excel files and an old SQL Server. You need a joined view by Friday.',
    o: [['Ask IT to build a data warehouse first', 0], ['Copy it all into one spreadsheet by hand', 1], ['Use only the SQL data and skip the rest', 1], ['Script each pull, clean and join, and confirm assumptions with the data owner', 3]],
    n: 'Real client data is messy and spread out. FDEs connect to what exists instead of waiting for ideal infrastructure.' },
  { d: 'data', self: true, p: 'How comfortable are you with APIs, authentication (OAuth, keys), SQL and messy data formats?',
    o: [['Mostly new to me', 0], ['I know the concepts but rarely do it', 1], ['I handle most of it with some searching', 2], ['Daily work for me', 3]],
    n: 'Integration is where most field time goes. Getting access and cleaning data often takes longer than the AI part.' },
  { d: 'discovery', p: 'A VP says: "We need AI for our maintenance team." Your next move?',
    o: [['Propose a predictive-maintenance model right away', 1], ['Ask for the budget and timeline', 1], ['Send a list of AI use cases to pick from', 1], ['Spend time with technicians, map where hours are lost, then pick one measurable problem', 3]],
    n: 'The request is rarely the problem. Go to the people doing the work before choosing a solution.' },
  { d: 'discovery', p: 'Mid-project, you realize what the client asked for won\'t fix their real problem.',
    o: [['Build what they asked; it\'s in the contract', 0], ['Mention it in the final report', 0], ['Quietly build what you think is right', 1], ['Bring evidence to the sponsor, propose a new scope with trade-offs, agree before changing course', 3]],
    n: 'FDEs push back with evidence and get agreement. Silent pivots break trust; silent compliance wastes the project.' },
  { d: 'client', self: true, p: 'You have 5 minutes to explain a model\'s limitations to a non-technical COO. How would it go?',
    o: [['I\'d struggle to make it clear', 0], ['I\'d get through it, but lean on jargon', 1], ['Clear, with a good example', 2], ['I do this often and people make decisions from it', 3]],
    n: 'You are the product\'s voice in the room. Clear limits build more trust than big promises.' },
  { d: 'client', p: 'In front of his manager, a frustrated client engineer says your solution "doesn\'t work."',
    o: [['Defend the solution with technical detail', 0], ['Escalate to your own manager', 0], ['Apologize and promise a fix by tomorrow', 1], ['Acknowledge it, ask for the exact case, debug together or set a concrete follow-up', 3]],
    n: 'Turn a complaint into a reproducible case. Calm, specific follow-through wins over the skeptic in the room.' },
  { d: 'ownership', p: 'No spec, no PM, just a goal: "cut invoice processing time." How do you react?',
    o: [['Uncomfortable; I need clear requirements', 0], ['Fine if someone checks in with me daily', 1], ['Fine; I\'d write my own plan and share it', 2], ['I\'d define a success metric, ship a first version in a week and iterate with users', 3]],
    n: 'Ambiguity is the default in the field. FDEs create their own structure and show progress early.' },
  { d: 'ownership', self: true, p: 'How ready are you for the field rhythm: travel, on-site weeks, switching clients and context?',
    o: [['Not possible for me right now', 0], ['Occasionally', 1], ['Yes, with some limits', 2], ['Fully ready', 3]],
    n: 'Many FDE roles involve real travel and on-site time. Knowing your limits helps you pick the right role.' }
];

const LEVELS = [
  { min: 0,  name: 'Recruit',          text: 'The foundations aren\'t there yet. Pick your two weakest areas and build one real project for each.' },
  { min: 41, name: 'Field Apprentice', text: 'You have parts of the profile. Close the gaps below and you\'ll be ready for a junior FDE or solutions role.' },
  { min: 61, name: 'Deployable',       text: 'You could start in an FDE role now. Tighten the remaining gaps to stand out in interviews.' },
  { min: 81, name: 'Lead FDE',         text: 'Strong across the board. You\'re ready to deploy, and probably to lead a field team.' }
];

// ---------- Scoring ----------
function score_(answers) {
  if (!Array.isArray(answers) || answers.length !== QUESTIONS.length) throw new Error('Please answer all the situations first.');
  const scores = {};
  ORDER.forEach(function (d) { scores[d] = 0; });
  const clean = answers.map(function (a, i) {
    const k = Number(a);
    if (!(k >= 0 && k < QUESTIONS[i].o.length && Math.floor(k) === k)) throw new Error('Something went wrong with your answers. Please retake the quiz.');
    scores[QUESTIONS[i].d] += QUESTIONS[i].o[k][1];
    return k;
  });
  const total = ORDER.reduce(function (s, d) { return s + scores[d]; }, 0);
  const max = QUESTIONS.length * 3;
  const pct = Math.round(total / max * 100);
  const level = LEVELS.slice().reverse().filter(function (l) { return pct >= l.min; })[0];
  const gaps = ORDER.filter(function (d) { return scores[d] <= 4; }).sort(function (a, b) { return scores[a] - scores[b]; });
  const badges = ORDER.filter(function (d) { return scores[d] === 6; }).map(function (d) { return DIMS[d].badge; });
  return { scores: scores, pct: pct, level: level, xp: total * 10, gaps: gaps, badges: badges, answers: clean };
}

function status_(s) { return s >= 5 ? 'Strong' : s >= 3 ? 'Developing' : 'Gap'; }

// ---------- Email ----------
function buildEmail_(name, r) {
  const ink = '#13201B', muted = '#5A6B64', line = '#D3DDD8', accent = '#0E6E60', gold = '#B87A0B';
  const colors = { Strong: '#1D7A43', Developing: '#A86A00', Gap: '#B03A2E' };
  const esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const first = name.split(' ')[0];

  const rows = ORDER.map(function (d) {
    const s = r.scores[d], st = status_(s), w = Math.round(s / 6 * 100);
    return '<tr><td style="padding:8px 0 2px;font-size:14px;color:' + ink + '">' + esc(DIMS[d].name) + '</td>' +
      '<td align="right" style="padding:8px 0 2px;font-size:12px;font-weight:600;color:' + colors[st] + ';font-family:Menlo,monospace">' + st.toUpperCase() + ' · ' + s + '/6</td></tr>' +
      '<tr><td colspan="2" style="padding:0 0 6px"><div style="background:' + line + ';height:8px;border-radius:4px"><div style="width:' + w + '%;background:' + colors[st] + ';height:8px;border-radius:4px"></div></div></td></tr>';
  }).join('');

  const gapsHtml = r.gaps.length ? r.gaps.map(function (d) {
    return '<div style="border:1px solid ' + line + ';border-radius:10px;padding:14px 16px;margin:0 0 12px">' +
      '<div style="font-weight:700;font-size:15px;color:' + ink + ';margin:0 0 6px">' + esc(DIMS[d].name) + ' <span style="font-weight:600;font-size:12px;color:' + colors[status_(r.scores[d])] + '">(' + r.scores[d] + '/6)</span></div>' +
      '<ol style="margin:0;padding-left:20px;color:' + ink + ';font-size:14px;line-height:1.5">' +
      DIMS[d].plan.map(function (p) { return '<li style="margin:0 0 4px">' + esc(p) + '</li>'; }).join('') + '</ol></div>';
  }).join('') : '<p style="color:' + muted + ';font-size:14px">Every area scored strong. Your next step is evidence: two or three client-style builds you can walk through in an interview.</p>';

  const badgesHtml = r.badges.length ? '<p style="margin:16px 0 0;font-size:14px;color:' + ink + '"><b>Badges earned:</b> ' + r.badges.map(esc).join(', ') + '</p>' : '';

  const html =
    '<div style="background:#EEF2F0;padding:24px 12px;font-family:Helvetica,Arial,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ' + line + ';border-radius:14px;padding:28px">' +
    '<div style="font-family:Menlo,monospace;font-size:11px;letter-spacing:2px;color:' + accent + ';font-weight:600">FDE FIELD READINESS · ' + esc(CONFIG.WORKSHOP_NAME).toUpperCase() + '</div>' +
    '<h1 style="font-size:24px;line-height:1.2;color:' + ink + ';margin:10px 0 6px">' + esc(first) + ', you\'re rated ' + esc(r.level.name) + '</h1>' +
    '<p style="margin:0 0 4px;font-size:15px;color:' + ink + '"><b style="color:' + gold + '">' + r.pct + '% readiness</b> · ' + r.xp + ' XP</p>' +
    '<p style="margin:0 0 20px;font-size:14px;color:' + muted + ';line-height:1.5">' + esc(r.level.text) + '</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' + rows + '</table>' +
    badgesHtml +
    '<h2 style="font-size:18px;color:' + ink + ';margin:28px 0 12px">Your 30-day plan</h2>' + gapsHtml +
    '<div style="border:1.5px solid ' + gold + ';background:#F6E9CC;border-radius:10px;padding:16px 18px 4px;margin:24px 0 0">' +
    '<div style="font-family:Menlo,monospace;font-size:11px;letter-spacing:2px;color:' + gold + ';font-weight:600;margin:0 0 6px">CLOSE YOUR GAPS FASTER</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
    '<tr><td style="padding:12px 0;border-top:1px solid ' + line + '">' +
    '<div style="font-family:Menlo,monospace;font-size:11px;letter-spacing:1px;color:' + muted + ';font-weight:600">SELF-PACED</div>' +
    '<div style="font-weight:700;font-size:16px;color:' + ink + ';margin:4px 0">FDE Self-Learning Kit</div>' +
    '<div style="font-size:14px;color:' + ink + ';line-height:1.5;margin:0 0 10px">Work through the gaps in your plan at your own pace.</div>' +
    '<a href="' + KIT.url + '" style="display:inline-block;background:' + accent + ';color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">Get the kit</a></td></tr>' +
    '<tr><td style="padding:12px 0;border-top:1px solid ' + line + '">' +
    '<div style="font-family:Menlo,monospace;font-size:11px;letter-spacing:1px;color:' + muted + ';font-weight:600">LIVE MASTERCLASS</div>' +
    '<div style="font-weight:700;font-size:16px;color:' + ink + ';margin:4px 0">Claude Certification Masterclass</div>' +
    '<div style="font-size:14px;color:' + ink + ';line-height:1.5;margin:0 0 10px">Two-track prep for the Claude Associate and Developer certifications, by ENTROGX Academy on the sidelines of AI Everything.</div>' +
    '<a href="' + MASTERCLASS.url + '" style="display:inline-block;border:1px solid ' + accent + ';color:' + accent + ';text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">Register on Luma</a></td></tr>' +
    '</table></div>' +
    '<p style="font-size:12px;color:' + muted + ';margin:20px 0 0;line-height:1.5">You received this because you took the FDE Field Readiness check at ' + esc(CONFIG.WORKSHOP_NAME) + ' and asked for your results by email.</p>' +
    '</div></div>';

  const text = 'FDE Field Readiness — ' + CONFIG.WORKSHOP_NAME + '\n\n' +
    first + ', you\'re rated ' + r.level.name + ' (' + r.pct + '%, ' + r.xp + ' XP)\n' + r.level.text + '\n\n' +
    ORDER.map(function (d) { return DIMS[d].name + ': ' + r.scores[d] + '/6 (' + status_(r.scores[d]) + ')'; }).join('\n') +
    '\n\nYour 30-day plan\n' +
    (r.gaps.length ? r.gaps.map(function (d) { return '\n' + DIMS[d].name + '\n' + DIMS[d].plan.map(function (p, i) { return (i + 1) + '. ' + p; }).join('\n'); }).join('\n') : 'No major gaps.') +
    '\n\nFDE Self-Learning Kit: ' + KIT.url +
    '\nClaude Certification Masterclass (ENTROGX Academy): ' + MASTERCLASS.url;

  return { subject: 'Your FDE readiness debrief: ' + r.level.name + ' (' + r.pct + '%)', html: html, text: text };
}

const PAGE = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>FDE Field Readiness</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap\">\n<style>\n/* Layout: single mission column; status bar (XP + stage track), one scenario card at a time, debrief with radar + gap plan */\n:root{\n  --bg:#EEF2F0; --surface:#FFFFFF; --ink:#13201B; --muted:#5A6B64; --line:#D3DDD8;\n  --accent:#0E6E60; --accent-soft:#DCEDE8; --xp:#B87A0B; --xp-soft:#F6E9CC;\n  --good:#1D7A43; --warn:#A86A00; --bad:#B03A2E;\n  --f-display:\"Bricolage Grotesque\", \"Segoe UI\", system-ui, sans-serif;\n  --f-body:\"IBM Plex Sans\", system-ui, -apple-system, sans-serif;\n  --f-mono:\"IBM Plex Mono\", ui-monospace, Menlo, monospace;\n  color-scheme:light;\n}\n@media (prefers-color-scheme: dark){:root{\n  --bg:#0F1714; --surface:#17221E; --ink:#E6EEEA; --muted:#93A59D; --line:#2A3832;\n  --accent:#4CC2AE; --accent-soft:#1B3631; --xp:#E8B44E; --xp-soft:#3A2F17;\n  --good:#5BC98A; --warn:#E3A640; --bad:#EE7B6E; color-scheme:dark;}}\n*{box-sizing:border-box}\nhtml,body{margin:0}\nbody{background:var(--bg);color:var(--ink);font-family:var(--f-body);font-size:16px;line-height:1.55;\n  padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px));padding-block:24px 48px}\n.wrap{max-width:680px;margin:0 auto;display:flex;flex-direction:column;gap:20px}\nh1,h2,h3{font-family:var(--f-display);text-wrap:balance;margin:0;line-height:1.15}\nh1{font-size:clamp(2rem,6vw,2.9rem);font-weight:800;letter-spacing:-.02em}\nh2{font-size:1.45rem;font-weight:700}\nh3{font-size:1.1rem;font-weight:700}\np{margin:0}\n[hidden]{display:none!important}\n.eyebrow{font-family:var(--f-mono);font-size:.74rem;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:600}\n.muted{color:var(--muted)}\n.mono{font-family:var(--f-mono);font-variant-numeric:tabular-nums}\n\n.status{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}\n.brand{font-family:var(--f-mono);font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}\n.xp{display:flex;align-items:center;gap:8px;background:var(--xp-soft);color:var(--xp);font-family:var(--f-mono);font-weight:600;\n  padding:6px 12px;border-radius:999px;font-size:.88rem;font-variant-numeric:tabular-nums}\n.xp-pop{animation:pop .5s ease}\n@keyframes pop{0%{transform:scale(1)}40%{transform:scale(1.15)}100%{transform:scale(1)}}\n.track{display:grid;grid-template-columns:repeat(12,1fr);gap:4px}\n.track span{height:6px;border-radius:2px;background:var(--line)}\n.track span.done{background:var(--accent)}\n.track span.now{background:var(--xp)}\n\n.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:clamp(20px,4vw,32px);display:flex;flex-direction:column;gap:18px}\n\n.dims{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}\n.dims li{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;min-width:0}\n.dims b{font-weight:600}\n.dims small{color:var(--muted);font-size:.84rem;line-height:1.4}\n@media (max-width:460px){.dims{grid-template-columns:1fr}}\n.meta{display:flex;gap:18px;flex-wrap:wrap;font-family:var(--f-mono);font-size:.82rem;color:var(--muted)}\n\nform.contact{display:flex;flex-direction:column;gap:14px;border-top:1px solid var(--line);padding-top:18px}\n.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}\n@media (max-width:520px){.grid2{grid-template-columns:1fr}}\nlabel.field{display:flex;flex-direction:column;gap:6px;font-weight:500;min-width:0}\ninput[type=text],input[type=email],input[type=tel]{font:inherit;padding:11px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);width:100%}\ninput[aria-invalid=true]{border-color:var(--bad)}\n.check{display:flex;gap:10px;align-items:flex-start;font-size:.9rem;color:var(--muted);line-height:1.45}\n.check input{margin-top:3px;width:18px;height:18px;accent-color:var(--accent);flex-shrink:0}\n.err{color:var(--bad);font-size:.88rem;font-weight:500}\n\nbutton{font:inherit;cursor:pointer}\n.btn{background:var(--accent);color:var(--surface);border:0;border-radius:10px;padding:13px 22px;font-weight:600;align-self:flex-start}\n.btn:hover{filter:brightness(1.08)}\n.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}\n:focus-visible{outline:3px solid var(--xp);outline-offset:2px}\n\n.qhead{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline}\n.tag{font-family:var(--f-mono);font-size:.74rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:6px;background:var(--accent-soft);color:var(--accent)}\n.prompt{font-size:1.15rem;font-weight:500;line-height:1.45}\n.opts{display:flex;flex-direction:column;gap:10px}\n.opt{display:flex;gap:12px;align-items:flex-start;text-align:left;background:var(--bg);color:var(--ink);border:1.5px solid var(--line);border-radius:10px;padding:13px 14px;transition:border-color .15s, background .15s}\n.opt:hover:not([disabled]){border-color:var(--accent)}\n.opt .key{font-family:var(--f-mono);font-weight:600;font-size:.8rem;min-width:26px;height:26px;display:grid;place-items:center;border-radius:6px;border:1px solid var(--line);color:var(--muted);flex-shrink:0}\n.opt[disabled]{cursor:default}\n.opt.picked{border-color:var(--xp);background:var(--xp-soft)}\n.opt.best{border-color:var(--good)}\n.opt .flag{display:block;font-family:var(--f-mono);font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;margin-top:4px;color:var(--good)}\n.note{border-left:3px solid var(--xp);padding:4px 0 4px 14px;display:flex;flex-direction:column;gap:4px}\n.note .gain{font-family:var(--f-mono);font-weight:600;color:var(--xp)}\n\n.sendbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 14px;border-radius:10px;border:1px solid var(--line);font-size:.92rem}\n.sendbar .dot{width:10px;height:10px;border-radius:50%;background:var(--xp);flex-shrink:0}\n.sendbar.pending .dot{animation:blink 1s infinite}\n.sendbar.ok .dot{background:var(--good)}\n.sendbar.err .dot{background:var(--bad)}\n.sendbar span.msg{flex:1;min-width:0}\n@keyframes blink{50%{opacity:.25}}\n\n.rank{display:flex;gap:18px;align-items:center;flex-wrap:wrap}\n.rank-badge{width:92px;height:92px;border-radius:50%;border:3px solid var(--xp);display:grid;place-items:center;flex-shrink:0;font-family:var(--f-display);font-weight:800;font-size:1.7rem;color:var(--xp);font-variant-numeric:tabular-nums}\n.rank > div{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}\n.chart{display:flex;justify-content:center}\n.chart svg{width:100%;max-width:400px;height:auto}\n.bars{display:flex;flex-direction:column;gap:12px}\n.bar-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center}\n.bar{grid-column:1/-1;height:8px;border-radius:4px;background:var(--line);overflow:hidden}\n.bar i{display:block;height:100%;border-radius:4px}\n.pill{font-family:var(--f-mono);font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:3px 8px;border-radius:6px}\n.pill.s{color:var(--good);border:1px solid var(--good)}\n.pill.d{color:var(--warn);border:1px solid var(--warn)}\n.pill.g{color:var(--bad);border:1px solid var(--bad)}\n.gaps{display:flex;flex-direction:column;gap:16px}\n.gap{border:1px solid var(--line);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px}\n.gap ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}\n.badges{display:flex;flex-wrap:wrap;gap:8px}\n.badges span{font-family:var(--f-mono);font-size:.8rem;font-weight:600;padding:6px 10px;border-radius:8px;background:var(--accent-soft);color:var(--accent)}\n.kit{border:1.5px solid var(--xp);background:var(--xp-soft)}\n.kit .eyebrow{color:var(--xp)}\na.btn{text-decoration:none;display:inline-block}\n.res{display:flex;flex-direction:column;gap:12px}\n.res-item{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:16px;border-radius:10px;background:var(--surface);border:1px solid var(--line)}\n.res-item > div{flex:1;min-width:200px;display:flex;flex-direction:column;gap:4px}\n.res-item .kind{font-family:var(--f-mono);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}\n.res-item p{color:var(--muted);font-size:.92rem;line-height:1.45}\n@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <div class=\"status\">\n    <span class=\"brand\">FDE Field Readiness</span>\n    <span class=\"xp\" id=\"xp\" aria-live=\"polite\">XP <b id=\"xpVal\">0</b> / <span id=\"xpMax\">360</span></span>\n  </div>\n  <div class=\"track\" id=\"track\" aria-hidden=\"true\"></div>\n\n  <section class=\"panel\" id=\"intro\">\n    <span class=\"eyebrow\" id=\"workshopName\">Mission briefing</span>\n    <h1>Are you ready to deploy?</h1>\n    <p>A Forward Deployed Engineer sits with the client, finds the real problem, and ships working software in their environment. This check runs you through 12 field situations and shows where you're strong and what to close before you go.</p>\n    <ul class=\"dims\" id=\"dimList\"></ul>\n    <div class=\"meta\"><span>12 situations</span><span>~6 minutes</span><span>Your full debrief arrives by email</span></div>\n\n    <form class=\"contact\" id=\"contact\" novalidate>\n      <h3>Where should we send your debrief?</h3>\n      <label class=\"field\" for=\"fName\">Full name\n        <input type=\"text\" id=\"fName\" autocomplete=\"name\" maxlength=\"60\" required>\n      </label>\n      <div class=\"grid2\">\n        <label class=\"field\" for=\"fEmail\">Email\n          <input type=\"email\" id=\"fEmail\" autocomplete=\"email\" maxlength=\"120\" required>\n        </label>\n        <label class=\"field\" for=\"fPhone\">Phone\n          <input type=\"tel\" id=\"fPhone\" autocomplete=\"tel\" maxlength=\"30\" placeholder=\"+971 50 123 4567\" required>\n        </label>\n      </div>\n      <label class=\"check\" for=\"fConsent\">\n        <input type=\"checkbox\" id=\"fConsent\" required>\n        <span>I agree that the workshop organizer may store my name, email, phone and results, and email me my debrief.</span>\n      </label>\n      <p class=\"err\" id=\"formErr\" role=\"alert\" hidden></p>\n      <button class=\"btn\" type=\"submit\" id=\"startBtn\">Start mission</button>\n    </form>\n  </section>\n\n  <section class=\"panel\" id=\"quiz\" hidden>\n    <div class=\"qhead\">\n      <span class=\"tag\" id=\"qTag\"></span>\n      <span class=\"mono muted\" id=\"qCount\"></span>\n    </div>\n    <p class=\"prompt\" id=\"qPrompt\"></p>\n    <div class=\"opts\" id=\"qOpts\"></div>\n    <div class=\"note\" id=\"qNote\" hidden>\n      <span class=\"gain\" id=\"qGain\"></span>\n      <p id=\"qNoteText\"></p>\n    </div>\n    <button class=\"btn\" id=\"nextBtn\" hidden>Next situation</button>\n  </section>\n\n  <section class=\"panel\" id=\"results\" hidden>\n    <span class=\"eyebrow\">Debrief</span>\n    <div class=\"sendbar pending\" id=\"sendbar\" aria-live=\"polite\">\n      <span class=\"dot\" aria-hidden=\"true\"></span>\n      <span class=\"msg\" id=\"sendMsg\"></span>\n      <button class=\"btn ghost\" id=\"resendBtn\" hidden>Try again</button>\n    </div>\n    <div class=\"rank\">\n      <div class=\"rank-badge\" id=\"rPct\"></div>\n      <div>\n        <h2 id=\"rLevel\"></h2>\n        <p class=\"muted\" id=\"rLevelText\"></p>\n      </div>\n    </div>\n    <div class=\"chart\" id=\"radar\"></div>\n    <div class=\"bars\" id=\"bars\"></div>\n  </section>\n\n  <section class=\"panel\" id=\"badgePanel\" hidden>\n    <h3>Badges earned</h3>\n    <div class=\"badges\" id=\"badges\"></div>\n  </section>\n\n  <section class=\"panel\" id=\"gapPanel\" hidden>\n    <span class=\"eyebrow\">Your 30-day plan</span>\n    <h2 id=\"gapTitle\">Gaps to close</h2>\n    <div class=\"gaps\" id=\"gaps\"></div>\n    <button class=\"btn ghost\" id=\"retryBtn\">Retake</button>\n  </section>\n  <section class=\"panel kit\" id=\"kitPanel\" hidden>\n    <span class=\"eyebrow\">Close your gaps faster</span>\n    <h2>Keep building toward FDE</h2>\n    <div class=\"res\">\n      <div class=\"res-item\">\n        <div>\n          <span class=\"kind\">Self-paced</span>\n          <h3>FDE Self-Learning Kit</h3>\n          <p>Work through the gaps in your plan at your own pace.</p>\n        </div>\n        <a class=\"btn\" id=\"kitLink\" href=\"https://book.stripe.com/fZufZgbwN9rC0Qm3Ba9sk00\" target=\"_blank\" rel=\"noopener\">Get the kit</a>\n      </div>\n      <div class=\"res-item\">\n        <div>\n          <span class=\"kind\">Live masterclass</span>\n          <h3>Claude Certification Masterclass</h3>\n          <p>Two-track prep for the Claude Associate and Developer certifications, by ENTROGX Academy on the sidelines of AI Everything.</p>\n        </div>\n        <a class=\"btn ghost\" id=\"masterclassLink\" href=\"https://luma.com/y4ueno3d\" target=\"_blank\" rel=\"noopener\">Register on Luma</a>\n      </div>\n    </div>\n  </section>\n</div>\n\n<script>\nconst C = __CONTENT__;\nconst DIMS = C.dims, ORDER = C.order, Q = C.questions, LEVELS = C.levels;\n\nlet i = 0, xp = 0, scores = {}, picks = [], contact = null, sending = false;\nconst $ = id => document.getElementById(id);\n\nif (C.workshop) $(\"workshopName\").textContent = C.workshop;\n$(\"xpMax\").textContent = Q.length * 30;\n$(\"dimList\").innerHTML = ORDER.map(k => `<li><b>${DIMS[k].name}</b><small>${DIMS[k].desc}</small></li>`).join(\"\");\n$(\"track\").innerHTML = Q.map(() => \"<span></span>\").join(\"\");\nfunction paintTrack(){ [...$(\"track\").children].forEach((s,k) => { s.className = k < i ? \"done\" : (k === i && !$(\"quiz\").hidden ? \"now\" : \"\"); }); }\n\n// ---- contact form ----\n$(\"contact\").addEventListener(\"submit\", e => {\n  e.preventDefault();\n  const f = { name: $(\"fName\").value.replace(/\\s+/g,\" \").trim(), email: $(\"fEmail\").value.trim(), phone: $(\"fPhone\").value.trim(), consent: $(\"fConsent\").checked };\n  const problems = [];\n  const mark = (id, bad) => $(id).setAttribute(\"aria-invalid\", bad ? \"true\" : \"false\");\n  mark(\"fName\", !f.name); if (!f.name) problems.push(\"your name\");\n  const emailOk = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(f.email); mark(\"fEmail\", !emailOk); if (!emailOk) problems.push(\"a valid email\");\n  const phoneOk = (f.phone.match(/\\d/g) || []).length >= 7; mark(\"fPhone\", !phoneOk); if (!phoneOk) problems.push(\"a valid phone number\");\n  if (!f.consent) problems.push(\"your consent\");\n  if (problems.length) {\n    $(\"formErr\").textContent = \"Please add \" + problems.join(\", \").replace(/, ([^,]*)$/, \" and $1\") + \".\";\n    $(\"formErr\").hidden = false; return;\n  }\n  $(\"formErr\").hidden = true;\n  contact = f;\n  start();\n});\n\nfunction start(){\n  i = 0; xp = 0; picks = []; scores = {}; ORDER.forEach(k => scores[k] = 0);\n  $(\"xpVal\").textContent = \"0\";\n  [\"intro\",\"results\",\"badgePanel\",\"gapPanel\",\"kitPanel\"].forEach(id => $(id).hidden = true);\n  $(\"quiz\").hidden = false; show(); window.scrollTo({top:0});\n}\n\nfunction show(){\n  const q = Q[i];\n  $(\"qTag\").textContent = DIMS[q.d].short + (q.self ? \" \u00b7 self-check\" : \" \u00b7 scenario\");\n  $(\"qCount\").textContent = `${i+1} / ${Q.length}`;\n  $(\"qPrompt\").textContent = q.p;\n  const keys = \"ABCD\";\n  $(\"qOpts\").innerHTML = q.o.map((o,k) => `<button class=\"opt\" data-k=\"${k}\"><span class=\"key\">${keys[k]}</span><span></span></button>`).join(\"\");\n  [...$(\"qOpts\").children].forEach((b,k) => b.lastElementChild.textContent = q.o[k][0]);\n  $(\"qNote\").hidden = true; $(\"nextBtn\").hidden = true;\n  $(\"nextBtn\").textContent = i === Q.length-1 ? \"See my debrief\" : \"Next situation\";\n  paintTrack();\n  $(\"qOpts\").querySelector(\".opt\").focus({preventScroll:true});\n}\n\n$(\"qOpts\").addEventListener(\"click\", e => {\n  const b = e.target.closest(\".opt\"); if (!b || b.disabled) return;\n  const q = Q[i], k = +b.dataset.k, pts = q.o[k][1];\n  scores[q.d] += pts; picks.push(k);\n  const gain = pts * 10; xp += gain;\n  $(\"xpVal\").textContent = xp;\n  const x = $(\"xp\"); x.classList.remove(\"xp-pop\"); void x.offsetWidth; x.classList.add(\"xp-pop\");\n  const opts = [...$(\"qOpts\").children];\n  opts.forEach(o => o.disabled = true);\n  b.classList.add(\"picked\");\n  if (!q.self) {\n    const bi = q.o.findIndex(o => o[1] === 3);\n    opts[bi].classList.add(\"best\");\n    opts[bi].lastElementChild.insertAdjacentHTML(\"beforeend\", '<span class=\"flag\">Strongest move</span>');\n  }\n  $(\"qGain\").textContent = `+${gain} XP`;\n  $(\"qNoteText\").textContent = q.n;\n  $(\"qNote\").hidden = false; $(\"nextBtn\").hidden = false; $(\"nextBtn\").focus({preventScroll:true});\n});\n\n$(\"nextBtn\").addEventListener(\"click\", () => { i++; if (i < Q.length) show(); else finish(); });\n\nfunction status(s){ return s >= 5 ? [\"s\",\"Strong\"] : s >= 3 ? [\"d\",\"Developing\"] : [\"g\",\"Gap\"]; }\n\nfunction radar(){\n  const cx=200, cy=170, R=110, n=ORDER.length;\n  const pt=(k,r)=>{const a=-Math.PI/2+k*2*Math.PI/n; return [cx+r*Math.cos(a), cy+r*Math.sin(a)];};\n  let g=\"\";\n  [2,4,6].forEach(lv=>{ g+=`<polygon points=\"${ORDER.map((_,k)=>pt(k,R*lv/6).join(\",\")).join(\" \")}\" fill=\"none\" stroke=\"var(--line)\" stroke-width=\"1\"/>`; });\n  ORDER.forEach((_,k)=>{const [x,y]=pt(k,R); g+=`<line x1=\"${cx}\" y1=\"${cy}\" x2=\"${x}\" y2=\"${y}\" stroke=\"var(--line)\"/>`;});\n  const poly=ORDER.map((d,k)=>pt(k,R*Math.max(scores[d],.15)/6).join(\",\")).join(\" \");\n  g+=`<polygon points=\"${poly}\" fill=\"var(--accent)\" fill-opacity=\".22\" stroke=\"var(--accent)\" stroke-width=\"2.5\" stroke-linejoin=\"round\"/>`;\n  ORDER.forEach((d,k)=>{const [x,y]=pt(k,R*Math.max(scores[d],.15)/6); g+=`<circle cx=\"${x}\" cy=\"${y}\" r=\"4.5\" fill=\"var(--accent)\"/>`;});\n  ORDER.forEach((d,k)=>{\n    const [x,y]=pt(k,R+26); const anchor = Math.abs(x-cx)<5 ? \"middle\" : x>cx ? \"start\" : \"end\";\n    g+=`<text x=\"${x}\" y=\"${y}\" text-anchor=\"${anchor}\" dominant-baseline=\"middle\" fill=\"var(--ink)\" font-family=\"IBM Plex Sans, sans-serif\" font-size=\"13\" font-weight=\"600\">${DIMS[d].short}</text>`;\n    g+=`<text x=\"${x}\" y=\"${y+16}\" text-anchor=\"${anchor}\" dominant-baseline=\"middle\" fill=\"var(--muted)\" font-family=\"IBM Plex Mono, monospace\" font-size=\"11\">${scores[d]}/6</text>`;\n  });\n  $(\"radar\").innerHTML=`<svg viewBox=\"0 0 400 340\" role=\"img\" aria-label=\"Readiness radar across six skill areas\">${g}</svg>`;\n}\n\nfunction finish(){\n  $(\"quiz\").hidden = true; [...$(\"track\").children].forEach(s => s.className = \"done\");\n  const total = ORDER.reduce((a,d) => a + scores[d], 0), pct = Math.round(total / (Q.length*3) * 100);\n  const lv = [...LEVELS].reverse().find(l => pct >= l.min);\n  $(\"rPct\").textContent = pct + \"%\";\n  $(\"rLevel\").textContent = contact.name.split(\" \")[0] + \": \" + lv.name;\n  $(\"rLevelText\").textContent = lv.text;\n  radar();\n  $(\"bars\").innerHTML = ORDER.map(d => { const [c,l] = status(scores[d]);\n    const col = c===\"s\"?\"var(--good)\":c===\"d\"?\"var(--warn)\":\"var(--bad)\";\n    return `<div class=\"bar-row\"><span>${DIMS[d].name}</span><span class=\"pill ${c}\">${l}</span><div class=\"bar\"><i style=\"width:${scores[d]/6*100}%;background:${col}\"></i></div></div>`; }).join(\"\");\n\n  const earned = ORDER.filter(d => scores[d] === 6);\n  $(\"badgePanel\").hidden = !earned.length;\n  $(\"badges\").innerHTML = earned.map(d => `<span>${DIMS[d].badge}</span>`).join(\"\");\n\n  const gaps = ORDER.filter(d => scores[d] <= 4).sort((a,b) => scores[a] - scores[b]);\n  if (gaps.length) {\n    $(\"gapTitle\").textContent = gaps.length === 1 ? \"One gap to close\" : `${gaps.length} gaps to close, weakest first`;\n    $(\"gaps\").innerHTML = gaps.map(d => { const [c,l] = status(scores[d]);\n      return `<div class=\"gap\"><div class=\"qhead\"><h3>${DIMS[d].name}</h3><span class=\"pill ${c}\">${l} \u00b7 ${scores[d]}/6</span></div><ol>${DIMS[d].plan.map(p => `<li>${p}</li>`).join(\"\")}</ol></div>`; }).join(\"\");\n  } else {\n    $(\"gapTitle\").textContent = \"No major gaps\";\n    $(\"gaps\").innerHTML = `<p class=\"muted\">Every area scored strong. Your next step is evidence: a portfolio of two or three client-style builds you can walk through in an interview.</p>`;\n  }\n  [\"results\",\"gapPanel\",\"kitPanel\"].forEach(id => $(id).hidden = false);\n  window.scrollTo({top:0});\n  send();\n}\n\nfunction setSend(state, msg, canRetry){\n  $(\"sendbar\").className = \"sendbar \" + state;\n  $(\"sendMsg\").textContent = msg;\n  $(\"resendBtn\").hidden = !canRetry;\n}\n\nfunction send(){\n  if (sending) return;\n  const to = contact.email;\n  sending = true;\n  setSend(\"pending\", `Emailing your debrief to ${to}\u2026`, false);\n  fetch(\"/api/submit\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" },\n    body: JSON.stringify({ name: contact.name, email: contact.email, phone: contact.phone, consent: contact.consent, answers: picks }) })\n    .then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok, j })))\n    .then(({ ok, j }) => {\n      sending = false;\n      if (!ok) { setSend(\"err\", j.error || \"We couldn't send your results. Try again.\", true); return; }\n      if (j.sent) setSend(\"ok\", `Sent to ${to}. Check your inbox, and your spam folder if it isn't there in a few minutes.`, false);\n      else setSend(\"err\", \"Your results are saved, but the email didn't go out. The facilitator can send you a copy.\", false);\n    })\n    .catch(() => { sending = false; setSend(\"err\", \"We couldn't reach the server. Check your connection and try again.\", true); });\n}\n\n$(\"resendBtn\").addEventListener(\"click\", send);\n$(\"retryBtn\").addEventListener(\"click\", start);\ndocument.addEventListener(\"keydown\", e => {\n  if ($(\"quiz\").hidden) return;\n  const k = \"abcd\".indexOf(e.key.toLowerCase());\n  if (k >= 0) { const b = $(\"qOpts\").children[k]; if (b && !b.disabled) b.click(); }\n});\n</script>\n</body>\n</html>\n";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default {
  async fetch(request, env) {
    CONFIG = {
      WORKSHOP_NAME: env.WORKSHOP_NAME || 'FDE Workshop',
      SENDER_NAME: env.SENDER_NAME || 'FDE Field Readiness',
      FROM_EMAIL: env.FROM_EMAIL || '',
      REPLY_TO: env.REPLY_TO || '',
      FACILITATOR_BCC: env.FACILITATOR_BCC || ''
    };
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      const content = JSON.stringify({ order: ORDER, dims: DIMS, questions: QUESTIONS, levels: LEVELS, workshop: CONFIG.WORKSHOP_NAME })
        .replace(/</g, '\\u003c');
      return new Response(PAGE.replace('__CONTENT__', () => content), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' }
      });
    }

    if (url.pathname === '/api/submit') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Not allowed' }, 403);
      let form;
      try { form = await request.json(); } catch { return json({ error: 'Something went wrong. Please try again.' }, 400); }
      try { return json(await submit(form, env)); }
      catch (e) { return json({ error: e.userMessage || 'Something went wrong on our side. Please try again in a minute.' }, e.userMessage ? 400 : 500); }
    }

    if (url.pathname === '/admin/export.csv' && request.method === 'GET') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('Not found', { status: 404 });
      const { results } = await env.DB.prepare('SELECT * FROM responses ORDER BY id').all();
      const cols = ['id', 'created_at', 'workshop', 'name', 'email', 'phone', 'consent', 'pct', 'level', 'xp',
        's_code', 's_ai', 's_data', 's_discovery', 's_client', 's_ownership', 'top_gap', 'email_status', 'answers'];
      const q = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
      const csv = '﻿' + [cols.join(',')].concat(results.map(r => cols.map(c => q(r[c])).join(','))).join('\r\n');
      return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="fde-readiness-responses.csv"', 'cache-control': 'no-store' } });
    }

    return new Response('Not found', { status: 404 });
  }
};

function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

async function submit(form, env) {
  form = form || {};
  const name = String(form.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const email = String(form.email || '').trim().toLowerCase().slice(0, 120);
  const phone = String(form.phone || '').replace(/[^\d+()\-\s]/g, '').trim().slice(0, 30);

  if (!name) throw userError('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw userError('Please enter a valid email address.');
  if ((phone.match(/\d/g) || []).length < 7) throw userError('Please enter a valid phone number.');
  if (form.consent !== true) throw userError('Please accept the consent box so we can email your results.');

  let r;
  try { r = score_(form.answers); } catch (e) { throw userError(e.message); }

  const recent = await env.DB.prepare(
    "SELECT SUM(CASE WHEN email = ?1 AND email_status = 'Sent' THEN 1 ELSE 0 END) AS mine, COUNT(*) AS total FROM responses WHERE created_at > datetime('now', '-1 hour')"
  ).bind(email).first();
  if ((recent && recent.mine) >= MAX_SENDS_PER_EMAIL_PER_HOUR) throw userError('Results were already sent to this address several times in the last hour. Please check your inbox.');
  if ((recent && recent.total) >= MAX_SUBMISSIONS_PER_HOUR) throw userError('The quiz is very busy right now. Please try again in a few minutes.');

  let status = 'Sent';
  try {
    if (!CONFIG.FROM_EMAIL) throw new Error('FROM_EMAIL is not set');
    const msg = buildEmail_(name, r);
    const message = {
      from: { email: CONFIG.FROM_EMAIL, name: CONFIG.SENDER_NAME },
      to: { email, name },
      subject: msg.subject, html: msg.html, text: msg.text
    };
    if (CONFIG.REPLY_TO) message.replyTo = CONFIG.REPLY_TO;
    if (CONFIG.FACILITATOR_BCC) message.bcc = CONFIG.FACILITATOR_BCC;
    await env.EMAIL.send(message);
  } catch (e) {
    status = ('Not sent: ' + (e && e.message || e)).slice(0, 200);
    console.error('email failed', status);
  }

  await env.DB.prepare(
    'INSERT INTO responses (workshop, name, email, phone, consent, pct, level, xp, s_code, s_ai, s_data, s_discovery, s_client, s_ownership, top_gap, email_status, answers) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)'
  ).bind(CONFIG.WORKSHOP_NAME, name, email, phone, r.pct, r.level.name, r.xp,
    r.scores.code, r.scores.ai, r.scores.data, r.scores.discovery, r.scores.client, r.scores.ownership,
    r.gaps.length ? DIMS[r.gaps[0]].name : 'None', status, r.answers.join(',')).run();

  return { sent: status === 'Sent' };
}
