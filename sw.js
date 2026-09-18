/* ==========================================================================
   Serviceworker för Klockan

   Uppgiften är att väggklockan ska fortsätta fungera när nätet försvinner.

   Egna filer levereras ur cachen direkt, men hämtas samtidigt om i bakgrunden
   så att nästa laddning får den nya versionen. Utan det krävs en manuell
   höjning av CACHE_VERSION vid varje ändring — ett steg som glöms bort, och
   då fastnar plattan på gamla filer utan att något syns.
   ========================================================================== */

const CACHE_VERSION = "klockan-v10";
const APP_START_PAGE = "./index.html";

/* Filer som ska finnas i cachen direkt vid installationen. */
const APP_SHELL_PATHS = Object.freeze([
  "./",
  APP_START_PAGE,
  /* Sidan bakom påskäggets QR-kod. Den delar quotes.js med klockan, så utan
     den här raden fanns modulen offline men inte sidan som använder den. */
  "./ordsprak.html",
  "./quotes.js",
  "./logo.png",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
]);

/* Typsnitten ligger hos Google och hämtas i två steg: först en CSS-fil, sedan
   själva typsnittsfilerna. Båda värdarna cachas i takt med att de används. */
const FONT_HOSTS = Object.freeze(["fonts.googleapis.com", "fonts.gstatic.com"]);

const NAVIGATION_REQUEST_MODE = "navigate";
const GET_METHOD = "GET";
const OPAQUE_RESPONSE_TYPE = "opaque";
/* Sidan frågar efter den här strängen för att kunna visa vilken cache som
   faktiskt är i tjänst. Samma sträng finns i index.html. */
const VERSION_REQUEST_MESSAGE = "vilken-cacheversion";


/* ==========================================================================
   Installation
   ========================================================================== */

/* Varje fil hämtas för sig. Med cache.addAll() räcker det att en enda fil
   saknas för att hela installationen ska avbrytas — och då uteblir
   offline-läget helt, utan synligt felmeddelande. */
async function cacheAppShell() {
  const cache = await caches.open(CACHE_VERSION);

  await Promise.all(APP_SHELL_PATHS.map(async (path) => {
    try {
      // cache: "reload" kringgår webbläsarens vanliga cache vid installationen
      await cache.add(new Request(path, { cache: "reload" }));
    } catch (error) {
      console.warn(`Klockan: ${path} kunde inte cachas och hoppas över.`, error);
    }
  }));

  // Ny version tar över direkt i stället för att vänta på att alla flikar stängs
  await self.skipWaiting();
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
});


/* ==========================================================================
   Aktivering
   ========================================================================== */

async function removeOutdatedCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => cacheName !== CACHE_VERSION)
      .map((cacheName) => caches.delete(cacheName))
  );
  await self.clients.claim();
}

self.addEventListener("activate", (event) => {
  event.waitUntil(removeOutdatedCaches());
});


/* ==========================================================================
   Hämtning
   ========================================================================== */

/* Sidan hämtas i första hand från nätet, så att en ny version slår igenom vid
   nästa laddning. Först när nätet inte svarar används den sparade kopian.

   Varje sida sparas under sin egen adress. Skrevs de alla under startsidans
   nyckel räckte ett besök på ordspråkssidan för att skriva över den cachade
   klockan — och då startade väggplattan i ordspråket nästa gång nätet låg
   nere, utan att något syntes som fel. */
async function respondWithNetworkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cachedPage = await cache.match(request);
    if (cachedPage !== undefined) return cachedPage;

    /* Okänd adress utan nät: klockan är ett bättre svar än ett felmeddelande. */
    const cachedStartPage = await cache.match(APP_START_PAGE);
    if (cachedStartPage !== undefined) return cachedStartPage;
    throw error;
  }
}

/* Typsnitten ligger på oföränderliga adresser hos Google och behöver aldrig
   hämtas om när de väl finns i cachen. */
async function respondWithCacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cachedResponse = await cache.match(request);
  if (cachedResponse !== undefined) return cachedResponse;

  const response = await fetch(request);
  /* Svar från en annan domän är ogenomskinliga och saknar läsbar status.
     De går ändå att spara och återanvända. */
  if (response.ok || response.type === OPAQUE_RESPONSE_TYPE) {
    cache.put(request, response.clone());
  }
  return response;
}

/* Egna filer: leverera ur cachen med en gång, men hämta om i bakgrunden.
   Sidan startar lika snabbt som förut och nästa laddning har det nya. */
async function respondWithCachedThenUpdate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cachedResponse = await cache.match(request);

  const networkUpdate = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cachedResponse !== undefined) return cachedResponse;

  const response = await networkUpdate;
  if (response !== undefined) return response;
  throw new Error(`Kunde inte hämta ${request.url}`);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== GET_METHOD) return;

  if (request.mode === NAVIGATION_REQUEST_MODE) {
    event.respondWith(respondWithNetworkFirst(request));
    return;
  }

  const requestUrl = new URL(request.url);
  const isOwnFile = requestUrl.origin === self.location.origin;
  const isFontFile = FONT_HOSTS.includes(requestUrl.hostname);
  if (isFontFile) {
    event.respondWith(respondWithCacheFirst(request));
    return;
  }
  if (isOwnFile) {
    event.respondWith(respondWithCachedThenUpdate(request));
  }
});


/* ==========================================================================
   Besked till sidan
   ========================================================================== */

/* Utan det här går det inte att se vilken serviceworker som är i tjänst — och
   det är just den frågan som är svår att svara på när något känns gammalt. */
self.addEventListener("message", (event) => {
  if (event.data !== VERSION_REQUEST_MESSAGE) return;
  event.ports[0]?.postMessage({ cacheVersion: CACHE_VERSION });
});
