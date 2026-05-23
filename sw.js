const CACHE_NAME = 'portal-cache-v2'; // Оновлена версія для скидання старого кешу
const urlsToCache = [
  './',
  './index.html',
  './schedule.html',
  './extra_shift.html'
];

// Встановлення Service Worker: кешуємо файли і примусово активуємо
self.addEventListener('install', event => {
  self.skipWaiting(); // Примусово оновлює SW без очікування
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

// Активація: видаляємо всі старі кеші попередніх версій
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Перехоплення запитів: Стратегія "Network First" (Спочатку мережа, потім кеш)
self.addEventListener('fetch', event => {
  // Пропускаємо POST-запити (наприклад, логування або відправку форм), їх не можна кешувати
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Якщо інтернет є і відповідь успішна - оновлюємо кеш свіжим файлом
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response; // Віддаємо свіжу версію з інтернету
      })
      .catch(() => {
        // Якщо інтернету немає - беремо файл з кешу
        return caches.match(event.request);
      })
  );
});
