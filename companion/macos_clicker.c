/*
 * MyWay Moswar Companion — нативный кликер macOS (Accessibility + CoreGraphics).
 *
 * Назначение: выполнить настоящий доверенный клик (isTrusted: true) в веб-область
 * окна Chrome, не требуя перезапуска браузера с флагами отладки и не искажая
 * позицию курсора пользователя.
 *
 * Почему именно Accessibility API:
 *   - координаты viewport берутся из реальной геометрии окна (AXWebArea),
 *     поэтому panels/DevTools/Ribbon/рамки и масштаб вкладки не влияют на попадание;
 *   - событие мыши создаётся на уровне HID-тапа, поэтому браузер помечает его
 *     как доверенное — игра получает честный isTrusted без каких-либо патчей JS.
 *
 * Зависимости: только системные фреймворки (ApplicationServices, CoreGraphics,
 * CoreFoundation). Внешние пакеты не требуются.
 *
 * Режимы:
 *   mw_clicker_mac --status
 *       JSON: {ok, trusted, displays:[{id,scale}]}
 *   mw_clicker_mac --probe <clientX> <clientY> <dpr> [titleSubstring]
 *       Только расчёт геометрии, БЕЗ клика (для проверки наводки).
 *   mw_clicker_mac --click <clientX> <clientY> <dpr> [titleSubstring]
 *       JSON: {ok, mode, viewport:{x,y,w,h}, point:{x,y}, zoom, window, error}
 */

#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>

/* ---------------- helpers ---------------- */

char g_windowTitle[512] = {0};

static CFTypeRef copyAttr(AXUIElementRef el, CFStringRef name) {
    CFTypeRef value = NULL;
    if (el == NULL) return NULL;
    if (AXUIElementCopyAttributeValue(el, name, &value) != kAXErrorSuccess) return NULL;
    return value;
}

static int attrPointRel(AXUIElementRef el, CFStringRef name, CGPoint *out) {
    CFTypeRef v = copyAttr(el, name);
    int ok = 0;
    if (v) {
        if (AXValueGetType(v) == kAXValueCGPointType) ok = AXValueGetValue(v, kAXValueCGPointType, out) ? 1 : 0;
        CFRelease(v);
    }
    return ok;
}

static int attrSizeRel(AXUIElementRef el, CFStringRef name, CGSize *out) {
    CFTypeRef v = copyAttr(el, name);
    int ok = 0;
    if (v) {
        if (AXValueGetType(v) == kAXValueCGSizeType) ok = AXValueGetValue(v, kAXValueCGSizeType, out) ? 1 : 0;
        CFRelease(v);
    }
    return ok;
}

static void attrStringRel(AXUIElementRef el, CFStringRef name, char *buf, size_t cap) {
    buf[0] = 0;
    CFTypeRef v = copyAttr(el, name);
    if (v && CFGetTypeID(v) == CFStringGetTypeID()) {
        CFStringGetCString((CFStringRef)v, buf, (CFIndex)cap, kCFStringEncodingUTF8);
    }
    if (v) CFRelease(v);
}

/* Масштаф дисплея: физических пикселей на 1 point (2 на Retina). */static double displayScaleForPoint(CGPoint p) {
    uint32_t dispID = CGMainDisplayID();
    CGDirectDisplayID displays[8];
    uint32_t count = 0;
    if (CGGetActiveDisplayList(8, displays, &count) == kCGErrorSuccess && count > 0) {
        dispID = displays[0];
        for (uint32_t i = 0; i < count; i++) {
            CGRect b = CGDisplayBounds(displays[i]);
            if (p.x >= b.origin.x && p.x < b.origin.x + b.size.width &&
                p.y >= b.origin.y && p.y < b.origin.y + b.size.height) {
                dispID = displays[i];
                break;
            }
        }
    }
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(dispID);
    if (!mode) return 2.0;
    size_t pxW = CGDisplayModeGetPixelWidth(mode);
    size_t ptW = CGDisplayModeGetWidth(mode);
    double scale = (ptW > 0) ? ((double)pxW / (double)ptW) : 2.0;
    CGDisplayModeRelease(mode);
    return scale > 0.0 ? scale : 2.0;
}

