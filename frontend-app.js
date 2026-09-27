const samples = {
  cabal: {
    token: 'DemoToken7x...cabal', score: 84, cluster: 37, exposure: '44.8', kind: 'high',
    summary: 'Early holders share funding and synchronized buys.',
    verdict: 'Do not buy blindly.',
    detail: '37 wallets received SOL from a shared source before launch and sold most of their positions nearly at the same time.',
    signals: [
      {title:'Shared funding source',text:'37 wallets received SOL from 3 linked addresses 8 minutes before launch.'},
      {title:'Synchronized buy',text:'31 wallets entered within two slots after the pool was created.'},
      {title:'Coordinated exit',text:'18 wallets sold more than 80% of their positions in one time window.'},
    ],
  },
  clean: {
    token: 'DemoToken3p...clean', score: 18, cluster: 4, exposure: '7.2', kind: 'low',
    summary: 'Early holders do not form a strong connected group.',
    verdict: 'No clear cabal signals.',
    detail: 'A few early wallets are linked, but concentration and timing remain below the alert threshold.',
    signals: [
      {title:'Weak funding link',text:'4 wallets share a source, but their activity is spread over time.'},
      {title:'Distributed buys',text:'No mass entry in one slot after pool launch.'},
      {title:'No shared exit',text:'No synchronized group sale was detected.'},
    ],
  },
};

const form = document.getElementById('scan-form');
const input = document.getElementById('token-input');
const report = document.getElementById('report');
const button = document.getElementById('scan-button');
const depthSelect = document.getElementById('scan-depth');
const slotInput = document.getElementById('scan-slot');
const liveState = document.createElement('section');
liveState.className = 'live-state hidden';
report.parentNode.insertBefore(liveState, report.nextSibling);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = input.value.trim() || samples.cabal.token;
  const sampleKind = token === samples.clean.token ? 'clean' : token === samples.cabal.token ? 'cabal' : null;
  if (sampleKind) runScan(token, sampleKind);
  else runLiveScan(token, depthSelect?.value || 'standard', slotInput?.value.trim() || '');
});

document.querySelectorAll('[data-sample]').forEach((sampleButton) => sampleButton.addEventListener('click', () => {
  const kind = sampleButton.dataset.sample;
  input.value = samples[kind].token;
  runScan(samples[kind].token, kind);
}));

