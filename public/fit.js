/* Make the crew pages fit a phone even when Chrome's "Desktop site" is on.
 *
 * Found 20 November: Khizar's phone signed in as a desktop browser, so Chrome
 * ignored the page's phone settings, laid it out about 980px wide and shrank
 * it to fit. Crew phones can have the same setting on. When the page is much
 * wider than the phone's own screen, on a touch screen, it is zoomed back up
 * so it lays out at the phone's real width.
 *
 * Loaded in <head>, before anything is drawn. ?fit=412 forces it for testing.
 */
(function () {
  try {
    var html = document.documentElement;
    var forced = Number((location.search.match(/[?&]fit=(\d{3})/) || [])[1]);
    var screenW = forced || Math.min(screen.width, screen.height);
    var pageW = html.clientWidth || window.innerWidth;
    var touch = forced || navigator.maxTouchPoints > 0 || "ontouchstart" in window;
    if (!touch || !screenW || screenW > 700 || pageW < screenW * 1.3) return;
    html.style.zoom = (pageW / screenW).toFixed(3);
  } catch (e) { /* leave the page as it is */ }
})();
