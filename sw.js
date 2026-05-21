const CACHE_NAME = 'portal-cache-v1';
const urlsToCache = [
  './',
  './index.html',
  './schedule.html'
];

// Встановлення Service Worker та кешування базових файлів
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

// Перехоплення запитів: спочатку шукаємо в кеші, якщо немає - йдемо в мережу
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response; // Віддаємо з кешу (миттєве завантаження)
        }
        return fetch(event.request);
      })
  );
});
