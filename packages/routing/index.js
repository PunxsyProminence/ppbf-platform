// packages/routing/index.js
// Decoupled tab routing logic using clean event listeners
// + Phase 2: Route factory (16 task dims × 11 lifecycle tags)

export * from './routeFactory'; // generateRoute, ALL_LIFECYCLE_TAGS, ALL_TASK_DIMENSIONS

export function switchTab(panelId) {
    document.querySelectorAll('.view-panel').forEach(function(p) {
        p.classList.remove('active');
    });
    document.querySelectorAll('.nav-btn').forEach(function(b) {
        b.classList.remove('active');
    });

    const panel = document.getElementById(panelId);
    if (panel) {
        panel.classList.add('active');
    }

    const btn = document.querySelector('.nav-btn[data-panel="' + panelId + '"]');
    if (btn) {
        btn.classList.add('active');
    }
    console.log("[DOM NAVIGATION ROUTE SUCCESS] Workspace view snapped to target node: " + panelId);
}

export function setupTabListeners() {
    const navContainer = document.querySelector('.nav-links');
    if (!navContainer) return;

    // Single isolated delegation listener for all tabs (clean + future-proof)
    navContainer.addEventListener('click', function(e) {
        const btn = e.target.closest('.nav-btn');
        if (!btn) return;
        const panelId = btn.getAttribute('data-panel');
        if (panelId) {
            switchTab(panelId);
        }
    });
}

// Backward compat
export const executeExplicitTabRouting = function(panelTargetId) {
    if (panelTargetId) switchTab(panelTargetId);
};