async function runLiveScan(token, depth = 'standard', scanAtSlot = '') {
  button.classList.add('loading');
  button.querySelector('span').textContent = depth === 'deep' ? 'Deep scan…' : 'Querying Helius…';
  report.classList.add('hidden');
  liveState.className = 'live-state';
  liveState.style.cssText = 'border-top:1px solid #273033;padding:70px 0 110px';
  liveState.innerHTML = `<div style="border:1px solid #5b4930;background:linear-gradient(135deg,#211b12,#101516);border-radius:8px;padding:28px;max-width:760px"><div class="eyebrow">${escapeHtml(depth.toUpperCase())} INDEXER SCAN</div><h2 style="margin:12px 0;font-size:28px">Scanning ${escapeHtml(token)}</h2><p style="color:#adb8b3;line-height:1.6;font-size:14px">Loading data at the selected analysis depth.</p></div>`;
  liveState.scrollIntoView({behavior:'smooth', block:'start'});
  try {
    const slotQuery = scanAtSlot ? `&scanAtSlot=${encodeURIComponent(scanAtSlot)}` : '';
    const response = await fetch(`/api/live-scan?mint=${encodeURIComponent(token)}&depth=${encodeURIComponent(depth)}${slotQuery}`);
    const data = await response.json();
    if (!response.ok || data.error) {
      const message = data.error || data.message || 'Indexer error';
      const diagnosticCode = data.code || message.match(/\[(E\d{3}_[A-Z_]+)\]/)?.[1] || 'E900_UNKNOWN';
      const diagnosticError = new Error(message);
      diagnosticError.code = diagnosticCode;
      throw diagnosticError;
    }
    if (data.configured === false) throw new Error(data.message);
    const supply = Number(data.supply?.uiAmount || 0);
    const signalHtml = (data.signals || []).map((signal) => `<li><b>${escapeHtml(signal.title)}</b> — ${escapeHtml(signal.detail)}</li>`).join('');
    const acquisition = data.acquisitionSpreadSeconds === null ? 'no confirmed data' : `${data.acquisitionSpreadSeconds} sec.`;
    const amountSpread = data.amountSpreadRatio === null ? 'no confirmed data' : `${Number(data.amountSpreadRatio).toFixed(1)}x`;
    const exits = (data.sharedExitDestinations || []).length ? 'repeated destinations found' : 'no repeated destinations found';
    const deepButton = depth === 'deep' ? '' : '<button id="deep-scan-button" style="margin-top:18px;background:#c7f36b;border:0;border-radius:6px;padding:12px 15px;font-weight:700;cursor:pointer">Run deep scan</button>';
    const security = data.security || {};
    const liquidityHtml = (security.liquidity || []).length
      ? security.liquidity.map((item) => `<li><b>${escapeHtml(item.venue || 'unknown')}</b>: ${escapeHtml(item.status || 'unknown')} — ${escapeHtml((item.evidence || []).join(' ') || 'No additional evidence')}</li>`).join('')
      : '<li>No liquidity candidate was identified.</li>';
    const dexHtml = (data.dex || []).length
      ? data.dex.map((item) => `<li><b>${escapeHtml(item.venue)}</b> · ${escapeHtml(item.confidence)} confidence · ${item.instructionCount} instructions</li>`).join('')
      : '<li>No supported DEX venue was detected in the sampled transactions.</li>';
    const jito = data.jitoBundle;
    const jitoText = jito ? `${jito.isConfirmedJitoBundle ? 'Confirmed evidence' : 'Not confirmed'} · ${jito.qualifyingWalletCount || 0} qualifying wallets · slots: ${(jito.slots || []).join(', ') || 'none'}` : 'Not analyzed in quick mode.';
    const ai = data.aiVerdict || {};
    const aiEvidenceHtml = (ai.evidence || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    liveState.innerHTML = `<div style="border:1px solid #2f554b;background:linear-gradient(135deg,#12211d,#101516);border-radius:8px;padding:28px;max-width:920px"><div class="eyebrow">LIVE HELIUS DATA · ${escapeHtml(data.scanDepth || depth)}</div><h2 style="margin:12px 0;font-size:28px">Data received</h2><p style="color:#adb8b3;line-height:1.6;font-size:14px">Supply: <code>${supply.toLocaleString()}</code><br>Unique owners in loaded page: <code>${data.uniqueOwners}</code><br>Top 10 of loaded page: <code>${data.top10ConcentrationOfLoadedPage ?? 'unknown'}%</code> supply.<br>First-entry spread: <code>${acquisition}</code><br>First-entry amount spread: <code>${amountSpread}</code><br>Post-sale destinations: <code>${exits}</code><br>Risk signal: <code>${data.riskScore}/100</code> · confidence: <code>${escapeHtml(data.confidence)}</code><br>Cache: <code>${data.cache?.hit ? 'HIT' : 'MISS'}</code> · Historical slot: <code>${data.historical?.scanAtSlot ?? 'latest'}</code></p><ul style="color:#d7e0d9;line-height:1.8;font-size:13px;padding-left:20px">${signalHtml}</ul><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-top:18px"><section style="border:1px solid #354142;border-radius:7px;padding:16px"><div class="card-kicker">SECURITY</div><p style="font-size:13px;line-height:1.7">Mint authority: <code>${security.mintAuthorityRevoked ? 'revoked' : 'active/unknown'}</code><br>Freeze authority: <code>${security.freezeAuthorityRevoked ? 'revoked' : 'active/unknown'}</code></p><ul style="font-size:12px;line-height:1.6;padding-left:18px">${liquidityHtml}</ul></section><section style="border:1px solid #354142;border-radius:7px;padding:16px"><div class="card-kicker">JITO BUNDLE EVIDENCE</div><p style="font-size:13px;line-height:1.7">${escapeHtml(jitoText)}</p><p style="font-size:12px;color:#adb8b3">${escapeHtml(jito?.reason || 'Bundle evidence is not collected in quick mode.')}</p></section><section style="border:1px solid #354142;border-radius:7px;padding:16px"><div class="card-kicker">DEX ROUTES</div><ul style="font-size:12px;line-height:1.6;padding-left:18px">${dexHtml}</ul></section></div><section style="border:1px solid #5b4930;border-radius:7px;padding:16px;margin-top:12px"><div class="card-kicker">AI VERDICT · ${escapeHtml(ai.model || 'unavailable')}</div><p style="font-size:14px;line-height:1.6"><b>${escapeHtml(ai.riskLevel || 'unknown').toUpperCase()}</b> — ${escapeHtml(ai.summary || 'No verdict available.')}</p><ul style="font-size:12px;line-height:1.6;padding-left:18px">${aiEvidenceHtml || '<li>No evidence summary available.</li>'}</ul></section><p style="color:#ffb66b;line-height:1.6;font-size:12px">Owners checked: ${data.analysisLimits?.ownersChecked || 0}; transactions per owner: ${data.analysisLimits?.transactionsPerOwner || 0}. This is a forensic preview, not proof of fraud. IP addresses are not recorded in Solana transactions.</p>${deepButton}</div>`;
    const deepScanButton = document.getElementById('deep-scan-button');
    if (deepScanButton) deepScanButton.addEventListener('click', () => runLiveScan(token, 'deep', scanAtSlot));
  } catch (error) {
    liveState.innerHTML = `<div style="border:1px solid #5b4930;background:linear-gradient(135deg,#211b12,#101516);border-radius:8px;padding:28px;max-width:760px"><div class="eyebrow">LIVE INDEXER UNAVAILABLE</div><h2 style="margin:12px 0;font-size:28px">No unsupported verdict</h2><p style="color:#adb8b3;line-height:1.6;font-size:14px">The local indexer returned no data: <code>${escapeHtml(error.message)}</code></p><p style="color:#ffb66b;line-height:1.6;font-size:12px">Diagnostic code: <code>${escapeHtml(error.code || 'E900_UNKNOWN')}</code><br>Check the local Helius API key configuration. Demo mode is still available through the buttons.</p></div>`;
  } finally {
    button.classList.remove('loading');
    button.querySelector('span').textContent = 'Scan token';
  }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])); }

