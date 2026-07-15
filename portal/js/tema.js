/* ============================================
   PORTAL DOCUMENTAL - Tema claro / oscuro
   Sirve para el login (index.html) y el portal (app.html).
   El tema se guarda en localStorage('portal_tema'). Un script en el <head>
   de cada página aplica el tema ANTES de pintar (evita el parpadeo); este
   archivo solo maneja el botón para cambiarlo.
   ============================================ */
(function () {
    const CLAVE_TEMA = 'portal_tema';

    function esOscuro() {
        return document.documentElement.dataset.tema === 'oscuro';
    }

    // Cambia el tema y lo recuerda
    window.alternarTema = function () {
        const html = document.documentElement;
        if (esOscuro()) {
            delete html.dataset.tema;
            try { localStorage.setItem(CLAVE_TEMA, 'claro'); } catch (e) { /* sin storage */ }
        } else {
            html.dataset.tema = 'oscuro';
            try { localStorage.setItem(CLAVE_TEMA, 'oscuro'); } catch (e) { /* sin storage */ }
        }
        pintarBotonesTema();
    };

    // Pone en cada botón de tema el icono correcto (sol si está oscuro → para
    // volver a claro; luna si está claro) y las etiquetas de accesibilidad.
    function pintarBotonesTema() {
        const oscuro = esOscuro();
        document.querySelectorAll('[data-accion="alternar-tema"]').forEach(function (boton) {
            const tam = boton.dataset.iconoTam ? Number(boton.dataset.iconoTam) : 18;
            if (typeof icono === 'function') boton.innerHTML = icono(oscuro ? 'sol' : 'luna', tam);
            boton.setAttribute('aria-pressed', String(oscuro));
            const etq = oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
            boton.setAttribute('aria-label', etq);
            boton.setAttribute('title', etq);
        });
    }
    window.pintarBotonesTema = pintarBotonesTema;

    // Un solo escuchador para ambas páginas (no depende de app.js / login.js)
    document.addEventListener('click', function (evento) {
        const boton = evento.target.closest('[data-accion="alternar-tema"]');
        if (boton) { evento.preventDefault(); window.alternarTema(); }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', pintarBotonesTema);
    } else {
        pintarBotonesTema();
    }
})();
