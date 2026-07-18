// packages/governance/index.js
// Admin Command Desk login validation with runtime-provided PIN
// Non-blocking, isolated from tab logic
// + Phase 2: Feature flags + routing matrix

export const RECONCILED_PIN_KEY =
    (typeof globalThis !== 'undefined' && typeof globalThis.PPBF_ADMIN_UNLOCK_PIN === 'string')
        ? globalThis.PPBF_ADMIN_UNLOCK_PIN.trim()
        : '';

export * from './featureFlags'; // isFeatureEnabled, getEnabledCapabilities, ROUTING_MATRIX
export * from './boundedContext'; // boundedContexts, enforceBoundedContext
export * from './errorHandler'; // handlePPBFError
export * from './version'; // PPBF_VERSION and getVersionInfo





export function showAdminPinEntry() {
    // If already present, focus it
    let zone = document.getElementById('pinEntryZone');
    if (zone) {
        const inp = document.getElementById('pinInput');
        if (inp) inp.focus();
        return;
    }

    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;

    zone = document.createElement('div');
    zone.id = 'pinEntryZone';
    zone.className = 'pin-entry';
    zone.innerHTML =
        '<input id="pinInput" type="password" maxlength="5" placeholder="5-digit PIN" />' +
        '<button id="pinSubmitBtn">Unlock</button>' +
        '<button id="pinCancelBtn">Cancel</button>';

    navLinks.appendChild(zone);

    const input = document.getElementById('pinInput');
    const submit = document.getElementById('pinSubmitBtn');
    const cancel = document.getElementById('pinCancelBtn');

    function cleanup() {
        if (zone && zone.parentNode) zone.parentNode.removeChild(zone);
    }

    function tryUnlock() {
        const val = (input ? input.value : '').trim();
        if (!RECONCILED_PIN_KEY) {
            if (input) {
                input.style.borderColor = '#e53e3e';
                input.value = '';
                input.placeholder = 'Admin unlock PIN not configured';
            }
            return;
        }
        if (val === RECONCILED_PIN_KEY) {
            performAdminUnlock();
            cleanup();
        } else {
            if (input) {
                input.style.borderColor = '#e53e3e';
                input.value = '';
                setTimeout(function() { if (input) input.style.borderColor = '#4a5568'; }, 800);
            }
        }
    }

    if (submit) submit.addEventListener('click', tryUnlock);
    if (cancel) cancel.addEventListener('click', cleanup);
    if (input) {
        input.addEventListener('keydown', function(ev) {
            if (ev.key === 'Enter') tryUnlock();
        });
        input.focus();
        input.select();
    }
}

export function performAdminUnlock() {
    // ONLY responsibility: reveal admin nav items by stripping hiding class. No tab switching.
    document.querySelectorAll('.admin-nav-item').forEach(function(el) {
        el.classList.remove('admin-nav-item');
        el.style.display = '';
    });
    const gate = document.getElementById('gatekeeperToggleBtn');
    if (gate) gate.style.display = 'none';

    // Non-blocking success signal
    const term = document.getElementById('masterTerminalTelemetryDataStreamOutputBox');
    if (term) term.textContent = '[ADMIN UNLOCKED] Coach Command Desk + Grant Analytics now enabled.';

    // Optionally refresh data
    if (typeof window.initializeEcosystemDataTables === 'function') {
        window.initializeEcosystemDataTables();
    }
}