/* Рекурсивный поиск AXWebArea — точной области, в которой рисуется страница. */
static AXUIElementRef findWebArea(AXUIElementRef el, int depth) {
    if (el == NULL || depth > 24) return NULL;
    char role[64];
    attrStringRel(el, kAXRoleAttribute, role, sizeof(role));
    if (strcmp(role, "AXWebArea") == 0) {
        return (AXUIElementRef)CFRetain(el);
    }
    CFTypeRef kids = copyAttr(el, kAXChildrenAttribute);
    AXUIElementRef found = NULL;
    if (kids && CFGetTypeID(kids) == CFArrayGetTypeID()) {
        CFIndex n = CFArrayGetCount((CFArrayRef)kids);
        for (CFIndex i = 0; i < n && !found; i++) {
            found = findWebArea((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)kids, i), depth + 1);
        }
    }
    if (kids) CFRelease(kids);
    return found;
}

/* Chrome включает дерево доступности лениво — просим явно. */
static void enableAccessibility(AXUIElementRef app) {
    if (!app) return;
    CFTypeRef yes = kCFBooleanTrue;
    AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), yes);
    AXUIElementSetAttributeValue(app, CFSTR("AXEnhancedUserInterface"), yes);
}

/* Поиск элемента по подстроке в AXTitle/AXDescription/AXValue.
 * Возвращает CFRetain'нутый элемент; координаты центра — в outCenter (global points). */
static AXUIElementRef findByLabel(AXUIElementRef el, const char *needle, int depth, CGPoint *outCenter) {
    if (el == NULL || depth > 40) return NULL;

    char role[64], text[512];
    text[0] = 0;
    attrStringRel(el, kAXRoleAttribute, role, sizeof(role));
    attrStringRel(el, kAXTitleAttribute, text, sizeof(text));
    if (!text[0]) attrStringRel(el, kAXDescriptionAttribute, text, sizeof(text));
    if (!text[0]) attrStringRel(el, kAXValueAttribute, text, sizeof(text));

    int isClickable = (strcmp(role, "AXButton") == 0 || strcmp(role, "AXLink") == 0 ||
                       strcmp(role, "AXCheckBox") == 0 || strcmp(role, "AXMenuItem") == 0);

    if (isClickable && needle && *needle && text[0] && strstr(text, needle)) {
        CGPoint pos; CGSize sz;
        if (attrPointRel(el, kAXPositionAttribute, &pos) && attrSizeRel(el, kAXSizeAttribute, &sz) &&
            sz.width > 1 && sz.height > 1) {
            outCenter->x = pos.x + sz.width / 2.0;
            outCenter->y = pos.y + sz.height / 2.0;
            return (AXUIElementRef)CFRetain(el);
        }
    }

    CFTypeRef kids = copyAttr(el, kAXChildrenAttribute);
    AXUIElementRef found = NULL;
    if (kids && CFGetTypeID(kids) == CFArrayGetTypeID()) {
        CFIndex n = CFArrayGetCount((CFArrayRef)kids);
        for (CFIndex i = 0; i < n && !found; i++) {
            found = findByLabel((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)kids, i), needle, depth + 1, outCenter);
        }
    }
    if (kids) CFRelease(kids);
    return found;
}

/* Выбор окна: совпадение по подстроке заголовка, иначе главное/первое с web-областью. */
static AXUIElementRef pickWindow(AXUIElementRef app, const char *titleHint) {
    CFTypeRef wins = copyAttr(app, kAXWindowsAttribute);
    if (!wins || CFGetTypeID(wins) != CFArrayGetTypeID()) { if (wins) CFRelease(wins); return NULL; }

    CFIndex n = CFArrayGetCount((CFArrayRef)wins);
    AXUIElementRef best = NULL;
    char bestTitle[512]; bestTitle[0] = 0;

    for (CFIndex i = 0; i < n; i++) {
        AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)wins, i);
        AXUIElementRef area = findWebArea(w, 0);
        if (!area) continue;
        CFRelease(area);

        char t[512];
        attrStringRel(w, kAXTitleAttribute, t, sizeof(t));
        if (titleHint && *titleHint && strstr(t, titleHint)) {
            best = (AXUIElementRef)CFRetain(w);
            snprintf(bestTitle, sizeof(bestTitle), "%s", t);
            break;
        }
        if (!best) {
            best = (AXUIElementRef)CFRetain(w);
            snprintf(bestTitle, sizeof(bestTitle), "%s", t);
        }
    }
    CFRelease(wins);
    if (best) {
        snprintf(g_windowTitle, sizeof(g_windowTitle), "%s", bestTitle);
    }
    return best;
}

