/**
 * Портфолио сайта «Dinara BILab Медиа».
 * Сейчас здесь ЗАГЛУШКИ со стоковыми фото — перед публикацией замените на реальные работы:
 * image — путь images/... (файл в папке images/) или ссылка https://images.unsplash.com/...;
 * kind — фильтр: video, cartoon, photo, invite, site; title_kk — название на казахском (без него — русское).
 */
// i18n-ignore-start: контент портфолио переводится полями _kk, а не словарём
export const PORTFOLIO = [
  {
    id: "w1",
    kind: "video",
    title: "Рекламный ролик",
    title_kk: "Жарнамалық ролик",
    image: "https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?auto=format&fit=crop&w=900&q=80",
  },
  {
    id: "w2",
    kind: "cartoon",
    title: "Мультфильм на заказ",
    title_kk: "Тапсырыспен мультфильм",
    image: "https://images.unsplash.com/photo-1626785774573-4b799315345d?auto=format&fit=crop&w=900&q=80",
  },
  {
    id: "w3",
    kind: "photo",
    title: "ИИ-фотосессия",
    title_kk: "ЖИ-фотосессия",
    image: "https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?auto=format&fit=crop&w=900&q=80",
  },
  {
    id: "w4",
    kind: "invite",
    title: "Пригласительное на праздник",
    title_kk: "Мерекеге шақыру билеті",
    image: "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=900&q=80",
  },
  {
    id: "w5",
    kind: "photo",
    title: "Генерация фото для соцсетей",
    title_kk: "Әлеуметтік желілерге фото генерациясы",
    image: "https://images.unsplash.com/photo-1554048612-b6a482bc67e5?auto=format&fit=crop&w=900&q=80",
  },
  {
    id: "w6",
    kind: "site",
    title: "Сайт-лендинг",
    title_kk: "Лендинг сайт",
    image: "images/website.jpg",
  },
  {
    id: "w7",
    kind: "video",
    title: "Видео для соцсетей",
    title_kk: "Әлеуметтік желілерге арналған видео",
    image: "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=900&q=80",
  },
];
// i18n-ignore-end

export const PORTFOLIO_KINDS = ["video", "cartoon", "photo", "invite", "site"];
