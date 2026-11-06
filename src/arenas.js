// arenas.js — темы арен. Размер у всех одинаковый, меняется только оформление.

export const ARENAS = [
  {
    id: 'halloween', name: 'Хэллоуин', emoji: '🎃',
    bg: ['#3b2a5a', '#7a4a8c'],
    hemi: [0xd6c4ff, 0x54406e, 1.15],
    sun: [0xffd9a8, 0.9],
    wall: ['#ff8a1f', '#2b1a3a'],
    rim: 0xff8a1f,
  },
  {
    id: 'christmas', name: 'Новый год', emoji: '🎄',
    bg: ['#9fcff3', '#eaf6ff'],
    hemi: [0xffffff, 0x9fb8d6, 1.1],
    sun: [0xfff4e0, 0.9],
    wall: ['#d8262f', '#ffffff'],
    rim: 0xffffff,
    snow: true,
  },
  {
    id: 'desert', name: 'Пустыня', emoji: '🌵',
    bg: ['#7ec8f2', '#ffe2a8'],
    hemi: [0xfff2d0, 0xb98a4a, 1.1],
    sun: [0xfff0c0, 1.0],
    wall: ['#f2c14e', '#9b5d2a'],
    rim: 0xc7863a,
  },
  {
    id: 'sky', name: 'Небо', emoji: '☁️',
    bg: ['#4aa8ff', '#cfeaff'],
    hemi: [0xffffff, 0xa9c8ff, 1.15],
    sun: [0xffffff, 0.8],
    wall: ['#ffffff', '#8fc8ff'],
    rim: 0xffffff,
  },
];