/* Chrome строит дерево доступности лениво: первый запрос может вернуть пусто.
 * Поэтому окно ищем с повторами, каждый раз явно включая AX. */
static AXUIElementRef pickWindowRetry(AXUIElementRef app, const char *titleHint, int attempts) {
    AXUIElementRef win = NULL;
    for (int i = 0; i < attempts; i++) {
        enableAccessibility(app);
        win = pickWindow(app, titleHint);
        if (win) {
            AXUIElementRef area = findWebArea(win, 0);
            if (area) { CFRelease(area); return win; }
            CFRelease(win);
            win = NULL;
        }
        usleep(350000);
    }
    return win;
}

static void jsonEscape(const char *s, char *out, size_t cap) {
    size_t o = 0;
    for (const char *p = s; *p && o + 2 < cap; p++) {
        if (*p == '"' || *p == '\\') { out[o++] = '\\'; out[o++] = *p; }
        else if ((unsigned char)*p < 32) { out[o++] = ' '; }
        else out[o++] = *p;
    }
    out[o] = 0;
}

/* ---------------- режимы ---------------- */

static int printStatus(void) {
    int trusted = AXIsProcessTrusted() ? 1 : 0;
    uint32_t count = 0;
    CGGetActiveDisplayList(0, NULL, &count);
    CGDirectDisplayID ids[16];
    if (count > 16) count = 16;
    CGGetActiveDisplayList(count, ids, &count);

    char disp[1024]; size_t o = 0;
    disp[0] = 0;
    for (uint32_t i = 0; i < count; i++) {
        CGDisplayModeRef m = CGDisplayCopyDisplayMode(ids[i]);
        double sc = 2.0;
        if (m) {
            size_t pw = CGDisplayModeGetPixelWidth(m), ptw = CGDisplayModeGetWidth(m);
            if (ptw > 0) sc = (double)pw / (double)ptw;
            CGDisplayModeRelease(m);
        }
        o += (size_t)snprintf(disp + o, sizeof(disp) - o, "%s{\"index\":%u,\"scale\":%.3f}",
                              i ? "," : "", (unsigned)i, sc);
    }
    printf("{\"ok\":true,\"trusted\":%s,\"displayCount\":%u,\"displays\":[%s]}\n",
           trusted ? "true" : "false", (unsigned)count, disp);
    return trusted ? 0 : 3;
}

/* Реальный масштаб страницы считаем из геометрии, а не из devicePixelRatio:
 * zoom = (ширина web-области в points) / (CSS-ширина окна). Такой расчёт
 * одинаково верен для 80%, 100%, 110% и любого «More Space» на дисплее.
 * cssW/cssH могут прийти нулевыми — тогда fallback на dpr/scale. */
static void computeZoom(CGSize vp, double cssW, double cssH, double dpr, double scale,
                        double *outX, double *outY) {
    double zx = 0, zy = 0;
    if (cssW > 50 && vp.width > 50) zx = vp.width / cssW;
    if (cssH > 50 && vp.height > 50) zy = vp.height / cssH;

    double fallback = (dpr > 0 && scale > 0) ? (dpr / scale) : 1.0;
    if (fallback <= 0 || fallback > 4) fallback = 1.0;

    /* Geometry-расчёт доверяем только в разумных пределах (25%..400%). */
    if (zx <= 0.2 || zx > 4) zx = fallback;
    if (zy <= 0.2 || zy > 4) zy = fallback;

    /* Оси должны совпадать: расхождение больше 2% означает, что один из
     * размеров неверен (например, панель DevTools) — берём dpr-оценку. */
    if (fabs(zx - zy) / zx > 0.02) {
        zx = zy = fallback;
    }
    *outX = zx;
    *outY = zy;
}

/* Возвращает фокус предыдущему приложению: пользователь мог работать в другом
 * окне, а кликер обязан только нажать кнопку и увести курсор обратно. */
static void restoreFrontmost(AXUIElementRef previous) {
    if (!previous) return;
    AXUIElementSetAttributeValue(previous, kAXFrontmostAttribute, kCFBooleanTrue);
    CFRelease(previous);
}

