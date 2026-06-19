/**
 * Make a fixed-positioned element draggable by a handle (e.g. its title bar).
 * Pins the element to left/top on first drag (clearing right/bottom) and clamps to the
 * viewport. Drags that start on an interactive control are ignored so buttons/sliders work.
 */
export function makeDraggable(el, handle) {
    handle.style.cursor = 'move';
    handle.style.userSelect = 'none';
    handle.style.touchAction = 'none';

    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button,input,select,textarea,a,label')) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';

        const startX = e.clientX;
        const startY = e.clientY;
        const origLeft = rect.left;
        const origTop = rect.top;

        const move = (ev) => {
            const nx = Math.max(0, Math.min(window.innerWidth - 40, origLeft + ev.clientX - startX));
            const ny = Math.max(0, Math.min(window.innerHeight - 28, origTop + ev.clientY - startY));
            el.style.left = `${nx}px`;
            el.style.top = `${ny}px`;
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });
}
