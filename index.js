/**
 * ZERX-XIT — AI Sensitivity Cloud Function
 * =========================================
 * Deployed separately from admin.html / user.html. This is the ONLY place
 * the AI provider's API key ever lives. The browser never sees it.
 *
 * Flow:
 *   client (sensi generator) --POST device+style--> this function
 *     --> builds a compact prompt --> Gemini
 *     --> parses + validates the JSON response
 *     --> if the AI fails/times out/returns garbage, falls back to the
 *         same deterministic formula the client already uses offline
 *     --> always returns a valid, clamped result
 *
 * Deploy:
 *   1. cd functions && npm install
 *   2. firebase functions:secrets:set GEMINI_API_KEY
 *      (paste your real key when prompted — never put it in code)
 *   3. firebase deploy --only functions:generateSensi
 *   4. Copy the deployed function URL into SENSI_AI_ENDPOINT in user.html
 *      (search for that constant near the top of the sensi generator script)
 *
 * Optional env var: GEMINI_MODEL (defaults to gemini-1.5-flash — fast + cheap,
 * appropriate for a short structured-JSON task like this one).
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

if (!getApps().length) {
    // No config needed inside Cloud Functions — picks up the project's
    // default Realtime Database automatically (same one user.html/admin.html use).
    initializeApp();
}

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// ---- Same valid ranges as the client-side engine — never trust the AI blindly ----
const RANGES = {
    general: [10, 100], red_dot: [10, 100], scope2x: [10, 100], scope4x: [10, 100],
    sniper: [10, 100], free_look: [10, 100], fire_button: [25, 75], dpi: [200, 1200]
};

function clamp(v, lo, hi) {
    v = Number(v);
    if (!Number.isFinite(v)) return null;
    return Math.max(lo, Math.min(hi, Math.round(v)));
}

// ---- Deterministic fallback (mirrors engine.py / the client's JS engine) ----
const PROC_TIERS = {
    'snapdragon 8 elite': 100, 'snapdragon 8 gen 3': 100, 'a17 pro': 100, 'tensor g3': 95,
    'snapdragon 8 gen 2': 95, 'a16 bionic': 95, 'snapdragon 8+ gen 1': 92, 'snapdragon 888': 85,
    'snapdragon 8 gen 1': 89, 'dimensity 8200': 84, 'snapdragon 7 gen 3': 82, 'a15 bionic': 88,
    'dimensity 7200': 80, 'tensor g2': 80, 'snapdragon 778g': 72, 'snapdragon 695': 64,
    'snapdragon 685': 60, 'helio g99': 62, 'exynos 1380': 68, 'exynos 850': 44,
    'dimensity 700': 52, 'helio g85': 55, 'helio g88': 56, 'helio g80': 50,
    'unisoc t616': 48, 'helio g36': 40, 'unisoc t606': 38, 'unisoc t603': 35,
    'helio p35': 34, 'snapdragon 4 gen 1': 50
};
const STYLE_MODS = {
    'One Tap': { general: 0.85, red_dot: 0.75, scope2x: 0.70, scope4x: 0.65, sniper: 0.55, free_look: 0.80, dpi_mod: 1.10 },
    'Balanced': { general: 1.00, red_dot: 1.00, scope2x: 1.00, scope4x: 1.00, sniper: 1.00, free_look: 1.00, dpi_mod: 1.00 },
    'Rusher': { general: 1.20, red_dot: 1.15, scope2x: 1.10, scope4x: 1.05, sniper: 0.90, free_look: 1.20, dpi_mod: 0.95 },
    'Freestyle': { general: 1.10, red_dot: 1.05, scope2x: 1.00, scope4x: 0.95, sniper: 0.85, free_look: 1.15, dpi_mod: 1.05 },
    'Sniper': { general: 0.75, red_dot: 0.65, scope2x: 0.60, scope4x: 0.55, sniper: 0.45, free_look: 0.70, dpi_mod: 1.20 },
    'Instaplayer': { general: 1.30, red_dot: 1.25, scope2x: 1.20, scope4x: 1.10, sniper: 1.00, free_look: 1.30, dpi_mod: 0.90 }
};
function procScore(name) {
    if (!name) return 50;
    const p = String(name).toLowerCase();
    if (PROC_TIERS[p] !== undefined) return PROC_TIERS[p];
    for (const key in PROC_TIERS) { if (p.includes(key) || key.includes(p)) return PROC_TIERS[key]; }
    return 50;
}
function deterministicFallback(device, style) {
    const perf = Number(device.performance_score) || 50;
    const gaming = Number(device.gaming_score) || 50;
    const ram = parseInt(String(device.ram || '4GB'), 10) || 4;
    const ramMod = ram >= 12 ? 1.05 : ram >= 8 ? 1.02 : ram >= 6 ? 1.0 : ram >= 4 ? 0.97 : 0.9;
    const refresh = parseInt(String(device.refresh_rate || '60'), 10) || 60;
    const refreshMod = refresh >= 144 ? 1.08 : refresh >= 120 ? 1.05 : refresh >= 90 ? 1.02 : 1.0;
    let hw = ((procScore(device.processor) + perf + gaming) / 300) * 0.4 + 0.8;
    hw = Math.max(0.75, Math.min(1.25, hw));
    const combined = hw * ramMod * refreshMod;
    const mod = STYLE_MODS[style] || STYLE_MODS['Balanced'];
    const bases = { general: 85, red_dot: 90, scope2x: 75, scope4x: 65, sniper: 50, free_look: 70, dpi: 400 };
    const out = {};
    for (const k in bases) {
        const v = k === 'dpi' ? bases[k] * combined * mod.dpi_mod : bases[k] * combined * (mod[k] ?? 1);
        out[k === 'scope2x' ? 'scope2x' : k] = clamp(v, ...(RANGES[k] || [10, 100]));
    }
    out.fire_button = clamp(35 + out.general * 0.25, 25, 75);
    return out;
}

function buildPrompt(device, style, existing, feedback) {
    // Compact by design — this is a cost-sensitive endpoint called often.
    const lines = [
        'You are tuning Free Fire touch-sensitivity for one specific Android/iOS device.',
        `Device: ${device.brand || 'Unknown'} ${device.model || 'Unknown'}`,
        `Chipset: ${device.processor || 'unknown'}, RAM: ${device.ram || 'unknown'}, Refresh: ${device.refresh_rate || 'unknown'}`,
        `OS: ${device.android_version || device.os || 'unknown'}`,
        `Play style: ${style}`
    ];
    if (existing) lines.push(`Current preset to refine (not replace blindly): ${JSON.stringify(existing)}`);
    if (feedback) lines.push(`User feedback on current preset: "${feedback}" — adjust accordingly, don't regenerate unrelated values.`);
    lines.push(
        'Return ONLY compact JSON, no prose, no markdown fences, matching exactly:',
        '{"general":n,"red_dot":n,"scope2x":n,"scope4x":n,"sniper":n,"free_look":n,"fire_button":n,"dpi":n,"reasoning":"one short sentence"}',
        'All sensitivity fields are integers 10-100, fire_button is 25-75, dpi is 200-1200 (omit dpi entirely for iOS devices).',
        'Base this on real hardware tradeoffs (weaker chipsets and lower refresh rates generally need slightly lower values for stable tracking). Do not just copy the example ranges.'
    );
    return lines.join('\n');
}

async function callGemini(apiKey, model, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000); // keep this endpoint snappy
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 300 }
            }),
            signal: controller.signal
        });
        if (!res.ok) throw new Error('Gemini HTTP ' + res.status);
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
    } finally {
        clearTimeout(timeout);
    }
}

function validateAndClamp(raw, device) {
    const isIOS = String(device.android_version || device.os || '').toLowerCase().includes('ios') ||
        String(device.brand || '').toLowerCase() === 'apple';
    const out = {};
    for (const key of ['general', 'red_dot', 'scope2x', 'scope4x', 'sniper', 'free_look']) {
        const v = clamp(raw[key], ...RANGES[key]);
        if (v === null) return null; // malformed — caller should fall back
        out[key] = v;
    }
    out.fire_button = clamp(raw.fire_button, ...RANGES.fire_button) ?? clamp(35 + out.general * 0.25, 25, 75);
    if (!isIOS) {
        out.dpi = clamp(raw.dpi, ...RANGES.dpi) ?? 400;
    }
    out.reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 240) : '';
    return out;
}

exports.generateSensi = onRequest(
    { cors: true, secrets: [GEMINI_API_KEY], timeoutSeconds: 15, memory: '256MiB' },
    async (req, res) => {
        if (req.method !== 'POST') {
            res.status(405).json({ error: 'POST only' });
            return;
        }
        const body = req.body || {};
        const device = body.device || {};
        const style = STYLE_MODS[body.playStyle] ? body.playStyle : 'Balanced';
        const existing = body.existing || null;
        const feedback = typeof body.feedback === 'string' ? body.feedback.slice(0, 200) : null;

        if (!device.brand && !device.model) {
            res.status(400).json({ error: 'device.brand or device.model required' });
            return;
        }

        const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
        let result = null;
        let source = 'fallback';

        try {
            const apiKey = GEMINI_API_KEY.value();
            if (apiKey) {
                const prompt = buildPrompt(device, style, existing, feedback);
                const raw = await callGemini(apiKey, model, prompt);
                const validated = validateAndClamp(raw, device);
                if (validated) { result = validated; source = 'ai'; }
            }
        } catch (e) {
            // Never leak provider errors/stack traces to the client — log server-side only.
            console.error('AI generation failed, using deterministic fallback:', e.message);
        }

        if (!result) {
            const det = deterministicFallback(device, style);
            result = { ...det, reasoning: 'Calculated from device hardware profile.' };
        }

        res.status(200).json({ ...result, source, play_style: style });
    }
);

/**
 * ZERX-XIT — Verification Code Check
 * ===================================
 * Ported from the Flask build's verification.py / routes.py (`/api/verify`).
 * The join + share steps are cheap to fake anyway (they just open links /
 * increment a counter), so they're handled directly by user.html against
 * the Realtime Database like everything else in this app. The one step
 * that actually matters is the CODE, because the correct code is the admin's
 * secret — so it is never sent to the browser. This function is the only
 * place that reads settings/verification/code (via the Admin SDK, which
 * ignores database rules), checks it, tracks attempts, and — after 3 wrong
 * codes — bans the account exactly like the Flask version did.
 *
 * Client contract:
 *   POST { uid, code } --> { success, message } on success
 *                      --> { success:false, message, attemptsLeft } on a wrong-but-not-final try
 *                      --> { success:false, banned:true, zerxId, message } once blocked
 *
 * Deploy alongside generateSensi:
 *   firebase deploy --only functions:verifyZerxCode
 */