static AXUIElementRef copyFrontmostApp(void) {
    AXUIElementRef sys = AXUIElementCreateSystemWide();
    CFTypeRef app = NULL;
    if (sys) {
        if (AXUIElementCopyAttributeValue(sys, kAXFocusedApplicationAttribute, &app) != kAXErrorSuccess) app = NULL;
        CFRelease(sys);
    }
    return (AXUIElementRef)app;
}

/* Постrealistичной цепочки в глобальных координатах + возврат курсора. */
static void postClickChain(CGPoint target) {
    CGEventRef probe = CGEventCreate(NULL);
    CGPoint saved = probe ? CGEventGetLocation(probe) : CGPointZero;
    if (probe) CFRelease(probe);

    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, target, kCGMouseButtonLeft);
    if (move) { CGEventPost(kCGHIDEventTap, move); CFRelease(move); }
    usleep(30000);

    CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, target, kCGMouseButtonLeft);
    if (down) { CGEventSetIntegerValueField(down, kCGMouseEventClickState, 1); CGEventPost(kCGHIDEventTap, down); CFRelease(down); }
    usleep(80000);

    CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, target, kCGMouseButtonLeft);
    if (up) { CGEventSetIntegerValueField(up, kCGMouseEventClickState, 1); CGEventPost(kCGHIDEventTap, up); CFRelease(up); }
    usleep(20000);

    CGEventRef back = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, saved, kCGMouseButtonLeft);
    if (back) { CGEventPost(kCGHIDEventTap, back); CFRelease(back); }
}

/* Диагностика: список окон приложения с заголовками и наличием AXWebArea. */
static int printWindows(pid_t pid, const char *needle) {
    char esc[1024]; esc[0] = 0;
    (void)needle;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) { printf("{\"ok\":false,\"error\":\"no_app\"}\n"); return 2; }
    AXUIElementSetMessagingTimeout(app, 3.0f);
    enableAccessibility(app);
    /* Даём Chrome время построить дерево лениво. */
    CFTypeRef wins = NULL;
    int got = -1;
    for (int attempt = 0; attempt < 6; attempt++) {
        if (wins) { CFRelease(wins); wins = NULL; }
        got = (int)AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &wins);
        if (got == kAXErrorSuccess && wins && CFArrayGetCount((CFArrayRef)wins) > 0) break;
        usleep(400000);
    }

    if (!wins || CFGetTypeID(wins) != CFArrayGetTypeID()) {
        printf("{\"ok\":false,\"error\":\"no_windows\",\"axError\":%d,\"pid\":%d}\n", got, (int)pid);
        if (wins) CFRelease(wins);
        CFRelease(app);
        return 2;
    }

    CFIndex n = CFArrayGetCount((CFArrayRef)wins);
    printf("{\"ok\":true,\"pid\":%d,\"windowCount\":%d,\"windows\":[", (int)pid, (int)n);
    for (CFIndex i = 0; i < n; i++) {
        AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)wins, i);
        char t[512]; attrStringRel(w, kAXTitleAttribute, t, sizeof(t));
        CGPoint pos = CGPointZero; CGSize sz = CGSizeZero;
        attrPointRel(w, kAXPositionAttribute, &pos);
        attrSizeRel(w, kAXSizeAttribute, &sz);
        AXUIElementRef area = findWebArea(w, 0);
        char at[512]; at[0] = 0;
        CGPoint apos = CGPointZero; CGSize asz = CGSizeZero;
        if (area) {
            attrStringRel(area, kAXValueAttribute, at, sizeof(at));
            if (!at[0]) attrStringRel(area, kAXTitleAttribute, at, sizeof(at));
            attrPointRel(area, kAXPositionAttribute, &apos);
            attrSizeRel(area, kAXSizeAttribute, &asz);
            CFRelease(area);
        }
        jsonEscape(t, esc, sizeof(esc));
        char escUrl[1024]; jsonEscape(at, escUrl, sizeof(escUrl));
        printf("%s{\"index\":%d,\"title\":\"%s\",\"webarea\":%s,"
               "\"win\":{\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f},"
               "\"area\":{\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f},\"areaText\":\"%s\"}",
               i ? "," : "", (int)i, esc, area ? "true" : "false",
               pos.x, pos.y, sz.width, sz.height,
               apos.x, apos.y, asz.width, asz.height, escUrl);
    }
    printf("]}\n");
    CFRelease(wins);
    CFRelease(app);
    return 0;
}

