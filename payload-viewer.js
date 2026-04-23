/* global CodeMirror */
(function () {
    const STORAGE_KEY = 'kssPayloadViewer';

    function modeForFormat(formatId) {
        if (formatId === 'xml') return 'xml';
        if (formatId === 'json') return { name: 'javascript', json: true };
        return null;
    }

    function init() {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        try {
            sessionStorage.removeItem(STORAGE_KEY);
        } catch (_) { /* ignore */ }

        if (!raw) {
            document.body.innerHTML = '<p style="padding:16px;font-family:system-ui,sans-serif;color:#64748b;">No payload to display.</p>';
            return;
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            document.body.textContent = 'Invalid payload data.';
            return;
        }

        const theme = data.theme === 'light' ? 'light' : 'dark';
        document.body.setAttribute('data-theme', theme);

        const formatId = data.formatId && ['json', 'xml', 'text'].includes(data.formatId) ? data.formatId : 'json';
        const labels = { json: 'JSON', xml: 'XML', text: 'Plain text' };
        document.title = `Message — ${labels[formatId]}`;

        const text = data.text != null ? String(data.text) : '';
        const mode = modeForFormat(formatId);
        const host = document.getElementById('editor');
        if (!host || typeof CodeMirror === 'undefined') {
            document.body.textContent = 'Editor could not load.';
            return;
        }

        const cm = CodeMirror(host, {
            value: text,
            readOnly: true,
            lineNumbers: true,
            lineWrapping: true,
            theme: 'default',
            mode,
            indentUnit: 2,
            tabSize: 2,
        });
        cm.setSize('100%', '100%');
        window.addEventListener('resize', () => {
            try {
                cm.refresh();
            } catch (_) { /* ignore */ }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
