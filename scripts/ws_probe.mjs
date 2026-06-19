// Probe the RobFlow /robot WebSocket and report the motion-relevant message types.
// Usage: node scripts/ws_probe.mjs <wsUrl> [seconds]
// The session token (SID) is part of the URL and is a credential — pass it at runtime,
// never commit it.
const url = process.argv[2];
const seconds = Number(process.argv[3] || 5);
if (!url) {
    console.error('usage: node ws_probe.mjs <wsUrl> [seconds]');
    process.exit(1);
}

const seen = new Map(); // type -> count
const sample = {};
const wantSample = ['robotModuleIds', 'jointAngles', 'baseShift', 'fixedModuleIds', 'tool', 'pose', 'operationMode', 'robotState'];

const ws = new WebSocket(url);
ws.onopen = () => console.log('[open]', url.replace(/session\/ws\/[^/]+/, 'session/ws/<SID>'));
ws.onerror = (e) => console.error('[error]', e.message || e.type || e);
ws.onclose = (e) => console.log('[close]', e.code, e.reason || '');
ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    seen.set(m.type, (seen.get(m.type) || 0) + 1);
    if (wantSample.includes(m.type) && sample[m.type] === undefined) {
        sample[m.type] = m.data;
    }
};

setTimeout(() => {
    console.log('\n=== message types seen ===');
    for (const [t, c] of [...seen.entries()].sort()) console.log(`  ${t}: ${c}`);
    console.log('\n=== samples ===');
    for (const k of wantSample) {
        if (sample[k] !== undefined) {
            let v = JSON.stringify(sample[k]);
            if (v.length > 300) v = v.slice(0, 300) + '…';
            console.log(`  ${k}: ${v}`);
        }
    }
    try { ws.close(); } catch {}
    process.exit(0);
}, seconds * 1000);