/* Поиск кнопки по тексту и (опционально) клик по ней. Самый надёжный путь:
 * не зависит от DOM-координат, масштаба вкладки и геометрии рамок окна. */
static int doFindLabel(const char *needle, double dpr, const char *titleHint, int dryRun) {
    char escTitle[512]; escTitle[0] = 0;
    const char *fail = NULL;
    AXUIElementRef app = NULL, win = NULL, area = NULL, hit = NULL;
    CGPoint vpOrigin = CGPointZero; CGSize vpSize = CGSizeZero;
    CGPoint center = CGPointZero;
    double zoom = 1.0, scale = 2.0;
    char hitText[512]; hitText[0] = 0;

    pid_t pid = 0;
    const char *pidEnv = getenv("MW_CHROME_PID");
    if (pidEnv) pid = (pid_t)atoi(pidEnv);
    if (pid <= 0) { fail = "chrome_pid_missing"; goto out; }

    app = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(app, 2.0f);
    win = pickWindowRetry(app, titleHint, 8);
    if (!win) { fail = "window_not_found"; goto out; }

    hit = findByLabel(win, needle, 0, &center);
    if (!hit) { fail = "element_not_found"; goto out; }
    attrStringRel(hit, kAXTitleAttribute, hitText, sizeof(hitText));
    if (!hitText[0]) attrStringRel(hit, kAXDescriptionAttribute, hitText, sizeof(hitText));

    area = findWebArea(win, 0);
    if (area && attrPointRel(area, kAXPositionAttribute, &vpOrigin) &&
        attrSizeRel(area, kAXSizeAttribute, &vpSize)) {
        scale = displayScaleForPoint(vpOrigin);
        zoom = (dpr > 0 && scale > 0) ? (dpr / scale) : 1.0;
        if (zoom <= 0 || zoom > 4) zoom = 1.0;
    }

    if (!dryRun) {
        AXUIElementPerformAction(win, kAXRaiseAction);
        CFTypeRef yes = kCFBooleanTrue;
        AXUIElementSetAttributeValue(win, kAXMainAttribute, yes);
        AXUIElementSetAttributeValue(win, kAXFocusedAttribute, yes);
        postClickChain(center);
    }

out: {
    char escLabel[1024]; escLabel[0] = 0;
    jsonEscape(hitText, escLabel, sizeof(escLabel));
    jsonEscape(g_windowTitle, escTitle, sizeof(escTitle));
    if (fail) {
        printf("{\"ok\":false,\"mode\":\"ax_find\",\"error\":\"%s\"}\n", fail);
    } else {
        printf("{\"ok\":true,\"mode\":\"ax_find\",\"dryRun\":%s,\"global\":{\"x\":%.2f,\"y\":%.2f},"
               "\"client\":{\"x\":%.2f,\"y\":%.2f},\"viewport\":{\"x\":%.2f,\"y\":%.2f,\"w\":%.2f,\"h\":%.2f},"
               "\"zoom\":%.4f,\"scale\":%.3f,\"window\":\"%s\",\"label\":\"%s\"}\n",
               dryRun ? "true" : "false",
               center.x, center.y,
               (center.x - vpOrigin.x) / zoom, (center.y - vpOrigin.y) / zoom,
               vpOrigin.x, vpOrigin.y, vpSize.width, vpSize.height,
               zoom, scale, escTitle, escLabel);
    }
    if (hit) CFRelease(hit);
    if (area) CFRelease(area);
    if (win) CFRelease(win);
    if (app) CFRelease(app);
    return fail ? 2 : 0;
    }
}