const MAX_CODE_ATTEMPTS = 3;

exports.verifyZerxCode = onRequest(
    { cors: true, timeoutSeconds: 15, memory: '256MiB' },
    async (req, res) => {
        if (req.method !== 'POST') {
            res.status(405).json({ error: 'POST only' });
            return;
        }
        const { uid, code } = req.body || {};
        if (!uid || typeof code !== 'string' || !code.trim()) {
            res.status(400).json({ error: 'uid and code are required' });
            return;
        }

        const db = getDatabase();
        const userRef = db.ref('users/' + uid);

        try {
            const userSnap = await userRef.get();
            const user = userSnap.val() || {};

            // Already-banned accounts can't burn more attempts.
            if (user.status === 'banned') {
                res.status(403).json({
                    success: false, banned: true, zerxId: user.zerxId || '',
                    message: 'This device is banned. Submit an appeal to regain access.'
                });
                return;
            }

            const settingsSnap = await db.ref('settings/verification/code').get();
            const correctCode = String(settingsSnap.val() || 'ZERX FOR 2027').trim().toUpperCase();
            const submitted = code.trim().toUpperCase();

            if (submitted === correctCode) {
                await userRef.child('verifyAttempts').set(0);
                res.status(200).json({ success: true, message: 'Verification complete.' });
                return;
            }

            // Wrong code — count it with a transaction so concurrent taps can't dodge the limit.
            const txResult = await userRef.child('verifyAttempts').transaction((curr) => (curr || 0) + 1);
            const attempts = txResult.snapshot.val() || 1;
            const remaining = MAX_CODE_ATTEMPTS - attempts;

            if (remaining > 0) {
                res.status(400).json({
                    success: false,
                    message: `Incorrect code. ${remaining} attempt(s) left before this device is blocked.`,
                    attemptsLeft: remaining
                });
                return;
            }

            // Out of attempts — ban, mirroring ban_device() in the Flask build.
            const zerxId = 'ZX-' + Math.random().toString(16).slice(2, 10).toUpperCase();
            await userRef.update({
                status: 'banned',
                banReason: 'Invalid Verification Code',
                zerxId,
                bannedAt: Date.now()
            });
            await userRef.child('verifyAttempts').set(0);
            res.status(403).json({
                success: false, banned: true, zerxId,
                message: 'Too many incorrect codes. Device blocked.'
            });
        } catch (e) {
            console.error('verifyZerxCode failed:', e.message);
            res.status(500).json({ success: false, message: 'Verification service error. Try again shortly.' });
        }
    }
);
