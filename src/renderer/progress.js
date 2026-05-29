/**
 * Shared progress bar UI helper for network operations.
 */

let opSeq = 0;

/**
 * @param {string} [containerId] - element id to mount progress bar into
 * @returns {{ opId: string, show: Function, update: Function, hide: Function, bind: Function }}
 */
function createProgressTracker(containerId) {
    const opId = `op-${Date.now()}-${++opSeq}`;
    let root = null;
    let bar = null;
    let label = null;
    let mountedContainer = null;

    function ensureMounted(target) {
        const container = target || (containerId ? document.getElementById(containerId) : null);
        if (!container) return false;
        if (root && mountedContainer === container) return true;

        root = document.createElement('div');
        root.className = 'kss-progress';
        root.hidden = true;
        root.setAttribute('role', 'progressbar');
        root.setAttribute('aria-valuemin', '0');
        root.setAttribute('aria-valuemax', '100');

        const track = document.createElement('div');
        track.className = 'kss-progress-track';
        bar = document.createElement('div');
        bar.className = 'kss-progress-bar';
        track.appendChild(bar);

        label = document.createElement('span');
        label.className = 'kss-progress-label';

        root.appendChild(track);
        root.appendChild(label);
        container.prepend(root);
        mountedContainer = container;
        return true;
    }

    function setIndeterminate(active) {
        if (!bar) return;
        bar.classList.toggle('kss-progress-bar--indeterminate', active);
    }

    function show(message, options) {
        const target = (options && options.container) || null;
        if (!ensureMounted(target)) return;
        root.hidden = false;
        setIndeterminate(true);
        if (label) label.textContent = message || 'Loading…';
        if (bar) bar.style.width = '0%';
    }

    function update(payload) {
        if (!root || root.hidden) {
            show(payload && payload.message ? payload.message : 'Loading…');
        }
        const msg = payload && payload.message ? payload.message : '';
        if (label && msg) label.textContent = msg;

        let pct = null;
        if (payload && typeof payload.percent === 'number') {
            pct = Math.max(0, Math.min(100, payload.percent));
        } else if (payload && payload.total > 0 && typeof payload.current === 'number') {
            pct = Math.round((payload.current / payload.total) * 100);
        }

        if (pct != null && bar) {
            setIndeterminate(false);
            bar.style.width = `${pct}%`;
            root.setAttribute('aria-valuenow', String(pct));
        } else {
            setIndeterminate(true);
        }
    }

    function hide() {
        if (!root) return;
        root.hidden = true;
        setIndeterminate(false);
        if (bar) bar.style.width = '0%';
        if (label) label.textContent = '';
    }

    function bind(containerEl) {
        return {
            opId,
            show: (msg) => show(msg, { container: containerEl }),
            update,
            hide,
        };
    }

    return { opId, show, update, hide, bind };
}

/**
 * Global top-of-app progress bar.
 */
function createGlobalProgressTracker() {
    let tracker = null;
    return {
        get opId() {
            if (!tracker) tracker = createProgressTracker('globalProgressContainer');
            return tracker.opId;
        },
        show(msg) {
            if (!tracker) tracker = createProgressTracker('globalProgressContainer');
            tracker.show(msg);
        },
        update(payload) {
            if (!tracker) tracker = createProgressTracker('globalProgressContainer');
            tracker.update(payload);
        },
        hide() {
            if (tracker) tracker.hide();
        },
    };
}

const globalProgress = createGlobalProgressTracker();

module.exports = {
    createProgressTracker,
    globalProgress,
};