static int doClick(double clientX, double clientY, double dpr, double cssW, double cssH,
                   const char *titleHint, int dryRun) {
    char escTitle[512]; escTitle[0] = 0;
    const char *fail = NULL;

    pid_t pid = 0;
    AXUIElementRef app = NULL, win = NULL, area = NULL, prevApp = NULL;
    CGPoint vpOrigin = CGPointZero;
    CGSize vpSize = CGSizeZero;
    CGPoint target = CGPointZero;
    double zoomX = 1.0, zoomY = 1.0, scale = 2.0;
    int mode = 0; /* 0 = none, 1 = clicked, 2 = dry-run */

    /* pid определяем снаружи (передаётся через переменную окружения), чтобы не
     * тащить libproc в базовый фреймворк. */
    const char *pidEnv = getenv("MW_CHROME_PID");
    if (pidEnv) pid = (pid_t)atoi(pidEnv);
    if (pid <= 0) { fail = "chrome_pid_missing"; goto out; }

    app = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(app, 2.0f);
    win = pickWindowRetry(app, titleHint, 8);
    if (!win) { fail = "window_not_found"; goto out; }

    area = findWebArea(win, 0);
    if (!area) { fail = "webarea_not_found"; goto out; }

    if (!attrPointRel(area, kAXPositionAttribute, &vpOrigin)) { fail = "no_viewport_position"; goto out; }
    if (!attrSizeRel(area, kAXSizeAttribute, &vpSize)) { fail = "no_viewport_size"; goto out; }

    scale = displayScaleForPoint(vpOrigin);
    computeZoom(vpSize, cssW, cssH, dpr, scale, &zoomX, &zoomY);

    target.x = vpOrigin.x + clientX * zoomX;
    target.y = vpOrigin.y + clientY * zoomY;

    if (target.x < vpOrigin.x - 2 || target.y < vpOrigin.y - 2 ||
        target.x > vpOrigin.x + vpSize.width + 2 || target.y > vpOrigin.y + vpSize.height + 2) {
        fail = "point_outside_viewport"; goto out;
    }

    /* В dryRun ничего не меняем: только расчёт геометрии. */
    if (!dryRun) {
        /* Запоминаем, в каком приложении работал пользователь, чтобы вернуть фокус. */
        prevApp = copyFrontmostApp();

        /* Активируем окно, чтобы клик не был «съеден» сменой фокуса. */
        AXUIElementPerformAction(win, kAXRaiseAction);
        AXUIElementSetAttributeValue(win, kAXMainAttribute, kCFBooleanTrue);
        AXUIElementSetAttributeValue(win, kAXFocusedAttribute, kCFBooleanTrue);

        /* Позиция курсора ДО клика — восстанавливаем после, чтобы не мешать работе. */
        CGEventRef probe = CGEventCreate(NULL);
        CGPoint saved = probe ? CGEventGetLocation(probe) : CGPointZero;
        if (probe) CFRelease(probe);

        /* Цепочка «наведение → нажатие → отпускание»: без move-событий игра
         * не собирает доказательство человеческого действия. */
        CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, target, kCGMouseButtonLeft);
        if (move) { CGEventPost(kCGHIDEventTap, move); CFRelease(move); }
        usleep(30000);

        CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, target, kCGMouseButtonLeft);
        if (down) { CGEventSetIntegerValueField(down, kCGMouseEventClickState, 1); CGEventPost(kCGHIDEventTap, down); CFRelease(down); }
        usleep(80000);

        CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, target, kCGMouseButtonLeft);
        if (up) { CGEventSetIntegerValueField(up, kCGMouseEventClickState, 1); CGEventPost(kCGHIDEventTap, up); CFRelease(up); }
        usleep(20000);

        /* Возврат курсора на прежнее место. */
        CGEventRef back = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, saved, kCGMouseButtonLeft);
        if (back) { CGEventPost(kCGHIDEventTap, back); CFRelease(back); }

        mode = 1;
    } else {
        mode = 2; /* геометрия рассчитана, клик не выполнялся */
    }

out:
    jsonEscape(g_windowTitle, escTitle, sizeof(escTitle));
    if (fail) {
        printf("{\"ok\":false,\"mode\":\"ax\",\"error\":\"%s\"}\n", fail);
    } else {
        printf("{\"ok\":%s,\"mode\":\"ax\",\"viewport\":{\"x\":%.2f,\"y\":%.2f,\"w\":%.2f,\"h\":%.2f},"
               "\"point\":{\"x\":%.2f,\"y\":%.2f},\"zoom\":%.4f,\"scale\":%.3f,"
               "\"window\":\"%s\",\"error\":null}\n",
               mode ? "true" : "false",
               vpOrigin.x, vpOrigin.y, vpSize.width, vpSize.height,
               target.x, target.y, zoomX, scale, escTitle);
    }

    if (!dryRun) restoreFrontmost(prevApp);
    if (area) CFRelease(area);
    if (win) CFRelease(win);
    if (app) CFRelease(app);
    return fail ? 2 : (mode ? 0 : 4);
}

