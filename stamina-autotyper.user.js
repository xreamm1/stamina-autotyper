// ==UserScript==
// @name         Stamina Online Auto Typer
// @namespace    https://github.com/xreamm1/stamina-autotyper
// @version      1.1.0
// @description  Автоматически печатает текст на stamina-online.com с настраиваемой скоростью. Авто-старт пробелом, поддержка русской и латинской раскладок.
// @author       @xre1mm
// @match        *://stamina-online.com/*
// @match        *://*.stamina-online.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Config persistence
    // -------------------------------------------------------------------------
    const DEFAULTS = {
        cpm: 300,
        humanize: 25,
        pause_ms: 0,
        autostart_press_space: true,
        startup_delay_ms: 400,
        hotkey_toggle: 'F8',
        hotkey_reset: 'F9',
        diag: false,
        // Sync mode is now ON by default — without it, high CPM gives
        // 1-5% accuracy because the site can't keep up with the key events.
        // With it on, each key is sent, we wait for the on-screen highlight
        // to move on, THEN we send the next. Accuracy ≈ 100%, speed limited
        // only by the site's render cadence.
        sync_mode: true,
        sync_poll_ms: 4,           // how often we poll for the highlight change
        sync_timeout_ms: 500,      // give up and move on after this many ms
        dedup: true,               // never fire same char twice before highlight moves
    };

    function cfgGet(k) {
        try {
            if (typeof GM_getValue === 'function') {
                const v = GM_getValue('stamina_' + k, undefined);
                if (v !== undefined) return v;
            }
        } catch (_) {}
        try {
            const v = localStorage.getItem('stamina_' + k);
            if (v !== null) return JSON.parse(v);
        } catch (_) {}
        return DEFAULTS[k];
    }

    function cfgSet(k, v) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue('stamina_' + k, v);
        } catch (_) {}
        try { localStorage.setItem('stamina_' + k, JSON.stringify(v)); } catch (_) {}
    }

    const cfg = {};
    for (const k of Object.keys(DEFAULTS)) cfg[k] = cfgGet(k);

    // -------------------------------------------------------------------------
    // Logging / diagnostics
    // -------------------------------------------------------------------------
    const TAG = '[Stamina AT]';
    const log = (...a) => console.log(TAG, ...a);
    const warn = (...a) => console.warn(TAG, ...a);

    // -------------------------------------------------------------------------
    // Current-character detection — stamina-online specific heuristics first,
    // then fallbacks. Selectors are based on the common exercise layouts of
    // the site (which keeps the task text in a container near the top of the
    // page as colored spans).
    // -------------------------------------------------------------------------
    const SELECTORS_CURRENT = [
        // stamina-specific candidates
        '#curletter', '#curChar', '#curchar', '.curletter',
        '.cur_letter', '.cur-letter',
        '.pr', '#pr',
        '.current', '.active', '.active-char',
        // generic
        'span.cl-cur', '.cl1 .cur', '.cl1 .current',
        '[class*="cur"]', '[class*="current"]', '[class*="active"]',
    ];

    const SELECTORS_CONTAINERS = [
        '#task', '.task', '.task-text',
        '#text', '.text',
        '.cl1', 'pre.cl1',
        '#exercise', '.exercise',
        '#practice', '.practice',
    ];

    // Stamina-online shows the "next key to press" by highlighting the
    // corresponding key on the virtual keyboard with a RED background. The
    // real exercise text at the top has NO visible cursor marker. So the
    // reliable way to know the current char is: find the virtual keyboard
    // key that has red/orange highlighting.
    // Spacebar helpers — the Space key on stamina-online's virtual keyboard
    // has no visible text (it's just a wide blank), so our length-filter
    // skipped it. Detect it by width, class, data-key, or label.
    const SPACE_LABEL_RE = /^(space|пробел|spacebar|пробел\s+-)$/i;
    function looksLikeSpacebar(el) {
        if (!el) return false;
        const cls = (el.className || '') + '';
        if (/\b(space|spacebar|sp)\b/i.test(cls)) return true;
        const dk = el.getAttribute && (el.getAttribute('data-key')
            || el.getAttribute('data-char') || el.getAttribute('data-symbol'));
        if (dk === ' ' || dk === 'Space' || dk === 'space') return true;
        const txt = (el.textContent || '').trim();
        if (SPACE_LABEL_RE.test(txt)) return true;
        // Visual heuristic: a very wide key with no (or empty) text.
        try {
            const rect = el.getBoundingClientRect();
            if (rect && rect.width > 150 && (txt === '' || txt.length > 3)) return true;
        } catch (_) {}
        return false;
    }

    function findHighlightedKey() {
        // 1) Collect all elements that look like a virtual-keyboard key.
        const candidates = document.querySelectorAll(
            '.k, .key, [data-key], [data-char], ' +
            '.keyboard *, #keyboard *, .kb *, #kb *'
        );
        const seen = new Set();
        for (const el of candidates) {
            if (seen.has(el)) continue;
            seen.add(el);
            if (!el.offsetParent) continue;
            if (!isHighlighted(el)) continue;
            // FIX: spacebar first — detectable by width/class even if the
            // visible text is empty or a long label like "Space"/"Пробел".
            if (looksLikeSpacebar(el)) {
                return { element: el, char: ' ', source: 'kbd-spacebar-highlight' };
            }
            const txt = (el.textContent || '').trim();
            if (txt.length >= 1 && txt.length <= 2) {
                const ch = resolveKeyChar(el, txt);
                if (ch) return { element: el, char: ch, source: 'kbd-key-highlight' };
            }
            // Still highlighted but no readable text? Try data-key first.
            const dk = el.getAttribute && (el.getAttribute('data-key')
                || el.getAttribute('data-char') || el.getAttribute('data-symbol'));
            if (dk && dk.length >= 1) {
                return { element: el, char: dk[0], source: 'kbd-datakey-highlight' };
            }
        }
        // 2) Fallback: scan body-wide for any 1-char span with red bg.
        const allSpans = document.querySelectorAll('span, div, td, button');
        for (const el of allSpans) {
            if (!el.offsetParent) continue;
            if (!isHighlighted(el)) continue;
            if (looksLikeSpacebar(el)) {
                return { element: el, char: ' ', source: 'generic-spacebar' };
            }
            const txt = (el.textContent || '').trim();
            if (txt.length !== 1) continue;
            if (!isLikelyKeyChar(txt)) continue;
            return { element: el, char: txt, source: 'generic-highlight' };
        }
        return null;
    }

    // Is this element highlighted as "next key"? Red / orange / bright
    // background, or a telling class name.
    function isHighlighted(el) {
        const cls = (el.className || '') + '';
        if (/\b(red|hot|next|pressed|hit|target|hilite|highlight|cur|current|active)\b/i.test(cls)) {
            return true;
        }
        const style = el.getAttribute && el.getAttribute('style');
        if (style && /background[^;]*(red|orange|#f[0-9a-f]{2}[0-9a-f]{3}|rgb\s*\(\s*2[0-5][0-9])/i.test(style)) {
            return true;
        }
        try {
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor || '';
            const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            if (m) {
                const r = +m[1], g = +m[2], b = +m[3];
                // red-ish (R dominant, G and B low) or orange (R high, G mid)
                if (r >= 180 && g <= 120 && b <= 120) return true;
                if (r >= 220 && g >= 100 && g <= 180 && b <= 100) return true;
            }
        } catch (_) {}
        return false;
    }

    function isLikelyKeyChar(ch) {
        return /^[a-zа-яё0-9\.\,\;\:\'\"\?\!\-\+\=\(\)\[\]\{\}\/\\\|\<\>\@\#\$\%\^\&\*\~\`\s]$/i.test(ch);
    }

    // Prefer the data-key attribute (actual key code), fall back to the
    // visible text content. Also handle Shift-case: stamina shows uppercase
    // when Shift is required.
    function resolveKeyChar(el, fallbackText) {
        const dk = el.getAttribute && (el.getAttribute('data-key')
            || el.getAttribute('data-char') || el.getAttribute('data-symbol'));
        if (dk && dk.length >= 1) return dk[0];
        return (fallbackText || '')[0];
    }

    // NEW PRIMARY DETECTOR for stamina-online: find any element on the page
    // whose background is pure red (#FF0000 ± tolerance) AND whose text is a
    // single character. This is exactly what stamina shows for the "next key
    // to press" — a red tile with one letter. Works independently of class
    // names or DOM structure.
    function findRedKey() {
        // Walk every element in the page body. There aren't that many — maybe
        // a few hundred to a few thousand — and this runs at CPM-interval
        // speed, which is well under the budget.
        const all = document.body.getElementsByTagName('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (!el.offsetParent) continue;
            const txt = (el.textContent || '').trim();
            // Keyboard-key tiles hold exactly 1 visible character (letter,
            // digit, punctuation). Longer labels like "Shift"/"Backspace" we
            // ignore here — they're handled by looksLikeSpacebar / shift.
            if (txt.length !== 1) {
                // SPACEBAR special — wide red tile with empty / long text.
                if (looksLikeSpacebar(el) && isPureRed(el)) {
                    return { element: el, char: ' ', source: 'red-spacebar' };
                }
                continue;
            }
            if (!isPureRed(el)) continue;
            if (!isLikelyKeyChar(txt)) continue;
            return { element: el, char: txt, source: 'red-key' };
        }
        return null;
    }

    // Pure red = R dominant and both G and B near zero.
    // Covers rgb(255,0,0) (CSS "red") and close shades like #ee0a0a used by
    // stamina for the highlight. We're deliberately strict so we don't
    // confuse this with just "warm colored" keyboard tiles.
    function isPureRed(el) {
        try {
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor || '';
            const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?/);
            if (!m) return false;
            const r = +m[1], g = +m[2], b = +m[3];
            const a = m[4] !== undefined ? +m[4] : 1;
            if (a < 0.5) return false;              // transparent -> no
            if (r < 200) return false;              // red channel not dominant
            if (g > 60) return false;               // too much green -> orange/yellow
            if (b > 60) return false;               // too much blue -> pink/magenta
            // Guard against pink/salmon: red much greater than green/blue.
            if (r - Math.max(g, b) < 120) return false;
            return true;
        } catch (_) { return false; }
    }

    function findCurrentChar() {
        // 0) BEST PATH for stamina-online: find a tile with #FF0000 bg + 1 char.
        const rk = findRedKey();
        if (rk) return rk;
        // 1) Fallback: broader "highlighted key" detector (any class/attr).
        const hk = findHighlightedKey();
        if (hk) return hk;
        // 1) Try explicit "current char" selectors.
        for (const sel of SELECTORS_CURRENT) {
            const nodes = document.querySelectorAll(sel);
            for (const el of nodes) {
                if (!el || !el.offsetParent) continue;
                const t = el.textContent;
                if (t && t.length >= 1) return { element: el, char: t[0], source: sel };
            }
        }
        // 2) Scan containers for a styled "current" span.
        for (const csel of SELECTORS_CONTAINERS) {
            const container = document.querySelector(csel);
            if (!container) continue;
            const styled = findStyledChar(container);
            if (styled) return { element: styled.el, char: styled.ch, source: csel + ' (styled)' };
        }
        // 3) Position-based fallback.
        for (const csel of SELECTORS_CONTAINERS) {
            const container = document.querySelector(csel);
            if (!container) continue;
            const idx = cursorIndexFromDOM(container);
            if (idx === null) continue;
            const text = container.textContent || '';
            if (idx < text.length) {
                return { element: container, char: text[idx], source: csel + ' (idx=' + idx + ')' };
            }
        }
        return null;
    }

    // Looks for a span-like element inside the container that has an
    // explicit background OR class that makes it visually distinct.
    function findStyledChar(container) {
        const CUR_CLASS_RE = /(cur|curr|active|hilite|highlight|pointer|now)/i;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
            const cls = node.className || '';
            if (typeof cls === 'string' && CUR_CLASS_RE.test(cls) && node.textContent) {
                const t = node.textContent;
                if (t.length >= 1) return { el: node, ch: t[0] };
            }
            const style = node.getAttribute && node.getAttribute('style');
            if (style && /background|color/i.test(style) && node.textContent) {
                const t = node.textContent;
                if (t.length === 1) return { el: node, ch: t };
            }
            node = walker.nextNode();
        }
        return null;
    }

    function cursorIndexFromDOM(container) {
        for (const a of ['data-pos', 'data-index', 'data-cursor']) {
            const v = container.getAttribute(a);
            if (v !== null) {
                const n = parseInt(v, 10);
                if (!Number.isNaN(n)) return n;
            }
        }
        const typed = container.querySelectorAll(
            '.typed, .ok, .passed, .done, .correct, .green, .grn'
        );
        if (typed.length) return typed.length;
        return null;
    }

    // -------------------------------------------------------------------------
    // Keyboard dispatching
    // Important fixes vs v1:
    //  - events go to document AND window AND the active element
    //  - set composed:true so events cross shadow-DOM boundaries if present
    //  - use the physical "code" format games actually check
    // -------------------------------------------------------------------------

    function needsShift(ch) {
        if (/[A-ZА-ЯЁ]/.test(ch)) return true;
        if ('!@#$%^&*()_+{}|:"<>?~'.includes(ch)) return true;
        return false;
    }

    function keyCodeFor(ch) {
        if (ch === ' ') return 32;
        if (ch === '\n' || ch === '\r') return 13;
        if (ch === '\t') return 9;
        const up = ch.toUpperCase();
        if (up.length === 1) {
            const c = up.charCodeAt(0);
            if (c >= 0x30 && c <= 0x5A) return c;
        }
        return ch.charCodeAt(0);
    }

    function codeForChar(ch) {
        if (ch === ' ') return 'Space';
        if (ch === '\n' || ch === '\r') return 'Enter';
        if (ch === '\t') return 'Tab';
        const up = ch.toUpperCase();
        if (up >= 'A' && up <= 'Z') return 'Key' + up;
        if (ch >= '0' && ch <= '9') return 'Digit' + ch;
        if (ch === '.') return 'Period';
        if (ch === ',') return 'Comma';
        return 'Unidentified';
    }

    function makeInit(ch, extra) {
        const code = keyCodeFor(ch);
        const base = {
            key: ch,
            code: codeForChar(ch),
            keyCode: code,
            which: code,
            charCode: ch.charCodeAt(0),
            shiftKey: needsShift(ch),
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
        };
        return Object.assign(base, extra || {});
    }

    // Send a real Shift keydown, then the char (with shiftKey=true), then
    // a Shift keyup. Some trainers only consider capitals correct if they
    // see the modifier down as a separate event. Used by unstick path.
    function fireShiftThenChar(ch) {
        const target = document.body || document.documentElement;
        if (!target) return;
        const shiftInit = {
            key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, charCode: 0,
            shiftKey: true, bubbles: true, cancelable: true, composed: true,
            view: window,
        };
        try {
            target.dispatchEvent(new KeyboardEvent('keydown', shiftInit));
            const kdInit = makeInit(ch, { shiftKey: true });
            const kpInit = makeInit(ch, {
                shiftKey: true,
                keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0),
            });
            const kuInit = makeInit(ch, { shiftKey: true });
            target.dispatchEvent(new KeyboardEvent('keydown', kdInit));
            target.dispatchEvent(new KeyboardEvent('keypress', kpInit));
            target.dispatchEvent(new KeyboardEvent('keyup', kuInit));
            target.dispatchEvent(new KeyboardEvent('keyup',
                Object.assign({}, shiftInit, { shiftKey: false })));
        } catch (_) {}
    }

    // CRITICAL FIX: dispatch only ONCE, on a single target that will bubble
    // through the whole document tree. Previously we fired on document,
    // window, body and activeElement simultaneously — stamina's single
    // listener saw each keystroke 4+ times (direct + bubble duplicates),
    // which is why accuracy was 1%: for every typed character the site
    // counted 1 "right" and ~3 "wrong" keystrokes.
    //
    // Dispatching on document.body (or documentElement) with bubbles:true
    // reaches listeners attached to body → document → window exactly once.
    function fireEventTriple(ch) {
        const target = document.body || document.documentElement;
        if (!target) return;
        const kdInit = makeInit(ch);
        const kpInit = makeInit(ch, {
            keyCode: ch.charCodeAt(0),
            which: ch.charCodeAt(0),
        });
        const kuInit = makeInit(ch);
        try {
            target.dispatchEvent(new KeyboardEvent('keydown', kdInit));
            target.dispatchEvent(new KeyboardEvent('keypress', kpInit));
            target.dispatchEvent(new KeyboardEvent('keyup', kuInit));
        } catch (e) {
            if (cfg.diag) warn('dispatch failed:', e);
        }
        // Still fill a focused input's value — but only if the user has
        // explicitly focused an exercise textbox (NOT our panel's inputs,
        // which are inside `panel`).
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
            && !(panel && panel.contains(ae))) {
            try {
                const start = ae.selectionStart ?? ae.value.length;
                const before = ae.value.slice(0, start);
                const after = ae.value.slice(ae.selectionEnd ?? start);
                ae.value = before + ch + after;
                ae.selectionStart = ae.selectionEnd = start + 1;
                ae.dispatchEvent(new Event('input', { bubbles: true }));
            } catch (_) {}
        }
    }

    // -------------------------------------------------------------------------
    // Loop
    // -------------------------------------------------------------------------
    let running = false;
    let loopTimer = null;
    let startupTimer = null;
    const stats = { typed: 0, started: 0, lastChar: '' };
    let lastSentSig = null; // signature of the highlight tile we last pressed
    let stuckCount = 0;     // consecutive ticks where dedup blocked us

    function intervalMs() {
        // No upper cap — user may dial it as high as they want.
        const cpm = Math.max(1, cfg.cpm | 0);
        const base = 60000 / cpm;
        const h = Math.max(0, Math.min(90, cfg.humanize | 0));
        if (h <= 0) return base;
        return base + (Math.random() * 2 - 1) * base * (h / 100);
    }

    // Snapshot of what the DOM reports as the current highlighted key — used
    // by sync_mode to detect when the site has moved on to the next char.
    function currentHighlightSignature() {
        const t = findCurrentChar();
        if (!t) return null;
        return (t.element && (t.element.outerHTML || '')).slice(0, 120) + '|' + t.char;
    }

    function waitForHighlightChange(oldSig, timeoutMs, pollMs, cb) {
        const started = performance.now();
        (function poll() {
            if (!running) return cb(false);
            if (performance.now() - started > timeoutMs) return cb(false);
            const sig = currentHighlightSignature();
            if (sig !== oldSig) return cb(true);
            setTimeout(poll, pollMs);
        })();
    }

    function tick() {
        if (!running) return;
        // SAFETY: if the user clicked into our panel to change settings,
        // skip this tick — otherwise the auto-typer keeps hammering keys
        // "into" our own input, scrambling what they're typing.
        if (panel && panel.contains(document.activeElement)) {
            loopTimer = setTimeout(tick, 150);
            return;
        }
        const target = findCurrentChar();
        if (target === null) {
            setStatus('не нашёл текущий символ — ждём');
            if (cfg.diag) warn('no current char detected');
            loopTimer = setTimeout(tick, 500);
            return;
        }
        const ch = target.char;
        if (!ch) { loopTimer = setTimeout(tick, 500); return; }

        // DEDUP: compute the signature of the CURRENT highlight tile. If
        // we've already pressed this exact tile and the site hasn't moved
        // on, don't press again — just wait. This alone takes a 1% accuracy
        // run to near 100% because the overwhelming majority of error
        // keystrokes were duplicates fired before the site had a chance to
        // advance its cursor.
        //
        // UNSTICK: if the same tile has been there for too many ticks the
        // site is probably waiting for something we're not sending (Shift
        // for an uppercase char, Caps toggle, a key event that didn't
        // register for some reason). After a threshold we FORCE a fresh
        // keystroke, and after a larger threshold we force a Shift+key for
        // the current char even if it's lowercase.
        const sigBefore = currentHighlightSignature();
        if (cfg.dedup && sigBefore !== null && sigBefore === lastSentSig) {
            stuckCount += 1;
            // 15 polls ≈ 60 ms — normal site latency, keep waiting.
            if (stuckCount < 15) {
                loopTimer = setTimeout(tick, Math.max(2, cfg.sync_poll_ms | 0));
                return;
            }
            // 15-40 polls ≈ 60-160 ms — repeat the keystroke, maybe the
            // first one didn't register.
            if (stuckCount < 40) {
                if (cfg.diag) warn('unstick #1: resending', JSON.stringify(ch));
                fireEventTriple(ch);
                loopTimer = setTimeout(tick, 20);
                return;
            }
            // 40-80 polls — the uppercase case: fire Shift+char explicitly
            // in case stamina needs a modifier press for capitals / symbols.
            if (stuckCount < 80) {
                if (cfg.diag) warn('unstick #2: shift+' + JSON.stringify(ch));
                fireShiftThenChar(ch);
                loopTimer = setTimeout(tick, 30);
                return;
            }
            // Over 80 polls (~320 ms stuck) — give up on this tile, clear
            // the dedup lock so we're free to try any detection path. The
            // next tick will re-scan the DOM from scratch.
            if (cfg.diag) warn('unstick #3: clearing dedup lock');
            lastSentSig = null;
            stuckCount = 0;
            loopTimer = setTimeout(tick, 50);
            return;
        }
        stuckCount = 0;
        if (cfg.diag) log('typing', JSON.stringify(ch), 'via', target.source);
        fireEventTriple(ch);
        lastSentSig = sigBefore;
        stats.typed += 1;
        stats.lastChar = ch;
        updateCounter();
        let delay = intervalMs();
        if (ch === ' ' && (cfg.pause_ms | 0) > 0) delay += cfg.pause_ms;

        if (cfg.sync_mode && sigBefore !== null) {
            // Wait until the site advances to the next char (highlight moves)
            // before scheduling the next tick. Guarantees ~100% accuracy at
            // the cost of speed — intervalMs() becomes a MINIMUM, not fixed.
            waitForHighlightChange(sigBefore,
                Math.max(50, cfg.sync_timeout_ms | 0),
                Math.max(1, cfg.sync_poll_ms | 0),
                () => { loopTimer = setTimeout(tick, delay); });
        } else {
            loopTimer = setTimeout(tick, delay);
        }
    }

    function pressSpaceOnce() {
        if (cfg.diag) log('pressing SPACE to start the exercise');
        fireEventTriple(' ');
    }

    function start() {
        if (running) return;
        running = true;
        stats.started = Date.now();
        stats.typed = 0;
        lastSentSig = null;
        stuckCount = 0;
        setToggleButton(true);
        if (cfg.autostart_press_space) {
            setStatus('нажимаю Пробел (старт)…');
            pressSpaceOnce();
            // Give the site a moment to show the first task char.
            const delay = Math.max(50, cfg.startup_delay_ms | 0);
            startupTimer = setTimeout(() => {
                setStatus('работаю');
                tick();
            }, delay);
        } else {
            setStatus('работаю');
            tick();
        }
    }

    function stop() {
        running = false;
        if (loopTimer) clearTimeout(loopTimer);
        if (startupTimer) clearTimeout(startupTimer);
        loopTimer = null; startupTimer = null;
        setStatus('остановлен');
        setToggleButton(false);
    }

    function toggle() { if (running) stop(); else start(); }

    function sendEsc() {
        if (cfg.diag) log('sending ESC');
        const init = {
            key: 'Escape', code: 'Escape', keyCode: 27, which: 27, charCode: 0,
            bubbles: true, cancelable: true, composed: true, view: window,
        };
        for (const t of [document, window, document.body]) {
            try {
                t.dispatchEvent(new KeyboardEvent('keydown', init));
                t.dispatchEvent(new KeyboardEvent('keyup', init));
            } catch (_) {}
        }
    }

    function diagnose() {
        console.group(TAG + ' DIAGNOSTIC REPORT');
        log('location:', location.href);
        log('document.activeElement:', document.activeElement);
        // Scan the whole page for red-background tiles (primary stamina
        // detection path). Everything found here is what the auto-typer
        // will try to press.
        const reds = [];
        const all = document.body.getElementsByTagName('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (!el.offsetParent) continue;
            if (isPureRed(el)) {
                reds.push({
                    el,
                    text: (el.textContent || '').trim().slice(0, 20),
                    bg: getComputedStyle(el).backgroundColor,
                    className: el.className,
                    id: el.id,
                });
            }
        }
        log('red-background elements on page:', reds.length);
        reds.forEach((r, i) => log(i, r));
        const kbdCandidates = document.querySelectorAll(
            '.k, .key, [data-key], [data-char], .keyboard *, #keyboard *, .kb *, #kb *'
        );
        log('keyboard key candidates (by class/attr):', kbdCandidates.length);
        const highlighted = [];
        for (const el of kbdCandidates) {
            if (el.offsetParent && isHighlighted(el)) highlighted.push(el);
        }
        log('highlighted keyboard elements:', highlighted);
        for (const sel of SELECTORS_CURRENT) {
            const nodes = document.querySelectorAll(sel);
            if (nodes.length) log('selector', sel, '→', nodes.length, 'match(es):', nodes);
        }
        for (const sel of SELECTORS_CONTAINERS) {
            const el = document.querySelector(sel);
            if (el) log('container', sel, '→', el, 'text:', (el.textContent || '').slice(0, 60));
        }
        const target = findCurrentChar();
        log('findCurrentChar() →', target);
        console.groupEnd();
        setStatus(target
            ? 'нашёл символ: "' + target.char + '" (' + target.source + ')'
            : 'символ не найден — посмотри консоль F12');
    }

    // -------------------------------------------------------------------------
    // Panel UI
    // -------------------------------------------------------------------------
    const PANEL_HTML = `
    <div id="stamina-ac-panel" style="
        position: fixed; top: 20px; right: 20px; z-index: 2147483647;
        width: 280px; background: #16181d; color: #e3e7ef;
        border: 1px solid #2b2f3a; border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,.4);
        font: 13px/1.4 'Inter', 'Segoe UI', sans-serif;
        user-select: none;">
        <div id="sa-head" style="
            display: flex; align-items: center; justify-content: space-between;
            padding: 10px 12px; background: #1e2129; cursor: move;
            border-bottom: 1px solid #2b2f3a; border-radius: 10px 10px 0 0;">
            <div style="font-weight: 600;">⌨ Stamina Auto Typer</div>
            <button id="sa-collapse" style="all: unset; cursor: pointer;
                padding: 2px 8px; border-radius: 4px; background: #2a2f3a;
                font-size: 11px;">−</button>
        </div>
        <div id="sa-body" style="padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <label for="sa-cpm" style="opacity:.8;">Скорость (зн/мин)</label>
                <input id="sa-cpm" type="number" min="1" step="1"
                    style="width:96px;background:#0f1116;color:#e3e7ef;border:1px solid #2b2f3a;border-radius:4px;padding:3px 6px;text-align:right;"
                    title="Введи любое число и нажми Enter (или Tab). Лимита нет.">
            </div>
            <input id="sa-cpm-range" type="range" min="30" max="3000" step="10"
                style="width:100%;accent-color:#7f6df2;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <label for="sa-humanize" style="opacity:.8;">Humanize (±%)</label>
                <input id="sa-humanize" type="number" min="0" max="90" step="5"
                    style="width:72px;background:#0f1116;color:#e3e7ef;border:1px solid #2b2f3a;border-radius:4px;padding:3px 6px;text-align:right;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <label for="sa-pause" style="opacity:.8;">Пауза на пробел (мс)</label>
                <input id="sa-pause" type="number" min="0" max="2000" step="10"
                    style="width:72px;background:#0f1116;color:#e3e7ef;border:1px solid #2b2f3a;border-radius:4px;padding:3px 6px;text-align:right;">
            </div>
            <label style="display:flex;align-items:center;gap:6px;opacity:.85;cursor:pointer;">
                <input id="sa-sync" type="checkbox"> Sync-режим (точность ~100%, медленнее)
            </label>
            <label style="display:flex;align-items:center;gap:6px;opacity:.85;cursor:pointer;">
                <input id="sa-autospace" type="checkbox"> Нажимать Пробел перед стартом
            </label>
            <label style="display:flex;align-items:center;gap:6px;opacity:.85;cursor:pointer;">
                <input id="sa-diag" type="checkbox"> Диагностика в консоли
            </label>
            <button id="sa-toggle" style="
                all: unset; cursor: pointer; text-align: center;
                padding: 10px; border-radius: 6px; background: #7f6df2;
                color: white; font-weight: 600;">▶ Старт  (F8)</button>
            <div style="display:flex;gap:6px;">
                <button id="sa-esc" style="all:unset;cursor:pointer;text-align:center;flex:1;
                    padding: 7px; border-radius: 5px; background: #2a2f3a;
                    color: #e3e7ef; font-size:11px;">Esc (стоп на сайте)</button>
                <button id="sa-diag-btn" style="all:unset;cursor:pointer;text-align:center;flex:1;
                    padding: 7px; border-radius: 5px; background: #2a2f3a;
                    color: #e3e7ef; font-size:11px;">Диагностика</button>
            </div>
            <div id="sa-status-row" style="font-size:11px;opacity:.75;
                display:flex;justify-content:space-between;">
                <span id="sa-status">готов</span>
                <span id="sa-counter">0 зн.</span>
            </div>
            <div style="font-size:11px;opacity:.5;border-top:1px solid #2b2f3a;padding-top:6px;">
                F8 — старт/стоп&nbsp;·&nbsp;F9 — сброс&nbsp;·&nbsp;@xre1mm
            </div>
        </div>
    </div>`;

    let panel, statusEl, counterEl, toggleBtn;

    function mountPanel() {
        if (panel) return;
        const c = document.createElement('div');
        c.innerHTML = PANEL_HTML.trim();
        panel = c.firstElementChild;
        (document.body || document.documentElement).appendChild(panel);
        statusEl = panel.querySelector('#sa-status');
        counterEl = panel.querySelector('#sa-counter');
        toggleBtn = panel.querySelector('#sa-toggle');
        wireUp();
        setStatus('готов');
        updateCounter();
    }

    function wireUp() {
        const $cpm = panel.querySelector('#sa-cpm');
        const $range = panel.querySelector('#sa-cpm-range');
        const $hum = panel.querySelector('#sa-humanize');
        const $pause = panel.querySelector('#sa-pause');
        const $autospace = panel.querySelector('#sa-autospace');
        const $diag = panel.querySelector('#sa-diag');
        const $sync = panel.querySelector('#sa-sync');
        $cpm.value = cfg.cpm; $range.value = Math.min(3000, cfg.cpm);
        $hum.value = cfg.humanize; $pause.value = cfg.pause_ms;
        $autospace.checked = !!cfg.autostart_press_space;
        $diag.checked = !!cfg.diag;
        $sync.checked = !!cfg.sync_mode;

        // FIX: don't echo value back into the number input while the user is
        // still typing — that resets the caret and makes multi-digit entry
        // impossible. `rewrite` controls whether we overwrite $cpm.value.
        function syncCpm(v, rewrite) {
            v = Math.max(1, parseInt(v, 10) || 0);
            cfg.cpm = v; cfgSet('cpm', v);
            if (rewrite) $cpm.value = v;
            if (v <= 3000) $range.value = v;
        }
        // Change (fires on blur or Enter): accept whatever the user typed and
        // normalize the field value. Safe to rewrite the input here.
        $cpm.addEventListener('change', e => syncCpm(e.target.value, true));
        // Input (fires per keystroke): update config but DON'T rewrite the
        // input field — otherwise caret jumps and user can't finish typing.
        $cpm.addEventListener('input', e => syncCpm(e.target.value, false));
        // Range slider: always rewrite the number field.
        $range.addEventListener('input', e => syncCpm(e.target.value, true));
        $hum.addEventListener('change', e => {
            cfg.humanize = Math.max(0, Math.min(90, parseInt(e.target.value, 10) || 0));
            cfgSet('humanize', cfg.humanize);
        });
        $pause.addEventListener('change', e => {
            cfg.pause_ms = Math.max(0, Math.min(10000, parseInt(e.target.value, 10) || 0));
            cfgSet('pause_ms', cfg.pause_ms);
        });
        $autospace.addEventListener('change', e => {
            cfg.autostart_press_space = !!e.target.checked;
            cfgSet('autostart_press_space', cfg.autostart_press_space);
        });
        $diag.addEventListener('change', e => {
            cfg.diag = !!e.target.checked;
            cfgSet('diag', cfg.diag);
        });
        $sync.addEventListener('change', e => {
            cfg.sync_mode = !!e.target.checked;
            cfgSet('sync_mode', cfg.sync_mode);
        });

        toggleBtn.addEventListener('click', toggle);
        panel.querySelector('#sa-esc').addEventListener('click', sendEsc);
        panel.querySelector('#sa-diag-btn').addEventListener('click', diagnose);

        const body = panel.querySelector('#sa-body');
        const collapseBtn = panel.querySelector('#sa-collapse');
        let collapsed = false;
        collapseBtn.addEventListener('click', () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : 'flex';
            collapseBtn.textContent = collapsed ? '+' : '−';
        });

        const head = panel.querySelector('#sa-head');
        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        head.addEventListener('mousedown', e => {
            if (e.target.closest('button')) return;
            dragging = true;
            const r = panel.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
            panel.style.left = sl + 'px'; panel.style.top = st + 'px';
            panel.style.right = 'auto';
            e.preventDefault();
        });
        window.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (sl + e.clientX - sx) + 'px';
            panel.style.top = (st + e.clientY - sy) + 'px';
        });
        window.addEventListener('mouseup', () => { dragging = false; });

        window.addEventListener('keydown', e => {
            if (e.key === cfg.hotkey_toggle) { e.preventDefault(); toggle(); }
            else if (e.key === cfg.hotkey_reset) {
                e.preventDefault();
                stats.typed = 0; stats.started = Date.now();
                updateCounter();
            }
        }, true);

        // CRITICAL FIX: stamina-online listens for keystrokes on window /
        // document to track the exercise. When the user types a number into
        // our speed input, those keystrokes ALSO reach stamina — which eats
        // them as "typing in the exercise" and often moves focus away or
        // discards the input. We stop the propagation of every keyboard
        // event whose target is inside our panel, in capture phase, so the
        // site's listeners never see them.
        const swallowIfInsidePanel = e => {
            if (panel && panel.contains(e.target)) {
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        };
        for (const type of ['keydown', 'keyup', 'keypress']) {
            window.addEventListener(type, swallowIfInsidePanel, true);
            document.addEventListener(type, swallowIfInsidePanel, true);
        }

        // Also: when ANY input in our panel is focused, we temporarily
        // discard every keyboard event on window too — some sites install
        // very-early capture-phase listeners that would still fire. This
        // makes the "user types in panel" path hermetic.
        const panelInputs = panel.querySelectorAll('input, textarea, select');
        panelInputs.forEach(inp => {
            inp.addEventListener('keydown', e => e.stopPropagation(), true);
            inp.addEventListener('keyup', e => e.stopPropagation(), true);
            inp.addEventListener('keypress', e => e.stopPropagation(), true);
            // Also stop click bubbling so the site doesn't blur our input.
            inp.addEventListener('click', e => e.stopPropagation(), true);
            inp.addEventListener('mousedown', e => e.stopPropagation(), true);
        });
    }

    function setStatus(s) { if (statusEl) statusEl.textContent = s; }

    function updateCounter() {
        if (!counterEl) return;
        const elapsed = stats.started ? Math.max(0.1, (Date.now() - stats.started) / 1000) : 0;
        const cpm = elapsed > 0 && stats.typed > 0 ? Math.round((stats.typed / elapsed) * 60) : 0;
        counterEl.textContent = stats.typed + ' зн.' + (cpm > 0 ? '  ·  ' + cpm + ' зн/мин' : '');
    }

    function setToggleButton(on) {
        if (!toggleBtn) return;
        toggleBtn.textContent = on ? '■ Стоп  (F8)' : '▶ Старт  (F8)';
        toggleBtn.style.background = on ? '#d9534f' : '#7f6df2';
    }

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------
    function boot() {
        if (!document.body) { setTimeout(boot, 50); return; }
        mountPanel();
        setInterval(() => { if (running) updateCounter(); }, 500);
        log('ready — press F8 or the ▶ button to start.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