function runScan(token, kind) {
  liveState.className = 'live-state hidden';
  button.classList.add('loading');
  button.querySelector('span').textContent = 'Scanning graph…';
  setTimeout(() => {
    const data = samples[kind] || samples.cabal;
    document.getElementById('report-title').textContent = token;
    document.getElementById('risk-score').textContent = data.score;
    document.getElementById('cluster-size').textContent = data.cluster;
    document.getElementById('exposure').innerHTML = `${data.exposure}<span>%</span>`;
    document.getElementById('risk-summary').textContent = data.summary;
    document.getElementById('verdict-text').textContent = data.verdict;
    document.getElementById('verdict-detail').textContent = data.detail;
    const badge = document.getElementById('risk-badge');
    badge.className = `risk-badge ${data.kind}`;
    document.getElementById('risk-label').textContent = data.kind === 'high' ? 'HIGH RISK' : 'LOW SIGNAL';
    document.getElementById('meter-fill').style.width = `${data.score}%`;
    document.getElementById('signals').innerHTML = data.signals.map((signal) => `<div class="signal"><div class="signal-icon">◈</div><div><strong>${signal.title}</strong><p>${signal.text}</p></div></div>`).join('');
    drawGraph(data.kind);
    report.classList.remove('hidden');
    report.scrollIntoView({behavior:'smooth', block:'start'});
    button.classList.remove('loading');
    button.querySelector('span').textContent = 'Scan token';
  }, 650);
}

function drawGraph(kind) {
  const svg = document.getElementById('graph');
  svg.innerHTML = '';
  const center = {x:360, y:190};
  const nodes = kind === 'high' ? [{x:360,y:190,c:'source',r:18,label:'FUNDING SOURCE'},{x:212,y:105,c:'hot',r:10},{x:270,y:70,c:'hot',r:9},{x:330,y:90,c:'hot',r:10},{x:414,y:78,c:'hot',r:9},{x:490,y:110,c:'hot',r:11},{x:180,y:220,c:'hot',r:9},{x:252,y:260,c:'hot',r:10},{x:336,y:280,c:'hot',r:10},{x:435,y:270,c:'hot',r:9},{x:525,y:220,c:'hot',r:10},{x:290,y:170,c:'mid',r:8},{x:440,y:175,c:'mid',r:8}] : [{x:360,y:190,c:'source',r:18,label:'SOURCE'},{x:210,y:105,c:'hot',r:9},{x:500,y:110,c:'hot',r:9},{x:240,y:270,c:'hot',r:9},{x:490,y:270,c:'hot',r:9},{x:355,y:65,c:'mid',r:8}];
  const group = svgEl('g');
  nodes.forEach((node, index) => {
    if (index > 0) group.appendChild(svgEl('line', {x1:center.x,y1:center.y,x2:node.x,y2:node.y,class:`graph-line ${kind === 'low' ? 'soft' : ''}`}));
  });
  nodes.forEach((node, index) => {
    const circle = svgEl('circle', {cx:node.x,cy:node.y,r:node.r,class:`graph-node ${node.c}`});
    circle.style.animationDelay = `${index * 60}ms`;
    group.appendChild(circle);
    if (node.label) { const text = svgEl('text', {x:node.x,y:node.y+35,class:'graph-label'}); text.textContent = node.label; group.appendChild(text); }
  });
  svg.appendChild(group);
}

function svgEl(tag, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

runScan(samples.cabal.token, 'cabal');