/* Диагностика: выводит все элементы, чей текст содержит needle (любая роль).
 * Нужно чтобы понять, доступны ли кнопки игры через Accessibility вообще. */
#define DUMP_MAX 60
typedef struct { int count; const char *needle; char out[8192]; size_t len; } DumpCtx;

static void dumpWalk(AXUIElementRef el, int depth, DumpCtx *ctx) {
    if (!el || depth > 60 || ctx->count >= DUMP_MAX) return;
    char role[64], text[256];
    text[0] = 0;
    attrStringRel(el, kAXRoleAttribute, role, sizeof(role));
    attrStringRel(el, kAXTitleAttribute, text, sizeof(text));
    if (!text[0]) attrStringRel(el, kAXDescriptionAttribute, text, sizeof(text));
    if (!text[0]) attrStringRel(el, kAXValueAttribute, text, sizeof(text));

    if (text[0] && ctx->needle && *ctx->needle && strstr(text, ctx->needle)) {
        CGPoint pos = CGPointZero; CGSize sz = CGSizeZero;
        attrPointRel(el, kAXPositionAttribute, &pos);
        attrSizeRel(el, kAXSizeAttribute, &sz);
        char esc[512]; jsonEscape(text, esc, sizeof(esc));
        if (ctx->len + 200 < sizeof(ctx->out)) {
            int written = snprintf(ctx->out + ctx->len, sizeof(ctx->out) - ctx->len,
                "%s{\"role\":\"%s\",\"text\":\"%s\",\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f}",
                ctx->count ? "," : "", role, esc, pos.x, pos.y, sz.width, sz.height);
            if (written > 0) ctx->len += (size_t)written;
        }
        ctx->count++;
        if (ctx->len + 200 >= sizeof(ctx->out)) return; /* буфер почти полон */
    }

    CFTypeRef kids = copyAttr(el, kAXChildrenAttribute);
    if (kids && CFGetTypeID(kids) == CFArrayGetTypeID()) {
        CFIndex n = CFArrayGetCount((CFArrayRef)kids);
        for (CFIndex i = 0; i < n && ctx->count < DUMP_MAX; i++) {
            dumpWalk((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)kids, i), depth + 1, ctx);
        }
    }
    if (kids) CFRelease(kids);
}

static int printDump(pid_t pid, const char *needle) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) { printf("{\"ok\":false,\"error\":\"no_app\"}\n"); return 2; }
    AXUIElementSetMessagingTimeout(app, 4.0f);
    AXUIElementRef win = pickWindowRetry(app, NULL, 8);
    if (!win) { CFRelease(app); printf("{\"ok\":false,\"error\":\"window_not_found\"}\n"); return 2; }
    DumpCtx ctx; ctx.count = 0; ctx.needle = needle; ctx.out[0] = 0; ctx.len = 0;
    dumpWalk(win, 0, &ctx);
    char escN[512]; jsonEscape(needle, escN, sizeof(escN));
    printf("{\"ok\":true,\"needle\":\"%s\",\"matches\":%d,\"items\":[%s]}\n", escN, ctx.count, ctx.out);
    CFRelease(win);
    CFRelease(app);
    return 0;
}

/* Закрыть окно по подстроке заголовка. Используется для сборки мусора после
 * диагностики (например, закрыть тестовую страницу). */
static int closeWindow(pid_t pid, const char *titleHint) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) { printf("{\"ok\":false,\"error\":\"no_app\"}\n"); return 2; }
    AXUIElementSetMessagingTimeout(app, 3.0f);
    AXUIElementRef win = pickWindowRetry(app, titleHint, 6);
    if (!win) { CFRelease(app); printf("{\"ok\":false,\"error\":\"window_not_found\"}\n"); return 2; }

    CFTypeRef btn = NULL;
    AXError err = AXUIElementCopyAttributeValue(win, kAXCloseButtonAttribute, &btn);
    int closed = 0;
    if (err == kAXErrorSuccess && btn) {
        closed = (AXUIElementPerformAction((AXUIElementRef)btn, kAXPressAction) == kAXErrorSuccess) ? 1 : 0;
        CFRelease(btn);
    }
    printf("{\"ok\":%s,\"mode\":\"close\",\"closed\":%s}\n", closed ? "true" : "false",
           closed ? "true" : "false");
    CFRelease(win);
    CFRelease(app);
    return closed ? 0 : 2;
}

