/* Interruptor de tema para las páginas legales.
   Comparte el mismo almacén que el portal y el diagnóstico
   ('portal_tema'), así el tema es uno solo en todo el sitio. */
(function () {
    const SOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    const LUNA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    const boton = document.getElementById('btn-tema');
    if (!boton) return;
    const pintar = function () {
        const oscuro = document.documentElement.dataset.tema === 'oscuro';
        boton.innerHTML = oscuro ? SOL : LUNA;
        boton.title = oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
        boton.setAttribute('aria-label', boton.title);
    };
    boton.addEventListener('click', function () {
        const oscuro = document.documentElement.dataset.tema === 'oscuro';
        if (oscuro) delete document.documentElement.dataset.tema;
        else document.documentElement.dataset.tema = 'oscuro';
        try { localStorage.setItem('portal_tema', oscuro ? 'claro' : 'oscuro'); } catch (e) {}
        pintar();
    });
    pintar();
})();