/* Показать штатный системный запрос доступа Accessibility. Нужен для сценария
 * автозапуска через launchd: такой процесс НЕ наследует разрешение терминала,
 * поэтому node должен быть добавлен в список Accessibility один раз вручную. */
static int promptAccessibility(void) {
    const void *keys[] = { kAXTrustedCheckOptionPrompt };
    const void *vals[] = { kCFBooleanTrue };
    CFDictionaryRef opts = CFDictionaryCreate(kCFAllocatorDefault, keys, vals, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    Boolean trusted = AXIsProcessTrustedWithOptions(opts);
    if (opts) CFRelease(opts);
    printf("{\"ok\":%s,\"trusted\":%s,\"promptShown\":\"true\"}\n",
           trusted ? "true" : "false", trusted ? "true" : "false");
    return trusted ? 0 : 3;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "--status") == 0) return printStatus();
    if (argc >= 2 && strcmp(argv[1], "--prompt") == 0) return promptAccessibility();
    if (argc >= 3 && strcmp(argv[1], "--close-window") == 0) {
        pid_t pid = 0;
        const char *pidEnv = getenv("MW_CHROME_PID");
        if (pidEnv) pid = (pid_t)atoi(pidEnv);
        if (pid <= 0) { printf("{\"ok\":false,\"error\":\"chrome_pid_missing\"}\n"); return 2; }
        return closeWindow(pid, argv[2]);
    }
    if (argc >= 3 && strcmp(argv[1], "--dump") == 0) {
        pid_t pid = 0;
        const char *pidEnv = getenv("MW_CHROME_PID");
        if (pidEnv) pid = (pid_t)atoi(pidEnv);
        if (pid <= 0) { printf("{\"ok\":false,\"error\":\"chrome_pid_missing\"}\n"); return 2; }
        return printDump(pid, argv[2]);
    }
    if (argc >= 2 && strcmp(argv[1], "--windows") == 0) {
        pid_t pid = 0;
        const char *pidEnv = getenv("MW_CHROME_PID");
        if (pidEnv) pid = (pid_t)atoi(pidEnv);
        const char *needle = (argc >= 3) ? argv[2] : NULL;
        if (pid <= 0) { printf("{\"ok\":false,\"error\":\"chrome_pid_missing\"}\n"); return 2; }
        return printWindows(pid, needle);
    }
    /* --find <text> <dpr> [titleHint]  /  --find-dry … — диагностика:
     * показать, видит ли Accessibility кнопку с таким заголовком и где она. */
    if (argc >= 4 && (strcmp(argv[1], "--find") == 0 || strcmp(argv[1], "--find-dry") == 0)) {
        const char *hint = (argc >= 5) ? argv[4] : NULL;
        int dryRun = (strcmp(argv[1], "--find-dry") == 0) ? 1 : 0;
        return doFindLabel(argv[2], atof(argv[3]), hint, dryRun);
    }
    /* --click <clientX> <clientY> <dpr> <titleHint> <cssW> <cssH>
     * --probe … — то же, но без клика. Аргументы обязательны по порядку,
     * titleHint может быть пустой строкой. */
    if (argc >= 8 && (strcmp(argv[1], "--click") == 0 || strcmp(argv[1], "--probe") == 0)) {
        const char *hint = argv[5];
        int dryRun = (strcmp(argv[1], "--probe") == 0) ? 1 : 0;
        return doClick(atof(argv[2]), atof(argv[3]), atof(argv[4]),
                       atof(argv[6]), atof(argv[7]),
                       (hint && *hint) ? hint : NULL, dryRun);
    }
    printf("{\"ok\":false,\"error\":\"usage: --status | --windows | --dump <text> | --find|--find-dry <text> <dpr> [title] | --probe|--click <x> <y> <dpr> <title> <cssW> <cssH>\"}\n");
    return 64;
}
